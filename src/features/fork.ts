/**
 * Fork-owned features, activated after upstream's (`index.ts` appends this list), so adding
 * one never touches upstream's feature list.
 */
import { activate as gitGraph } from "./git-graph";
import { activate as gitGraphBridge } from "./vcs/gitGraphBridge";

export const forkFeatures: Array<[string, () => void | (() => void)]> = [
  ["vcs-git-graph-bridge", gitGraphBridge],
  ["git-graph", gitGraph],
];
