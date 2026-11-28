//! macOS PAC (Automatic Proxy Configuration) support for `ProxyMode::Auto`.
//!
//! reqwest's built-in system proxy ignores macOS PAC scripts. When a PAC URL is
//! enabled and no `*_PROXY` env var overrides it, we fetch the script in the
//! background (refreshing after a TTL) and evaluate it per request on a
//! dedicated worker thread with a timeout so requests never hang.

use hyper_util::client::proxy::matcher::Matcher;
use ide_core::proxy_settings::{ProxyMode, ProxyRoute, ProxySettings};
use objc2_cf_network as cf;
use objc2_core_foundation::{CFArray, CFDictionary, CFNumber, CFRetained, CFString, CFType, CFURL};
use parking_lot::Mutex;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

const PROXY_ENV: [&str; 6] = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
const PAC_FETCH_TIMEOUT: Duration = Duration::from_secs(5);
const SCRIPT_TTL: Duration = Duration::from_secs(5 * 60);
const RETRY_BACKOFF: Duration = Duration::from_secs(30);
const EVAL_TIMEOUT: Duration = Duration::from_millis(200);

fn env_proxy_set() -> bool {
    PROXY_ENV.iter().any(|k| std::env::var_os(k).is_some_and(|v| !v.is_empty()))
}

fn env_no_proxy() -> String {
    std::env::var("NO_PROXY").or_else(|_| std::env::var("no_proxy")).unwrap_or_default()
}

fn system_settings() -> Option<CFRetained<CFDictionary>> {
    // SAFETY: plain CFNetwork call returning an owned CFDictionary or NULL.
    unsafe { cf::CFNetworkCopySystemProxySettings() }
}

/// Attaches a PAC-aware custom proxy only when macOS has a PAC enabled and no
/// `*_PROXY` env var overrides it; leaves `builder` untouched otherwise.
pub(crate) fn with_system_pac(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    with_pac_from(builder, env_proxy_set(), system_settings, &env_no_proxy(), ScriptSlot::shared)
}

fn with_pac_from(
    builder: reqwest::ClientBuilder,
    has_env_proxy: bool,
    read_settings: impl FnOnce() -> Option<CFRetained<CFDictionary>>,
    no_proxy: &str,
    slot_for: impl FnOnce(String) -> Arc<ScriptSlot>,
) -> reqwest::ClientBuilder {
    let Some((settings, url)) =
        (!has_env_proxy).then(read_settings).flatten().and_then(|s| configured_pac(&s).map(|u| (s, u)))
    else {
        return builder;
    };
    let resolver = PacResolver::new(slot_for(url), manual_matcher(&settings, no_proxy), no_proxy);
    builder.proxy(reqwest::Proxy::custom(move |url| resolver.resolve(url)))
}

/// Fingerprint of the active macOS PAC URL, or `None`.
pub(crate) fn system_pac_fingerprint() -> Option<String> {
    (!env_proxy_set()).then(system_settings).flatten().and_then(|s| pac_fingerprint(&s))
}

enum Load {
    Pending,
    Ready { script: Arc<str>, fetched_at: Instant, refreshing: bool },
    Failed(Instant),
}

struct EvalJob {
    script: Arc<str>,
    url: String,
    reply: mpsc::SyncSender<Option<String>>,
}

struct ScriptSlot {
    url: String,
    ttl: Duration,
    backoff: Duration,
    eval_timeout: Duration,
    load: Mutex<Load>,
    worker: Mutex<Option<mpsc::SyncSender<EvalJob>>>,
}

impl ScriptSlot {
    fn shared(url: String) -> Arc<Self> {
        // Share the active PAC across `shared()`, `shared_without_redirects()`, and `check_connection()`.
        static ACTIVE: Mutex<Option<(String, Arc<ScriptSlot>)>> = Mutex::new(None);
        let mut active = ACTIVE.lock();
        if let Some((cached, slot)) = active.as_ref()
            && *cached == url
        {
            return Arc::clone(slot);
        }
        let slot = Self::new(url.clone(), SCRIPT_TTL, RETRY_BACKOFF, EVAL_TIMEOUT);
        *active = Some((url, Arc::clone(&slot)));
        slot
    }

    fn new(url: String, ttl: Duration, backoff: Duration, eval_timeout: Duration) -> Arc<Self> {
        let slot = Arc::new(Self {
            url,
            ttl,
            backoff,
            eval_timeout,
            load: Mutex::new(Load::Pending),
            worker: Mutex::new(None),
        });
        slot.spawn_fetch();
        slot
    }

    fn script(self: &Arc<Self>) -> Option<Arc<str>> {
        let mut load = self.load.lock();
        match &mut *load {
            Load::Ready { script, fetched_at, refreshing } => {
                let current = Arc::clone(script);
                if !*refreshing && fetched_at.elapsed() >= self.ttl {
                    *refreshing = true;
                    drop(load);
                    self.spawn_fetch();
                }
                Some(current)
            }
            Load::Failed(at) if at.elapsed() >= self.backoff => {
                *load = Load::Pending;
                drop(load);
                self.spawn_fetch();
                None
            }
            Load::Pending | Load::Failed(_) => None,
        }
    }

    fn fail_if_current(&self, failed: &Arc<str>) {
        let mut load = self.load.lock();
        if let Load::Ready { script, .. } = &*load
            && Arc::ptr_eq(script, failed)
        {
            *load = Load::Failed(Instant::now());
        }
    }

    fn evaluate(self: &Arc<Self>, url: &str) -> Option<String> {
        let _ = self.script()?;
        let mut worker = self.worker.lock();
        // Re-read after acquiring the worker lock so a prior timeout's `Failed` skips spawning a new thread.
        let script = match &*self.load.lock() {
            Load::Ready { script, .. } => Arc::clone(script),
            Load::Pending | Load::Failed(_) => return None,
        };
        if worker.is_none() {
            *worker = spawn_eval_worker();
        }
        let tx = worker.as_ref()?;
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        if tx.send(EvalJob { script: Arc::clone(&script), url: url.to_owned(), reply: reply_tx }).is_err() {
            *worker = None;
            return None;
        }
        match reply_rx.recv_timeout(self.eval_timeout) {
            Ok(route) => route,
            Err(_) => {
                // Abandon the wedged worker thread and stop evaluating this script until refetch.
                *worker = None;
                self.fail_if_current(&script);
                None
            }
        }
    }

    fn spawn_fetch(self: &Arc<Self>) {
        let slot = Arc::clone(self);
        let fut = async move {
            let next = match fetch_script(&slot.url).await {
                Some(js) => Load::Ready { script: Arc::from(js), fetched_at: Instant::now(), refreshing: false },
                None => Load::Failed(Instant::now()),
            };
            *slot.load.lock() = next;
        };
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(fut);
        } else {
            // Sync callers outside a Tokio runtime still fetch without blocking `build()`.
            let fallback = Arc::clone(self);
            if std::thread::Builder::new()
                .name("ide-http-pac-fetch".into())
                .spawn(move || {
                    if let Ok(rt) = tokio::runtime::Builder::new_current_thread().enable_all().build() {
                        rt.block_on(fut);
                    } else {
                        *fallback.load.lock() = Load::Failed(Instant::now());
                    }
                })
                .is_err()
            {
                *self.load.lock() = Load::Failed(Instant::now());
            }
        }
    }
}

fn spawn_eval_worker() -> Option<mpsc::SyncSender<EvalJob>> {
    let (tx, rx) = mpsc::sync_channel::<EvalJob>(0);
    std::thread::Builder::new()
        .name("ide-http-pac-eval".into())
        .spawn(move || {
            while let Ok(job) = rx.recv() {
                let _ = job.reply.send(evaluate_sync(&job.script, &job.url));
            }
        })
        .ok()?;
    Some(tx)
}

async fn fetch_script(pac: &str) -> Option<String> {
    if let Ok(url) = reqwest::Url::parse(pac)
        && url.scheme() == "file"
    {
        return tokio::fs::read_to_string(url.to_file_path().ok()?).await.ok();
    }
    // The PAC host is reached directly: the script is what says which proxy to use.
    let client = crate::client::build(&ProxySettings { mode: ProxyMode::None, ..Default::default() }).ok()?;
    client.get(pac).timeout(PAC_FETCH_TIMEOUT).send().await.ok()?.error_for_status().ok()?.text().await.ok()
}

struct PacResolver {
    slot: Arc<ScriptSlot>,
    fallback: Matcher,
    no_proxy: Option<Matcher>,
}

impl PacResolver {
    fn new(slot: Arc<ScriptSlot>, fallback: Matcher, no_proxy: &str) -> Self {
        let list = no_proxy.trim();
        let no_proxy = (!list.is_empty()).then(|| Matcher::builder().all("http://proxy.invalid").no(list).build());
        Self { slot, fallback, no_proxy }
    }

    fn resolve(&self, url: &reqwest::Url) -> Option<String> {
        let uri = url.as_str().parse().ok();
        if let Some(uri) = &uri
            && self.no_proxy.as_ref().is_some_and(|m| m.intercept(uri).is_none())
        {
            return None;
        }
        if let Some(host) = url.host_str() {
            let origin = url
                .port()
                .map_or_else(|| format!("{}://{host}/", url.scheme()), |p| format!("{}://{host}:{p}/", url.scheme()));
            if let Some(via) = self.slot.evaluate(&origin) {
                return Some(via);
            }
        }
        uri.as_ref().and_then(|u| self.fallback.intercept(u)).map(|i| i.uri().to_string())
    }
}

fn authority(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') { format!("[{host}]:{port}") } else { format!("{host}:{port}") }
}

fn entries(list: &CFArray) -> Vec<CFRetained<CFDictionary<CFString, CFType>>> {
    // SAFETY: CFNetwork proxy lists hold dictionaries keyed by kCFProxy*Key strings.
    let list: &CFArray<CFType> = unsafe { list.cast_unchecked() };
    list.iter()
        .filter_map(|e| e.downcast::<CFDictionary>().ok())
        .map(|d| unsafe { CFRetained::cast_unchecked(d) })
        .collect()
}

fn cf_str(dict: &CFDictionary<CFString, CFType>, key: &CFString) -> Option<CFRetained<CFString>> {
    dict.get(key)?.downcast::<CFString>().ok()
}

fn cf_i64(dict: &CFDictionary<CFString, CFType>, key: &CFString) -> Option<i64> {
    dict.get(key)?.downcast_ref::<CFNumber>()?.as_i64()
}

fn configured_pac(settings: &CFDictionary) -> Option<String> {
    // SAFETY: CFNetworkCopySystemProxySettings returns a CFDictionary keyed by CFString.
    unsafe {
        let dict: &CFDictionary<CFString, CFType> = settings.cast_unchecked();
        let enabled = cf_i64(dict, cf::kCFNetworkProxiesProxyAutoConfigEnable).is_some_and(|n| n != 0);
        enabled.then(|| {
            cf_str(dict, cf::kCFNetworkProxiesProxyAutoConfigURLString)
                .map(|s| s.to_string().trim().to_owned())
                .filter(|s| !s.is_empty())
        })?
    }
}

fn pac_fingerprint(settings: &CFDictionary) -> Option<String> {
    let mut hasher = DefaultHasher::new();
    configured_pac(settings)?.hash(&mut hasher);
    Some(format!("pac:{:016x}", hasher.finish()))
}

/// Reads a macOS manual HTTP or HTTPS proxy entry the same way `hyper_util::Matcher::from_system` does.
fn manual_proxy(
    dict: &CFDictionary<CFString, CFType>,
    enable_key: &CFString,
    host_key: &CFString,
    port_key: &CFString,
) -> Option<String> {
    if cf_i64(dict, enable_key) != Some(1) {
        return None;
    }
    let host = cf_str(dict, host_key)?.to_string();
    let port = cf_i64(dict, port_key).and_then(|p| u16::try_from(p).ok());
    Some(match port {
        Some(port) => authority(&host, port),
        None if host.contains(':') && !host.starts_with('[') => format!("[{host}]"),
        None => host,
    })
}

/// Matches `hyper_util::Matcher::from_system` on macOS: manual HTTP/HTTPS proxy + `NO_PROXY`.
fn manual_matcher(settings: &CFDictionary, no_proxy: &str) -> Matcher {
    // SAFETY: CFNetworkCopySystemProxySettings returns a CFDictionary keyed by CFString.
    let dict: &CFDictionary<CFString, CFType> = unsafe { settings.cast_unchecked() };
    let mut builder = Matcher::builder().no(no_proxy);
    unsafe {
        if let Some(h) = manual_proxy(
            dict,
            cf::kCFNetworkProxiesHTTPEnable,
            cf::kCFNetworkProxiesHTTPProxy,
            cf::kCFNetworkProxiesHTTPPort,
        ) {
            builder = builder.http(h);
        }
        if let Some(h) = manual_proxy(
            dict,
            cf::kCFNetworkProxiesHTTPSEnable,
            cf::kCFNetworkProxiesHTTPSProxy,
            cf::kCFNetworkProxiesHTTPSPort,
        ) {
            builder = builder.https(h);
        }
    }
    builder.build()
}

fn parse_proxy_entry(entry: &CFDictionary<CFString, CFType>) -> Option<ProxyRoute> {
    // SAFETY: reading CFNetwork proxy dictionary constants and values.
    unsafe {
        let kind = cf_str(entry, cf::kCFProxyTypeKey)?;
        let scheme = if &*kind == cf::kCFProxyTypeNone {
            return Some(ProxyRoute::Direct);
        } else if &*kind == cf::kCFProxyTypeHTTP || &*kind == cf::kCFProxyTypeHTTPS {
            // `HTTPS` means a proxy for https URLs; the proxy itself speaks plain HTTP.
            "http"
        } else if &*kind == cf::kCFProxyTypeSOCKS {
            "socks5h"
        } else {
            return None;
        };
        let host = cf_str(entry, cf::kCFProxyHostNameKey)?.to_string();
        let port = u16::try_from(cf_i64(entry, cf::kCFProxyPortNumberKey)?).ok()?;
        Some(ProxyRoute::Via(format!("{scheme}://{}", authority(&host, port))))
    }
}

fn evaluate_sync(script: &str, url: &str) -> Option<String> {
    let target = CFURL::from_string(None, &CFString::from_str(url), None)?;
    let mut error = std::ptr::null_mut();
    // SAFETY: CFNetwork call on owned, valid CF objects; `error` is an out-pointer it may fill.
    let list =
        unsafe { cf::CFNetworkCopyProxiesForAutoConfigurationScript(&CFString::from_str(script), &target, &mut error) };
    if !error.is_null() {
        // SAFETY: CFNetwork hands over ownership of the error it created.
        drop(unsafe { CFRetained::from_raw(std::ptr::NonNull::new_unchecked(error)) });
        return None;
    }
    let list = list?;
    entries(&list).iter().find_map(|e| match parse_proxy_entry(e) {
        Some(ProxyRoute::Direct) => Some(None),
        Some(ProxyRoute::Via(via)) => Some(Some(via)),
        Some(ProxyRoute::System) | None => None,
    })?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    fn settings_dict(entries: Vec<(&'static CFString, CFRetained<CFType>)>) -> CFRetained<CFDictionary> {
        let keys: Vec<&CFString> = entries.iter().map(|(k, _)| *k).collect();
        let values: Vec<&CFType> = entries.iter().map(|(_, v)| &**v).collect();
        let dict = CFDictionary::from_slices(&keys, &values);
        // SAFETY: erasing typed dictionary generics to opaque CFDictionary is always valid.
        unsafe { CFRetained::cast_unchecked::<CFDictionary>(dict) }
    }

    fn as_cf_type<T: objc2_core_foundation::Type>(v: CFRetained<T>) -> CFRetained<CFType> {
        // SAFETY: every CoreFoundation object is a subtype of CFType.
        unsafe { CFRetained::cast_unchecked::<CFType>(v) }
    }

    fn settings_with_pac_url(pac_url: &str, enabled: bool) -> CFRetained<CFDictionary> {
        settings_dict(vec![
            (unsafe { cf::kCFNetworkProxiesProxyAutoConfigEnable }, as_cf_type(CFNumber::new_i32(i32::from(enabled)))),
            (unsafe { cf::kCFNetworkProxiesProxyAutoConfigURLString }, as_cf_type(CFString::from_str(pac_url))),
        ])
    }

    fn cf_string_array(items: &[&str]) -> CFRetained<CFType> {
        let strings: Vec<CFRetained<CFString>> = items.iter().map(|s| CFString::from_str(s)).collect();
        as_cf_type(CFArray::from_retained_objects(&strings))
    }

    fn serve_pac(body: String, hits: Arc<AtomicUsize>) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                }
                hits.fetch_add(1, Ordering::SeqCst);
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/x-ns-proxy-autoconfig\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(body.as_bytes());
            }
        });
        port
    }

    fn recording_server(requests: Arc<Mutex<Vec<String>>>) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new();
                if reader.read_line(&mut first).unwrap_or(0) == 0 {
                    continue;
                }
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                }
                requests.lock().push(first.trim_end().to_owned());
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
            }
        });
        port
    }

    async fn wait_for_script(slot: &Arc<ScriptSlot>) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while slot.script().is_none() {
            assert!(Instant::now() < deadline, "PAC script did not finish loading in time");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    #[tokio::test]
    async fn pac_file_urls_read_the_original_script() {
        let dir = tempfile::tempdir().unwrap();
        let script = "function FindProxyForURL(url, host) { return \"DIRECT\"; }";
        for name in ["proxy.pac", "proxy settings.pac", "代理.pac", "100%.pac"] {
            let path = dir.path().join(name);
            std::fs::write(&path, script).unwrap();
            let url = reqwest::Url::from_file_path(&path).unwrap();
            assert_eq!(fetch_script(url.as_str()).await.as_deref(), Some(script), "{url}");
        }
    }

    #[tokio::test]
    async fn pac_file_urls_accept_localhost() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("proxy settings.pac");
        let script = "function FindProxyForURL(url, host) { return \"DIRECT\"; }";
        std::fs::write(&path, script).unwrap();
        let url = reqwest::Url::from_file_path(&path).unwrap();
        let url = url.as_str().replacen("file:///", "file://localhost/", 1);
        assert_eq!(fetch_script(&url).await.as_deref(), Some(script));
    }

    #[test]
    fn ipv6_hosts_get_brackets() {
        assert_eq!(authority("::1", 3128), "[::1]:3128");
        assert_eq!(authority("[::1]", 3128), "[::1]:3128");
        assert_eq!(authority("proxy", 3128), "proxy:3128");
    }

    #[test]
    fn configured_pac_respects_enable_flag_and_tracks_changes() {
        let empty = settings_dict(Vec::new());
        assert_eq!(configured_pac(&empty), None);
        assert_eq!(pac_fingerprint(&empty), None);

        // macOS keeps the previous PAC URL in the dictionary when Auto Config is unchecked.
        let disabled = settings_with_pac_url("http://127.0.0.1:8080/proxy.pac", false);
        assert_eq!(configured_pac(&disabled), None);
        assert_eq!(pac_fingerprint(&disabled), None);

        let pac_a = settings_with_pac_url("http://127.0.0.1:8080/a.pac", true);
        let pac_b = settings_with_pac_url("http://127.0.0.1:8080/b.pac", true);
        let pac_a_exc = settings_dict(vec![
            (unsafe { cf::kCFNetworkProxiesProxyAutoConfigEnable }, as_cf_type(CFNumber::new_i32(1))),
            (
                unsafe { cf::kCFNetworkProxiesProxyAutoConfigURLString },
                as_cf_type(CFString::from_str("http://127.0.0.1:8080/a.pac")),
            ),
            (unsafe { cf::kCFNetworkProxiesExceptionsList }, cf_string_array(&["*.local"])),
        ]);
        assert_eq!(configured_pac(&pac_a).as_deref(), Some("http://127.0.0.1:8080/a.pac"));
        assert_ne!(pac_fingerprint(&pac_a), pac_fingerprint(&pac_b));
        // ExceptionsList is ignored by hyper-util on macOS and does not change PAC fingerprint.
        assert_eq!(pac_fingerprint(&pac_a), pac_fingerprint(&pac_a_exc));
    }

    #[test]
    fn runs_a_pac_script() {
        let pac = r#"function FindProxyForURL(url, host) {
            if (host == "github.com") return "PROXY 127.0.0.1:3128; DIRECT";
            // CFNetwork knows `SOCKS` but not `SOCKS5` (Safari neither).
            if (host == "socks.example") return "SOCKS 127.0.0.1:1080";
            return "DIRECT";
        }"#;
        assert_eq!(evaluate_sync(pac, "https://github.com/a/b").as_deref(), Some("http://127.0.0.1:3128"));
        assert_eq!(evaluate_sync(pac, "https://socks.example/").as_deref(), Some("socks5h://127.0.0.1:1080"));
        assert_eq!(evaluate_sync(pac, "https://elsewhere.example/"), None);
        assert_eq!(evaluate_sync("not valid javascript {{{", "https://github.com/"), None);

        // IPv6 proxy hosts from macOS proxy settings get brackets in the proxy URL.
        let ipv6_manual = settings_dict(vec![
            (unsafe { cf::kCFNetworkProxiesHTTPEnable }, as_cf_type(CFNumber::new_i32(1))),
            (unsafe { cf::kCFNetworkProxiesHTTPProxy }, as_cf_type(CFString::from_str("::1"))),
            (unsafe { cf::kCFNetworkProxiesHTTPPort }, as_cf_type(CFNumber::new_i32(8080))),
        ]);
        let matcher = manual_matcher(&ipv6_manual, "");
        let intercepted = matcher.intercept(&"http://example.com/".parse().unwrap()).unwrap();
        assert_eq!(intercepted.uri().to_string(), "http://[::1]:8080/");
    }

    #[tokio::test]
    async fn with_pac_from_wires_shared_slot_and_skips_when_disabled() {
        let proxy_reqs = Arc::new(Mutex::new(Vec::new()));
        let proxy_port = recording_server(Arc::clone(&proxy_reqs));
        let direct_reqs = Arc::new(Mutex::new(Vec::new()));
        let direct_port = recording_server(Arc::clone(&direct_reqs));
        let pac_hits = Arc::new(AtomicUsize::new(0));
        let pac_script = format!(
            r#"function FindProxyForURL(url, host) {{
                if (host == "wired.invalid") return "PROXY 127.0.0.1:{proxy_port}";
                return "DIRECT";
            }}"#
        );
        let pac_port = serve_pac(pac_script, Arc::clone(&pac_hits));
        let pac_url = format!("http://127.0.0.1:{pac_port}/shared.pac");

        // 1. Disabled PAC leaves the builder untouched and triggers no PAC fetch.
        let disabled = crate::client::build_with_builder(|b| {
            with_pac_from(b, false, || Some(settings_with_pac_url(&pac_url, false)), "", ScriptSlot::shared)
        })
        .unwrap();
        assert_eq!(
            disabled.get(format!("http://127.0.0.1:{direct_port}/disabled")).send().await.unwrap().status(),
            reqwest::StatusCode::OK
        );
        assert_eq!(pac_hits.load(Ordering::SeqCst), 0);

        // 2. Active *_PROXY env var also skips PAC.
        let env_override = crate::client::build_with_builder(|b| {
            with_pac_from(b, true, || Some(settings_with_pac_url(&pac_url, true)), "", ScriptSlot::shared)
        })
        .unwrap();
        assert_eq!(
            env_override.get(format!("http://127.0.0.1:{direct_port}/env")).send().await.unwrap().status(),
            reqwest::StatusCode::OK
        );
        assert_eq!(pac_hits.load(Ordering::SeqCst), 0);

        // 3. Enabled PAC wires the shared ScriptSlot; a second client reuses the loaded slot immediately.
        let client_a = crate::client::build_with_builder(|b| {
            with_pac_from(b, false, || Some(settings_with_pac_url(&pac_url, true)), "", ScriptSlot::shared)
        })
        .unwrap();
        let shared_slot = ScriptSlot::shared(pac_url.clone());
        wait_for_script(&shared_slot).await;
        assert_eq!(client_a.get("http://wired.invalid/one").send().await.unwrap().status(), reqwest::StatusCode::OK);

        let client_b = crate::client::build_with_builder(|b| {
            with_pac_from(b, false, || Some(settings_with_pac_url(&pac_url, true)), "", ScriptSlot::shared)
        })
        .unwrap();
        assert_eq!(client_b.get("http://wired.invalid/two").send().await.unwrap().status(), reqwest::StatusCode::OK);

        assert_eq!(
            proxy_reqs.lock().as_slice(),
            ["GET http://wired.invalid/one HTTP/1.1", "GET http://wired.invalid/two HTTP/1.1"]
        );
        assert_eq!(pac_hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn auto_mode_follows_pac_url_via_cfnetwork() {
        let proxy_requests = Arc::new(Mutex::new(Vec::new()));
        let proxy_port = recording_server(Arc::clone(&proxy_requests));
        let direct_requests = Arc::new(Mutex::new(Vec::new()));
        let direct_port = recording_server(Arc::clone(&direct_requests));
        let pac_script = format!(
            r#"function FindProxyForURL(url, host) {{
                if (host == "localhost") return "PROXY 127.0.0.1:{proxy_port}; DIRECT";
                return "DIRECT";
            }}"#
        );
        let pac_hits = Arc::new(AtomicUsize::new(0));
        let pac_port = serve_pac(pac_script, Arc::clone(&pac_hits));
        let pac_url = format!("http://127.0.0.1:{pac_port}/proxy.pac");

        let slot = ScriptSlot::new(pac_url.clone(), SCRIPT_TTL, RETRY_BACKOFF, EVAL_TIMEOUT);
        let client = crate::client::build_with_builder(|b| {
            with_pac_from(b, false, || Some(settings_with_pac_url(&pac_url, true)), "", |_| Arc::clone(&slot))
        })
        .unwrap();
        wait_for_script(&slot).await;

        let r1 = client.get(format!("http://localhost:{direct_port}/first")).send().await.unwrap();
        assert_eq!(r1.status(), reqwest::StatusCode::OK);
        let r2 = client.get(format!("http://localhost:{direct_port}/second")).send().await.unwrap();
        assert_eq!(r2.status(), reqwest::StatusCode::OK);
        let r3 = client.get(format!("http://127.0.0.1:{direct_port}/direct")).send().await.unwrap();
        assert_eq!(r3.status(), reqwest::StatusCode::OK);

        assert_eq!(
            proxy_requests.lock().as_slice(),
            [
                format!("GET http://localhost:{direct_port}/first HTTP/1.1"),
                format!("GET http://localhost:{direct_port}/second HTTP/1.1"),
            ]
        );
        assert_eq!(direct_requests.lock().as_slice(), ["GET /direct HTTP/1.1"]);
        // PAC script downloaded once across all three requests.
        assert_eq!(pac_hits.load(Ordering::SeqCst), 1);

        // Local file:// PAC URL with percent-encoded spaces works through the same path.
        let dir = tempfile::tempdir().unwrap();
        let file_pac = dir.path().join("proxy settings.pac");
        std::fs::write(
            &file_pac,
            format!(
                r#"function FindProxyForURL(url, host) {{
                    if (host == "file-pac.invalid") return "PROXY 127.0.0.1:{proxy_port}";
                    return "DIRECT";
                }}"#
            ),
        )
        .unwrap();
        let file_url = reqwest::Url::from_file_path(&file_pac).unwrap().to_string();
        let file_slot = ScriptSlot::new(file_url.clone(), SCRIPT_TTL, RETRY_BACKOFF, EVAL_TIMEOUT);
        let file_client = crate::client::build_with_builder(|b| {
            with_pac_from(b, false, || Some(settings_with_pac_url(&file_url, true)), "", |_| Arc::clone(&file_slot))
        })
        .unwrap();
        wait_for_script(&file_slot).await;

        let r4 = file_client.get("http://file-pac.invalid/local").send().await.unwrap();
        assert_eq!(r4.status(), reqwest::StatusCode::OK);
        assert_eq!(
            proxy_requests.lock().last().map(String::as_str),
            Some("GET http://file-pac.invalid/local HTTP/1.1")
        );
    }

    #[tokio::test]
    async fn fallback_matches_main_system_matcher() {
        let manual_http_reqs = Arc::new(Mutex::new(Vec::new()));
        let manual_http_port = recording_server(Arc::clone(&manual_http_reqs));
        let pac_proxy_reqs = Arc::new(Mutex::new(Vec::new()));
        let pac_proxy_port = recording_server(Arc::clone(&pac_proxy_reqs));
        let direct_reqs = Arc::new(Mutex::new(Vec::new()));
        let direct_port = recording_server(Arc::clone(&direct_reqs));
        let no_proxy = "noproxy.example, 127.0.0.1";

        // Main's `hyper_util::Matcher::from_system()` on macOS reads only manual HTTP/HTTPS + NO_PROXY
        // (NOT macOS ExceptionsList and NOT manual SOCKS).
        let main_matcher = Matcher::builder()
            .http(format!("127.0.0.1:{manual_http_port}"))
            .https("127.0.0.1:8443")
            .no(no_proxy)
            .build();
        let main_route = |u: &str| main_matcher.intercept(&u.parse().unwrap()).map(|i| i.uri().to_string());

        let make_settings = |pac_url: &str| {
            settings_dict(vec![
                (unsafe { cf::kCFNetworkProxiesProxyAutoConfigEnable }, as_cf_type(CFNumber::new_i32(1))),
                (unsafe { cf::kCFNetworkProxiesProxyAutoConfigURLString }, as_cf_type(CFString::from_str(pac_url))),
                (unsafe { cf::kCFNetworkProxiesHTTPEnable }, as_cf_type(CFNumber::new_i32(1))),
                (unsafe { cf::kCFNetworkProxiesHTTPProxy }, as_cf_type(CFString::from_str("127.0.0.1"))),
                (unsafe { cf::kCFNetworkProxiesHTTPPort }, as_cf_type(CFNumber::new_i32(i32::from(manual_http_port)))),
                (unsafe { cf::kCFNetworkProxiesHTTPSEnable }, as_cf_type(CFNumber::new_i32(1))),
                (unsafe { cf::kCFNetworkProxiesHTTPSProxy }, as_cf_type(CFString::from_str("127.0.0.1"))),
                (unsafe { cf::kCFNetworkProxiesHTTPSPort }, as_cf_type(CFNumber::new_i32(8443))),
                (unsafe { cf::kCFNetworkProxiesSOCKSEnable }, as_cf_type(CFNumber::new_i32(1))),
                (unsafe { cf::kCFNetworkProxiesSOCKSProxy }, as_cf_type(CFString::from_str("127.0.0.1"))),
                (unsafe { cf::kCFNetworkProxiesSOCKSPort }, as_cf_type(CFNumber::new_i32(1080))),
                (unsafe { cf::kCFNetworkProxiesExceptionsList }, cf_string_array(&["bypass.example", "*.local"])),
            ])
        };

        let sample_urls = [
            "http://other.example/",
            "https://other.example/",
            // Listed in macOS ExceptionsList: main's matcher ignores ExceptionsList, so fallback does too.
            "http://bypass.example/",
            "http://sub.local/",
            // Listed in env NO_PROXY: bypassed in both main and fallback.
            "http://noproxy.example/",
        ];

        // 1. Before PAC script is ready (closed port), routing matches main's Matcher exactly.
        let closed_port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let closed_url = format!("http://127.0.0.1:{closed_port}/proxy.pac");
        let pending_settings = make_settings(&closed_url);
        let pending_resolver = PacResolver::new(
            ScriptSlot::new(closed_url, SCRIPT_TTL, RETRY_BACKOFF, EVAL_TIMEOUT),
            manual_matcher(&pending_settings, no_proxy),
            no_proxy,
        );
        for url in sample_urls {
            assert_eq!(pending_resolver.resolve(&reqwest::Url::parse(url).unwrap()), main_route(url), "pending {url}");
        }

        // Manual SOCKS alone (no HTTP/HTTPS) matches main: None.
        let socks_only = settings_dict(vec![
            (unsafe { cf::kCFNetworkProxiesSOCKSEnable }, as_cf_type(CFNumber::new_i32(1))),
            (unsafe { cf::kCFNetworkProxiesSOCKSProxy }, as_cf_type(CFString::from_str("127.0.0.1"))),
            (unsafe { cf::kCFNetworkProxiesSOCKSPort }, as_cf_type(CFNumber::new_i32(1080))),
        ]);
        assert!(manual_matcher(&socks_only, "").intercept(&"https://other.example/".parse().unwrap()).is_none());

        // 2. Once PAC is loaded: PAC proxy wins for matched hosts (unless NO_PROXY);
        //    when PAC returns DIRECT, fallback matches main's Matcher exactly.
        let pac_script = format!(
            r#"function FindProxyForURL(url, host) {{
                if (host == "pac.invalid" || host == "noproxy.example") {{
                    return "PROXY 127.0.0.1:{pac_proxy_port}";
                }}
                return "DIRECT";
            }}"#
        );
        let pac_port = serve_pac(pac_script, Arc::new(AtomicUsize::new(0)));
        let pac_url = format!("http://127.0.0.1:{pac_port}/proxy.pac");
        let slot = ScriptSlot::new(pac_url.clone(), SCRIPT_TTL, RETRY_BACKOFF, EVAL_TIMEOUT);
        let loaded_settings = make_settings(&pac_url);
        let resolver = PacResolver::new(Arc::clone(&slot), manual_matcher(&loaded_settings, no_proxy), no_proxy);
        wait_for_script(&slot).await;

        for url in sample_urls {
            assert_eq!(resolver.resolve(&reqwest::Url::parse(url).unwrap()), main_route(url), "DIRECT {url}");
        }

        let client = crate::client::build_with_builder(|b| {
            with_pac_from(b, false, || Some(make_settings(&pac_url)), no_proxy, |_| Arc::clone(&slot))
        })
        .unwrap();
        assert_eq!(client.get("http://pac.invalid/a").send().await.unwrap().status(), reqwest::StatusCode::OK);
        assert_eq!(client.get("http://fallback.invalid/b").send().await.unwrap().status(), reqwest::StatusCode::OK);
        assert_eq!(
            client.get(format!("http://127.0.0.1:{direct_port}/c")).send().await.unwrap().status(),
            reqwest::StatusCode::OK
        );

        assert_eq!(pac_proxy_reqs.lock().as_slice(), ["GET http://pac.invalid/a HTTP/1.1"]);
        assert_eq!(manual_http_reqs.lock().as_slice(), ["GET http://fallback.invalid/b HTTP/1.1"]);
        assert_eq!(direct_reqs.lock().as_slice(), ["GET /c HTTP/1.1"]);
    }

    #[tokio::test]
    async fn pac_refetches_after_ttl_without_blocking_and_falls_back_on_failure() {
        enum Mode {
            Proxy(u16),
            SlowDirect(Duration),
            Error503,
        }
        let proxy_reqs = Arc::new(Mutex::new(Vec::new()));
        let proxy_port = recording_server(Arc::clone(&proxy_reqs));
        let direct_reqs = Arc::new(Mutex::new(Vec::new()));
        let direct_port = recording_server(Arc::clone(&direct_reqs));

        let mode = Arc::new(Mutex::new(Mode::Proxy(proxy_port)));
        let hits = Arc::new(AtomicUsize::new(0));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let pac_port = listener.local_addr().unwrap().port();
        let mode_srv = Arc::clone(&mode);
        let hits_srv = Arc::clone(&hits);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                }
                let action = match &*mode_srv.lock() {
                    Mode::Proxy(p) => Ok((
                        Duration::ZERO,
                        format!(r#"function FindProxyForURL(u,h){{return "PROXY 127.0.0.1:{p}";}}"#),
                    )),
                    Mode::SlowDirect(d) => Ok((*d, r#"function FindProxyForURL(u,h){return "DIRECT";}"#.to_owned())),
                    Mode::Error503 => Err(()),
                };
                match action {
                    Ok((delay, body)) => {
                        if !delay.is_zero() {
                            std::thread::sleep(delay);
                        }
                        hits_srv.fetch_add(1, Ordering::SeqCst);
                        let head =
                            format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                        let _ = stream.write_all(head.as_bytes());
                        let _ = stream.write_all(body.as_bytes());
                    }
                    Err(()) => {
                        hits_srv.fetch_add(1, Ordering::SeqCst);
                        let _ = stream.write_all(
                            b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        );
                    }
                }
            }
        });

        let pac_url = format!("http://127.0.0.1:{pac_port}/proxy.pac");
        let ttl = Duration::from_millis(60);
        let slot = ScriptSlot::new(pac_url.clone(), ttl, Duration::from_secs(30), EVAL_TIMEOUT);
        let client = crate::client::build_with_builder(|b| {
            with_pac_from(b, false, || Some(settings_with_pac_url(&pac_url, true)), "", |_| Arc::clone(&slot))
        })
        .unwrap();
        wait_for_script(&slot).await;

        // 1. Initially routes via proxy.
        let target = format!("http://localhost:{direct_port}");
        assert_eq!(client.get(format!("{target}/initial")).send().await.unwrap().status(), reqwest::StatusCode::OK);
        assert_eq!(proxy_reqs.lock().len(), 1);
        assert_eq!(direct_reqs.lock().len(), 0);

        // 2. PAC changes to DIRECT with a 200 ms server delay; wait past TTL.
        *mode.lock() = Mode::SlowDirect(Duration::from_millis(200));
        tokio::time::sleep(ttl + Duration::from_millis(20)).await;

        // Request during refetch must NOT wait for the 200 ms refetch and keeps using the current script.
        let t0 = Instant::now();
        assert_eq!(
            client.get(format!("{target}/during-refetch")).send().await.unwrap().status(),
            reqwest::StatusCode::OK
        );
        let during_refetch = t0.elapsed();
        eprintln!("PAC refetch: request during 200ms background refetch took {during_refetch:?}");
        assert!(during_refetch < Duration::from_millis(120), "request waited for refetch: {during_refetch:?}");
        assert_eq!(proxy_reqs.lock().len(), 2);

        // Wait for background refetch to finish and switch routing to DIRECT without a restart.
        let deadline = Instant::now() + Duration::from_secs(3);
        while hits.load(Ordering::SeqCst) < 2 || slot.evaluate("http://localhost/").is_some() {
            assert!(Instant::now() < deadline, "refetched DIRECT script did not take effect");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(client.get(format!("{target}/after-ttl")).send().await.unwrap().status(), reqwest::StatusCode::OK);
        assert_eq!(proxy_reqs.lock().len(), 2);
        assert_eq!(direct_reqs.lock().as_slice(), ["GET /after-ttl HTTP/1.1"]);

        // 3. Switch back to Proxy, wait TTL to pick it up, then simulate network loss (503).
        *mode.lock() = Mode::Proxy(proxy_port);
        tokio::time::sleep(ttl + Duration::from_millis(20)).await;
        let _ = slot.script();
        let deadline = Instant::now() + Duration::from_secs(3);
        while slot.evaluate("http://localhost/").is_none() {
            assert!(Instant::now() < deadline, "proxy script did not reload");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        *mode.lock() = Mode::Error503;
        tokio::time::sleep(ttl + Duration::from_millis(20)).await;
        let _ = slot.script();
        let deadline = Instant::now() + Duration::from_secs(3);
        while slot.script().is_some() {
            assert!(Instant::now() < deadline, "failed refetch did not transition to Failed");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        // Failed state routes as main does (direct when no manual proxy is set).
        assert_eq!(client.get(format!("{target}/after-503")).send().await.unwrap().status(), reqwest::StatusCode::OK);
        assert_eq!(direct_reqs.lock().as_slice(), ["GET /after-ttl HTTP/1.1", "GET /after-503 HTTP/1.1"]);
    }

    #[tokio::test]
    async fn looping_pac_script_times_out_and_falls_back_to_main() {
        let direct_reqs = Arc::new(Mutex::new(Vec::new()));
        let direct_port = recording_server(Arc::clone(&direct_reqs));
        let pac_port =
            serve_pac("function FindProxyForURL(url, host) { while (true) {} }".into(), Arc::new(AtomicUsize::new(0)));
        let pac_url = format!("http://127.0.0.1:{pac_port}/loop.pac");
        let eval_timeout = Duration::from_millis(80);
        let slot = ScriptSlot::new(pac_url.clone(), SCRIPT_TTL, RETRY_BACKOFF, eval_timeout);
        let client = crate::client::build_with_builder(|b| {
            with_pac_from(b, false, || Some(settings_with_pac_url(&pac_url, true)), "", |_| Arc::clone(&slot))
        })
        .unwrap();
        wait_for_script(&slot).await;

        let target = format!("http://127.0.0.1:{direct_port}/loop");
        let t0 = Instant::now();
        assert_eq!(client.get(&target).send().await.unwrap().status(), reqwest::StatusCode::OK);
        let first = t0.elapsed();

        // After timing out once, the script is marked Failed so subsequent requests fall back immediately.
        let t1 = Instant::now();
        assert_eq!(client.get(&target).send().await.unwrap().status(), reqwest::StatusCode::OK);
        let second = t1.elapsed();

        eprintln!("Looping PAC: first={first:?} (timeout={eval_timeout:?}), second={second:?}");
        assert!(first < Duration::from_millis(500), "looping PAC hung: {first:?}");
        assert!(second < Duration::from_millis(50), "second request waited again: {second:?}");
        assert_eq!(direct_reqs.lock().len(), 2);
    }

    #[tokio::test]
    async fn loaded_pac_path_overhead_vs_no_pac() {
        let direct_reqs = Arc::new(Mutex::new(Vec::new()));
        let direct_port = recording_server(Arc::clone(&direct_reqs));
        let pac_script = r#"function FindProxyForURL(url, host) {
            if (host == "corp.invalid") return "PROXY 127.0.0.1:8080";
            return "DIRECT";
        }"#;
        let pac_port = serve_pac(pac_script.into(), Arc::new(AtomicUsize::new(0)));
        let pac_url = format!("http://127.0.0.1:{pac_port}/fast.pac");
        let slot = ScriptSlot::new(pac_url.clone(), SCRIPT_TTL, RETRY_BACKOFF, EVAL_TIMEOUT);
        wait_for_script(&slot).await;

        let baseline = crate::client::build(&ProxySettings { mode: ProxyMode::None, ..Default::default() }).unwrap();
        let pac_client = crate::client::build_with_builder(|b| {
            with_pac_from(b, false, || Some(settings_with_pac_url(&pac_url, true)), "", |_| Arc::clone(&slot))
        })
        .unwrap();

        let target = format!("http://127.0.0.1:{direct_port}/bench");
        // Warm up both clients and the evaluator worker thread.
        for _ in 0..3 {
            assert_eq!(baseline.get(&target).send().await.unwrap().status(), reqwest::StatusCode::OK);
            assert_eq!(pac_client.get(&target).send().await.unwrap().status(), reqwest::StatusCode::OK);
        }

        const N: u32 = 30;
        let t0 = Instant::now();
        for _ in 0..N {
            assert_eq!(baseline.get(&target).send().await.unwrap().status(), reqwest::StatusCode::OK);
        }
        let no_pac_per_req = t0.elapsed() / N;

        let t1 = Instant::now();
        for _ in 0..N {
            assert_eq!(pac_client.get(&target).send().await.unwrap().status(), reqwest::StatusCode::OK);
        }
        let with_pac_per_req = t1.elapsed() / N;

        let resolver = PacResolver::new(Arc::clone(&slot), Matcher::builder().build(), "");
        let sample = reqwest::Url::parse(&target).unwrap();
        let t2 = Instant::now();
        for _ in 0..100 {
            assert_eq!(resolver.resolve(&sample), None);
        }
        let resolve_per_call = t2.elapsed() / 100;

        let delta = with_pac_per_req.saturating_sub(no_pac_per_req);
        eprintln!(
            "Loaded PAC timing ({N} reqs): no_pac={no_pac_per_req:?}/req, \
             with_pac={with_pac_per_req:?}/req, delta={delta:?}/req, resolve={resolve_per_call:?}/call"
        );
        assert!(resolve_per_call < Duration::from_millis(5), "PAC resolve too slow: {resolve_per_call:?}");
    }

    #[tokio::test]
    async fn unreachable_or_stalled_pac_does_not_delay_build_or_requests() {
        let direct_reqs = Arc::new(Mutex::new(Vec::new()));
        let direct_port = recording_server(Arc::clone(&direct_reqs));
        let target = format!("http://127.0.0.1:{direct_port}/ping");

        // Baseline: no PAC (main behaviour).
        let t0 = Instant::now();
        let baseline = crate::client::build(&ProxySettings { mode: ProxyMode::None, ..Default::default() }).unwrap();
        let baseline_build = t0.elapsed();
        let t1 = Instant::now();
        assert_eq!(baseline.get(&target).send().await.unwrap().status(), reqwest::StatusCode::OK);
        let baseline_req = t1.elapsed();

        // Case 1: closed port PAC URL (immediate connection refused).
        let closed_port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let closed_url = format!("http://127.0.0.1:{closed_port}/proxy.pac");
        let t2 = Instant::now();
        let closed_client = crate::client::build_with_builder(|b| {
            with_pac_from(
                b,
                false,
                || Some(settings_with_pac_url(&closed_url, true)),
                "",
                |u| ScriptSlot::new(u, SCRIPT_TTL, RETRY_BACKOFF, EVAL_TIMEOUT),
            )
        })
        .unwrap();
        let closed_build = t2.elapsed();
        let t3 = Instant::now();
        assert_eq!(closed_client.get(&target).send().await.unwrap().status(), reqwest::StatusCode::OK);
        let closed_req = t3.elapsed();

        // Case 2: stalled PAC server (accepts TCP and never responds).
        let stalled = TcpListener::bind("127.0.0.1:0").unwrap();
        let stalled_port = stalled.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((_s, _)) = stalled.accept() {
                std::thread::sleep(Duration::from_secs(10));
            }
        });
        let stalled_url = format!("http://127.0.0.1:{stalled_port}/proxy.pac");
        let t4 = Instant::now();
        let stalled_client = crate::client::build_with_builder(|b| {
            with_pac_from(
                b,
                false,
                || Some(settings_with_pac_url(&stalled_url, true)),
                "",
                |u| ScriptSlot::new(u, SCRIPT_TTL, RETRY_BACKOFF, EVAL_TIMEOUT),
            )
        })
        .unwrap();
        let stalled_build = t4.elapsed();
        let t5 = Instant::now();
        assert_eq!(stalled_client.get(&target).send().await.unwrap().status(), reqwest::StatusCode::OK);
        let stalled_req = t5.elapsed();

        eprintln!(
            "PAC latency: baseline build={baseline_build:?} req={baseline_req:?}; \
             closed build={closed_build:?} req={closed_req:?}; \
             stalled build={stalled_build:?} req={stalled_req:?}"
        );
        assert!(closed_build < Duration::from_millis(500), "closed PAC build blocked: {closed_build:?}");
        assert!(stalled_build < Duration::from_millis(500), "stalled PAC build blocked: {stalled_build:?}");
        assert!(closed_req < Duration::from_millis(500), "closed PAC request blocked: {closed_req:?}");
        assert!(stalled_req < Duration::from_millis(500), "stalled PAC request blocked: {stalled_req:?}");
        assert_eq!(direct_reqs.lock().len(), 3);
    }

    #[tokio::test]
    async fn failed_pac_fetch_retries_after_backoff() {
        let ready = Arc::new(AtomicBool::new(false));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let ready_srv = Arc::clone(&ready);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                }
                if ready_srv.load(Ordering::SeqCst) {
                    let body = r#"function FindProxyForURL(u,h){return "PROXY 127.0.0.1:3128";}"#;
                    let head =
                        format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                    let _ = stream.write_all(head.as_bytes());
                    let _ = stream.write_all(body.as_bytes());
                } else {
                    let _ = stream.write_all(
                        b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    );
                }
            }
        });

        let pac_url = format!("http://127.0.0.1:{port}/proxy.pac");
        let slot = ScriptSlot::new(pac_url, SCRIPT_TTL, Duration::from_millis(40), EVAL_TIMEOUT);
        let resolver = PacResolver::new(Arc::clone(&slot), Matcher::builder().build(), "");
        // Wait for the initial 503 fetch to complete.
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert_eq!(resolver.resolve(&reqwest::Url::parse("http://example.com/").unwrap()), None);

        // Server recovers; after backoff elapses, a lookup triggers retry and picks up the script.
        ready.store(true, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(50)).await;
        let _ = resolver.resolve(&reqwest::Url::parse("http://example.com/").unwrap());
        wait_for_script(&slot).await;
        assert_eq!(
            resolver.resolve(&reqwest::Url::parse("http://example.com/").unwrap()).as_deref(),
            Some("http://127.0.0.1:3128")
        );
    }
}
