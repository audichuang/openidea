/**
 * Fork-owned: the Git Graph's presentation of its lane layout (the Git Log's default, Show Long
 * Edges off), computed once per loaded page instead of once over every loaded row.
 *
 * `presentRows(layout(all).rows)` is the reference result. `createGraphPresenter` returns the same
 * rows, but when the commit list only grew at its end it lays out and presents just the new
 * commits plus a fixed window before them, so a page append costs the same at row 600 as at row
 * 20 000. Why each pass allows that:
 *
 * - `computeGraph` walks the commits in order and resumes from its `GraphState`; without `refs`
 *   on the commits nothing in a row depends on later commits.
 * - `hideLongEdges` is ported below (`hideLongEdgesFrom`) so it can resume from the lanes running
 *   through at a row. A row's output depends only on the runs covering it, and a run still open
 *   at the old end changes earlier rows in one place only: the `targetRow` of the down arrow
 *   that starts it, which is patched in place (its index is the same after every later pass).
 * - `dropTailStubs` only ever cuts at the last two rows, reading the row above them.
 * - `compactLanes` and `straightenLaneChanges` read one neighbour row on each side.
 *
 * `__tests__/gitGraphPresent.test.ts` checks paged results against `presentRows(layout(all))`,
 * and the port against upstream `hideLongEdges`.
 */
import {
  compactLanes,
  computeGraph,
  emptyGraphState,
  hideLongEdges,
  straightenLaneChanges,
  type GraphRow,
  type GraphSegment,
  type GraphState,
} from "./graph";

/**
 * `hideLongEdges` ends every run still open after the last loaded row there, so each lane heading
 * to commits not loaded yet gets an up-arrow stub on the last rows: hundreds of lanes side by side
 * on a merge-heavy history. Such a lane continues out of sight below; its down arrow where it
 * disappears says so, so drop the tail stub (from its up arrow to the last row). A stub that another
 * edge joins (a merge into the lane, from the row above the up arrow on) stays: without it that
 * edge would end at a row boundary with nothing to join.
 */
export function dropTailStubs(rows: readonly GraphRow[]): GraphRow[] {
  const last = rows.at(-1);
  if (!last) return rows.slice();
  const straight = (list: readonly GraphSegment[], lane: number) => list.some((s) => s.from === lane && s.to === lane);
  const through = (row: GraphRow, lane: number) =>
    row.lane !== lane && straight(row.up, lane) && straight(row.down, lane);
  const upArrow = (row: GraphRow, lane: number) =>
    row.up.some((s) => s.arrow === "up" && s.from === lane && s.to === lane);
  const joined = (row: GraphRow, lane: number) => row.down.some((s) => s.to === lane && s.from !== lane);
  // Lane → first row of its tail stub.
  const cut = new Map<number, number>();
  for (const s of last.up) {
    const lane = s.from;
    if (s.to !== lane || cut.has(lane)) continue;
    let r = rows.length - 1;
    while (r >= 0 && through(rows[r]!, lane) && !upArrow(rows[r]!, lane)) r--;
    if (r < 0 || !through(rows[r]!, lane) || !upArrow(rows[r]!, lane)) continue;
    if (rows.slice(Math.max(0, r - 1)).some((row) => joined(row, lane))) continue;
    cut.set(lane, r);
  }
  if (!cut.size) return rows.slice();
  const hidden = (s: GraphSegment, r: number) => s.from === s.to && r >= (cut.get(s.from) ?? Infinity);
  const filter = (list: GraphSegment[], targets: string[] | undefined, r: number) => {
    const kept = list.flatMap((s, i) => (hidden(s, r) ? [] : [i]));
    if (kept.length === list.length) return [list, targets] as const;
    return [kept.map((i) => list[i]!), targets && kept.map((i) => targets[i]!)] as const;
  };
  return rows.map((row, r) => {
    const [up, upTargets] = filter(row.up, row.upTargets, r);
    const [down, downTargets] = filter(row.down, row.downTargets, r);
    return up === row.up && down === row.down ? row : { ...row, up, down, upTargets, downTargets };
  });
}

/** The Git Log's default (Show Long Edges off), as in `logPresentation.ts`. */
export function presentRows(rows: readonly GraphRow[]): GraphRow[] {
  return straightenLaneChanges(compactLanes(dropTailStubs(hideLongEdges(rows))));
}

// `graph.ts`'s LONG_EDGE and LONG_EDGE_STUB (not exported); the port's test pins them.
const LONG_EDGE = 30;
const LONG_EDGE_STUB = 2;

type Run = { lane: number; from: number; to: number; start: number; end: number };

/** A long run still open at the last row: where its down arrow is (`targetRow` = the row count). */
interface OpenArrow {
  lane: number;
  start: number;
  row: number;
  index: number;
}

/**
 * Upstream `hideLongEdges` over rows `[w, w + raw.length)` of a longer list, `raw` being its rows
 * from `w` on and `entering` its runs open before row `w` (lane → first row), as the upstream
 * sweep holds them there. Same output rows; also returns the runs entering row `snapAt` (in
 * `[w, end)`), the down arrows of long runs open at the end, and where the runs of `entering`
 * ended.
 */
function hideLongEdgesFrom(raw: readonly GraphRow[], w: number, entering: ReadonlyMap<number, number>, snapAt: number) {
  const n = w + raw.length;
  const starts = new Map<number, Run[]>();
  const ends = new Map<number, Run[]>();
  const seeds: Run[] = [];
  const enteringEnds = new Map<number, number>();
  const record = (events: Map<number, Run[]>, at: number, run: Run) => {
    const existing = events.get(at);
    if (existing) existing.push(run);
    else events.set(at, [run]);
  };
  const finish = (lane: number, start: number, end: number) => {
    if (entering.get(lane) === start && !enteringEnds.has(lane)) enteringEnds.set(lane, end);
    if (end - start < LONG_EDGE) return;
    const from = start + LONG_EDGE_STUB;
    const to = end - LONG_EDGE_STUB;
    const run = { lane, from, to, start, end };
    // Entered the sweep's `hidden` above row `w`: carried in when it still covers row `w`.
    if (from - 1 < w) {
      if (to >= w) seeds.push(run);
      return;
    }
    record(starts, from - 1, run);
    record(ends, to, run);
  };

  const runs = new Map(entering);
  let snapshot = new Map<number, number>();
  for (const [i, row] of raw.entries()) {
    const index = w + i;
    if (index === snapAt) snapshot = new Map(runs);
    const outgoing = new Set<number>();
    for (const s of row.down) if (s.from === s.to && s.from !== row.lane) outgoing.add(s.from);
    const through = new Set<number>();
    for (const s of row.up) if (s.from === s.to && outgoing.has(s.from)) through.add(s.from);
    for (const [lane, start] of runs) {
      if (through.has(lane)) continue;
      finish(lane, start, index);
      runs.delete(lane);
    }
    for (const lane of through) if (!runs.has(lane)) runs.set(lane, index);
  }
  for (const [lane, start] of runs) finish(lane, start, n);

  const arrows: OpenArrow[] = [];
  if (!starts.size && !seeds.length) return { rows: raw.slice(), snapshot, arrows, enteringEnds };
  const hidden = new Map<number, Run>(seeds.map((run) => [run.lane, run]));
  const rows = raw.map((row, i) => {
    const index = w + i;
    for (const run of starts.get(index) ?? []) hidden.set(run.lane, run);
    if (!hidden.size) return row;
    const filter = (segments: GraphSegment[], targets: string[] | undefined, up: boolean) => {
      const visible: GraphSegment[] = [];
      const visibleTargets = targets ? ([] as string[]) : undefined;
      for (const [k, s] of segments.entries()) {
        const run = s.from === s.to ? hidden.get(s.from) : undefined;
        if (run && index >= run.from && index < run.to) continue;
        const targetRow =
          run && (up && index === run.to ? run.start - 1 : !up && index === run.from - 1 ? run.end : undefined);
        if (run && !up && targetRow === n)
          arrows.push({ lane: run.lane, start: run.start, row: index, index: visible.length });
        visible.push(targetRow === undefined ? s : { ...s, arrow: up ? "up" : "down", targetRow });
        visibleTargets?.push(targets![k]!);
      }
      return [visible, visibleTargets] as const;
    };
    const [up, upTargets] = filter(row.up, row.upTargets, true);
    const [down, downTargets] = filter(row.down, row.downTargets, false);
    for (const run of ends.get(index) ?? []) hidden.delete(run.lane);
    return { ...row, up, down, upTargets, downTargets };
  });
  return { rows, snapshot, arrows, enteringEnds };
}

/** Exported for its test only: the port over a whole list, as upstream `hideLongEdges` runs. */
export const hideLongEdgesPort = (rows: readonly GraphRow[]) => hideLongEdgesFrom(rows, 0, new Map(), 0).rows;

export interface PresentInput {
  id: string;
  parents: readonly string[];
  dashed?: readonly boolean[];
}

interface Cache {
  commits: readonly PresentInput[];
  layout: GraphState;
  /** Presented rows, the result. */
  rows: GraphRow[];
  /** Where the next append starts re-presenting (`hideLongEdges` input from here). */
  w: number;
  /** Runs of `hideLongEdges` open before row `w`. */
  runs: ReadonlyMap<number, number>;
  /** Layout rows from `w`. */
  raw: GraphRow[];
  /** `dropTailStubs` rows from `max(0, w - 4)` (the context `compactLanes` and `straightenLaneChanges` need). */
  mid: GraphRow[];
  /** Down arrows above row `w` of long runs still open at the end. */
  arrows: OpenArrow[];
}

const EMPTY: Cache = {
  commits: [],
  layout: emptyGraphState(),
  rows: [],
  w: 0,
  runs: new Map(),
  raw: [],
  mid: [],
  arrows: [],
};

// `computeGraph` reads a missing `dashed` as all false.
const sameCommit = (a: PresentInput, b: PresentInput) =>
  a.id === b.id &&
  a.parents.length === b.parents.length &&
  a.parents.every((p, i) => p === b.parents[i] && !!a.dashed?.[i] === !!b.dashed?.[i]);

/** Whether `commits` starts with every commit of `prev`. */
const extendsList = (prev: readonly PresentInput[], commits: readonly PresentInput[]) =>
  prev.length <= commits.length && prev.every((c, i) => c === commits[i] || sameCommit(c, commits[i]!));

/** `segment`'s copy with `targetRow`, in a copy of `row`. */
function withTarget(row: GraphRow, index: number, targetRow: number): GraphRow {
  const down = row.down.slice();
  down[index] = { ...down[index]!, targetRow };
  return { ...row, down };
}

/** `cache` extended by `commits` beyond its own (which they start with). */
function append(cache: Cache, commits: readonly PresentInput[]): Cache {
  const n0 = cache.commits.length;
  const n = commits.length;
  const { w } = cache;
  const { rows: added, state: layout } = computeGraph(commits.slice(n0), cache.layout);
  const raw = cache.raw.concat(added);
  const snapAt = Math.max(0, n - LONG_EDGE);
  const hidden = hideLongEdgesFrom(raw, w, cache.runs, snapAt);
  const tail = dropTailStubs(hidden.rows);

  // Rows above `w` are final but for the down arrows of runs that were open at the old end.
  const midFrom = Math.max(0, w - 4);
  const mid = cache.mid.slice(0, w - midFrom);
  const outFrom = midFrom > 0 ? midFrom + 2 : 0;
  const out = cache.rows.slice(0, outFrom);
  const arrows: OpenArrow[] = [];
  for (const a of cache.arrows) {
    const end = hidden.enteringEnds.get(a.lane) ?? n;
    if (end === n) arrows.push(a);
    if (end === n0) continue;
    if (a.row >= midFrom) mid[a.row - midFrom] = withTarget(mid[a.row - midFrom]!, a.index, end);
    if (a.row < outFrom) out[a.row] = withTarget(out[a.row]!, a.index, end);
  }
  arrows.push(...hidden.arrows);

  const window = mid.concat(tail);
  // compactLanes row r reads rows r ± 1, straightenLaneChanges as well: drop one context row each.
  const skip = midFrom > 0 ? 1 : 0;
  const presented = straightenLaneChanges(compactLanes(window).slice(skip)).slice(skip);
  const nextMidFrom = Math.max(0, snapAt - 4);
  return {
    commits,
    layout,
    rows: out.concat(presented),
    w: snapAt,
    runs: hidden.snapshot,
    raw: raw.slice(snapAt - w),
    mid: window.slice(nextMidFrom - midFrom),
    // Arrows from row `snapAt` on are found again by the next append's sweep.
    arrows: arrows.filter((a) => a.row < snapAt),
  };
}

/**
 * A function returning `presentRows(computeGraph(commits).rows)`. Each call reuses the previous
 * call's work when `commits` starts with the previous call's commits (a page appended); any
 * other list is computed from scratch. Commits must not carry `refs` (they change the layout).
 */
export function createGraphPresenter(): (commits: readonly PresentInput[]) => GraphRow[] {
  let cache = EMPTY;
  return (commits) => {
    if (commits === cache.commits) return cache.rows;
    const base = extendsList(cache.commits, commits) ? cache : EMPTY;
    cache = base.commits.length === commits.length ? { ...base, commits } : append(base, commits);
    return cache.rows;
  };
}
