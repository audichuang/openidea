/**
 * Find in a response body: the matches `findInLines` gives for the body's
 * lines (split at `\n`), without visiting the lines one by one. A plain query
 * cannot reach across a line break, so it is searched in the whole text at
 * once and each match is placed on its line; a regular expression can (`\s`,
 * `[^x]`, `^`), so it still goes line by line.
 */
import { findInLines, MAX_MATCHES, type FindOptions, type FindResult } from "@/ui/consoleFind";

/** Offsets where the lines of `text` (split at `\n`) start. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) starts.push(at + 1);
  return starts;
}

/** The line holding `offset`: the last start at or before it. */
function lineAt(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * All matches of `query` in `text`, as `findInLines(lines, …)` returns them for
 * `lines` = `text` split at `\n` with ids = line indexes. `starts` is
 * `lineStarts(text)`; `lines` is called only for a regular expression.
 */
export function findInBody(
  text: string,
  starts: readonly number[],
  lines: () => readonly { id: number; text: string }[],
  query: string,
  options: FindOptions,
  limit = MAX_MATCHES,
): FindResult {
  if (options.regex || query.includes("\n")) return findInLines(lines(), query, options, limit);
  const found = findInLines([{ id: 0, text }], query, options, limit);
  return {
    ...found,
    matches: found.matches.map(({ start, end }) => {
      const line = lineAt(starts, start);
      return { line, lineId: line, start: start - starts[line]!, end: end - starts[line]! };
    }),
  };
}
