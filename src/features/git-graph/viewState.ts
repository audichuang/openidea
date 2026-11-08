/** What the Git Graph tab shows, kept while the tab is hidden (switching tabs unmounts it). */
import { create } from "zustand";

export interface GraphViewState {
  /** Chosen repository; null: the vcs feature's selected one. */
  repo: string | null;
  branchFilter: string[];
  showRemotes: boolean;
  /** Selected commit ids and the repository they belong to. */
  selection: { repo: string | null; ids: string[] };
  query: string;
  matchIndex: number;
  /** The bottom pane's tab. */
  panel: GraphPanel;
  /** Revision the File Tree tab lists; null: the selected commit. */
  treeRev: string | null;
  /** The commit graph or the pull request preview below the toolbar. */
  mode: GraphMode;
  /** The PR view's choices per repository root, so another repository's refs never leak in. */
  pr: Record<string, PrChoice>;
}

export type GraphMode = "graph" | "pr";

export interface PrChoice {
  /** Branch, tag or `HEAD` the pull request goes into; null: the default base. */
  base: string | null;
  /** Branch, tag or `HEAD` the pull request comes from; null: the current branch. */
  head: string | null;
  tab: "files" | "commits";
  /** Selected changed file (repository-relative); null: the first one. */
  file: string | null;
}

export type GraphPanel = "details" | "tree" | "reflog" | "stats";

export const initialGraphView = (): GraphViewState => ({
  repo: null,
  branchFilter: [],
  showRemotes: true,
  selection: { repo: null, ids: [] },
  query: "",
  matchIndex: 0,
  panel: "details",
  treeRev: null,
  mode: "graph",
  pr: {},
});

export const useGraphView = create<GraphViewState>(initialGraphView);

const NO_PR_CHOICE: PrChoice = { base: null, head: null, tab: "files", file: null };

export const prChoice = (s: GraphViewState, repo: string): PrChoice => s.pr[repo] ?? NO_PR_CHOICE;

/** Updates `repo`'s PR view choices. */
export function setPrChoice(repo: string, patch: Partial<PrChoice>) {
  useGraphView.setState((s) => ({ pr: { ...s.pr, [repo]: { ...prChoice(s, repo), ...patch } } }));
}
