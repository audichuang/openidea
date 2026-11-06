//! Fork-owned updater source and automatic proxy policy.

pub(crate) struct UpdateEndpoints {
    pub(crate) urls: Vec<String>,
}

impl UpdateEndpoints {
    pub(crate) fn configured(config: &tauri::Config) -> Self {
        Self::resolve(std::env::var("OPENIDEA_UPDATE_ENDPOINT").ok().as_deref(), config.plugins.0.get("updater"))
    }

    fn resolve(override_url: Option<&str>, updater: Option<&serde_json::Value>) -> Self {
        let urls = match override_url.filter(|url| !url.trim().is_empty()) {
            Some(url) => vec![url.to_owned()],
            None => updater
                .and_then(|updater| updater.get("endpoints"))
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_owned)
                .collect(),
        };
        Self { urls }
    }

    pub(crate) fn auto_proxy_target(&self) -> Option<&str> {
        // The updater shares one proxy decision across every endpoint and the download.
        match self.urls.as_slice() {
            [url] => Some(url),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn multiple_endpoints_do_not_share_an_automatic_proxy_decision() {
        let config = json!({"endpoints": ["https://internal.example/update", "https://external.example/update"]});
        let endpoints = UpdateEndpoints::resolve(None, Some(&config));
        assert_eq!(endpoints.auto_proxy_target(), None);
    }

    #[test]
    fn fork_release_uses_only_its_configured_source() {
        let workflow = include_str!("../../.github/workflows/fork-release.yml");
        let endpoint = workflow
            .lines()
            .find_map(|line| line.trim().strip_prefix("UPDATER_ENDPOINT: "))
            .expect("fork release updater endpoint");
        let config = json!({"endpoints": [endpoint]});
        let endpoints = UpdateEndpoints::resolve(None, Some(&config));
        assert_eq!(endpoints.urls, ["https://github.com/audichuang/openidea/releases/latest/download/latest.json"]);
        assert_eq!(endpoints.auto_proxy_target(), Some(endpoint));
        assert!(endpoints.urls.iter().all(|url| !url.contains("cnb.cool") && !url.contains("l0ng-ai")));
    }

    #[test]
    fn environment_override_replaces_all_configured_endpoints() {
        let config = json!({"endpoints": ["https://first.example/update", "https://second.example/update"]});
        let endpoints = UpdateEndpoints::resolve(Some("https://override.example/update"), Some(&config));
        assert_eq!(endpoints.urls, ["https://override.example/update"]);
        assert_eq!(endpoints.auto_proxy_target(), Some("https://override.example/update"));
    }

    #[test]
    fn blank_override_preserves_configured_endpoints_in_order() {
        let config = json!({"endpoints": ["https://first.example/update", "https://second.example/update"]});
        let endpoints = UpdateEndpoints::resolve(Some("  "), Some(&config));
        assert_eq!(endpoints.urls, ["https://first.example/update", "https://second.example/update"]);
    }

    #[test]
    fn empty_configuration_has_no_source_or_automatic_proxy_target() {
        for config in [None, Some(json!({"endpoints": []}))] {
            let endpoints = UpdateEndpoints::resolve(None, config.as_ref());
            assert!(endpoints.urls.is_empty());
            assert_eq!(endpoints.auto_proxy_target(), None);
        }
    }
}
