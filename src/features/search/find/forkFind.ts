/**
 * Fork: the Find tool window keeps the fork's incremental results tree (`forkFindTree.ts`: an
 * order-statistic tree the list reads row by row, so a search with thousands of files never
 * flattens or re-sorts the whole result per update). Upstream's own streaming tree
 * (l0ng-ai/openidea#5239, v0.1.51) stays behind this flag, as does its `FindSession`. Tests flip
 * it to cover upstream.
 */
import { ForkFindSession } from "./forkFindSession";
import { FindSession, type FindDeps, type FindState } from "./session";

export const forkFind = { upstream: false };

/** The Find session the flag selects: the fork's publishes per frame and copies once per publish. */
export type AnyFindSession = FindSession | ForkFindSession;

export function newFindSession(deps: FindDeps, onChange: (s: FindState) => void): AnyFindSession {
  return forkFind.upstream ? new FindSession(deps, onChange) : new ForkFindSession(deps, onChange);
}

/** The Find tool window module the flag selects. */
export const findToolWindowModule = () =>
  forkFind.upstream ? import("./FindToolWindow") : import("./ForkFindToolWindow");
