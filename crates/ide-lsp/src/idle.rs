//! Stopping a language server nothing uses: jdtls keeps 0.5–1.8 GB while the project
//! is open, whether or not a Java file is. The server starts again with the next file
//! it serves or the next request that needs it (Run / Debug).

use std::time::{Duration, Instant};

/// How often servers are checked.
pub(crate) const CHECK_INTERVAL: Duration = Duration::from_secs(60);

/// What the app wants for one server: stop it after `timeout` without use (zero: never),
/// unless `keep_alive` (e.g. a debug session runs inside it).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct IdlePolicy {
    pub timeout: Duration,
    pub keep_alive: bool,
}

/// Gives the policy for the server named by its argument.
pub type IdleFn = dyn Fn(&str) -> IdlePolicy + Send + Sync;

/// One server, as the check sees it.
#[derive(Clone, Copy, Debug)]
pub(crate) struct IdleState {
    pub running: bool,
    /// Documents attached to the server.
    pub open_documents: usize,
    /// Work in progress (an import, a build).
    pub busy: bool,
    /// Since when nothing used the server (its start, a closed file, a request).
    pub idle_since: Instant,
}

/// Whether to stop the server now.
pub(crate) fn should_stop(state: IdleState, policy: IdlePolicy, now: Instant) -> bool {
    !policy.timeout.is_zero()
        && !policy.keep_alive
        && state.running
        && state.open_documents == 0
        && !state.busy
        && now.saturating_duration_since(state.idle_since) >= policy.timeout
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE: Duration = Duration::from_secs(60);

    #[test]
    fn stops_a_running_server_unused_for_the_timeout() {
        let start = Instant::now();
        let policy = IdlePolicy { timeout: 15 * MINUTE, keep_alive: false };
        let idle = IdleState { running: true, open_documents: 0, busy: false, idle_since: start };
        assert!(!should_stop(idle, policy, start + 14 * MINUTE));
        assert!(should_stop(idle, policy, start + 15 * MINUTE));
        assert!(should_stop(idle, policy, start + 60 * MINUTE));

        let late = start + 60 * MINUTE;
        let cases = [
            (IdleState { open_documents: 1, ..idle }, policy, "a Java file is open"),
            (IdleState { busy: true, ..idle }, policy, "an import is running"),
            (IdleState { running: false, ..idle }, policy, "not running (stopped or starting)"),
            (idle, IdlePolicy { keep_alive: true, ..policy }, "a debug session runs in it"),
            (idle, IdlePolicy { timeout: Duration::ZERO, ..policy }, "0 = never"),
            (IdleState { idle_since: late, ..idle }, policy, "just used"),
        ];
        for (state, policy, why) in cases {
            assert!(!should_stop(state, policy, late), "{why}");
        }
        // A clock that went backwards doesn't stop it either.
        assert!(!should_stop(IdleState { idle_since: late, ..idle }, policy, start));
    }
}
