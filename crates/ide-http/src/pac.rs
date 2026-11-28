//! macOS PAC (Automatic Proxy Configuration) support for `ProxyMode::Auto`.
//!
//! reqwest's built-in system proxy ignores macOS PAC scripts. When a PAC is
//! enabled and no `*_PROXY` env var overrides it, we fetch the script in the
//! background and evaluate it per origin via CFNetwork without blocking requests.

use hyper_util::client::proxy::matcher::Matcher;
use ide_core::proxy_settings::{ProxyMode, ProxyRoute, ProxySettings};
use objc2_cf_network as cf;
use objc2_core_foundation::{CFArray, CFDictionary, CFNumber, CFRetained, CFString, CFType, CFURL};
use parking_lot::Mutex;
use std::collections::{HashMap, hash_map::DefaultHasher};
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use std::time::{Duration, Instant};

const PROXY_ENV: [&str; 6] = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
const PAC_FETCH_TIMEOUT: Duration = Duration::from_secs(5);
const RETRY_BACKOFF: Duration = Duration::from_secs(30);
const MAX_CACHED_ROUTES: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum PacSource {
    Url(String),
    Script(String),
}

type SettingsFn = Box<dyn Fn() -> Option<CFRetained<CFDictionary>> + Send + Sync>;
type OriginKey = (String, String, Option<u16>);

fn env_proxy_set() -> bool {
    PROXY_ENV.iter().any(|k| std::env::var_os(k).is_some_and(|v| !v.is_empty()))
}

fn system_settings() -> Option<CFRetained<CFDictionary>> {
    // SAFETY: plain CFNetwork call returning an owned CFDictionary or NULL.
    unsafe { cf::CFNetworkCopySystemProxySettings() }
}

/// Attaches a PAC-aware custom proxy only when macOS has a PAC enabled and no
/// `*_PROXY` env var overrides it; leaves `builder` untouched otherwise.
pub(crate) fn with_system_pac(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    let Some(source) = (!env_proxy_set()).then(system_settings).flatten().and_then(|s| configured_pac(&s)) else {
        return builder;
    };
    let no_proxy = std::env::var("NO_PROXY").or_else(|_| std::env::var("no_proxy")).unwrap_or_default();
    let resolver = PacResolver::new(Box::new(system_settings), ScriptSlot::shared(source), &no_proxy);
    builder.proxy(reqwest::Proxy::custom(move |url| resolver.resolve(url)))
}

/// Fingerprint of the active macOS PAC configuration and bypass list, or `None`.
pub(crate) fn system_pac_fingerprint() -> Option<String> {
    (!env_proxy_set()).then(system_settings).flatten().and_then(|s| pac_fingerprint(&s))
}

enum Load {
    Ready(String),
    Pending,
    Failed(Instant),
}

struct ScriptSlot {
    url: String,
    backoff: Duration,
    load: Mutex<Load>,
}

impl ScriptSlot {
    fn shared(source: PacSource) -> Arc<Self> {
        let PacSource::Url(url) = source else { return Self::new(source, RETRY_BACKOFF) };
        // Share the active PAC across `shared()`, `shared_without_redirects()`, and `check_connection()`.
        static ACTIVE: Mutex<Option<(String, Arc<ScriptSlot>)>> = Mutex::new(None);
        let mut active = ACTIVE.lock();
        if let Some((cached, slot)) = active.as_ref()
            && *cached == url
        {
            return Arc::clone(slot);
        }
        let slot = Self::new(PacSource::Url(url.clone()), RETRY_BACKOFF);
        *active = Some((url, Arc::clone(&slot)));
        slot
    }

    fn new(source: PacSource, backoff: Duration) -> Arc<Self> {
        let (url, load) = match source {
            PacSource::Script(js) => (String::new(), Load::Ready(js)),
            PacSource::Url(url) => (url, Load::Pending),
        };
        let slot = Arc::new(Self { url, backoff, load: Mutex::new(load) });
        if !slot.url.is_empty() {
            slot.spawn_fetch();
        }
        slot
    }

    fn script(self: &Arc<Self>) -> Option<String> {
        let mut load = self.load.lock();
        match &*load {
            Load::Ready(js) => Some(js.clone()),
            Load::Failed(at) if at.elapsed() >= self.backoff => {
                *load = Load::Pending;
                drop(load);
                self.spawn_fetch();
                None
            }
            Load::Pending | Load::Failed(_) => None,
        }
    }

    fn spawn_fetch(self: &Arc<Self>) {
        let slot = Arc::clone(self);
        let fut = async move {
            *slot.load.lock() = fetch_script(&slot.url).await.map_or_else(|| Load::Failed(Instant::now()), Load::Ready);
        };
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(fut);
        } else {
            // Sync callers outside a Tokio runtime still fetch without blocking `build()`.
            std::thread::spawn(move || {
                let _ = tokio::runtime::Builder::new_current_thread().enable_all().build().map(|rt| rt.block_on(fut));
            });
        }
    }
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
    settings: SettingsFn,
    slot: Arc<ScriptSlot>,
    no_proxy: Option<Matcher>,
    routes: Mutex<HashMap<OriginKey, Option<String>>>,
}

impl PacResolver {
    fn new(settings: SettingsFn, slot: Arc<ScriptSlot>, no_proxy: &str) -> Self {
        let list = no_proxy.trim();
        let no_proxy = (!list.is_empty()).then(|| Matcher::builder().all("http://proxy.invalid").no(list).build());
        Self { settings, slot, no_proxy, routes: Mutex::new(HashMap::new()) }
    }

    fn resolve(&self, url: &reqwest::Url) -> Option<String> {
        if self.no_proxy.as_ref().is_some_and(|m| url.as_str().parse().ok().is_some_and(|u| m.intercept(&u).is_none()))
        {
            return None;
        }
        let host = url.host_str()?;
        let origin = url
            .port()
            .map_or_else(|| format!("{}://{host}/", url.scheme()), |p| format!("{}://{host}:{p}/", url.scheme()));
        let Some(script) = self.slot.script() else {
            return (self.settings)().and_then(|s| lookup_in_settings(&origin, &s).1);
        };
        let key = (url.scheme().to_owned(), host.to_ascii_lowercase(), url.port_or_known_default());
        if let Some(cached) = self.routes.lock().get(&key) {
            return cached.clone();
        }
        let route = (self.settings)().and_then(|s| {
            let (has_pac, manual) = lookup_in_settings(&origin, &s);
            has_pac.then(|| evaluate(&script, &origin)).flatten().or(manual)
        });
        let mut routes = self.routes.lock();
        if routes.len() >= MAX_CACHED_ROUTES && !routes.contains_key(&key) {
            routes.clear();
        }
        routes.insert(key, route.clone());
        route
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

fn configured_pac(settings: &CFDictionary) -> Option<PacSource> {
    // SAFETY: CFNetworkCopySystemProxySettings returns a CFDictionary keyed by CFString.
    unsafe {
        let dict: &CFDictionary<CFString, CFType> = settings.cast_unchecked();
        let enabled = dict
            .get(cf::kCFNetworkProxiesProxyAutoConfigEnable)
            .and_then(|v| v.downcast_ref::<CFNumber>()?.as_i64())
            .is_some_and(|n| n != 0);
        let val = |k| cf_str(dict, k).map(|s| s.to_string().trim().to_owned()).filter(|s| !s.is_empty());
        enabled.then(|| {
            val(cf::kCFNetworkProxiesProxyAutoConfigURLString)
                .map(PacSource::Url)
                .or_else(|| val(cf::kCFNetworkProxiesProxyAutoConfigJavaScript).map(PacSource::Script))
        })?
    }
}

fn exceptions(settings: &CFDictionary) -> Vec<String> {
    // SAFETY: CFNetworkCopySystemProxySettings returns a CFDictionary keyed by CFString; ExceptionsList holds CFStrings.
    unsafe {
        let dict: &CFDictionary<CFString, CFType> = settings.cast_unchecked();
        let Some(list) = dict.get(cf::kCFNetworkProxiesExceptionsList).and_then(|v| v.downcast::<CFArray>().ok())
        else {
            return Vec::new();
        };
        let list: &CFArray<CFType> = list.cast_unchecked();
        list.iter().filter_map(|e| e.downcast::<CFString>().ok()).map(|s| s.to_string()).collect()
    }
}

fn pac_fingerprint(settings: &CFDictionary) -> Option<String> {
    let mut hasher = DefaultHasher::new();
    configured_pac(settings)?.hash(&mut hasher);
    exceptions(settings).hash(&mut hasher);
    Some(format!("pac:{:016x}", hasher.finish()))
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
        let port = u16::try_from(entry.get(cf::kCFProxyPortNumberKey)?.downcast_ref::<CFNumber>()?.as_i64()?).ok()?;
        Some(ProxyRoute::Via(format!("{scheme}://{}", authority(&host, port))))
    }
}

/// Returns `(has_pac, manual_fallback)` for `url` under `settings`.
/// `CFNetworkCopyProxiesForURL` enforces macOS `ExceptionsList` (replacing manual
/// entries with `kCFProxyTypeNone` for bypassed hosts) alongside any PAC entry.
fn lookup_in_settings(url: &str, settings: &CFDictionary) -> (bool, Option<String>) {
    let Some(target) = CFURL::from_string(None, &CFString::from_str(url), None) else { return (false, None) };
    // SAFETY: plain CFNetwork call on owned, valid CF objects.
    unsafe {
        let (mut has_pac, mut manual) = (false, None);
        for entry in entries(&cf::CFNetworkCopyProxiesForURL(&target, settings)) {
            if cf_str(&entry, cf::kCFProxyTypeKey).is_some_and(|k| {
                &*k == cf::kCFProxyTypeAutoConfigurationURL || &*k == cf::kCFProxyTypeAutoConfigurationJavaScript
            }) {
                has_pac = true;
            } else if manual.is_none()
                && let Some(ProxyRoute::Via(via)) = parse_proxy_entry(&entry)
            {
                manual = Some(via);
            }
        }
        (has_pac, manual)
    }
}

fn evaluate(script: &str, url: &str) -> Option<String> {
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

    fn with_resolver(builder: reqwest::ClientBuilder, resolver: PacResolver) -> reqwest::ClientBuilder {
        builder.proxy(reqwest::Proxy::custom(move |url| resolver.resolve(url)))
    }

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
        assert_eq!(configured_pac(&pac_a), Some(PacSource::Url("http://127.0.0.1:8080/a.pac".into())));
        assert_ne!(pac_fingerprint(&pac_a), pac_fingerprint(&pac_b));
        assert_ne!(pac_fingerprint(&pac_a), pac_fingerprint(&pac_a_exc));
    }

    #[test]
    fn runs_a_pac_script() {
        let pac = r#"function FindProxyForURL(url, host) {
            if (host == "github.com") return "PROXY 127.0.0.1:3128; DIRECT";
            // CFNetwork knows `SOCKS` but not `SOCKS5` (Safari neither).
            if (host == "socks.example") return "SOCKS 127.0.0.1:1080";
            return "DIRECT";
        }"#;
        assert_eq!(evaluate(pac, "https://github.com/a/b").as_deref(), Some("http://127.0.0.1:3128"));
        assert_eq!(evaluate(pac, "https://socks.example/").as_deref(), Some("socks5h://127.0.0.1:1080"));
        assert_eq!(evaluate(pac, "https://elsewhere.example/"), None);
        assert_eq!(evaluate("not valid javascript {{{", "https://github.com/"), None);

        // IPv6 proxy hosts from macOS proxy settings get brackets in the proxy URL.
        let ipv6_manual = settings_dict(vec![
            (unsafe { cf::kCFNetworkProxiesHTTPEnable }, as_cf_type(CFNumber::new_i32(1))),
            (unsafe { cf::kCFNetworkProxiesHTTPProxy }, as_cf_type(CFString::from_str("::1"))),
            (unsafe { cf::kCFNetworkProxiesHTTPPort }, as_cf_type(CFNumber::new_i32(8080))),
        ]);
        assert_eq!(lookup_in_settings("http://example.com/", &ipv6_manual), (false, Some("http://[::1]:8080".into())));
    }

    #[tokio::test]
    async fn auto_mode_without_pac_installs_no_custom_proxy() {
        let settings = settings_with_pac_url("http://127.0.0.1:8080/proxy.pac", false);
        assert_eq!(configured_pac(&settings), None);

        let direct_requests = Arc::new(Mutex::new(Vec::new()));
        let direct_port = recording_server(Arc::clone(&direct_requests));
        let client = crate::client::build_with_builder(|builder| {
            // Same zero-cost path as `with_system_pac`: no PAC -> builder untouched.
            if configured_pac(&settings).is_none() { builder } else { unreachable!() }
        })
        .unwrap();
        let resp = client.get(format!("http://127.0.0.1:{direct_port}/no-pac")).send().await.unwrap();
        assert_eq!(resp.status(), reqwest::StatusCode::OK);
        assert_eq!(direct_requests.lock().as_slice(), ["GET /no-pac HTTP/1.1"]);
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

        let slot = ScriptSlot::new(PacSource::Url(pac_url.clone()), RETRY_BACKOFF);
        let injected = pac_url.clone();
        let resolver =
            PacResolver::new(Box::new(move || Some(settings_with_pac_url(&injected, true))), Arc::clone(&slot), "");
        let client = crate::client::build_with_builder(|b| with_resolver(b, resolver)).unwrap();
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
        let file_slot = ScriptSlot::new(PacSource::Url(file_url.clone()), RETRY_BACKOFF);
        let injected_file = file_url.clone();
        let file_resolver = PacResolver::new(
            Box::new(move || Some(settings_with_pac_url(&injected_file, true))),
            Arc::clone(&file_slot),
            "",
        );
        let file_client = crate::client::build_with_builder(|b| with_resolver(b, file_resolver)).unwrap();
        wait_for_script(&file_slot).await;

        let r4 = file_client.get("http://file-pac.invalid/local").send().await.unwrap();
        assert_eq!(r4.status(), reqwest::StatusCode::OK);
        assert_eq!(
            proxy_requests.lock().last().map(String::as_str),
            Some("GET http://file-pac.invalid/local HTTP/1.1")
        );
    }

    #[tokio::test]
    async fn parity_honours_manual_proxies_exceptions_list_and_no_proxy() {
        let manual_http_reqs = Arc::new(Mutex::new(Vec::new()));
        let manual_http_port = recording_server(Arc::clone(&manual_http_reqs));
        let pac_proxy_reqs = Arc::new(Mutex::new(Vec::new()));
        let pac_proxy_port = recording_server(Arc::clone(&pac_proxy_reqs));
        let direct_reqs = Arc::new(Mutex::new(Vec::new()));
        let direct_port = recording_server(Arc::clone(&direct_reqs));

        // Coexisting PAC + manual HTTP/HTTPS/SOCKS + ExceptionsList.
        let make_settings = move |pac_url: String| {
            settings_dict(vec![
                (unsafe { cf::kCFNetworkProxiesProxyAutoConfigEnable }, as_cf_type(CFNumber::new_i32(1))),
                (unsafe { cf::kCFNetworkProxiesProxyAutoConfigURLString }, as_cf_type(CFString::from_str(&pac_url))),
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

        // 1. Before PAC script is ready (closed port), requests fall back to manual proxies
        //    while still honouring ExceptionsList and NO_PROXY.
        let closed_port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let closed_url = format!("http://127.0.0.1:{closed_port}/proxy.pac");
        let u = closed_url.clone();
        let pending_resolver = PacResolver::new(
            Box::new(move || Some(make_settings(u.clone()))),
            ScriptSlot::new(PacSource::Url(closed_url), RETRY_BACKOFF),
            "noproxy.example, 127.0.0.1",
        );
        assert_eq!(
            pending_resolver.resolve(&reqwest::Url::parse("http://other.example/").unwrap()).as_deref(),
            Some(format!("http://127.0.0.1:{manual_http_port}").as_str())
        );
        assert_eq!(
            pending_resolver.resolve(&reqwest::Url::parse("https://other.example/").unwrap()).as_deref(),
            Some("http://127.0.0.1:8443")
        );
        assert_eq!(pending_resolver.resolve(&reqwest::Url::parse("http://bypass.example/").unwrap()), None);
        assert_eq!(pending_resolver.resolve(&reqwest::Url::parse("http://sub.local/").unwrap()), None);
        assert_eq!(pending_resolver.resolve(&reqwest::Url::parse("http://noproxy.example/").unwrap()), None);

        // Manual SOCKS proxy alone alongside PAC.
        let socks_settings = settings_dict(vec![
            (unsafe { cf::kCFNetworkProxiesProxyAutoConfigEnable }, as_cf_type(CFNumber::new_i32(1))),
            (
                unsafe { cf::kCFNetworkProxiesProxyAutoConfigURLString },
                as_cf_type(CFString::from_str("http://127.0.0.1:9/proxy.pac")),
            ),
            (unsafe { cf::kCFNetworkProxiesSOCKSEnable }, as_cf_type(CFNumber::new_i32(1))),
            (unsafe { cf::kCFNetworkProxiesSOCKSProxy }, as_cf_type(CFString::from_str("127.0.0.1"))),
            (unsafe { cf::kCFNetworkProxiesSOCKSPort }, as_cf_type(CFNumber::new_i32(1080))),
        ]);
        assert_eq!(
            lookup_in_settings("https://other.example/", &socks_settings),
            (true, Some("socks5h://127.0.0.1:1080".into()))
        );

        // 2. Once PAC is loaded: PAC proxy wins for matched hosts; when PAC returns DIRECT,
        //    manual proxy still applies except for ExceptionsList hosts; NO_PROXY bypasses all.
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
        let slot = ScriptSlot::new(PacSource::Url(pac_url.clone()), RETRY_BACKOFF);
        let u = pac_url.clone();
        let resolver = PacResolver::new(
            Box::new(move || Some(make_settings(u.clone()))),
            Arc::clone(&slot),
            "noproxy.example, 127.0.0.1",
        );
        wait_for_script(&slot).await;

        assert_eq!(resolver.resolve(&reqwest::Url::parse("http://bypass.example/").unwrap()), None);
        assert_eq!(resolver.resolve(&reqwest::Url::parse("http://sub.local/").unwrap()), None);
        assert_eq!(resolver.resolve(&reqwest::Url::parse("http://noproxy.example/").unwrap()), None);

        let client = crate::client::build_with_builder(|b| with_resolver(b, resolver)).unwrap();
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
        let u = closed_url.clone();
        let closed_client = crate::client::build_with_builder(|b| {
            with_resolver(
                b,
                PacResolver::new(
                    Box::new(move || Some(settings_with_pac_url(&u, true))),
                    ScriptSlot::new(PacSource::Url(closed_url), RETRY_BACKOFF),
                    "",
                ),
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
        let u = stalled_url.clone();
        let stalled_client = crate::client::build_with_builder(|b| {
            with_resolver(
                b,
                PacResolver::new(
                    Box::new(move || Some(settings_with_pac_url(&u, true))),
                    ScriptSlot::new(PacSource::Url(stalled_url), RETRY_BACKOFF),
                    "",
                ),
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
        let slot = ScriptSlot::new(PacSource::Url(pac_url.clone()), Duration::from_millis(40));
        let u = pac_url.clone();
        let resolver = PacResolver::new(Box::new(move || Some(settings_with_pac_url(&u, true))), Arc::clone(&slot), "");
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
