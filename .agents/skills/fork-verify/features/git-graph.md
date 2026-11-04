# Git Graph (fork editor tab)

## Sub-features

- Commit graph of every branch (`src/features/git-graph/`), lanes from upstream's `computeGraph` through the bridge (`src/workbench/gitGraphBridge.ts` ← `src/features/vcs/gitGraphBridge.ts`).
- Branch filter (all / chosen branches, remote branches on or off), repository switcher with several roots, find with match stepping.
- Details pane: message, hash, parents (click jumps), author, dates, changed files; a file click opens the diff in the preview tab, double-click opens it.
- Menus reused from the vcs feature: commit rows (Git Log commit menu), reference pills (Branches popup branch/tag menu), files (Git Log changes menu).
- Hover on a row dims every other branch line.
- A vcs refresh reloads the graph only when branch tips or tags moved.

## How to get to it (user POV)

Find Action → "Git Graph" (action `gitGraph.open`, when `vcsAvailable`).

## Driving it

1. Fixture: a repo with two feature branches, a `--no-ff` merge, tags, and one branch with a `/` in its name and no remote (that case once showed as a remote branch).
2. Open it: `import("/src/platform/actions.ts").then(m => m.executeAction("gitGraph.open"))` (same path as Find Action).
3. Rows: `[aria-label="Commits"] [role=row]`; selection is `aria-selected`; files `[aria-label="Changed Files"] [role=listitem]`.
4. Click a reference pill (`button[title="<branch>"]`) for its menu; run "Merge … into …" or a commit menu's "New Tag…", then check `git log` / `git tag` in the fixture and that the graph reloaded on its own.
5. Hover needs real input: `cliclick m:X,Y` (window origin + row rect); assert the count of `svg path, circle` with opacity < 0.5 and look at a `screencapture` crop.

## Gotchas

- A Tauri MCP `strategy=text` click on a subject can miss the row; click row coordinates from `getBoundingClientRect` instead.
- Commit and branch menus come from upstream; `src/features/vcs/__tests__/gitGraphBridge.test.ts` pins what the graph relies on. After a rebase, a failure there means upstream changed a reused piece: fix the bridge, not the graph.
