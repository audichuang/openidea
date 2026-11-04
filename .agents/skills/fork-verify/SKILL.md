---
name: fork-verify
description: Entry point for proving any OpenIDEA change in the running app in this fork (macOS); start here instead of the upstream `verify` skill, which it loads as its base. Tauri MCP (`mcp__tauri__*`) drives and asserts everything inside the webview; real OS input that synthetic events cannot reach (⌘V and other native-menu shortcuts, real clicks, hover, drags, native menus and dialogs) goes through osascript and cliclick against the same `pnpm dev:app` process, with screencapture for pixels and AppKit chrome (project window tabs, fullscreen). lcu is not needed for the dev build. Lists Tauri MCP pitfalls on this app and the fork feature map (Annotate colors, window groups, auto fetch, clipboard paste).
---

# Verify OpenIDEA in the real app (fork, macOS)

Upstream's `verify` skill (`.agents/skills/verify`) is the base: launch and session reuse, `mcp__tauri__*` basics, CodeMirror/xterm input quirks, `fixtures/`, evidence naming. Read it first. This skill adds when synthetic Tauri MCP input is not enough and how to send real OS input instead, what broke on this app, and the fork's feature map (`features/`).

## Verify a change, in order

1. **Pick a path for every case before launching.** List what the change touches and look each item up in the split table below. Webview-only cases use Tauri MCP; anything that starts in AppKit (native-menu shortcuts, native menus, real mouse, window chrome) uses real OS input. A case with no path is unverified, not passed.
2. **Launch and connect** (Launch, Doctor): `pnpm dev:app` with `~/.cargo/bin` on `PATH`, wait for `pnpm dev:status`, then `driver_session start` on the reported port. Take window labels from `pnpm dev:status`, not `manage_window list`, and pass `appIdentifier` and `windowId` on every call. Reuse a running app only if it was built after your last Rust change.
3. **Set up through Tauri MCP.** The app reopens the last projects on launch; open your own fixture with the `openProjectInWindow` recipe, trust it, and note any setting you change so you can restore it.
4. **Act like a user.** For AppKit cases, `manage_window focus` the window, then send osascript or cliclick to this worktree's pid. Clipboard cases start with a fresh `pbcopy` sentinel from outside the app.
5. **Assert on the result, not the action.** "Pressed key" or "Clicked" from a Tauri MCP tool proves nothing: read the document text, DOM or files through Tauri MCP. For system-level results (permission bubbles, dialogs, AppKit chrome) take `screencapture -x` and look at it.
6. **Record and clean up** (Evidence, Cleanup).

Before reporting PASS, check:

- Every AppKit-path case was driven with osascript or cliclick. A Tauri MCP ⌘V reports success and pastes nothing.
- Clipboard proof used a sentinel copied from outside OpenIDEA.
- A `screencapture` was checked for a WebKit permission bubble or an unexpected dialog; Tauri MCP screenshots never show them.
- The running binary was built after the last Rust change.
- Light and dark themes were covered for anything colored.
- Settings are restored, the app you started is stopped, build output is cleaned per Cleanup step 4. Dialogs from other apps were left for the user.

The pitfalls behind these rules are listed in "Tauri MCP on this app"; read them before the first call.

## The split: Tauri MCP for the webview, osascript/cliclick for real OS input

```text
            ┌───────── one `pnpm dev:app` process ─────────┐
 Tauri MCP ─┤ webview: DOM, CSS, app state, webview menus, │
 (synthetic)│ dialogs, editor text, window screenshots     │
            ├──────────────────────────────────────────────┤
 osascript ─┤ macOS: real keystrokes, native menu bar and  │
 cliclick   │ dialogs, window focus, real clicks and drags │
            ├──────────────────────────────────────────────┤
 screencap. │ pixels: AppKit chrome, permission bubbles    │
            └──────────────────────────────────────────────┘
```

Tauri MCP events are synthetic (`isTrusted === false`, `event.detail === 0`) and never pass through AppKit. That is enough when a webview handler is the code under test, and not enough when the path starts in AppKit. Measured 2026-11-04 on the same editor:

| Test                                                                                   | Result                                                                                                              |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Tauri MCP `webview_keyboard press v modifiers=[Meta]` with a sentinel on the clipboard | Nothing pasted. ⌘V is the native Edit → Paste menu item (`src-tauri/src/menu.rs`), which a DOM event never reaches. |
| `osascript` `keystroke "v" using command down` to the `pnpm dev:app` process           | Sentinel pasted, no WebKit "Paste" bubble (`screencapture`).                                                        |
| `cliclick c:x,y` on a project tab, coordinates from Tauri MCP                          | Real click switched the focused window (`pnpm dev:status`).                                                         |
| Tauri MCP click vs `cliclick c:x,y` on the same Project tree row                       | MCP: `isTrusted` false, `detail` 0, no `pointerdown`. cliclick: `isTrusted` true, `detail` 1, `pointerdown` fired.  |
| Tauri MCP `webview_screenshot` vs `screencapture -x`                                   | MCP shows the webview only; system dialogs, notifications and the menu bar appear only in `screencapture`.          |
| lcu `getApp` with the dev bundle id or the binary path                                 | `Invalid app`: lcu cannot attach to the plain `pnpm dev:app` process.                                               |

| Situation                                                                             | Use                                                                                                 |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Webview menus, dialogs, settings pages, colors, layout, editor content                | Tauri MCP only. A synthetic click runs the same handler as a user click.                            |
| Native-menu shortcuts (⌘V, ⌘C, ⌘Z, ⌃⌘F), native menu items, clipboard reads, OS focus | Tauri MCP sets up → `osascript` sends the key or clicks the menu item → Tauri MCP reads the result. |
| Real mouse: hover-only controls, drag and drop, anything that checks `isTrusted`      | `cliclick` at screen coordinates computed from Tauri MCP rects (below).                             |
| Window tab group, fullscreen frames, traffic lights                                   | `osascript` frames + `screencapture`; Tauri MCP reads the tab row DOM the app draws.                |

Do not accept a Tauri MCP event as proof for rows 2–3.

**lcu is not needed for the dev build.** It reaches a debug process only through a hand-made `.app` wrapper (signing, its own Vite), and everything it added here, osascript and cliclick do on the plain `pnpm dev:app` process. Reach for lcu only outside this skill's scope: the installed release (no bridge) or a side-by-side IntelliJ check, and even there osascript + screencapture usually suffice.

### Real input recipes

```bash
P=$(pgrep -f "^$(git rev-parse --show-toplevel)/target/debug/openidea" | head -1)   # this worktree's dev process
# keystroke into the app (focus the right window first, see below)
osascript -e "tell application \"System Events\"" -e "set frontmost of (first process whose unix id is $P) to true" -e "delay 0.5" -e "keystroke \"v\" using command down" -e "end tell"
# native menu: list items, then `click menu item "<name>" of menu "<menu>" of menu bar 1` (verified: Edit → Paste pasted a sentinel)
osascript -e "tell application \"System Events\" to tell (first process whose unix id is $P) to get name of menu items of menu \"Window\" of menu bar 1"
# window frames (screen points)
osascript -e "tell application \"System Events\" to tell (first process whose unix id is $P) to get {name, position, size} of windows"
# real click / drag / move (screen points)
cliclick c:X,Y          # click
cliclick dd:X1,Y1 dm:X2,Y2 du:X2,Y2   # drag
cliclick m:X,Y          # hover
```

- **Bring the target window forward first**: `manage_window action=focus windowId=project-N`. A window in a tab group, or on another Space (fullscreen), is invisible to System Events until then; only the selected tab of a group is an AX window.
- **Coordinates**: screen point = window origin (from `osascript ... position`) + the element's CSS rect center (from `webview_find_element` or `getBoundingClientRect`). The webview fills the window (the toolbar is web content), so no title-bar offset. Verified with the window at (0,0) in fullscreen; recheck the offset once in windowed mode.
- Before a paste test, put a fresh sentinel on the clipboard (`printf 'SENTINEL-%s' $RANDOM | pbcopy`) and read the result through Tauri MCP. Copying inside OpenIDEA hides clipboard bugs.
- `osascript`/`cliclick` drive the real screen: say so to the user first, and don't touch other apps' dialogs (e.g. a "claude wants to control Codex Computer Use" prompt): leave them for the user.

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
- **`manage_window action=list` can miss windows** (it listed 3 of 6, including a new project window). `pnpm dev:status` / `ipc_get_backend_state` has the full list.
- **`webview_dom_snapshot` can fail with "aria-api library not loaded"** in a window whose bridge script was not (re)injected. Fall back to `webview_find_element` or `webview_execute_js` in that window.
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
- Run against the `pnpm dev:app` process itself. A plain `cargo build` binary lacks `devUrl` (blank window), and copying the binary into a `.app` needs `codesign --force --sign -` (else POSIX 162) plus your own Vite; past wrappers cost more time than they saved.
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
2. Stop the `pnpm dev:app` you started (its background task or pid; never `pkill openidea`, the installed app has the same name).
3. `rm -rf /tmp/oi-verify/repo*`; keep `/tmp/oi-verify/evidence`.
4. Free this worktree's build output. If `PATH="$HOME/.cargo/bin:$PATH" cargo -V` mentions `huacnlee` (the Mac mini), only `rm -rf ./target` if you need the space: that cargo keeps the real build output for every worktree of the repo under `~/.cargo/targets/` and trims it itself, and its `cargo clean` deletes that shared directory without a lock, breaking builds running in other worktrees. With a stock cargo, `cargo clean` in `src-tauri` (`target/` grows past 6 GB).

## Feature map

`features/README.md` indexes the fork's user-facing features and how to prove each. Update an entry when a run teaches you something new.
