# Auto fetch / incoming check

## Sub-features

- `vcs.git.autoFetch` + `vcs.git.autoFetchMinutes`: fetch every repository on an interval, keep going after failures (`src/features/vcs/incoming.ts`).
- Otherwise `vcs.git.incomingCheck` only checks for incoming commits.

## How to get to it (user POV)

Settings → Version Control → Git → "Auto fetch" toggle and minutes field (`src/features/settings/pages/vcs.tsx`).

## Driving it with Tauri MCP

1. Fixture: a bare remote plus a clone opened in the app; push a new commit to the remote from another clone.
2. Turn the setting on through Settings (or `settingsSet("global", "vcs.git.autoFetch", "true")` and `autoFetchMinutes` 1 for a short run).
3. Proof is a side effect, not UI: `git -C <clone> rev-parse origin/main` moves to the new commit without you running fetch; the incoming indicator updates.

## Gotchas

- `autoFetchMinutes` is clamped to 1–1440 (`workflowSettings.ts`, default 30); a 1-minute run still means waiting ~60 s.
- Restore both settings afterwards; the dev data dir persists.
