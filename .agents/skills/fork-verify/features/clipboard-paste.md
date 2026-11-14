# Clipboard paste

## Sub-features

Paste into editor, terminal and inputs from: right-click menu, command palette, ⌘V (native Edit → Paste, a WebKit paste event). Menu and command-palette pastes read text through the `clipboard_text` command instead of WebKit's clipboard API, which would show the "Paste" callout.

## How to get to it (user POV)

Copy text in another app, then paste in OpenIDEA from each entry above.

## Driving it (Tauri MCP + osascript, verified 2026-11-04 for ⌘V into the editor)

- Open the fixture with Tauri MCP, then `manage_window action=focus windowId=project-N` so System Events sees that window.
- Put text on the clipboard from outside the app: `printf 'SENTINEL-%s' $RANDOM | pbcopy`.
- Paste with real input: `osascript` frontmost + `keystroke "v" using command down` (SKILL.md recipes). A Tauri MCP `webview_keyboard press v Meta` pastes nothing: ⌘V is the native Edit → Paste item.
- Other entries: native Edit → Paste via `osascript click menu item "Paste" of menu "Edit"`; the webview right-click menu and command palette can be opened with Tauri MCP, but the content must still come from `pbcopy`.
- Proof: the sentinel appears in `webview_find_element selector=.cm-content` text (or the terminal buffer), and `screencapture -x` shows no WebKit "Paste" bubble.

## Gotchas

- A WebKit "Paste" permission bubble is a product bug (users see it too) → FAIL.
- Copying inside OpenIDEA then pasting hides the bug; always copy from another app.
- Re-test on the installed release build, not only dev.
