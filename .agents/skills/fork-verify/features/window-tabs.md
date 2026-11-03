# Project window tabs (macOS window groups)

## Sub-features

- Projects opened "in the same window" join a native NSWindow tab group; OpenIDEA hides AppKit's tab bar and draws its own tab row **below the main toolbar** (IntelliJ layout) in both windowed and fullscreen mode (`src-tauri/src/macos.rs`, `src/workbench/WindowGroupTabs.tsx`).
- Switch tab, close on hover, drag to reorder, "Move Tab to New Window".
- Joining a group while it is fullscreen: the new tab must fill the screen (minus the notch safe area).

## How to get to it (user POV)

Open two project windows (Open → "New Window" in the "Open project" dialog), then **Window → Merge All Project Windows** (native menu bar; drive it with osascript `click menu item "Merge All Project Windows" of menu "Window" of menu bar 1`). Switch tabs by clicking or ⌥⌘PageDown/PageUp; drag to reorder; tab close button; **Move Tab to New Window**. Fullscreen with the green traffic light or ⌃⌘F. Groups restore on restart when "Reopen last project" is on (`docs/workspaces-and-window-groups.md`).

## Driving it with native tools (+ Tauri MCP for the tab row DOM)

- Fixture projects: a few `git init` dirs under `/tmp/oi-verify/tabs/{alpha,beta,gamma}`.
- Tab row DOM and titles: `webview_dom_snapshot type=accessibility selector='[role=tablist][aria-label="Project windows"]'` (tabs show `[selected]`).
- Window frames (windowed vs fullscreen): osascript `{position, size} of windows`; compare with the screen size.
- Drag reorder: `cliclick dd:/dm:/du:` in screen points computed from the window origin + tab rect; then re-read tab order through Tauri MCP **and** the native order (Window menu lists tabs in order).
- Screenshot with `screencapture -x` (the toolbar must be above the tab row; no AppKit tab bar anywhere).

## Gotchas

- Use `cliclick` for drags (lcu `drag` returned `noWindowsAvailable`) and `screencapture -x` for pixels (fullscreen captures from other tools were stale).
- Only the selected tab of a group is an AX window; `manage_window action=focus` the one you need first.
- AppKit re-installs its tab bar; a fix that looks right once must survive tab switch, new tab, resize, fullscreen enter/exit.
- Joining a fullscreen group used to leave the new window at 1440x900 — recheck this case on every change here. Notched displays are not covered by the Mac mini; note it as untested.
- Tabs can no longer be dragged out of the window (system tab bar hidden); "Move Tab to New Window" is the path.
