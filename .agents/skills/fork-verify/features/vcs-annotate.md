# Annotate with Git Blame

## Sub-features

- Gutter column with date (4-digit year) and author per line.
- Background color per commit. Default mode `order`: IntelliJ new-UI ramp, newest commit darkest (`--vcs-annotate-1..5` in `src/styles/tokens.css`, mixed from `--accent`). Modes `order` / `author` / `none` (`vcs.git.annotateColors`, also in the annotate gutter's right-click menu).
- Close Annotations from the same menus.

## How to get to it (user POV)

- Right-click the editor line-number gutter → "Annotate with Git Blame".
- Right-click a file in the Project tree → "Annotate with Git Blame" (`src/features/project-tree/contextMenu.ts`; exact submenu not yet driven).
- VCS actions / Search Everywhere: "Annotate with Git Blame".
- Click the author hint above a declaration (code vision, `src/editor/lsp/codeLens.ts`) → toggles annotations for that file. On by default (Settings › Editor › Inlay Hints › Code Vision › Code author). It only shows on declarations the outline finds in a git-tracked file, so not on the plain-text `app.txt` fixture below; not yet driven.

## Driving it with Tauri MCP

1. Fixture repo with commits on different dates and authors:
   ```bash
   R="$S/repo"; rm -rf $R; mkdir -p $R && cd $R && git init -q -b main
   for i in 1 2 3 4 5 6; do printf 'line from commit %s (%s)\n' $i 1 $i 2 $i 3 >> app.txt; git add app.txt
     GIT_AUTHOR_DATE="2026-0$i-10T10:00:00" GIT_COMMITTER_DATE="2026-0$i-10T10:00:00" git -c user.name=Dev$((i%3)) -c user.email=d@x commit -qm c$i; done
   ```
2. Open it with `openProjectInWindow` and trust it (SKILL.md recipes).
3. `webview_interact action=right-click windowId=project-N selector=".cm-lineNumbers .cm-gutterElement:nth-child(3)"`, then `webview_interact action=click strategy=text selector="Annotate with Git Blame"`.
4. `webview_find_element selector=".cm-vcs-blame .cm-vcs-blame-colored" properties=["background-color"] limit=20`.
   Proof: each commit's lines share one `cm-vcs-blame-cN` class (N spread over 0–20, not consecutive); `cm-vcs-blame-c0` is the newest; colors get lighter (light theme) / closer to the editor background (dark theme) as commits get older. Reference values measured 2026-11-04: light newest ≈ `#a3bef1` (IDEA `#a1bef7`), dark newest ≈ `#2d5198` (IDEA `#2f5194`).
5. `webview_screenshot` in light and dark (switch `appearance.theme` via the bindings recipe, restore after).

## Gotchas

- The gutter also holds a hidden width-measuring row (text like `2020/12/28Mmmmmmmm`, no color); selecting `.cm-vcs-blame-colored` skips it.
- A repo with fewer than 2 commits (or 2 authors in `author` mode) gets no colors by design (`annotateColorIndexes` in `src/features/vcs/blame.ts`).
- Uncommitted lines have no color.
