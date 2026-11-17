# Incoming check (background fetch)

## Sub-features

- Upstream's incoming check (l0ng-ai/openidea#3812, v0.1.47), taken as it is (FORK.md standing decision "background fetch"; the fork's own auto fetch setting was removed on 2026-11-18): `vcs.git.incomingCheck` (`auto` default, `always`, `never`) fetches every repository whose branch has an upstream, one after another, 20 s after the project opens (`FIRST_DELAY`), then every `vcs.git.incomingCheckInterval` minutes (default 15). `auto` skips a repository for the session after its first failure; `always` retries it; `never` turns it off. A repository without an upstream is never fetched.

## How to get to it (user POV)

Settings → Version Control → Git (`src/features/settings/pages/vcs.tsx`): "Explicitly check for incoming commits on remotes" and "Check for incoming commits every … min". The branch widget shows incoming commits as `main ↙N`.

## Driving it with Tauri MCP

1. Fixture: a bare remote plus a clone (with an upstream) opened in the app; push a new commit to the remote from another clone.
2. For a short run: `settingsSet("global", "vcs.git.incomingCheckInterval", "1")`.
3. Proof is a side effect, not UI: `git -C <clone> rev-parse origin/main` moves to the new commit without you running fetch, and the branch widget shows `↙N`. Timestamps of the fetches come from `stat -f %m <clone>/.git/FETCH_HEAD`.

## Gotchas

- The interval is clamped to 1–1440 (`workflowSettings.ts`); a 1-minute run still means waiting ~60 s.
- Changing `incomingCheck` restarts the schedule: the next fetch comes 20 s later. Changing `incomingCheckInterval` waits one full new interval.
- An old `autoFetch` / `autoFetchMinutes` in `settings.toml` is ignored.
- Restore the settings afterwards; the dev data dir persists.
