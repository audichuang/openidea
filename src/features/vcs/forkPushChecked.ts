/**
 * Fork decision (#224, FORK.md): the multi-repository Push dialog starts with nothing checked,
 * Commit and Push included. Upstream's preselection (what has outgoing commits, or the
 * repositories just committed, v0.1.51) stays behind this flag. Tests flip it to cover upstream.
 */
export const forkPushChecked = { upstream: false };
