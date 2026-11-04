# Project window tabs (macOS window groups)

## Sub-features

- Projects opened with **New Tab** (Open project dialog button, or "Open project in: New tab") join the current window's group on every platform; the macOS "Prefer tabs" system preference is not consulted. On macOS a group is a native NSWindow tab group; OpenIDEA hides AppKit's tab bar and draws its own tab row **below the main toolbar** (IntelliJ layout) in both windowed and fullscreen mode (`src-tauri/src/macos.rs`, `src/workbench/WindowGroupTabs.tsx`).
- Switch tab, close on hover, drag to reorder, "Move Tab to New Window".
- Tab context menu: Close Tab, Close Other Tabs, Close Tabs to the Left/Right (`close_tabs` in `src-tauri/src/window_groups.rs`). Tabs close one at a time, each project showing its own unsaved-changes prompt in turn; Cancel stops the rest of the batch, Don't Save continues; the right-clicked tab ends selected. Left/Right are disabled on the first/last tab.
- Joining a group while it is fullscreen: the new tab must fill the screen (minus the notch safe area).

## How to get to it (user POV)

With a project open, open another and pick **New Tab** in the "Open project" dialog (`openProjectWithPolicy` from `src/features/app/windows.ts`; the dialog's buttons are webview DOM). Or open two project windows ("New Window"), then **Window → Merge All Project Windows** (native menu bar; drive it with osascript `click menu item "Merge All Project Windows" of menu "Window" of menu bar 1`). Switch tabs by clicking or ⌥⌘PageDown/PageUp; drag to reorder; tab close button; **Move Tab to New Window**. Fullscreen with the green traffic light or ⌃⌘F. Groups restore on restart when "Reopen projects on startup" (`general.reopenLastProject`) is on (`docs/workspaces-and-window-groups.md`).

## Driving it with native tools (+ Tauri MCP for the tab row DOM)

- Fixture projects: a few `git init` dirs under `$S/tabs/{alpha,beta,gamma}`.
- Tab row DOM and titles: `webview_dom_snapshot type=accessibility selector='[role=tablist][aria-label="Project windows"]'` (tabs show `[selected]`).
- Window frames (windowed vs fullscreen): osascript `{position, size} of windows`; compare with the screen size.
- Drag reorder: `cliclick dd:/dm:/du:` in screen points computed from the window origin + tab rect; then re-read tab order through Tauri MCP **and** the native order (Window menu lists tabs in order).
- Screenshot with `screencapture -x` (the toolbar must be above the tab row; no AppKit tab bar anywhere).

## Gotchas

- Use `cliclick` for drags and `screencapture -x` for pixels, fullscreen included.
- Only the selected tab of a group is an AX window; `manage_window action=focus` the one you need first.
- AppKit re-installs its tab bar; a fix that looks right once must survive tab switch, new tab, resize, fullscreen enter/exit.
- Joining a fullscreen group used to leave the new window at 1440x900 — recheck this case on every change here. Notched displays are not covered by the Mac mini; note it as untested.
- Tabs cannot be dragged out of the window (system tab bar hidden); "Move Tab to New Window" is the path.
- osascript `windows of process` returns only the selected window of a native tab group; count tabs from the tab row DOM or the Window menu.
- The unsaved-changes prompt rarely shows: auto save writes the file on tab switch and focus loss, so a project is clean by the time it closes. To test the prompt, put `[files]` / `autoSave = false` in the fixture's `.openidea/settings.toml` and reopen that project; written while the project is open, it did not take effect.
