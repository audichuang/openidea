/**
 * The Git Log's graph (`presentLogGraph` without Collapse Linear Branches, Collapse Merges or
 * pruned filtered merges), extended page by page: when the commit list only grew at its end, only
 * the new commits and a fixed window of rows before them are laid out and presented again, so a
 * page costs about the same at row 30,000 as at row 600. The result is the full computation's,
 * row for row; whenever that cannot be shown the graph is computed from scratch.
 *
 * Why each pass allows it:
 *
 * - Lanes: {@link layOut} is `computeGraph` resumable from its lane state, given the lane layout of
 *   the whole list. Two things a row shows change when commits are appended, and both are resolved
 *   when a row is drawn ({@link resolveRow}): colours (`graphLayout`'s owners move as its DFS finds
 *   more chains) and the `unloaded` kind of edges into parents that got loaded.
 * - The DFS also moves the lane a branch tip prefers (`layout - 1`), so lanes of rows already laid
 *   out may get other numbers. Every later pass only reads the lanes' order, so those rows stay
 *   valid when each new lane takes the same place among the lanes in use as before; {@link replay}
 *   checks that without building rows, and gives the lanes' new numbers.
 * - `hideLongEdges` resumes from the lanes running through a row ({@link hideLongEdgesFrom}). A run
 *   still open at the old end changes earlier rows in one place only: the `targetRow` of the down
 *   arrow that starts it, patched in place.
 * - `compactLanes` and `straightenLaneChanges` read one neighbour row on each side.
 */
import {
  compactLanes,
  graphLayout,
  straightenLaneChanges,
  type EdgeKind,
  type GraphCommit,
  type GraphRow,
  type GraphSegment,
} from "./graph";
import type { LogOptions } from "./logOptions";
import { graphCommit, type RepoCommit } from "./multiRoot";

// `graph.ts`'s LONG_EDGE and LONG_EDGE_STUB (not exported); the tests compare with `hideLongEdges`.
const LONG_EDGE = 30;
const LONG_EDGE_STUB = 2;
/** Rows laid out again before a page: the long-edge window and the context of the passes after it. */
const WINDOW = LONG_EDGE + 4;

/** A segment as laid out, with what {@link resolveRow} needs to finish it. */
interface LaidSegment extends GraphSegment {
  /** Commit whose `graphLayout` owner gives the colour (ref-aware layouts). */
  colorKey?: string;
  /** For an `unloaded` edge: its parent and its kind once that parent is loaded. */
  target?: string;
  loadedKind?: EdgeKind;
}

interface LaidRow extends GraphRow {
  up: LaidSegment[];
  down: LaidSegment[];
  colorKey?: string;
}

interface Lane {
  id: string;
  source?: string;
  kind?: EdgeKind;
  color: number;
  dashed?: true;
  colorKey: string;
  loadedKind?: EdgeKind;
  /** Creation number: the same lane in every layout of the same commits. */
  identity: number;
}

interface LaneState {
  lanes: Array<Lane | null>;
  nextColor: number;
  nextIdentity: number;
}

/** The lanes before a row, and the lengths of `ranks` and `tips` there. */
interface Snapshot extends LaneState {
  ranks: number;
  tips: number;
}

interface Layout {
  positions: ReadonlyMap<string, number>;
  layout: readonly number[];
  refAware: boolean;
}

const firstFree = (lanes: Array<Lane | null>) => {
  const i = lanes.indexOf(null);
  return i < 0 ? lanes.length : i;
};

const seg = (from: number, to: number, color: number, dashed?: boolean): GraphSegment =>
  dashed ? { from, to, color, dashed: true } : { from, to, color };

/** `computeGraph`'s `stableColor` for a commit's owner. */
function ownerColor(owner: string) {
  let hash = 2166136261;
  for (const char of owner) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

/** The lane a commit without a lane starts at, before `firstFree` if it is taken. */
const preferredLane = (whole: Layout, row: number) => Math.max(0, whole.layout[row]! - 1);

/**
 * `computeGraph(commits).rows` from row `start` on, continuing from `from` (the lanes before row
 * `start`), with `computeGraph`'s positions, layout and ref-awareness of the whole list. Colours
 * keep their fallback numbers and a `colorKey`, edges into parents not loaded keep what they become
 * once loaded, and the last row's arrows into unloaded parents are left to the presentation.
 * `ranks` gets each new lane's place among the lanes in use (see {@link replay}) and `tips` the rows
 * of commits that start a lane; `snap` is the state before row `snapAt`.
 */
function layOut(
  commits: readonly GraphCommit[],
  start: number,
  from: LaneState,
  whole: Layout,
  ranks: number[],
  tips: number[],
  snapAt: number,
) {
  const { positions, refAware } = whole;
  // `slice` keeps the holes `lanes.length = lane + 1` leaves (preferred lanes run far right):
  // `forEach` skips them, and `firstFree` passes them by as in `computeGraph`.
  const lanes = from.lanes.slice();
  let { nextColor, nextIdentity } = from;
  const snapshot = (): Snapshot => ({
    lanes: lanes.slice(),
    nextColor,
    nextIdentity,
    ranks: ranks.length,
    tips: tips.length,
  });
  let snap = snapshot();
  const rank = (index: number) => {
    let below = 0;
    lanes.forEach((lane, i) => {
      if (lane && i < index) below++;
    });
    ranks.push(below);
  };
  const describe = (s: GraphSegment, lane: Omit<Lane, "identity">): LaidSegment => ({
    ...s,
    edge: `${lane.source ?? ""}\0${lane.id}`,
    source: lane.source,
    kind: lane.kind,
    colorKey: lane.colorKey,
    ...(lane.kind === "unloaded" ? { target: lane.id, loadedKind: lane.loadedKind } : {}),
  });
  const segments = lanes.map((lane, i) => (lane ? describe(seg(i, i, lane.color, lane.dashed), lane) : null));
  const putLane = (index: number, lane: Omit<Lane, "identity">) => {
    lanes[index] = { ...lane, identity: nextIdentity++ };
    segments[index] = describe(seg(index, index, lane.color, lane.dashed), lane);
  };
  const rows: LaidRow[] = [];

  for (let row = start; row < commits.length; row++) {
    if (row === snapAt) snap = snapshot();
    const c = commits[row]!;
    const matching: number[] = [];
    lanes.forEach((l, i) => {
      if (l?.id === c.id) matching.push(i);
    });
    let lane: number;
    let color: number;
    let colorKey: string;
    if (matching.length) {
      lane = matching[0]!;
      color = lanes[lane]!.color;
      colorKey = lanes[lane]!.colorKey;
    } else {
      const preferred = refAware ? preferredLane(whole, positions.get(c.id)!) : firstFree(lanes);
      lane = !lanes[preferred] ? preferred : firstFree(lanes);
      rank(lane);
      tips.push(row);
      color = nextColor++;
      colorKey = c.id;
    }
    const widthBefore = lanes.length;

    const up: LaidSegment[] = [];
    const upTargets: string[] = [];
    lanes.forEach((l, i) => {
      if (!l) return;
      up.push(l.id === c.id && lane !== i ? describe(seg(i, lane, l.color, l.dashed), l) : segments[i]!);
      upTargets.push(l.id);
    });
    for (const m of matching) {
      lanes[m] = null;
      segments[m] = null;
    }
    if (lane >= lanes.length) lanes.length = lane + 1;
    lanes[lane] = null;
    segments[lane] = null;

    const down: LaidSegment[] = [];
    const downTargets: string[] = [];
    lanes.forEach((l, i) => {
      if (l) {
        down.push(segments[i]!);
        downTargets.push(l.id);
      }
    });

    c.parents.forEach((p, k) => {
      const dashed = !!c.dashed?.[k];
      const kind = c.edgeTypes?.[k] ?? (dashed ? "filtered" : "normal");
      const info = {
        id: p,
        source: c.id,
        kind: !positions.has(p) && kind !== "shallow" ? ("unloaded" as const) : kind,
        loadedKind: kind,
      };
      const laneOf = (col: number, key: string) =>
        dashed ? { ...info, color: col, dashed: true as const, colorKey: key } : { ...info, color: col, colorKey: key };
      if (kind === "shallow") {
        down.push({
          ...describe(seg(lane, lane, color, dashed), laneOf(color, colorKey)),
          kind: "shallow",
          arrow: "down",
          targetRow: -1,
        });
        downTargets.push(p);
        return;
      }
      // The first parent continues this lane even if another lane also leads to it.
      if (k === 0) {
        putLane(lane, laneOf(color, colorKey));
        down.push(describe(seg(lane, lane, color, dashed), laneOf(color, colorKey)));
        downTargets.push(p);
        return;
      }
      const existing = lanes.findIndex((l) => l?.id === p);
      if (existing >= 0) {
        const into = lanes[existing]!;
        down.push(describe(seg(lane, existing, into.color, dashed), laneOf(into.color, into.colorKey)));
        downTargets.push(p);
        return;
      }
      const slot = firstFree(lanes);
      rank(slot);
      const col = nextColor++;
      putLane(slot, laneOf(col, p));
      down.push(describe(seg(lane, slot, col, dashed), laneOf(col, p)));
      downTargets.push(p);
    });

    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    segments.length = lanes.length;
    const widthAfter = down.reduce((width, segment) => Math.max(width, segment.to + 1), 0);
    rows.push({
      id: c.id,
      lane,
      color,
      colorKey,
      up,
      down,
      upTargets,
      downTargets,
      width: Math.max(widthBefore, widthAfter, lane + 1),
    });
  }
  return { rows, snap };
}

/** Counts per lane number (a Fenwick tree): how many below a number, and the first one counted. */
class Counts {
  private tree: Int32Array;
  constructor(size: number) {
    this.tree = new Int32Array(size + 1);
  }
  add(i: number, delta: number) {
    for (let j = i + 1; j < this.tree.length; j += j & -j) this.tree[j]! += delta;
  }
  below(i: number) {
    let sum = 0;
    for (let j = i; j > 0; j -= j & -j) sum += this.tree[j]!;
    return sum;
  }
  /** The lowest counted number, or -1. */
  first() {
    let at = 0;
    for (let step = 1 << Math.floor(Math.log2(this.tree.length)); step; step >>= 1)
      if (at + step < this.tree.length && this.tree[at + step] === 0) at += step;
    return at + 1 < this.tree.length && this.below(at + 1) ? at : -1;
  }
}

// A lane slot in `computeGraph`'s array: never written since the array last grew (a hole, which
// `indexOf(null)` skips, so `firstFree` passes it by), free (null), or in use.
const HOLE = 0;
const FREE = 1;
const USED = 2;

/**
 * The lane choices of `layOut` over rows `[0, upTo)` with `whole`'s layout, without building rows:
 * each new lane's place among the lanes in use (`ranks`, as `layOut` records them), and the lane
 * slots before row `upTo` (`identities` of the lanes in use by slot).
 */
function replay(commits: readonly GraphCommit[], upTo: number, whole: Layout) {
  // Lanes are either preferred ones or below the number of lanes in use.
  let size = 2;
  for (let row = 0; row < upTo; row++)
    size = Math.max(size, (whole.layout[row] ?? 0) + 1) + commits[row]!.parents.length;
  const slots = new Uint8Array(size);
  const used = new Counts(size);
  const free = new Counts(size);
  let length = 0;
  const ids: Array<string | undefined> = [];
  const identities: number[] = [];
  const lanesOf = new Map<string, number[]>();
  const ranks: number[] = [];
  let nextIdentity = 0;
  const mark = (i: number, slot: number) => {
    const was = slots[i]!;
    if (was === slot) return;
    if (was === USED) {
      const list = lanesOf.get(ids[i]!)!;
      list.splice(list.indexOf(i), 1);
      if (!list.length) lanesOf.delete(ids[i]!);
      used.add(i, -1);
    } else if (was === FREE) free.add(i, -1);
    if (slot === USED) used.add(i, 1);
    else if (slot === FREE) free.add(i, 1);
    slots[i] = slot;
  };
  const put = (i: number, id: string) => {
    mark(i, USED);
    if (i >= length) length = i + 1;
    ids[i] = id;
    identities[i] = nextIdentity++;
    const list = lanesOf.get(id);
    if (list) list.push(i);
    else lanesOf.set(id, [i]);
  };
  const firstFree = () => {
    const i = free.first();
    return i < 0 ? length : i;
  };
  for (let row = 0; row < upTo; row++) {
    const c = commits[row]!;
    const matching = [...(lanesOf.get(c.id) ?? [])];
    let lane: number;
    if (matching.length) lane = Math.min(...matching);
    else {
      const preferred = whole.refAware ? preferredLane(whole, row) : firstFree();
      lane = slots[preferred] !== USED ? preferred : firstFree();
      ranks.push(used.below(lane));
    }
    for (const m of matching) mark(m, FREE);
    if (lane >= length) length = lane + 1;
    mark(lane, FREE);
    c.parents.forEach((p, k) => {
      const kind = c.edgeTypes?.[k] ?? (c.dashed?.[k] ? "filtered" : "normal");
      if (kind === "shallow") return;
      if (k === 0) return put(lane, p);
      if (lanesOf.has(p)) return;
      const slot = firstFree();
      ranks.push(used.below(slot));
      put(slot, p);
    });
    while (length && slots[length - 1] === FREE) mark(--length, HOLE);
  }
  return { ranks, slots: slots.subarray(0, length), identities };
}

/** `computeGraph`'s last-row arrows: edges into parents that are not loaded continue out of sight. */
function withUnloadedArrows(rows: readonly LaidRow[], loaded: (id: string) => boolean): LaidRow[] {
  const last = rows.at(-1);
  if (!last) return rows.slice();
  const down = last.down.map((s) =>
    s.kind === "unloaded" && !loaded(s.target!) ? { ...s, arrow: "down" as const, targetRow: -1 } : s,
  );
  return [...rows.slice(0, -1), { ...last, down }];
}

type Run = { lane: number; from: number; to: number; start: number; end: number };

/** A long run still open at the last row: where its down arrow is (`targetRow` = the row count). */
interface OpenArrow {
  lane: number;
  start: number;
  row: number;
  index: number;
}

/**
 * `hideLongEdges` over rows `[w, w + raw.length)` of a longer list, `raw` being its rows from `w`
 * on and `entering` its runs open before row `w` (lane → first row), as that sweep holds them there.
 * Same output rows; also returns the runs entering row `snapAt` (in `[w, end)`), the down arrows of
 * long runs open at the end, and where the runs of `entering` ended. `minLength` Infinity draws
 * every edge (Show Long Edges on).
 */
function hideLongEdgesFrom(
  raw: readonly LaidRow[],
  w: number,
  entering: ReadonlyMap<number, number>,
  snapAt: number,
  minLength: number,
) {
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
    if (end - start < minLength) return;
    const from = start + LONG_EDGE_STUB;
    const to = end - LONG_EDGE_STUB;
    const run = { lane, from, to, start, end };
    // Entered the sweep's hidden runs above row `w`: carried in when it still covers row `w`.
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
  const rows = raw.map((row, i): LaidRow => {
    const index = w + i;
    for (const run of starts.get(index) ?? []) hidden.set(run.lane, run);
    if (!hidden.size) return row;
    const filter = (segments: LaidSegment[], targets: string[] | undefined, up: boolean) => {
      const visible: LaidSegment[] = [];
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

/** A paged graph: the presented rows, and what the next page needs. */
interface Paged {
  all: readonly RepoCommit[];
  graph: GraphCommit[];
  positions: Map<string, number>;
  refAware: boolean;
  longEdges: boolean;
  /** `graphLayout(graph)` (ref-aware layouts). */
  layout: readonly number[];
  owners: readonly string[];
  /** Presented rows, colours and kinds resolved by {@link resolveRow}. */
  rows: LaidRow[];
  /** Each new lane's place among the lanes in use, in layout order. */
  ranks: number[];
  /** Rows of commits that start a lane. */
  tips: number[];
  /** The next page lays out again from this row. */
  restart: number;
  lanes: Snapshot;
  /** Runs of `hideLongEdges` open before row `restart` (lane identity → first row). */
  runs: ReadonlyMap<number, number>;
  /** Down arrows above row `restart` of long runs still open at the end, by lane identity. */
  arrows: OpenArrow[];
}

function emptyPaged(longEdges: boolean): Paged {
  return {
    all: [],
    graph: [],
    positions: new Map(),
    refAware: false,
    longEdges,
    layout: [],
    owners: [],
    rows: [],
    ranks: [],
    tips: [],
    restart: 0,
    lanes: { lanes: [], nextColor: 0, nextIdentity: 0, ranks: 0, tips: 0 },
    runs: new Map(),
    arrows: [],
  };
}

/** `segment`'s copy with `targetRow`, in a copy of `row`. */
function withTarget(row: LaidRow, index: number, targetRow: number): LaidRow {
  const down = row.down.slice();
  down[index] = { ...down[index]!, targetRow };
  return { ...row, down };
}

/** The lanes before `paged.restart` under the new layout, or null when rows above it would change. */
function lanesAtRestart(paged: Paged, graph: readonly GraphCommit[], whole: Layout): Array<Lane | null> | null {
  const { restart, lanes } = paged;
  const preferred = (layout: readonly number[], row: number) => Math.max(0, layout[row]! - 1);
  const moved =
    whole.refAware &&
    paged.tips.slice(0, lanes.tips).some((row) => preferred(paged.layout, row) !== preferred(whole.layout, row));
  if (!moved) return lanes.lanes;
  const { ranks, slots, identities } = replay(graph, restart, whole);
  if (ranks.length !== lanes.ranks || ranks.some((r, i) => r !== paged.ranks[i])) return null;
  const byIdentity = new Map<number, Lane>();
  for (const lane of lanes.lanes) if (lane) byIdentity.set(lane.identity, lane);
  // Holes stay holes: `firstFree` passes them by.
  const out = new Array<Lane | null>(slots.length);
  for (const [i, slot] of slots.entries()) {
    if (slot === FREE) out[i] = null;
    else if (slot === USED) {
      const lane = byIdentity.get(identities[i]!);
      if (!lane) return null;
      out[i] = lane;
      byIdentity.delete(identities[i]!);
    }
  }
  return byIdentity.size ? null : out;
}

/** `paged` extended by `graph` beyond its own (which `graph` starts with). */
function extend(
  paged: Paged,
  all: readonly RepoCommit[],
  graph: GraphCommit[],
  positions: Map<string, number>,
  refAware: boolean,
): Paged | null {
  const n0 = paged.graph.length;
  const n = graph.length;
  const { layout, owners } = refAware ? graphLayout(graph) : { layout: [], owners: [] };
  const whole = { positions, layout, refAware };
  const { restart } = paged;
  const lanes = lanesAtRestart(paged, graph, whole);
  if (!lanes) return null;
  const ranks = paged.ranks.slice(0, paged.lanes.ranks);
  const tips = paged.tips.slice(0, paged.lanes.tips);
  const next = Math.max(0, n - WINDOW);
  const laid = layOut(graph, restart, { ...paged.lanes, lanes }, whole, ranks, tips, next);
  // Rows laid out before must have kept their lane order.
  for (let i = paged.lanes.ranks; i < paged.ranks.length; i++) if (ranks[i] !== paged.ranks[i]) return null;

  const number = new Map<number, number>();
  lanes.forEach((lane, i) => lane && number.set(lane.identity, i));
  const entering = new Map<number, number>();
  for (const [identity, start] of paged.runs) entering.set(number.get(identity)!, start);
  const hidden = hideLongEdgesFrom(
    withUnloadedArrows(laid.rows, (id) => positions.has(id)),
    restart,
    entering,
    next,
    paged.longEdges ? Infinity : LONG_EDGE,
  );

  // Rows above the window are final but for the down arrows of runs that were open at the old end.
  const outFrom = restart > 0 ? restart + 2 : 0;
  const out = paged.rows.slice(0, outFrom);
  const arrows: OpenArrow[] = [];
  for (const a of paged.arrows) {
    const end = hidden.enteringEnds.get(number.get(a.lane)!) ?? n;
    if (end === n) arrows.push(a);
    if (end !== n0) out[a.row] = withTarget(out[a.row]!, a.index, end);
  }
  // The window's first two rows were only context: take their arrows' new targets.
  for (let r = restart; r < outFrom; r++) {
    const fresh = hidden.rows[r - restart]!;
    fresh.down.forEach((s, i) => {
      if (s.arrow === "down" && out[r]!.down[i]!.targetRow !== s.targetRow)
        out[r] = withTarget(out[r]!, i, s.targetRow!);
    });
  }

  // compactLanes row r reads rows r ± 1, straightenLaneChanges as well: drop one context row each.
  const skip = restart > 0 ? 1 : 0;
  const presented = straightenLaneChanges(compactLanes(hidden.rows).slice(skip)).slice(skip) as LaidRow[];
  const identityAt = (lane: number) => laid.snap.lanes[lane]!.identity;
  for (const a of hidden.arrows) if (a.row < next) arrows.push({ ...a, lane: identityAt(a.lane) });
  return {
    all,
    graph,
    positions,
    refAware,
    longEdges: paged.longEdges,
    layout,
    owners,
    rows: out.concat(presented),
    ranks,
    tips,
    restart: next,
    lanes: laid.snap,
    runs: new Map([...hidden.snapshot].map(([lane, start]) => [identityAt(lane), start])),
    arrows,
  };
}

const prunable = (c: GraphCommit) =>
  c.parents.length >= 2 &&
  c.parents.some((_, i) => (c.edgeTypes?.[i] ?? (c.dashed?.[i] ? "filtered" : "normal")) === "filtered");

/** Whether `createPagedLogGraph` computes the graph for these options (none rewrites the graph). */
export const pagesLogGraph = (options: LogOptions, fragments: { collapsed: ReadonlySet<string> }) =>
  !options.collapseLinear && !fragments.collapsed.size && !options.linearizeMerges;

export interface PagedLogGraph {
  commits: readonly RepoCommit[];
  graph: readonly GraphCommit[];
  /** Presented rows; only their geometry (lanes, widths, targets) is final. */
  rows: readonly GraphRow[];
  /** Row `index` as `presentLogGraph` returns it. */
  row(index: number): GraphRow | undefined;
}

/** `row` with its colours and edge kinds as the whole list gives them. */
function resolveRow(
  row: LaidRow,
  color: (key: string | undefined, fallback: number) => number,
  loaded: (id: string) => boolean,
): GraphRow {
  const segment = ({ colorKey, target, loadedKind, ...s }: LaidSegment): GraphSegment =>
    s.kind === "unloaded" && loaded(target!)
      ? { ...s, color: color(colorKey, s.color), kind: loadedKind }
      : { ...s, color: color(colorKey, s.color) };
  const { colorKey, ...rest } = row;
  return { ...rest, color: color(colorKey, row.color), up: row.up.map(segment), down: row.down.map(segment) };
}

/**
 * A function returning `presentLogGraph(all, options, …)` for options {@link pagesLogGraph} accepts,
 * rows resolved one at a time through `row`. Each call reuses the previous call's work when `all`
 * starts with the previous call's commits (a page appended); any other list is computed from
 * scratch. Returns null when the graph has to come from `presentLogGraph` (filtered merges are
 * pruned, or two commits share a key).
 */
export function createPagedLogGraph(): (all: readonly RepoCommit[], options: LogOptions) => PagedLogGraph | null {
  let paged = emptyPaged(false);
  let result: PagedLogGraph | null = null;
  const reset = () => {
    paged = emptyPaged(false);
    result = null;
    return null;
  };
  return (all, options) => {
    if (paged.all === all && paged.longEdges === options.longEdges && result) return result;
    const n0 = paged.all.length;
    const extendsPrevious =
      result !== null &&
      paged.longEdges === options.longEdges &&
      n0 <= all.length &&
      paged.all.every((c, i) => c === all[i]);
    if (extendsPrevious && n0 === all.length) {
      paged = { ...paged, all };
      return (result = { ...result!, commits: all });
    }
    const base = extendsPrevious ? paged : emptyPaged(options.longEdges);
    const added = all.slice(base.all.length).map(graphCommit);
    if (added.some(prunable)) return reset();
    // Shared with the previous result, which a newer one replaces.
    const positions = base.positions;
    for (const [i, c] of added.entries()) {
      if (positions.has(c.id)) return reset();
      positions.set(c.id, base.all.length + i);
    }
    const graph = base.graph.concat(added);
    const refAware = base.refAware || added.some((c) => c.refs?.length);
    const next =
      (base.all.length && refAware === base.refAware && extend(base, all, graph, positions, refAware)) ||
      extend(emptyPaged(options.longEdges), all, graph, positions, refAware);
    if (!next) return reset();
    paged = next;
    const { owners } = next;
    // `positions` keeps growing with later pages: this result reads only its own rows.
    const at = (id: string) => {
      const index = positions.get(id);
      return index != null && index < graph.length ? index : undefined;
    };
    const colors = new Map<string, number>();
    const color = (key: string | undefined, fallback: number) => {
      if (!refAware || key === undefined) return fallback;
      let value = colors.get(key);
      if (value === undefined) {
        const index = at(key);
        colors.set(key, (value = ownerColor(index === undefined ? key : owners[index]!)));
      }
      return value;
    };
    const loaded = (id: string) => at(id) !== undefined;
    const resolved = new Map<number, GraphRow>();
    const { rows } = next;
    result = {
      commits: all,
      graph,
      rows,
      row(index) {
        let row = resolved.get(index);
        if (!row && rows[index]) resolved.set(index, (row = resolveRow(rows[index], color, loaded)));
        return row;
      },
    };
    return result;
  };
}
