# Auto fetch / incoming check

## Sub-features

- Upstream's incoming check (l0ng-ai/openidea#3812, v0.1.47) is the base: `vcs.git.incomingCheck` (`auto` default, `always`, `never`) fetches every repository whose branch has an upstream, 20 s after the project opens (`FIRST_DELAY`), then every `vcs.git.incomingCheckInterval` minutes (default 15). `auto` skips a repository for the session after its first failure; `always` retries it.
- The fork's `vcs.git.autoFetch` + `vcs.git.autoFetchMinutes` (off by default, 30 min) takes that schedule over when on (`fetchPlan` in `src/features/vcs/incoming.ts`): every repository with or without an upstream, every `autoFetchMinutes`, whatever `incomingCheck` says (`never` included), retrying failed ones, and one "Automatic fetch failed" warning per failure streak. Turning it off hands the schedule back to the incoming check; both never fetch at once (FORK.md standing decision "background fetch").

## How to get to it (user POV)

Settings → Version Control → Git (`src/features/settings/pages/vcs.tsx`) has two rows: upstream's "Explicitly check for incoming commits on remotes" with "Check for incoming commits every … min", and the fork's "Fetch remotes automatically every … min" (a toggle plus a minutes field). The branch widget shows incoming commits as `main ↙N`.

## Driving it with Tauri MCP

1. Fixture: a bare remote plus a clone opened in the app; push a new commit to the remote from another clone.
2. Turn the setting on through Settings (or `settingsSet("global", "vcs.git.autoFetch", "true")` and `autoFetchMinutes` 1 for a short run).
3. Proof is a side effect, not UI: `git -C <clone> rev-parse origin/main` moves to the new commit without you running fetch, and the branch widget shows `↙N`. Timestamps of the fetches come from `stat -f %m <clone>/.git/FETCH_HEAD`.
4. Cases (v0.1.47 rebase, measured on 2026-11-17): with auto fetch on, the first fetch about 20 s after opening, then one per `autoFetchMinutes`, with no extra fetch from the incoming check in between; a repository without an upstream is fetched too; with auto fetch off, the incoming check still fetches at 20 s.

## Gotchas

- Both intervals are clamped to 1–1440 (`workflowSettings.ts`); a 1-minute run still means waiting ~60 s.
- Changing `incomingCheck`, `autoFetch` or `autoFetchMinutes` restarts the schedule: the next fetch comes 20 s later (`FIRST_DELAY`). Changing `incomingCheckInterval` waits one full new interval.
- Not exercised so far: the `incomingCheckInterval` cadence after the first fetch, and the failure warning (point the remote at a missing path to trigger it).
- Restore the settings afterwards; the dev data dir persists.
