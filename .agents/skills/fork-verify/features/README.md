# OpenIDEA feature map

One file per user-facing feature: what it is, how a user reaches it, how to drive it, what proves it. Driver names refer to `../SKILL.md` (MCP = `mcp__tauri__*`; native = osascript/cliclick/screencapture for real input and AppKit).

| Feature                                                       | File                                     | Driver       |
| ------------------------------------------------------------- | ---------------------------------------- | ------------ |
| Annotate with Git Blame (gutter colors, dates, color modes)   | [vcs-annotate.md](vcs-annotate.md)       | MCP          |
| Project window tabs (macOS window groups, fullscreen)         | [window-tabs.md](window-tabs.md)         | native + MCP |
| Auto fetch / incoming check                                   | [vcs-auto-fetch.md](vcs-auto-fetch.md)   | MCP          |
| Theme switching (light / dark / high contrast / color themes) | [themes.md](themes.md)                   | MCP          |
| Clipboard paste into editor/terminal                          | [clipboard-paste.md](clipboard-paste.md) | MCP + native |
| Git Graph editor tab (graph, details, menus, hover)           | [git-graph.md](git-graph.md)             | MCP + native |

Not mapped yet, so plan them from source: Git staging mode (`src/features/vcs/staging.ts`; what a rebase must keep is in `FORK.md`, Rebase conflicts) and the updater (`src-tauri/src/fork_updater.rs`; the fork endpoint is injected only by release builds, so endpoint checks need a candidate build).
