/**
 * Fork: the Find tool window keeps the fork's incremental results tree (`forkFindTree.ts`: an
 * order-statistic tree the list reads row by row, so a search with thousands of files never
 * flattens or re-sorts the whole result per update). Upstream's own streaming tree
 * (l0ng-ai/openidea#5239, v0.1.51) stays behind this flag. Tests flip it to cover upstream.
 */
export const forkFind = { upstream: false };

/** The Find tool window module the flag selects. */
export const findToolWindowModule = () =>
  forkFind.upstream ? import("./FindToolWindow") : import("./ForkFindToolWindow");
