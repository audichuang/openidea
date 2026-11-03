---
name: fork-verify
description: Fork supplement to the upstream `verify` skill for proving OpenIDEA changes on macOS. Use it when the `mcp__tauri__*` tools are not loaded (drives the same MCP bridge from Bash with scripts/bridge.ts), when a check needs real OS input (keyboard shortcuts, clipboard paste, hover, native menus) through lcu on a wrapped dev .app, when it touches AppKit chrome (project window tabs, fullscreen, traffic lights), or when testing fork features (Annotate colors, window groups, auto fetch, clipboard). Says which driver to pick and how to combine bridge and lcu.
---

# Verify OpenIDEA in the real app (fork, macOS)

Upstream's `verify` skill (`.agents/skills/verify`) is the base: launch and session reuse, driving through `mcp__tauri__*`, CodeMirror/xterm input quirks, `fixtures/`, evidence naming. Read it first. This skill adds what it does not cover:

- `scripts/bridge.ts`: the same bridge from Bash, for sessions without the `mcp__tauri__*` tools.
- lcu plus `scripts/lcu-wrap.sh`, for real OS input on the dev build.
- AppKit chrome (window tabs, fullscreen) and the fork's feature map (`features/`).

Upstream quirks that also apply to `bridge.ts`:

- `.click()` arrives with `event.detail === 0`, and CodeMirror treats that as a line-select click. Set the caret through `document.querySelector('.cm-content').cmTile.view`.
- Type into CodeMirror with `document.execCommand('insertText', false, text)`.
- Background windows throttle timers. Unfocused but visible windows screenshotted fine on 2026-11-04. If a screenshot comes back black or an `execute_js` promise times out, focus the window first (`osascript` `activate`, or lcu click).

## Choosing the driver: bridge, lcu, or both

Two drivers see different layers of the same app:

|            | **Bridge** (`scripts/bridge.ts`, tauri-plugin-mcp-bridge)                                                                      | **lcu** (`mcp__lcu__js`, see the `lcu-desktop` skill)                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Builds     | Debug only (`#[cfg(debug_assertions)]` in `src-tauri/src/lib.rs`). The installed release has no bridge.                        | Any `.app`: dev wrapper, installed release, IntelliJ for side-by-side comparison.                                                                            |
| Sees       | The webview: DOM, computed styles, app state through `import("/src/...")`, a PNG of one window, even behind other windows.     | What macOS sees: AX tree of the whole app, native menu bar, native dialogs, real screen pixels.                                                              |
| Input      | JS: `.click()` and `dispatchEvent`, so `isTrusted === false`. Does not move the mouse, focus the window, or go through AppKit. | Real mouse and keyboard events through macOS: shortcuts, hover, focus, native menus.                                                                         |
| Setup      | `pnpm dev:app`, then `pnpm dev:status`. Nothing else.                                                                          | Needs a `.app` path: wrap the debug binary, `codesign`, run vite yourself (see "lcu wrapper" below). Takes the screen, keyboard and clipboard while it runs. |
| Weak spots | Blind to window tabs, fullscreen, traffic lights, native menus and dialogs, OS clipboard permission bubbles.                   | Slow `getApp` (thousands of tokens). `drag` fails on this app (`noWindowsAvailable`). Screenshots go stale or offset in fullscreen. Cannot read CSS values.  |

**Rule:** the bridge sets up and asserts, a real input source performs the gesture under test.

- **Bridge only (default):** the behavior lives in the webview and a synthetic click is the same code path as a user click. Examples: menus, dialogs and settings pages drawn by the webview, colors, layout, editor content. Annotate (2026-11-04) was proven this way end to end.
- **Bridge + real input (lcu, or `osascript`/`cliclick`):** the path depends on a real OS event. Examples: keyboard shortcuts routed through the native menu (⌘V, ⌃⌘F), clipboard reads (a WebKit "Paste" bubble only appears for real input), hover-only controls, drag and drop, focus. Use the bridge to open fixtures and switch settings, lcu to press the key or click, then the bridge again to read the result (editor text, DOM state, computed style). Pixels go in `screencapture -x`.
- **Native tools only:** AppKit chrome (window tab groups, fullscreen frames, traffic lights, the Window menu). Use `osascript` for frames and menu items, `cliclick` for drags, `screencapture` for pixels. The bridge still reads the tab row DOM if the app draws it.
- **lcu only:** the installed release build (no bridge), or comparing behavior with IntelliJ.

**One instance per identifier.** The dev identifier is single-instance (`tauri_plugin_single_instance` in `lib.rs`), so either `pnpm dev:app` runs or the lcu wrapper runs, never both. The wrapper carries the same debug binary, so the bridge keeps working inside it: lcu and the bridge drive one process (verified 2026-11-04, see the combined recipe below).

### Combined recipe: bridge + lcu on one process

```bash
# 1. build once, then stop it (it owns the single instance)
PATH="$HOME/.cargo/bin:$PATH" CARGO_PROFILE_DEV_DEBUG=0 pnpm dev:app > /tmp/oi-dev.log 2>&1   # background; stop after `pnpm dev:status` shows a bridge
# 2. relaunch as a signed .app with its own vite (reads identifier/devUrl from the log)
.agents/skills/fork-verify/scripts/lcu-wrap.sh up /tmp/oi-dev.log      # prints the .app path
pnpm -s dev:status                                                 # bridge answers again
```

Then in lcu: `globalThis.app = await cua.getApp('<printed .app path>')`. Proven flow (clipboard paste): bridge opens the fixture and clicks "Trust Project" → Bash `printf 'SENTINEL-%s' $RANDOM | pbcopy` → lcu `app.click(<editor text area id>)`, `app.pressKey('cmd+v')` → bridge `document.querySelector(".cm-content").innerText` contains the sentinel → `screencapture -x` shows no WebKit "Paste" bubble. Finish with `lcu-wrap.sh down` (quits the wrapper app, stops its vite by port, deletes the wrapper).

Notes from that run:

- lcu `pressKey` rejected `cmd+end` and `cmd+down` (`keyNotFound`); check names with `cua.rewriteDocumentation()` before using navigation keys.
- The AX tree exposes the project tab row as `tab group Project windows` and the editor as `text entry area ... Editor for <path>`; webview widgets have AX names, so lcu can click them by id without coordinates.
- A macOS consent dialog from another app (e.g. "claude wants to control Codex Computer Use") can appear on top; leave it for the user, it does not block OpenIDEA input.
- After a Rust rebuild, run `lcu-wrap.sh down` and `up` again: the wrapper holds a copy of the old binary.

Do not drive webview UI through lcu coordinates when the bridge can address it by text or selector. Do not assert on bridge clicks for anything listed under real input.

## Launch

From the repo (or worktree) root:

```bash
PATH="$HOME/.cargo/bin:$PATH" CARGO_PROFILE_DEV_DEBUG=0 pnpm dev:app > /tmp/oi-dev.log 2>&1   # run_in_background
```

- The agent shell lacks `~/.cargo/bin`; without it the build dies at `cargo metadata`.
- First build takes ~5–10 min. Wait with a background `until grep -q "Running .*target/debug/openidea" /tmp/oi-dev.log; do sleep 3; done` (also grep `^error` so a failed build doesn't hang the wait).
- Ready = `pnpm dev:status` lists a bridge (step below), not just the Running line.
- It is a per-worktree identity: `ai.l0ng.openidea.dev.w<hash>` with its own data dir `~/Library/Application Support/<identifier>/`. The user's installed OpenIDEA and its settings are untouched, so a dev instance can run beside it. Two worktrees can run side by side; do not start a second `dev:app` in the same worktree.
- Vite hot-reloads frontend edits into the running app. Rust edits rebuild and restart it, which closes the windows you set up.
- This Mac mini is short on disk: only build locally when you must touch the UI; Rust tests/clippy go through `rust-remote` (see the user's global CLAUDE.md).

## Doctor

```bash
pnpm -s dev:status
```

Healthy: JSON with `bridges[0].port` (9223+), `app.identifier` equal to `identifier`, and the `windows` you expect. Exit 1 with "No MCP bridge found" = still compiling, crashed (read `/tmp/oi-dev.log`), or another worktree's app owns the port.

## Drive (bridge)

`scripts/bridge.ts` finds this worktree's port through `dev:status` (override with `OI_BRIDGE_PORT`). Every command prints the bridge JSON; exit code 1 on failure.

```bash
B=.agents/skills/fork-verify/scripts/bridge.ts
node $B windows                                   # labels: main, project-1, ...
node $B js '<expression or promise>' <label>      # result in "data" (strings; JSON.stringify objects)
node $B shot /tmp/oi-verify/evidence/x.png <label> # PNG of that window, 1440 wide
```

Read the PNG with the Read tool and look at it. Also read the numbers (`getComputedStyle`, text) — a screenshot alone hides small color/spacing differences.

Recipes that worked (2026-11-04):

- **Open a fixture project + file** (setup step; the user path is the Welcome screen "Open" button, which opens a native dialog):
  ```bash
  node $B js 'import("/src/features/app/windows.ts").then(m => m.openProjectInWindow("/tmp/oi-verify/repo", false, ["/tmp/oi-verify/repo/app.txt"])).then(() => "ok")' main
  ```
  A new window `project-N` appears with a webview **"Trust and Open Project?"** dialog. Click it by text:
  ```bash
  node $B js '[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Trust Project").click() ?? "ok"' project-N
  ```
- **Context menus** (gutter, project tree, tabs) are webview menus: dispatch `contextmenu` on the element, then click `[role=menuitem]` by text. Gutter example: `document.querySelector(".cm-lineNumbers .cm-gutterElement:nth-child(3)")`.
- **Settings** go through the generated bindings, the same call the Settings page makes:
  ```bash
  node $B js 'import("/src/bindings.ts").then(m => m.commands.settingsSet("global", "appearance.theme", JSON.stringify("dark"))).then(r => r.status)' project-N
  ```
  Keys live in `src/platform/clientSettings.ts` / `workflowSettings.ts`. Put the value back afterwards — the dev data dir persists between runs.
- `node $B invoke` only reaches **plugin** commands (`plugin:mcp-bridge|...`); app commands return "Unsupported Tauri command". Use the bindings import above instead.
- Vite serves source modules, so `import("/src/...")` works only in the dev build.

Prefer the user's real path for the behavior under test (click the menu item, not the store setter); internal imports are fine for setup (opening a fixture, switching theme).

## Drive (native AppKit and lcu)

For window tabs, fullscreen and other chrome the bridge cannot see:

- Window frames: `osascript -e 'tell application "System Events" to tell (first process whose unix id is <pid>) to get {position, size} of windows'`. Fullscreen frame should equal the screen (minus notch safe area on notched displays).
- Screenshots: `screencapture -x /tmp/oi-verify/evidence/x.png` (whole screen; lcu screenshots in fullscreen were stale/offset).
- Drags: `cliclick dd:x,y dm:x,y du:x,y` in screen points. lcu `drag` returns `noWindowsAvailable` on this app.
- **lcu wrapper**: use `scripts/lcu-wrap.sh up|down` (combined recipe above). It handles what failed by hand before: plain `cargo build` binaries lack `devUrl` (blank window), an unsigned copy fails with POSIX 162, a wrapper under `/tmp` made `getApp` hang, and stopping tauri dev also stops its vite.
- AppKit view trees: lldb attach hangs (Developer mode off). Temporarily `eprintln!` `_subtreeDescription` behind an env var, and remove it before committing.
- Private-API behavior (e.g. `_setTabBarAccessoryViewController:`) can only be judged live: AppKit re-applies state on its own run loop, so one call that "works" can be undone a frame later. Recheck after a resize, a tab switch, entering and leaving fullscreen.
- When something looks broken, `git stash` and check the baseline before assuming your change caused it.

## Evidence

Put proof in `/tmp/oi-verify/evidence/<task>/` (cleanup never deletes it):

- Before/after screenshots of the window under test, plus the numbers that matter (computed colors, frames, text) saved as `.json`/`.txt`.
- Cover every entry the feature map lists for the feature (menu, shortcut, command palette), and both light and dark themes for anything colored.
- Side effects checked directly: files on disk, `git` state of the fixture repo, settings in the dev data dir.
- Report each case PASS/FAIL with the screenshot path. A WebKit permission bubble or a dialog the user would also see is a FAIL, not a test limitation.

## Cleanup

1. Restore any setting you changed (theme etc.) through the same bindings call.
2. Stop the `pnpm dev:app` you started (the background task / its pid — never `pkill openidea`, the user's installed app has the same name). Stopping tauri dev also stops its vite.
3. Remove fixtures: `rm -rf /tmp/oi-verify/repo*` (keep `/tmp/oi-verify/evidence`). If you used the wrapper, `scripts/lcu-wrap.sh down` (removes `~/Applications/OpenIDEA-verify-<worktree>.app` and its vite).
4. `cargo clean` in `src-tauri` (the Mac mini rule; `target/` grows to tens of GB).

## Feature map

`features/README.md` indexes the user-facing features and how to prove each. Update the entry when a run teaches you something new.
