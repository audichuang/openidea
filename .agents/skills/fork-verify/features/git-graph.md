# Git Graph (fork editor tab)

## Sub-features

- Commit graph of every branch (`src/features/git-graph/`), lanes from upstream's `computeGraph` through the bridge (`src/workbench/gitGraphBridge.ts` ← `src/features/vcs/gitGraphBridge.ts`).
- Branch filter (all / chosen branches, remote branches on or off), repository switcher with several roots, find with match stepping.
- Details pane: message, hash, parents (click jumps), author, dates, changed files; a file click opens the diff in the preview tab, double-click opens it.
- Menus reused from the vcs feature: commit rows (Git Log commit menu), reference pills (Branches popup branch/tag menu), files (Git Log changes menu).
- Hover on a row dims every other branch line.
- A vcs refresh reloads the graph only when branch tips or tags moved.
- Uncommitted-changes row above HEAD and stash rows above their base (dashed, hollow nodes); fork backend `graph_working_state` / `graph_stashes` (`crates/ide-vcs/src/fork_graph.rs`).
- Bottom pane tabs: Details, File Tree (`graph_tree`, double-click compares the revision with the working file), Reflog (`graph_reflog`), Statistics (`graph_author_stats`, branches/tags/remotes only).
- Tag pills: push to / delete from each remote, delete locally; local branch pills: Set / Unset Upstream (`graph_ref_op`).
- Bisect: select two commits → "Bisect: Bad …, Good …"; banner with Good / Bad / Skip / End Bisect (`graph_bisect`).
- Drag and drop (real pointer only): a branch pill onto the current branch's commit → merge / rebase; the current branch elsewhere → rebase / reset; a commit row onto HEAD → cherry-pick.
- Main toolbar button (title item `gitGraph.open`).

## How to get to it (user POV)

Find Action → "Git Graph" (action `gitGraph.open`, when `vcsAvailable`).

## Driving it

1. Fixture: a repo with two feature branches, a `--no-ff` merge, tags, and one branch with a `/` in its name and no remote (that case once showed as a remote branch).
2. Open it: `import("/src/platform/actions.ts").then(m => m.executeAction("gitGraph.open"))` (same path as Find Action).
3. Rows: `[aria-label="Commits"] [role=row]`; selection is `aria-selected`; files `[aria-label="Changed Files"] [role=listitem]`.
4. Click a reference pill (`button[title="<branch>"]`) for its menu; run "Merge … into …" or a commit menu's "New Tag…", then check `git log` / `git tag` in the fixture and that the graph reloaded on its own.
5. Drag needs real input: `cliclick dd:… dm:… du:…` from a pill's rect to the HEAD row's; assert the `[role=menu]` items, then click one with `cliclick c:` and check `git log`.
6. Bisect: two `click` events (second with `metaKey`) on rows, `contextmenu`, click the Bisect item; the banner is the `[role=status]` inside the Git Graph tab that contains "End Bisect" (the toolbar hides its operation status during a bisect, and the status bar has its own `role=status`): select it by that text, not by position. Check `git bisect log`.
7. Hover needs real input: `cliclick m:X,Y` (window origin + row rect); assert the count of `svg path, circle` with opacity < 0.5 and look at a `screencapture` crop.

## Gotchas

- A Tauri MCP `strategy=text` click on a subject can miss the row; click row coordinates from `getBoundingClientRect` instead.
- Commit and branch menus come from upstream; `src/features/vcs/__tests__/gitGraphBridge.test.ts` pins what the graph relies on. After a rebase, a failure there means upstream changed a reused piece: fix the bridge, not the graph.
