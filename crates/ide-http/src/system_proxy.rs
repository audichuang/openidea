//! The operating system's automatic proxy configuration (a PAC script, or WPAD on
//! Windows), which reqwest's own system-proxy lookup does not read: it only sees the
//! manual proxies of macOS and Windows and the `*_PROXY` environment variables.
//! Corporate networks often hand out their proxy through a PAC script alone, so a
//! connection that ignores it goes direct and is blocked.

use std::time::Duration;

/// Where the automatic configuration sends a URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AutoProxy {
    Direct,
    /// Through this proxy (`http://host:port`, `socks5h://host:port`).
    Via(String),
}

/// What the OS's automatic proxy configuration picks for `url`, or `None` when none
/// applies: no PAC script or WPAD configured, a `*_PROXY` environment variable set
/// (it wins, as in reqwest's own lookup), Linux, or the lookup failed. On `None`
/// the caller keeps reqwest's own lookup, so nothing changes for manual proxies.
pub async fn auto_proxy_for(url: &str) -> Option<AutoProxy> {
    if env_proxy_set() {
        return None;
    }
    let result = platform::auto_proxy_for(url).await;
    if let Err(e) = &result {
        tracing::warn!("automatic proxy configuration for {url}: {e}");
    }
    result.ok().flatten()
}

const PROXY_ENV: [&str; 6] = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];

fn env_proxy_set() -> bool {
    PROXY_ENV.iter().any(|k| std::env::var_os(k).is_some_and(|v| !v.is_empty()))
}

/// How long a PAC script may take to download.
#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
const PAC_FETCH_TIMEOUT: Duration = Duration::from_secs(5);

/// `host:port` as the authority of a URL (IPv6 literals in brackets).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn authority(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') { format!("[{host}]:{port}") } else { format!("{host}:{port}") }
}

/// One entry of a WinHTTP proxy list (`host:port`, `http://host:port`) as a proxy URL.
#[cfg_attr(not(windows), allow(dead_code))]
fn proxy_url(entry: &str, default_scheme: &str) -> Option<String> {
    let entry = entry.trim();
    if entry.is_empty() {
        return None;
    }
    if entry.contains("://") { Some(entry.to_owned()) } else { Some(format!("{default_scheme}://{entry}")) }
}

/// The proxy WinHTTP's `lpszProxy` names for a URL with scheme `scheme`. It holds
/// `host:port` entries separated by `;` or whitespace, the first one preferred, or
/// per-scheme entries (`http=a:80;https=b:443;socks=c:1080`).
#[cfg_attr(not(windows), allow(dead_code))]
fn pick_from_list(list: &str, scheme: &str) -> Option<String> {
    let entries: Vec<&str> = list.split([';', ' ', '\t', '\r', '\n']).filter(|e| !e.trim().is_empty()).collect();
    let per_scheme = entries.iter().any(|e| e.contains('=') && !e.contains("://"));
    if !per_scheme {
        return entries.first().and_then(|e| proxy_url(e, "http"));
    }
    let named = |name: &str| {
        entries
            .iter()
            .find_map(|e| e.split_once('=').filter(|(k, _)| k.trim().eq_ignore_ascii_case(name)).map(|(_, v)| v))
    };
    if let Some(v) = named(scheme) {
        return proxy_url(v, "http");
    }
    // WinINet's `socks=` is SOCKS 4.
    named("socks").and_then(|v| proxy_url(v, "socks4a"))
}

/// The scheme of `url`, lower-case (`https`).
#[cfg_attr(not(windows), allow(dead_code))]
fn scheme_of(url: &str) -> String {
    url.split_once("://").map(|(s, _)| s.to_ascii_lowercase()).unwrap_or_else(|| "http".into())
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{AutoProxy, PAC_FETCH_TIMEOUT, authority};
    use objc2_cf_network::{
        CFNetworkCopyProxiesForAutoConfigurationScript, CFNetworkCopyProxiesForURL, CFNetworkCopySystemProxySettings,
        kCFProxyAutoConfigurationJavaScriptKey, kCFProxyAutoConfigurationURLKey, kCFProxyHostNameKey,
        kCFProxyPortNumberKey, kCFProxyTypeAutoConfigurationJavaScript, kCFProxyTypeAutoConfigurationURL,
        kCFProxyTypeHTTP, kCFProxyTypeHTTPS, kCFProxyTypeKey, kCFProxyTypeNone, kCFProxyTypeSOCKS,
    };
    use objc2_core_foundation::{CFArray, CFDictionary, CFNumber, CFRetained, CFString, CFType, CFURL};

    /// What the system settings say about a URL before any script runs.
    enum First {
        /// A PAC script at this URL.
        ScriptUrl(String),
        /// An inline PAC script.
        Script(String),
    }

    pub(super) async fn auto_proxy_for(url: &str) -> Result<Option<AutoProxy>, String> {
        let target = url.to_owned();
        let first = tokio::task::spawn_blocking(move || first_entry(&target)).await.map_err(|e| e.to_string())??;
        let script = match first {
            None => return Ok(None),
            Some(First::Script(script)) => script,
            Some(First::ScriptUrl(pac)) => fetch_script(&pac).await?,
        };
        let target = url.to_owned();
        tokio::task::spawn_blocking(move || evaluate(&script, &target)).await.map_err(|e| e.to_string())?.map(Some)
    }

    fn cf_url(url: &str) -> Result<CFRetained<CFURL>, String> {
        CFURL::from_string(None, &CFString::from_str(url), None).ok_or_else(|| format!("not a URL: {url}"))
    }

    /// The entries CFNetwork returns, as dictionaries with `CFString` keys.
    fn entries(list: &CFArray) -> Vec<CFRetained<CFDictionary<CFString, CFType>>> {
        // SAFETY: CFNetwork's proxy lists hold dictionaries keyed by the kCFProxy*Key strings.
        let list: &CFArray<CFType> = unsafe { list.cast_unchecked() };
        list.iter()
            .filter_map(|e| e.downcast::<CFDictionary>().ok())
            .map(|d| unsafe { CFRetained::cast_unchecked::<CFDictionary<CFString, CFType>>(d) })
            .collect()
    }

    fn string(dict: &CFDictionary<CFString, CFType>, key: &CFString) -> Option<String> {
        dict.get(key).and_then(|v| v.downcast::<CFString>().ok()).map(|s| s.to_string())
    }

    /// The PAC script the system settings point `url` at, if they point it at one.
    fn first_entry(url: &str) -> Result<Option<First>, String> {
        // SAFETY: plain CFNetwork calls on owned, valid CF objects.
        unsafe {
            let Some(settings) = CFNetworkCopySystemProxySettings() else { return Ok(None) };
            let target = cf_url(url)?;
            let list = CFNetworkCopyProxiesForURL(&target, &settings);
            let Some(entry) = entries(&list).into_iter().next() else { return Ok(None) };
            let kind = string(&entry, kCFProxyTypeKey).unwrap_or_default();
            if kind == kCFProxyTypeAutoConfigurationURL.to_string() {
                let pac = entry
                    .get(kCFProxyAutoConfigurationURLKey)
                    .and_then(|v| v.downcast::<CFURL>().ok())
                    .map(|u| u.string().to_string())
                    .ok_or("PAC entry without a URL")?;
                Ok(Some(First::ScriptUrl(pac)))
            } else if kind == kCFProxyTypeAutoConfigurationJavaScript.to_string() {
                Ok(string(&entry, kCFProxyAutoConfigurationJavaScriptKey).map(First::Script))
            } else {
                Ok(None)
            }
        }
    }

    async fn fetch_script(pac: &str) -> Result<String, String> {
        if let Some(path) = pac.strip_prefix("file://") {
            return tokio::fs::read_to_string(path).await.map_err(|e| format!("reading PAC script {pac}: {e}"));
        }
        // The PAC host is reached directly: the script is what says which proxy to use.
        let direct = ide_core::proxy_settings::ProxySettings {
            mode: ide_core::proxy_settings::ProxyMode::None,
            ..Default::default()
        };
        let client = crate::client::build(&direct).map_err(|e| e.message)?;
        let response = client
            .get(pac)
            .timeout(PAC_FETCH_TIMEOUT)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("downloading PAC script {pac}: {}", crate::client::describe(&e)))?;
        response.text().await.map_err(|e| format!("downloading PAC script {pac}: {e}"))
    }

    /// Runs the PAC `script` for `url` and takes its first choice.
    pub(super) fn evaluate(script: &str, url: &str) -> Result<AutoProxy, String> {
        let target = cf_url(url)?;
        let mut error = std::ptr::null_mut();
        // SAFETY: CFNetwork call on owned, valid CF objects; `error` is an out-pointer it may fill.
        let list =
            unsafe { CFNetworkCopyProxiesForAutoConfigurationScript(&CFString::from_str(script), &target, &mut error) };
        if !error.is_null() {
            // SAFETY: CFNetwork hands over ownership of the error it created.
            let error = unsafe { CFRetained::from_raw(std::ptr::NonNull::new_unchecked(error)) };
            return Err(format!("PAC script failed: {error:?}"));
        }
        let list = list.ok_or("PAC script returned nothing")?;
        let Some(entry) = entries(&list).into_iter().next() else { return Ok(AutoProxy::Direct) };
        let kind = string(&entry, unsafe { kCFProxyTypeKey }).unwrap_or_default();
        let scheme = if kind == unsafe { kCFProxyTypeNone }.to_string() {
            return Ok(AutoProxy::Direct);
        } else if kind == unsafe { kCFProxyTypeHTTP }.to_string() || kind == unsafe { kCFProxyTypeHTTPS }.to_string() {
            // `HTTPS` means a proxy for https URLs; the proxy itself speaks plain HTTP.
            "http"
        } else if kind == unsafe { kCFProxyTypeSOCKS }.to_string() {
            "socks5h"
        } else {
            return Err(format!("unsupported proxy type {kind}"));
        };
        let host = string(&entry, unsafe { kCFProxyHostNameKey }).ok_or("proxy without a host")?;
        let port = entry
            .get(unsafe { kCFProxyPortNumberKey })
            .and_then(|v| v.downcast::<CFNumber>().ok())
            .and_then(|n| n.as_i64())
            .and_then(|n| u16::try_from(n).ok())
            .ok_or("proxy without a port")?;
        Ok(AutoProxy::Via(format!("{scheme}://{}", authority(&host, port))))
    }
}

#[cfg(windows)]
mod platform {
    use super::{AutoProxy, PAC_FETCH_TIMEOUT, pick_from_list, scheme_of};
    use windows::Win32::Foundation::{GlobalFree, HGLOBAL};
    use windows::Win32::Networking::WinHttp::{
        ERROR_WINHTTP_AUTODETECTION_FAILED, WINHTTP_ACCESS_TYPE_NAMED_PROXY, WINHTTP_ACCESS_TYPE_NO_PROXY,
        WINHTTP_AUTO_DETECT_TYPE_DHCP, WINHTTP_AUTO_DETECT_TYPE_DNS_A, WINHTTP_AUTOPROXY_AUTO_DETECT,
        WINHTTP_AUTOPROXY_CONFIG_URL, WINHTTP_AUTOPROXY_OPTIONS, WINHTTP_CURRENT_USER_IE_PROXY_CONFIG,
        WINHTTP_PROXY_INFO, WinHttpCloseHandle, WinHttpGetIEProxyConfigForCurrentUser, WinHttpGetProxyForUrl,
        WinHttpOpen, WinHttpSetTimeouts,
    };
    use windows::core::{BOOL, HRESULT, PCWSTR, PWSTR, w};

    pub(super) async fn auto_proxy_for(url: &str) -> Result<Option<AutoProxy>, String> {
        let url = url.to_owned();
        tokio::task::spawn_blocking(move || {
            let Some((detect, config_url)) = user_auto_config()? else { return Ok(None) };
            resolve(&url, detect, config_url.as_deref())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    /// Takes a string WinHTTP allocated, freeing it.
    fn take(s: PWSTR) -> Option<String> {
        if s.is_null() {
            return None;
        }
        // SAFETY: WinHTTP returns NUL-terminated strings allocated with GlobalAlloc.
        let value = unsafe { s.to_string() }.ok();
        let _ = unsafe { GlobalFree(Some(HGLOBAL(s.0.cast()))) };
        value
    }

    /// The current user's automatic configuration: WPAD on, and the PAC script URL.
    /// `None` when neither is set.
    fn user_auto_config() -> Result<Option<(bool, Option<String>)>, String> {
        let mut config = WINHTTP_CURRENT_USER_IE_PROXY_CONFIG::default();
        // SAFETY: WinHTTP fills `config`; every string in it is freed by `take`.
        unsafe { WinHttpGetIEProxyConfigForCurrentUser(&mut config) }.map_err(|e| e.to_string())?;
        let config_url = take(config.lpszAutoConfigUrl).filter(|u| !u.trim().is_empty());
        take(config.lpszProxy);
        take(config.lpszProxyBypass);
        let detect = config.fAutoDetect.as_bool();
        Ok((detect || config_url.is_some()).then_some((detect, config_url)))
    }

    /// Runs WPAD (`detect`) and/or the PAC script at `config_url` for `url`. `None` when
    /// WPAD alone finds nothing: "Automatically detect settings" is on by default, so that
    /// is an ordinary network without automatic configuration, not a failure.
    pub(super) fn resolve(url: &str, detect: bool, config_url: Option<&str>) -> Result<Option<AutoProxy>, String> {
        // SAFETY: the session handle is closed below; every string WinHTTP returns is freed by `take`.
        unsafe {
            let session = WinHttpOpen(w!("OpenIDEA"), WINHTTP_ACCESS_TYPE_NO_PROXY, PCWSTR::null(), PCWSTR::null(), 0);
            if session.is_null() {
                return Err(windows::core::Error::from_thread().to_string());
            }
            let ms = i32::try_from(PAC_FETCH_TIMEOUT.as_millis()).unwrap_or(i32::MAX);
            let _ = WinHttpSetTimeouts(session, ms, ms, ms, ms);
            let config_wide: Option<Vec<u16>> = config_url.map(|u| u.encode_utf16().chain([0]).collect());
            let mut options =
                WINHTTP_AUTOPROXY_OPTIONS { fAutoLogonIfChallenged: BOOL::from(true), ..Default::default() };
            if detect {
                options.dwFlags |= WINHTTP_AUTOPROXY_AUTO_DETECT;
                options.dwAutoDetectFlags = WINHTTP_AUTO_DETECT_TYPE_DHCP | WINHTTP_AUTO_DETECT_TYPE_DNS_A;
            }
            if let Some(wide) = &config_wide {
                options.dwFlags |= WINHTTP_AUTOPROXY_CONFIG_URL;
                options.lpszAutoConfigUrl = PCWSTR(wide.as_ptr());
            }
            let url_wide: Vec<u16> = url.encode_utf16().chain([0]).collect();
            let mut info = WINHTTP_PROXY_INFO::default();
            let result = WinHttpGetProxyForUrl(session, PCWSTR(url_wide.as_ptr()), &mut options, &mut info);
            let _ = WinHttpCloseHandle(session);
            if let Err(e) = result {
                if config_url.is_none() && e.code() == HRESULT::from_win32(ERROR_WINHTTP_AUTODETECTION_FAILED) {
                    tracing::debug!("WPAD found no proxy configuration");
                    return Ok(None);
                }
                return Err(e.to_string());
            }
            let list = take(info.lpszProxy);
            take(info.lpszProxyBypass);
            if info.dwAccessType != WINHTTP_ACCESS_TYPE_NAMED_PROXY {
                return Ok(Some(AutoProxy::Direct));
            }
            let list = list.unwrap_or_default();
            pick_from_list(&list, &scheme_of(url))
                .map(|via| Some(AutoProxy::Via(via)))
                .ok_or_else(|| format!("unusable proxy list {list:?}"))
        }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    use super::AutoProxy;

    pub(super) async fn auto_proxy_for(_url: &str) -> Result<Option<AutoProxy>, String> {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_list_takes_its_first_entry() {
        assert_eq!(pick_from_list("proxy.corp:8080", "https").as_deref(), Some("http://proxy.corp:8080"));
        assert_eq!(pick_from_list("a:1; b:2", "https").as_deref(), Some("http://a:1"));
        assert_eq!(pick_from_list("http://a:1", "http").as_deref(), Some("http://a:1"));
        assert_eq!(pick_from_list("  ", "http"), None);
    }

    #[test]
    fn a_per_scheme_list_takes_the_scheme_entry_then_socks() {
        let list = "http=web:80;https=secure:443;socks=sock:1080";
        assert_eq!(pick_from_list(list, "https").as_deref(), Some("http://secure:443"));
        assert_eq!(pick_from_list(list, "http").as_deref(), Some("http://web:80"));
        assert_eq!(pick_from_list("http=web:80;socks=sock:1080", "https").as_deref(), Some("socks4a://sock:1080"));
        assert_eq!(pick_from_list("http=web:80", "https"), None);
    }

    #[test]
    fn ipv6_hosts_get_brackets() {
        assert_eq!(authority("::1", 3128), "[::1]:3128");
        assert_eq!(authority("proxy", 3128), "proxy:3128");
    }

    #[test]
    fn the_scheme_comes_from_the_url() {
        assert_eq!(scheme_of("HTTPS://github.com/x"), "https");
        assert_eq!(scheme_of("github.com"), "http");
    }

    #[cfg(any(target_os = "macos", windows))]
    const PAC: &str = r#"function FindProxyForURL(url, host) {
        if (host == "github.com") return "PROXY 127.0.0.1:3128; DIRECT";
        if (host == "socks.example") return "SOCKS5 127.0.0.1:1080";
        return "DIRECT";
    }"#;

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_runs_a_pac_script() {
        use platform::evaluate;
        assert_eq!(evaluate(PAC, "https://github.com/a/b").unwrap(), AutoProxy::Via("http://127.0.0.1:3128".into()));
        assert_eq!(evaluate(PAC, "https://socks.example/").unwrap(), AutoProxy::Via("socks5h://127.0.0.1:1080".into()));
        assert_eq!(evaluate(PAC, "https://elsewhere.example/").unwrap(), AutoProxy::Direct);
    }

    /// Serves `body` to every request on loopback, forever (the test process ends it).
    #[cfg(windows)]
    fn serve(body: &'static str) -> u16 {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
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

    #[cfg(windows)]
    #[test]
    fn windows_runs_a_pac_script() {
        let pac = format!("http://127.0.0.1:{}/proxy.pac", serve(PAC));
        let resolve = |url: &str| platform::resolve(url, false, Some(&pac)).unwrap().unwrap();
        assert_eq!(resolve("https://github.com/a/b"), AutoProxy::Via("http://127.0.0.1:3128".into()));
        assert_eq!(resolve("https://elsewhere.example/"), AutoProxy::Direct);
    }
}
