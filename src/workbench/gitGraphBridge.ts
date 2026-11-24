/**
 * Fork-owned seam between the Git Graph view (`features/git-graph`) and the vcs feature.
 *
 * Features never import each other, so the graph reaches the vcs feature's menus, diff
 * editor, layout and state only through this service, provided by
 * `features/vcs/gitGraphBridge.ts`. Keeping every upstream dependency behind this one
 * interface means an upstream refactor surfaces as a type error in that provider instead of
 * a rebase conflict across the graph.
 */
import type { ComponentType } from "react";
import type { Branch, ChangedFile, Commit, GraphStash } from "@/bindings";
import type { MenuItem } from "@/ui";
import type { EditorInput } from "./contributions";

/** A commit of the graph, tagged with its repository root. */
export type GraphCommit = Commit & { repo: string };

/** One row of the lane layout: the node and the edges entering (`up`) and leaving (`down`) it. */
export interface GraphLaneRow {
  lane: number;
  /** Colour index; stable along one branch line, so it doubles as the line's identity. */
  color: number;
  up: GraphLaneSegment[];
  down: GraphLaneSegment[];
  width: number;
}

export interface GraphLaneSegment {
  from: number;
  to: number;
  color: number;
  dashed?: true;
  /** The edge continues out of sight this way: its long straight middle is hidden. */
  arrow?: "up" | "down";
  /**
   * With `arrow`: the row at the edge's other end (its index in the laid-out list); at or past the
   * list's end (or -1) when that row is not loaded.
   */
  targetRow?: number;
  /** Drawn lane positions when they differ from `from` / `to` (a lane change drawn as one diagonal). */
  fromX?: number;
  toX?: number;
}

export interface GraphRefLabel {
  kind: "head" | "local" | "remote" | "tag";
  /** Branch or tag name. */
  name: string;
}

/** One side of a two-revision comparison: what git reads and what the diff header shows. */
export interface GraphRevisionSide {
  rev: string;
  label: string;
}

export interface GraphLayoutState {
  readonly _layout: unknown;
}

export interface GitGraphRepoState {
  /** Repository roots, the project's own first. */
  roots: string[];
  /** The repository the vcs feature has selected. */
  repo: string | null;
  /** Root → current branch (null: detached) and HEAD commit. */
  heads: Record<string, { head: string | null; headCommit: string | null }>;
  /** Root → merge / rebase / cherry-pick / revert in progress. */
  operations: Record<string, string>;
  /** Bumped after each vcs refresh (commit, checkout, fetch…): the graph reloads on change. */
  version: number;
}

/** Props of the Git Log's branch filter popup as the graph's toolbar uses it. */
export interface GraphBranchFilterProps {
  anchor: HTMLElement;
  /** The repository whose branches are listed (favorites are per repository). */
  repo: string;
  branches: readonly Branch[];
  selected: readonly string[];
  /** A branch (or `HEAD`) picked from the list. */
  onSelect(branch: string): void;
  /** The result of the Select… multi-choice dialog. */
  onSelectMany(branches: string[]): void;
  onClose(): void;
}

/** Moving along the files of an embedded revision diff (`GitGraphBridge.revisionDiffInput`). */
export interface GraphDiffNavigation {
  files: readonly ChangedFile[];
  /** Select the first or last difference once shown (after moving along the files). */
  reveal?: "first" | "last";
  onNeighbour(file: ChangedFile, reveal: "first" | "last"): void;
}

export interface GitGraphBridge {
  state(): GitGraphRepoState;
  subscribe(listener: () => void): () => void;
  /** Lays out `commits` continuing from `state` (append pages). */
  layout(
    commits: readonly { id: string; parents: readonly string[]; dashed?: readonly boolean[] }[],
    state?: GraphLayoutState,
  ): { rows: GraphLaneRow[]; state: GraphLayoutState };
  /**
   * The Git Log's default presentation of `layout`'s rows for the whole list: long straight
   * edges hidden behind arrows, lanes packed, lane changes drawn as diagonals. Same row count.
   */
  present(rows: readonly GraphLaneRow[]): GraphLaneRow[];
  /**
   * A function returning `present(layout(commits).rows)`. A call whose `commits` start with the
   * previous call's (a page appended) reuses that work: its cost follows the new commits, not the
   * whole list. One per view. Pass plain `{ id, parents, dashed }` objects: a commit carrying
   * `refs` (a `GraphCommit`) changes the layout and breaks the reuse.
   */
  presenter(): (
    commits: readonly { id: string; parents: readonly string[]; dashed?: readonly boolean[] }[],
  ) => GraphLaneRow[];
  laneColor(color: number): string;
  /** `root`'s colour among `roots`, as the Git tool window shows it; null with a single repository. */
  repoColor(root: string, roots: readonly string[]): string | null;
  /** A commit's decorations (`HEAD`, `main`, `origin/main`, `tag: v1`) as one label per reference. */
  refLabels(refs: readonly string[], remoteBranches: ReadonlySet<string>): GraphRefLabel[];
  /** The Git Log's commit menu (cherry-pick, rebase, reset, squash, ClipCode…) for `commit`. */
  commitMenu(commit: GraphCommit, selection: GraphCommit[]): Promise<MenuItem[]>;
  /** The Branches popup's menu for a branch of `repo`. */
  branchMenu(branch: Branch, repo: string): Promise<MenuItem[]>;
  tagMenu(tag: string, repo: string): Promise<MenuItem[]>;
  /** The Git Log's searchable branch filter: HEAD, then Local and Remote, favorites first. */
  BranchFilterPopup: ComponentType<GraphBranchFilterProps>;
  /** The Git Log's changed-files menu for `files` of `commit`. */
  filesMenu(commit: GraphCommit, files: ChangedFile[]): Promise<MenuItem[]>;
  /** Opens the diff of `files[index]` with the others chained (F7 moves along). */
  openDiff(commit: GraphCommit, files: ChangedFile[], index: number, preview?: boolean): Promise<void>;
  /**
   * The diff viewer's input for `file` changed between `from` and `to`, embedded and read-only.
   * With `nav`, `files` are its chain: F7 past the last difference calls `onNeighbour` with the
   * next changed file (and which difference to select) instead of opening an editor tab.
   */
  revisionDiffInput(
    repo: string,
    from: GraphRevisionSide,
    to: GraphRevisionSide,
    file: ChangedFile,
    nav?: GraphDiffNavigation,
  ): EditorInput;
  /** Opens the diff of `files[index]` between `from` and `to` in an editor tab, the others chained. */
  openRevisionDiff(
    repo: string,
    from: GraphRevisionSide,
    to: GraphRevisionSide,
    files: ChangedFile[],
    index: number,
  ): Promise<void>;
  /** ClipCode: the files changed between `base` and `tip` (Copy Changed Files); false when nothing was copied. */
  copyRange(repo: string, base: string, tip: string): Promise<boolean>;
  /** `path` (repository-relative) at `rev` compared with the working file. */
  openRevisionFile(repo: string, rev: string, path: string): Promise<void>;
  /** Unstash Changes entries for `stash` of `repo` (apply, pop, the dialog, drop). */
  stashMenu(stash: GraphStash, repo: string): MenuItem[];
  /** Continue / Abort of the merge, rebase, cherry-pick or revert `repo` stopped in. */
  controlOperation(repo: string, control: "continue" | "abort", operation: string): Promise<void>;
  /** The Conflicts dialog, with `repo` selected so it concludes that repository's operation. */
  resolveConflicts(repo: string): Promise<void>;
  /** The Stash Changes dialog starting on `repo`. */
  stashChanges(repo: string): void;
  /** The Rollback dialog with `repo`'s changes. */
  rollback(repo: string): void;
  /** The Git Log, with `repo` selected. */
  showLog(repo: string): Promise<void>;
  /** Merges `branch` into `repo`'s current branch, with the vcs feature's conflict handling. */
  mergeIntoCurrent(branch: string, repo: string): Promise<void>;
  /** Rebases `repo`'s current branch onto `branch` (a branch, tag or commit id). */
  rebaseCurrentOnto(branch: string, repo: string): Promise<void>;
  /**
   * Runs a git operation with the vcs feature's console log, notifications and refresh
   * afterwards; resolves to undefined when it failed (already reported).
   */
  runOp<T>(title: string, fn: () => Promise<T>, success?: string): Promise<T | undefined>;
  /** The vcs feature's confirmation dialog. */
  confirm(opts: { title: string; message: string; okLabel?: string; danger?: boolean }): Promise<boolean>;
  /** The vcs feature's one-field prompt; null when cancelled. */
  prompt(opts: { title: string; label: string; initial?: string; okLabel?: string }): Promise<string | null>;
}

let bridge: GitGraphBridge | null = null;

export function provideGitGraphBridge(b: GitGraphBridge): () => void {
  bridge = b;
  return () => {
    if (bridge === b) bridge = null;
  };
}

export function gitGraphBridge(): GitGraphBridge | null {
  return bridge;
}
