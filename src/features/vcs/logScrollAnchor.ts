import { commitKey, type RepoCommit } from "./multiRoot";

/**
 * Rows to move the Log's scroll position by after its commits were replaced, so the first
 * row at or below `top` that is still listed stays where it was; null when none is.
 * One lookup table, not a search of `commits` per row: a checkout to an older commit drops
 * tens of thousands of leading rows, and the per-row search froze the window for minutes.
 */
export function survivingRowShift(
  previous: readonly RepoCommit[],
  commits: readonly RepoCommit[],
  top: number,
): number | null {
  if (top >= previous.length) return null;
  const index = new Map<string, number>();
  commits.forEach((c, i) => {
    const key = commitKey(c);
    if (!index.has(key)) index.set(key, i);
  });
  for (let i = top; i < previous.length; i++) {
    const next = index.get(commitKey(previous[i]!));
    if (next !== undefined) return next - i;
  }
  return null;
}
