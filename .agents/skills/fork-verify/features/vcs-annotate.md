# Annotate with Git Blame

## Sub-features

- Gutter column with date (4-digit year) and author per line.
- Background color per commit. Default mode `order`: IntelliJ new-UI ramp, newest commit darkest (`--vcs-annotate-1..5` in `src/styles/tokens.css`, mixed from `--accent`). Modes `order` / `author` / `none` (`vcs.git.annotateColors`, also in the annotate gutter's right-click menu).
- Close Annotations from the same menus.

## How to get to it (user POV)

- Right-click the editor line-number gutter → "Annotate with Git Blame".
- Right-click a file in the Project tree → "Annotate with Git Blame" (`src/features/project-tree/contextMenu.ts`; exact submenu not yet driven).
- VCS actions / Search Everywhere: "Annotate with Git Blame".

## Driving it with the bridge

1. Fixture repo with commits on different dates and authors:
   ```bash
   R=/tmp/oi-verify/repo; rm -rf $R; mkdir -p $R && cd $R && git init -q -b main
   for i in 1 2 3 4 5 6; do printf 'line from commit %s (%s)\n' $i 1 $i 2 $i 3 >> app.txt; git add app.txt
     GIT_AUTHOR_DATE="2026-0$i-10T10:00:00" GIT_COMMITTER_DATE="2026-0$i-10T10:00:00" git -c user.name=Dev$((i%3)) -c user.email=d@x commit -qm c$i; done
   ```
2. Open it with `openProjectInWindow` and click "Trust Project" (see SKILL.md).
3. Gutter menu:
   ```bash
   node $B js '(() => { const g = document.querySelector(".cm-lineNumbers .cm-gutterElement:nth-child(3)"); const r = g.getBoundingClientRect(); g.dispatchEvent(new MouseEvent("contextmenu", {bubbles: true, cancelable: true, clientX: r.x + 5, clientY: r.y + 5, button: 2})); return "ok" })()' project-N
   node $B js '[...document.querySelectorAll("[role=menuitem]")].find(e => e.textContent.trim() === "Annotate with Git Blame").click() ?? "ok"' project-N
   ```
4. Read colors and text:
   ```bash
   node $B js 'JSON.stringify([...document.querySelectorAll(".cm-vcs-blame .cm-gutterElement")].map(e => [e.className.match(/c\d+/)?.[0], e.textContent.trim(), getComputedStyle(e).backgroundColor]))' project-N
   ```
   Proof: each commit's lines share one class `cN`; `c0` is the newest; colors get lighter (light theme) / closer to the editor background (dark theme) as commits get older. Reference values measured 2026-11-04: light newest ≈ `#a3bef1` (IDEA `#a1bef7`), dark newest ≈ `#2d5198` (IDEA `#2f5194`).
5. Screenshot in light and dark (switch `appearance.theme` via bindings, restore after).

## Gotchas

- The first gutter row is a hidden width-measuring element (`rgba(0,0,0,0)`, text like `2020/12/28Mmmmmmmm`); skip it.
- A repo with fewer than 2 commits (or 2 authors in `author` mode) gets no colors by design (`annotateColorIndexes` in `src/features/vcs/blame.ts`).
- Uncommitted lines have no color.
