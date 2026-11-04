/**
 * Fork-owned seam between the Git Graph view (`features/git-graph`) and the vcs feature.
 *
 * Features never import each other, so the graph reaches the vcs feature's menus, diff
 * editor, layout and state only through this service, provided by
 * `features/vcs/gitGraphBridge.ts`. Keeping every upstream dependency behind this one
 * interface means an upstream refactor surfaces as a type error in that provider instead of
 * a rebase conflict across the graph.
 */
import type { Branch, ChangedFile, Commit } from "@/bindings";
import type { MenuItem } from "@/ui";

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
}

export interface GraphRefLabel {
  kind: "head" | "local" | "remote" | "tag";
  /** Branch or tag name. */
  name: string;
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

export interface GitGraphBridge {
  state(): GitGraphRepoState;
  subscribe(listener: () => void): () => void;
  /** Lays out `commits` continuing from `state` (append pages). */
  layout(
    commits: readonly { id: string; parents: readonly string[]; dashed?: readonly boolean[] }[],
    state?: GraphLayoutState,
  ): { rows: GraphLaneRow[]; state: GraphLayoutState };
  laneColor(color: number): string;
  /** A commit's decorations (`HEAD`, `main`, `origin/main`, `tag: v1`) as one label per reference. */
  refLabels(refs: readonly string[], remoteBranches: ReadonlySet<string>): GraphRefLabel[];
  /** The Git Log's commit menu (cherry-pick, rebase, reset, squash, ClipCode…) for `commit`. */
  commitMenu(commit: GraphCommit, selection: GraphCommit[]): Promise<MenuItem[]>;
  /** The Branches popup's menu for a branch of `repo`. */
  branchMenu(branch: Branch, repo: string): Promise<MenuItem[]>;
  tagMenu(tag: string, repo: string): Promise<MenuItem[]>;
  /** The Git Log's changed-files menu for `files` of `commit`. */
  filesMenu(commit: GraphCommit, files: ChangedFile[]): Promise<MenuItem[]>;
  /** Opens the diff of `files[index]` with the others chained (F7 moves along). */
  openDiff(commit: GraphCommit, files: ChangedFile[], index: number, preview?: boolean): Promise<void>;
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
