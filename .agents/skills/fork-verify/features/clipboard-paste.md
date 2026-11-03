# Clipboard paste

## Sub-features

Paste into editor, terminal and inputs from: right-click menu, command palette, ⌘V. Text is read through the `clipboard_text` command, not WebKit's clipboard API.

## How to get to it (user POV)

Copy text in another app, then paste in OpenIDEA from each entry above.

## Driving it (Tauri MCP + lcu, verified 2026-11-04 for ⌘V into the editor)

- Launch with `scripts/lcu-wrap.sh up` so lcu and Tauri MCP share one process (SKILL.md, combined recipe).
- Put text on the clipboard from outside the app: `printf 'SENTINEL-%s' $RANDOM | pbcopy`.
- Paste with real input: lcu `app.click(<"Editor for <path>" text area id>)`, `app.pressKey('cmd+v')`. A Tauri MCP (synthetic) paste is not a proof: it skips the native Edit menu and WebKit's clipboard permission check.
- Other entries (right-click Paste, command palette): open the menu with lcu or Tauri MCP, but proof still needs the content to come from `pbcopy`.
- Proof: the sentinel appears in `webview_find_element selector=.cm-content` text (Tauri MCP) or the terminal buffer, and `screencapture -x` shows no WebKit "Paste" bubble.

## Gotchas

- A WebKit "Paste" permission bubble is a product bug (users see it too) → FAIL.
- Copying inside OpenIDEA then pasting hides the bug; always copy from another app.
- Re-test on the installed release build, not only dev.
