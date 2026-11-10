# Project window tabs (macOS window groups)

## Sub-features

- Projects opened with **New Tab** (Open project dialog button, or "Open project in: New tab") join the current window's group on every platform; the macOS "Prefer tabs" system preference is not consulted. On macOS a group is a native NSWindow tab group; OpenIDEA hides AppKit's tab bar and draws its own tab row **below the main toolbar** (IntelliJ layout) in both windowed and fullscreen mode (`src-tauri/src/macos.rs`, `src/workbench/WindowGroupTabs.tsx`).
- Switch tab, close on hover, drag to reorder, "Move Tab to New Window".
- Tab context menu: Close Tab, Close Other Tabs, Close Tabs to the Left/Right (`close_tabs` in `src-tauri/src/window_groups.rs`). Tabs close one at a time, each project showing its own unsaved-changes prompt in turn; Cancel stops the rest of the batch, Don't Save continues; the right-clicked tab ends selected. Left/Right are disabled on the first/last tab.
- Joining a group while it is fullscreen: the new tab must fill the screen (minus the notch safe area).

## How to get to it (user POV)

With a project open, open another and pick **New Tab** in the "Open project" dialog (`openProjectWithPolicy` from `src/features/app/windows.ts`; the dialog's buttons are webview DOM). Or open two project windows ("New Window"), then **Window → Merge All Project Windows** (native menu bar; drive it with osascript `click menu item "Merge All Project Windows" of menu "Window" of menu bar 1`). Switch tabs by clicking or ⌥⌘PageDown/PageUp; drag to reorder; tab close button; **Move Tab to New Window**. Fullscreen with the green traffic light, ⌃⌘F, or osascript `click menu item "Enter Full Screen" of menu "View" of menu bar 1` (Tauri MCP `setFullscreen` is not permitted). Groups restore on restart when "Reopen projects on startup" (`general.reopenLastProject`) is on (`docs/workspaces-and-window-groups.md`).

## Driving it with native tools (+ Tauri MCP for the tab row DOM)

- Fixture projects: a few `git init` dirs under `$S/tabs/{alpha,beta,gamma}`.
- Tab row DOM and titles: `webview_dom_snapshot type=accessibility selector='[role=tablist][aria-label="Project windows"]'` (tabs show `[selected]`).
- Window frames (windowed vs fullscreen): osascript `{position, size} of windows`; compare with the screen size.
- Drag reorder: `cliclick dd:/dm:/du:` in screen points computed from the window origin + tab rect; then re-read tab order through Tauri MCP **and** the native order (Window menu lists tabs in order).
- Screenshot with `screencapture -x` (the toolbar must be above the tab row; no AppKit tab bar anywhere).
- In the group's own fullscreen Space, click a page toolbar button with cliclick and check it acted: nothing native covers it. Moving the pointer to the top edge slides the menu bar and the native toolbar down together; they hide again when it leaves (`AutoHideToolbar` in `titlebar.rs`).

## Gotchas

- Use `cliclick` for drags and `screencapture -x` for pixels, fullscreen included.
- AppKit re-installs its tab bar; a fix that looks right once must survive tab switch, new tab, resize, fullscreen enter/exit.
- Joining a fullscreen group used to leave the new window at 1440x900 — recheck this case on every change here. Notched displays are not covered by the Mac mini; note it as untested.
- A new tab keeps its saved window size inside the fullscreen Space (AppKit does not resize it; `match_tab_frames` fills the Space). To test a saved size as wide as the screen (a notched MacBook's usual case, #71) on the Mac mini: stop the app, give the next label (e.g. `project-4`) a frame of 3840 × 1800 physical pixels at 0,0 in the dev data dir's `.window-state.json` (a hidden file), relaunch, and open a project as a new tab from the fullscreen group. Read the frame each second with osascript: it must reach 1920×1080 by itself, not only after a tab or Space switch.
- Also check with the menu bar shown in fullscreen (`defaults write NSGlobalDomain AppleMenuBarVisibleInFullscreen -bool true`, delete the key afterwards): the group is 1920×1050 below the menu bar and must stay so, at 0% CPU (no resize loop), with the page toolbar still clickable by a real cliclick (`titlebar.rs` auto-hides the native toolbar only when the menu bar auto-hides).
- Tabs cannot be dragged out of the window (system tab bar hidden); "Move Tab to New Window" is the path.
- Closing a group with the red traffic light closes every tab at once. With the group as the only window, its first member in label order returns to the Welcome screen and the app keeps running (#194, fixed in #207 after upstream's l0ng-ai/openidea#2130); with another window open, no Welcome screen appears. A member with unsaved changes that is not the first keeps its prompt and stays in front of the Welcome window (#209: `cancel_close` refocuses a member whose close guard still runs); Cancel leaves the Welcome window plus that project's window. With other agents' apps on screen, compare z-order with `CGWindowListCopyWindowInfo` instead of trusting a screenshot. Recheck all of this when a rebase touches `closeGuard.ts`, `window_close_context` or window closing. A first real click on the button may only focus the window.
- Opening several project windows at once (e.g. `Promise.all` over `commands.windowOpenProject(path, true, [])`) must give each a different `project-N` label, without a panic in the dev log (the `CREATING` lock in `windows.rs`, from l0ng-ai/openidea#2124). New windows wait on "Trust and Open Project?", so the call does not return until each is trusted.
- osascript `windows of process` returns only the selected window of a native tab group; count tabs from the tab row DOM or the Window menu.
- The unsaved-changes prompt rarely shows: auto save writes the file on tab switch and focus loss, so a project is clean by the time it closes. To test the prompt, put `[files]` / `autoSave = false` in the fixture's `.openidea/settings.toml` and reopen that project; written while the project is open, it did not take effect.
