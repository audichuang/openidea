---
name: fork-verify
description: Fork supplement to the upstream `verify` skill for proving OpenIDEA changes on macOS. Splits the work between the Tauri MCP tools (`mcp__tauri__*`, for everything inside the webview) and lcu (real OS keyboard/mouse, native menus and dialogs, the installed release, IntelliJ comparison), plus native tools for AppKit chrome (project window tabs, fullscreen, traffic lights). Covers running both drivers on one process with scripts/lcu-wrap.sh, Tauri MCP pitfalls on this app, and the fork feature map (Annotate colors, window groups, auto fetch, clipboard paste).
---

# Verify OpenIDEA in the real app (fork, macOS)

Upstream's `verify` skill (`.agents/skills/verify`) is the base: launch and session reuse, `mcp__tauri__*` basics, CodeMirror/xterm input quirks, `fixtures/`, evidence naming. Read it first. This skill adds the split between Tauri MCP and lcu, how to run them on one process, what broke on this app, and the fork's feature map (`features/`).

## The split: Tauri MCP inside the webview, lcu for the OS

```text
            ┌──────────── OpenIDEA debug process ────────────┐
 Tauri MCP ─┤ webview: DOM, CSS, app state, webview menus,   │
 (synthetic)│ dialogs, editor text, window screenshots       │
            ├────────────────────────────────────────────────┤
 lcu ───────┤ macOS: real keys/mouse, native menu bar,       │
 (real OS)  │ native dialogs, AX tree, focus, clipboard      │
            ├────────────────────────────────────────────────┤
 osascript/ │ AppKit chrome: window tab group, fullscreen    │
 cliclick/  │ frames, traffic lights, drags                  │
 screencap. │                                                │
            └────────────────────────────────────────────────┘
```

|        | **Tauri MCP** (`mcp__tauri__*`)                                                                                                                                       | **lcu** (`mcp__lcu__js`, see `lcu-desktop`)                                                                              |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Builds | Debug only: the app's `tauri-plugin-mcp-bridge` is `#[cfg(debug_assertions)]` in `src-tauri/src/lib.rs`.                                                              | Any `.app`: dev wrapper, installed release, IntelliJ.                                                                    |
| Sees   | Webview DOM as a role tree with `ref=eN` handles, computed styles, rects, console logs, one window's pixels (returned inline, even when the window is behind others). | The whole app as macOS sees it: AX tree, native menu bar and dialogs, real screen pixels.                                |
| Input  | Synthetic DOM events (`isTrusted === false`, `event.detail === 0`). No mouse movement, no AppKit, no OS focus.                                                        | Real keyboard and mouse through macOS.                                                                                   |
| Setup  | `pnpm dev:app` + `driver_session start port=<dev:status port>`.                                                                                                       | `scripts/lcu-wrap.sh up` (a signed .app around the debug binary). Owns the screen, keyboard and clipboard while it runs. |
| Cost   | Fast (most calls < 200 ms), scoped snapshots are small.                                                                                                               | `getApp` dumps thousands of tokens; slower per step.                                                                     |

**Rule: Tauri MCP sets up and asserts; whatever the user physically does goes through lcu when the code path depends on a real OS event.**

| Situation                                                                                                      | Use                                                                                                      |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Webview menus, dialogs, settings pages, colors, layout, editor content                                         | Tauri MCP only. A synthetic click runs the same handler as a user click. (Annotate, 2026-11-04.)         |
| Shortcuts routed through the native menu (⌘V, ⌃⌘F), clipboard reads, hover-only controls, drag and drop, focus | Tauri MCP opens the fixture → lcu presses / clicks → Tauri MCP reads the result. (⌘V paste, 2026-11-04.) |
| Window tab group, fullscreen frames, traffic lights, Window menu                                               | `osascript` + `cliclick` + `screencapture`. Tauri MCP may still read the tab row DOM the app draws.      |
| Installed release build, or side-by-side with IntelliJ                                                         | lcu only (no bridge in release).                                                                         |

Do not drive webview widgets by lcu coordinates when Tauri MCP can address them by `ref`, text or selector. Do not accept a Tauri MCP click as proof for anything in the second row.

## Tauri MCP on this app

Registered on this Mac at local scope (2026-11-04):

```bash
claude mcp add tauri --scope local -- npx -y @hypothesi/tauri-mcp-server@0.13
```

Keep the minor version equal to the crate (`tauri-plugin-mcp-bridge = "0.13"` in `src-tauri/Cargo.toml`). If the tools are missing or the server dropped, ask the user to run `/mcp` to reconnect; there is no other driver.

Workflow:

1. `driver_session action=start port=<pnpm dev:status port>`.
2. `manage_window action=list` → labels `main`, `project-N`. Pass `windowId` on every call.
3. Find: `webview_dom_snapshot type=accessibility selector=<scope>` (scope it, e.g. `[role=dialog]`; a whole window is large), then act on `ref=eN`.
4. Act: `webview_interact` click / right-click / double-click / hover / scroll by `ref`, CSS, or `strategy=text`.
5. Assert: `webview_find_element` with `properties=["background-color", ...]` returns text, classes, rect, visibility and computed styles in one call. `webview_screenshot` returns the image inline (`maxWidth` keeps it small) and prints the CSS-to-image scale.
6. `webview_execute_js` for app-level setup (see recipes). A bare promise expression works.

Pitfalls found on 2026-11-04:

- **`read_logs source=system` kills the server.** It runs `log show --last 1m` for the whole Mac with no process filter, and the connection closed. Use `source=console` for the webview; read `pnpm dev:app`'s log file (`/tmp/oi-dev.log`) for Rust.
- **`ipc_monitor` captures nothing here.** It hooks `window.__TAURI__.core`, but the app calls the backend through the `@tauri-apps/api/core` `invoke` module (`src/bindings.ts`). Check backend effects on disk or in the UI instead.
- **`ipc_execute_command` / bridge invoke** only reach plugin commands; app commands answer "Unsupported Tauri command". Call the generated bindings from `webview_execute_js` (recipe below).
- **`webview_keyboard type` fails on CodeMirror** ("HTMLInputElement.value setter"). Use `webview_execute_js`: focus `.cm-content`, then `document.execCommand('insertText', false, text)`.
- **`webview_wait_for` stops at ~5 s** whatever `timeout` says ("Script execution timeout"). Call it again for longer waits.
- Synthetic clicks have `event.detail === 0`; CodeMirror treats them as line-select clicks. Set the caret through `document.querySelector('.cm-content').cmTile.view`.
- `strategy=text` can hit a hidden node (upstream note); prefer the snapshot `ref`.
- Background windows throttle timers. Unfocused visible windows screenshotted fine; if a capture is black or a script times out, `manage_window action=focus`.

Recipes (dev build only, since Vite serves `/src/...`):

- **Open a fixture project + file** (setup; the user path is Welcome → Open, a native dialog):
  `webview_execute_js windowId=main script=import("/src/features/app/windows.ts").then(m => m.openProjectInWindow("/tmp/oi-verify/repo", true, ["/tmp/oi-verify/repo/app.txt"])).then(() => "ok")`.
  A new `project-N` shows **"Trust and Open Project?"** for a path not trusted before: snapshot `[role=dialog]`, click the `Trust Project` ref. A path trusted in an earlier run opens without it (the dev data dir persists).
- **Settings** through the same call the Settings page makes:
  `import("/src/bindings.ts").then(m => m.commands.settingsSet("global", "appearance.theme", JSON.stringify("dark"))).then(r => r.status)`.
  Keys live in `src/platform/clientSettings.ts` / `workflowSettings.ts`. Restore them afterwards.
- **Webview context menus** (gutter, project tree, tabs): `webview_interact action=right-click` on the element, then `action=click strategy=text selector=<item label>`.

Prefer the user's real path for the behavior under test (click the menu item, not the store setter); internal imports are for setup.

## Running Tauri MCP and lcu on one process

The dev identifier is single-instance (`tauri_plugin_single_instance` in `lib.rs`): either `pnpm dev:app` runs or the lcu wrapper runs, never both. The wrapper carries the same debug binary, so the bridge, Tauri MCP and lcu all reach one process (verified 2026-11-04).

```bash
# 1. build once; stop it after `pnpm dev:status` shows a bridge (it owns the single instance)
PATH="$HOME/.cargo/bin:$PATH" CARGO_PROFILE_DEV_DEBUG=0 pnpm dev:app > /tmp/oi-dev.log 2>&1   # background
# 2. relaunch as a signed .app with its own vite (reads identifier/devUrl from the log)
.agents/skills/fork-verify/scripts/lcu-wrap.sh up /tmp/oi-dev.log      # prints the .app path
pnpm -s dev:status                                                     # bridge answers again
```

Then `driver_session start` for Tauri MCP and `globalThis.app = await cua.getApp('<printed .app path>')` for lcu. Finish with `lcu-wrap.sh down` (quits the wrapper app, stops its vite by port, deletes the wrapper). After a Rust rebuild, `down` and `up` again: the wrapper holds a copy of the old binary.

Proven flow (⌘V paste): Tauri MCP opens the fixture and trusts it → Bash `printf 'SENTINEL-%s' $RANDOM | pbcopy` → lcu `app.click(<"Editor for <path>" text area id>)`, `app.pressKey('cmd+v')` → Tauri MCP reads `.cm-content` text and finds the sentinel → `screencapture -x` shows no WebKit "Paste" bubble.

lcu notes from these runs:

- `pressKey` rejected `cmd+end` and `cmd+down` (`keyNotFound`); check key names with `cua.rewriteDocumentation()`.
- Webview widgets have AX names (`tab group Project windows`, `text entry area ... Editor for <path>`), so lcu can click them by id.
- `drag` returns `noWindowsAvailable` on this app; use `cliclick`. Fullscreen screenshots can be stale; use `screencapture -x`.
- A macOS consent dialog from another app (e.g. "claude wants to control Codex Computer Use") can appear on top; leave it for the user.

## Launch

From the repo (or worktree) root:

```bash
PATH="$HOME/.cargo/bin:$PATH" CARGO_PROFILE_DEV_DEBUG=0 pnpm dev:app > /tmp/oi-dev.log 2>&1   # run_in_background
```

- The agent shell lacks `~/.cargo/bin`; without it the build dies at `cargo metadata`.
- First build takes ~5–10 min. Wait in the background with `until pnpm -s dev:status >/dev/null 2>&1 || grep -q "^error" /tmp/oi-dev.log; do sleep 5; done` (the log's `Running` line carries color codes, so a plain grep for it can miss).
- Per-worktree identity `ai.l0ng.openidea.dev.w<hash>` with its own data dir `~/Library/Application Support/<identifier>/`; the installed OpenIDEA and its settings are untouched.
- Vite hot-reloads frontend edits. Rust edits rebuild and restart the app, closing the windows you set up.
- The Mac mini is short on disk: build locally only to touch the UI; Rust tests/clippy go through `rust-remote`.

## Doctor

`pnpm -s dev:status`: healthy is JSON with `bridges[0].port` (9223+) whose `app.identifier` equals `identifier`. Exit 1 "No MCP bridge found" = still compiling, crashed (`/tmp/oi-dev.log`), or not running. `driver_session action=status` shows what Tauri MCP is connected to.

## Native AppKit

- Window frames: `osascript -e 'tell application "System Events" to tell (first process whose unix id is <pid>) to get {position, size} of windows'`. Fullscreen should equal the screen (minus the notch safe area on notched displays).
- Pixels: `screencapture -x /tmp/oi-verify/evidence/x.png`. Drags: `cliclick dd:x,y dm:x,y du:x,y` in screen points.
- `scripts/lcu-wrap.sh` already handles what failed by hand: plain `cargo build` binaries lack `devUrl` (blank window), an unsigned copy fails with POSIX 162, a wrapper under `/tmp` made `getApp` hang, stopping tauri dev also stops its vite.
- AppKit view trees: lldb attach hangs (Developer mode off). Temporarily `eprintln!` `_subtreeDescription` behind an env var; remove before committing.
- Private-API behavior (e.g. `_setTabBarAccessoryViewController:`) can only be judged live: AppKit re-applies state on its run loop. Recheck after a resize, a tab switch, entering and leaving fullscreen.
- When something looks broken, `git stash` and check the baseline before blaming your change.

## Evidence

Put proof in `/tmp/oi-verify/evidence/<task>/` (cleanup never deletes it):

- Before/after screenshots plus the numbers that matter (computed colors, frames, text) as `.json`/`.txt`. Save a Tauri MCP screenshot with `filePath` when it must outlive the session.
- Cover every entry the feature map lists for the feature, and light and dark themes for anything colored.
- Check side effects directly: files on disk, the fixture repo's `git` state, settings in the dev data dir.
- PASS/FAIL per case with the screenshot path. A WebKit permission bubble or any dialog a user would also see is a FAIL.

## Cleanup

1. Restore settings you changed through the same bindings call.
2. Stop the `pnpm dev:app` you started (its background task or pid; never `pkill openidea`, the installed app has the same name), or `scripts/lcu-wrap.sh down` if you used the wrapper.
3. `rm -rf /tmp/oi-verify/repo*`; keep `/tmp/oi-verify/evidence`.
4. `cargo clean` in `src-tauri` (`target/` grows past 6 GB).

## Feature map

`features/README.md` indexes the fork's user-facing features and how to prove each. Update an entry when a run teaches you something new.
