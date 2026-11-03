# OpenIDEA feature map

One file per user-facing feature: what it is, how a user reaches it, how to drive it, what proves it. Driver names refer to `../SKILL.md` (MCP = `mcp__tauri__*`; lcu = `mcp__lcu__js` on the `lcu-wrap.sh` app; native = screencapture/osascript/cliclick).

| Feature                                                       | File                                     | Driver       |
| ------------------------------------------------------------- | ---------------------------------------- | ------------ |
| Annotate with Git Blame (gutter colors, dates, color modes)   | [vcs-annotate.md](vcs-annotate.md)       | bridge       |
| Project window tabs (macOS window groups, fullscreen)         | [window-tabs.md](window-tabs.md)         | native + MCP |
| Auto fetch / incoming check                                   | [vcs-auto-fetch.md](vcs-auto-fetch.md)   | bridge       |
| Theme switching (light / dark / high contrast / color themes) | [themes.md](themes.md)                   | bridge       |
| Clipboard paste into editor/terminal                          | [clipboard-paste.md](clipboard-paste.md) | bridge + lcu |
