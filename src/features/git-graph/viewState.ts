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
});

export const useGraphView = create<GraphViewState>(initialGraphView);
