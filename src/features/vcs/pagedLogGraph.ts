/**
 * The Git Log's graph (`presentLogGraph` without Collapse Linear Branches, Collapse Merges or
 * pruned filtered merges), laid out again only from the first row that can change: when a page is
 * appended, the new commits and a fixed window of rows before them; when a Refresh returns the
 * history with a change somewhere, the rows from a kept lane state before that change on (none
 * when nothing in the graph changed), or, when the change is near the top (commits made on top),
 * the rows down to a kept lane state below it ({@link resync}). The result is the full
 * computation's, row for row; whenever that cannot be shown the graph is computed from scratch.
 *
 * Why each pass allows it:
 *
 * - Lanes: {@link layOut} is `computeGraph` resumable from its lane state, given the lane layout of
 *   the whole list. Two things a row shows change with commits after it, and both are resolved
 *   when a row is drawn ({@link resolveRow}): colours (`graphLayout`'s owners move as its DFS finds
 *   more chains) and the `unloaded` kind of edges into parents that got loaded or dropped.
 * - The DFS also moves the lane a branch tip prefers (`layout - 1`), so lanes of rows already laid
 *   out may get other numbers. Every later pass only reads the lanes' order, so those rows stay
 *   valid when each new lane takes the same place among the lanes in use as before; {@link replay}
 *   checks that without building rows, and gives the lanes' new numbers.
 * - `hideLongEdges` resumes from the lanes running through a row ({@link hideLongEdgesFrom}). A run
 *   still open there changes earlier rows in one place only: the `targetRow` of the down arrow that
 *   starts it, patched in place.
 * - `compactLanes` and `straightenLaneChanges` read one neighbour row on each side.
 */
import {
  compactLanes,
  headPriority,
  layoutChains,
  straightenLaneChanges,
  type EdgeKind,
  type GraphCommit,
  type GraphRow,
  type GraphSegment,
} from "./graph";
import type { LogOptions } from "./logOptions";

/** The options that shape the graph (`GraphOptions` in `logPresentation.ts`). */
type GraphShape = Pick<LogOptions, "collapseLinear" | "linearizeMerges" | "longEdges">;
import { graphCommit, type RepoCommit } from "./multiRoot";

// `graph.ts`'s LONG_EDGE and LONG_EDGE_STUB (not exported); the tests compare with `hideLongEdges`.
const LONG_EDGE = 30;
const LONG_EDGE_STUB = 2;
/** Rows laid out again before a change: the long-edge window and the context of the passes after it. */
const WINDOW = LONG_EDGE + 4;
/** Rows between the lane states kept for laying out again from a change deep in the list. */
const CHECKPOINT = 512;
/** Lanes a step of laying out goes over before it yields (about a millisecond of work). */
const STEP_LANES = 8_192;
/** Rows of cheaper per-row passes between yields. */
const STEP_ROWS = 2_048;

/**
 * Work that yields between steps so a caller can spread it over several tasks ({@link
 * createPagedLogGraph}'s `steps`); `run` does it all at once.
 */
export type Steps<T> = Generator<void, T, void>;

export function run<T>(steps: Steps<T>): T {
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

/** A segment as laid out, with what {@link resolveRow} needs to finish it. */
interface LaidSegment extends GraphSegment {
  /** Commit whose `graphLayout` owner gives the colour (ref-aware layouts). */
  colorKey?: string;
  /** The parent the lane leads to, and the edge's kind while that parent is loaded. */
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
  loadedKind: EdgeKind;
  /** Creation number: the same lane in every layout of the same commits. */
  identity: number;
}

/** `computeGraph`'s lane array without its holes: its length, and the slots in use or free. */
interface LaneSnapshot {
  length: number;
  slots: ReadonlyArray<readonly [number, Lane | null]>;
}

/** The lane state before a row, kept to lay out again from that row. */
interface Checkpoint {
  row: number;
  lanes: LaneSnapshot;
  nextColor: number;
  nextIdentity: number;
  /** Lengths of `ranks` and `tips` there. */
  ranks: number;
  tips: number;
  /** Runs of `hideLongEdges` open before the row (lane identity → first row). */
  runs: ReadonlyMap<number, number>;
  /** Whether its lanes are numbered for the layout of the list that keeps it. */
  numbered: boolean;
  /** One of the states kept every `CHECKPOINT` rows (the others are where a page restarted). */
  periodic: boolean;
}

/**
 * `checkpoints` without periodic ones closer than half a `CHECKPOINT` to the one kept before them,
 * so that commits made on top, which move them all down, do not pile them up near the top.
 */
function spaced(checkpoints: readonly Checkpoint[], keep = -1) {
  const out: Checkpoint[] = [];
  let last = -CHECKPOINT;
  for (const p of checkpoints) {
    if (p.periodic && p.row - last < CHECKPOINT / 2 && p.row !== keep) continue;
    out.push(p);
    if (p.periodic) last = p.row;
  }
  return out;
}

interface Layout {
  positions: ReadonlyMap<string, number>;
  /** `graphLayout(graph).layout` (ref-aware layouts). */
  layout: ArrayLike<number>;
  refAware: boolean;
}

/** A shallow boundary in {@link LayoutIndex.links}: no lane. */
const SHALLOW = Number.MIN_SAFE_INTEGER;

/** `graphLayout`'s inputs, kept up to date as commits are appended. */
interface LayoutIndex {
  /** Loaded parents of each commit (rows, in parent order). */
  parents: number[][];
  /** Each commit's parents as {@link replay} reads them: rows, a number below zero per parent not
   * loaded, {@link SHALLOW} for a shallow boundary. */
  links: number[][];
  unloaded: Map<string, number>;
  /** Commits whose parent is not loaded yet, by that parent's id. */
  waiting: Map<string, number[]>;
  /** Heads in the order the DFS takes them, and their priorities. */
  heads: number[];
  priorities: string[];
}

/**
 * `graphLayout`'s inputs for `graph` (whose rows and parent references `positions` and
 * `children` hold), reusing `prev`'s for rows before `from`. Commits appended to a list in log
 * order give no commit above them a child or a parent, so the heads above stay heads, in order.
 */
function* indexLayout(
  prev: LayoutIndex | null,
  graph: readonly GraphCommit[],
  from: number,
  positions: ReadonlyMap<string, number>,
  children: ReadonlyMap<string, number>,
): Steps<LayoutIndex> {
  const loadedParents = (c: GraphCommit) => c.parents.flatMap((p) => positions.get(p) ?? []);
  const linksOf = (c: GraphCommit) =>
    c.parents.map((p, k) => {
      if ((c.edgeTypes?.[k] ?? (c.dashed?.[k] ? "filtered" : "normal")) === "shallow") return SHALLOW;
      const row = positions.get(p);
      if (row !== undefined) return row;
      let id = index.unloaded.get(p);
      if (id === undefined) index.unloaded.set(p, (id = -1 - index.unloaded.size));
      return id;
    });
  let index: LayoutIndex;
  if (prev && from > 0 && graph.slice(from).every((c, i) => c.parents.every((p) => !(positions.get(p)! <= from + i)))) {
    index = prev;
    for (let j = from; j < graph.length; j++) {
      const c = graph[j]!;
      for (const node of index.waiting.get(c.id) ?? []) {
        index.parents[node] = loadedParents(graph[node]!);
        index.links[node] = linksOf(graph[node]!);
      }
      index.waiting.delete(c.id);
    }
  } else {
    index = { parents: [], links: [], unloaded: new Map(), waiting: new Map(), heads: [], priorities: [] };
    from = 0;
  }
  const { parents, links, waiting } = index;
  const heads: number[] = [];
  for (let j = from; j < graph.length; j++) {
    if ((j - from) % STEP_ROWS === STEP_ROWS - 1) yield;
    const c = graph[j]!;
    parents[j] = loadedParents(c);
    links[j] = linksOf(c);
    for (const p of c.parents)
      if (!positions.has(p)) {
        const list = waiting.get(p);
        if (list) list.push(j);
        else waiting.set(p, [j]);
      }
    if (!children.get(c.id) || c.refs?.length) heads.push(j);
  }
  // Sorted as `graphLayout` sorts them (stable, so rows above come first among equals).
  const priorities = new Map(heads.map((i) => [i, headPriority(graph[i]!)]));
  heads.sort((a, b) => priorities.get(a)!.localeCompare(priorities.get(b)!));
  // Few heads come with a page: find each one's place among the others.
  const merged: number[] = [];
  const keys: string[] = [];
  let a = 0;
  for (const head of heads) {
    const key = priorities.get(head)!;
    let hi = index.heads.length;
    for (let lo = a; lo < hi;) {
      const mid = (lo + hi) >> 1;
      if (index.priorities[mid]!.localeCompare(key) <= 0) lo = mid + 1;
      else hi = mid;
    }
    for (; a < hi; a++) {
      merged.push(index.heads[a]!);
      keys.push(index.priorities[a]!);
    }
    merged.push(head);
    keys.push(key);
  }
  for (; a < index.heads.length; a++) {
    merged.push(index.heads[a]!);
    keys.push(index.priorities[a]!);
  }
  return { ...index, heads: merged, priorities: keys };
}

const seg = (from: number, to: number, color: number, dashed?: boolean): GraphSegment =>
  dashed ? { from, to, color, dashed: true } : { from, to, color };

/** `computeGraph`'s `stableColor` for a commit's owner. */
function ownerColor(owner: string) {
  let hash = 2166136261;
  for (const char of owner) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

/** The lane a commit without a lane starts at, before `firstFree` if it is taken. */
const preferredLane = (layout: ArrayLike<number>, row: number) => Math.max(0, layout[row]! - 1);

/** Items of sorted `list` below `value`. */
function below(list: readonly number[], value: number) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const insertSorted = (list: number[], value: number) => list.splice(below(list, value), 0, value);
const removeSorted = (list: number[], value: number) => list.splice(below(list, value), 1);

/**
 * `computeGraph`'s lane array: a slot is in use, free (null, which `firstFree` takes), or a hole
 * (never written since the array grew past it, which `indexOf(null)` passes by). The slots in use,
 * the free ones and the slots of each lane id are kept sorted, so a row costs its lanes in use and
 * not the array's length (a branch tip's preferred lane can be thousands of slots to the right).
 */
class LaneSlots {
  length = 0;
  private slots = new Map<number, Lane | null>();
  private used: number[] = [];
  private free: number[] = [];
  private ids = new Map<string, number[]>();

  constructor(snapshot: LaneSnapshot) {
    this.length = snapshot.length;
    for (const [slot, lane] of snapshot.slots) {
      this.slots.set(slot, lane);
      if (lane) this.use(slot, lane);
      else this.free.push(slot);
    }
    this.used.sort((a, b) => a - b);
    this.free.sort((a, b) => a - b);
    for (const list of this.ids.values()) list.sort((a, b) => a - b);
  }

  private use(slot: number, lane: Lane) {
    this.used.push(slot);
    const list = this.ids.get(lane.id);
    if (list) list.push(slot);
    else this.ids.set(lane.id, [slot]);
  }

  private release(slot: number, lane: Lane) {
    removeSorted(this.used, slot);
    const list = this.ids.get(lane.id)!;
    if (list.length === 1) this.ids.delete(lane.id);
    else removeSorted(list, slot);
  }

  get(slot: number) {
    return this.slots.get(slot);
  }

  /** `firstFree(lanes)`. */
  firstFree() {
    return this.free.length ? this.free[0]! : this.length;
  }

  /** Slots in use below `slot`. */
  usedBelow(slot: number) {
    return below(this.used, slot);
  }

  /** Slots of lanes leading to `id`, ascending. */
  withId(id: string): readonly number[] {
    return this.ids.get(id) ?? [];
  }

  /** Slots in use, ascending. */
  inUse(): readonly number[] {
    return this.used;
  }

  /** `lanes[slot] = null`, growing the array to it first (`lanes.length = slot + 1`). */
  clear(slot: number) {
    if (slot >= this.length) this.length = slot + 1;
    const was = this.slots.get(slot);
    if (was === null) return;
    if (was) this.release(slot, was);
    insertSorted(this.free, slot);
    this.slots.set(slot, null);
  }

  put(slot: number, lane: Lane) {
    const was = this.slots.get(slot);
    if (was === null) removeSorted(this.free, slot);
    else if (was) this.release(slot, was);
    if (slot >= this.length) this.length = slot + 1;
    this.slots.set(slot, lane);
    insertSorted(this.used, slot);
    const list = this.ids.get(lane.id);
    if (list) insertSorted(list, slot);
    else this.ids.set(lane.id, [slot]);
  }

  /** Drops trailing free slots (`while (lanes.at(-1) === null) lanes.pop()`). */
  trim() {
    while (this.length && this.slots.get(this.length - 1) === null) {
      this.slots.delete(--this.length);
      this.free.pop();
    }
  }

  snapshot(): LaneSnapshot {
    return { length: this.length, slots: [...this.slots] };
  }
}

/** A lane state to lay out from, and the counts of `ranks` and `tips` it belongs with. */
interface LaneState {
  lanes: LaneSnapshot;
  nextColor: number;
  nextIdentity: number;
}

type Snapshot = LaneState & { ranks: number; tips: number };

/**
 * `computeGraph(commits).rows` from row `start` on, continuing from `from` (the lanes before row
 * `start`), with `computeGraph`'s positions, layout and ref-awareness of the whole list. Colours
 * keep their fallback numbers and a `colorKey`, edges keep the parent they lead to, and the last
 * row's arrows into unloaded parents are left to the presentation. `ranks` gets each new lane's
 * place among the lanes in use (see {@link replay}) and `rankRows` its row, `tips` the rows of
 * commits that start a lane; `snaps` gets the state before each row of `snapRows`. Each row goes
 * to `sink` as it is laid out (a row holds every lane in use, so they are not kept). Stops before
 * row `end`.
 */
function* layOut(
  commits: readonly GraphCommit[],
  start: number,
  from: LaneState,
  whole: Layout,
  ranks: number[],
  rankRows: number[],
  tips: number[],
  snapRows: ReadonlySet<number>,
  sink: (row: LaidRow) => void,
  end = commits.length,
): Steps<Map<number, Snapshot>> {
  const { positions, refAware } = whole;
  const lanes = new LaneSlots(from.lanes);
  let { nextColor, nextIdentity } = from;
  const snaps = new Map<number, Snapshot>();
  const describe = (s: GraphSegment, lane: Omit<Lane, "identity">): LaidSegment => ({
    ...s,
    edge: `${lane.source ?? ""}\0${lane.id}`,
    source: lane.source,
    kind: lane.kind,
    colorKey: lane.colorKey,
    target: lane.id,
    loadedKind: lane.loadedKind,
  });
  // A lane keeps its straight segment while it stays in its slot, as in `computeGraph`.
  const segments = new Map<number, LaidSegment>();
  for (const i of lanes.inUse()) {
    const lane = lanes.get(i)!;
    segments.set(i, describe(seg(i, i, lane.color, lane.dashed), lane));
  }
  const putLane = (index: number, lane: Omit<Lane, "identity">) => {
    lanes.put(index, { ...lane, identity: nextIdentity++ });
    segments.set(index, describe(seg(index, index, lane.color, lane.dashed), lane));
  };
  const rank = (index: number, row: number) => {
    ranks.push(lanes.usedBelow(index));
    rankRows.push(row);
  };
  let work = 0;

  for (let row = start; row < end; row++) {
    work += lanes.inUse().length + 1;
    if (work >= STEP_LANES) {
      work = 0;
      yield;
    }
    if (snapRows.has(row))
      snaps.set(row, { lanes: lanes.snapshot(), nextColor, nextIdentity, ranks: ranks.length, tips: tips.length });
    const c = commits[row]!;
    const matching = [...lanes.withId(c.id)];
    let lane: number;
    let color: number;
    let colorKey: string;
    if (matching.length) {
      lane = matching[0]!;
      color = lanes.get(lane)!.color;
      colorKey = lanes.get(lane)!.colorKey;
    } else {
      const preferred = refAware ? preferredLane(whole.layout, positions.get(c.id)!) : lanes.firstFree();
      lane = !lanes.get(preferred) ? preferred : lanes.firstFree();
      rank(lane, row);
      tips.push(row);
      color = nextColor++;
      colorKey = c.id;
    }
    const widthBefore = lanes.length;

    const up: LaidSegment[] = [];
    for (const i of lanes.inUse()) {
      const l = lanes.get(i)!;
      up.push(l.id === c.id && lane !== i ? describe(seg(i, lane, l.color, l.dashed), l) : segments.get(i)!);
    }
    for (const m of matching) {
      lanes.clear(m);
      segments.delete(m);
    }
    lanes.clear(lane);
    segments.delete(lane);

    const down: LaidSegment[] = [];
    for (const i of lanes.inUse()) down.push(segments.get(i)!);

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
        return;
      }
      // The first parent continues this lane even if another lane also leads to it.
      if (k === 0) {
        putLane(lane, laneOf(color, colorKey));
        down.push(describe(seg(lane, lane, color, dashed), laneOf(color, colorKey)));
        return;
      }
      const existing = lanes.withId(p)[0];
      if (existing !== undefined) {
        const into = lanes.get(existing)!;
        down.push(describe(seg(lane, existing, into.color, dashed), laneOf(into.color, into.colorKey)));
        return;
      }
      const slot = lanes.firstFree();
      rank(slot, row);
      const col = nextColor++;
      putLane(slot, laneOf(col, p));
      down.push(describe(seg(lane, slot, col, dashed), laneOf(col, p)));
    });

    lanes.trim();
    const widthAfter = down.reduce((width, segment) => Math.max(width, segment.to + 1), 0);
    sink({
      id: c.id,
      lane,
      color,
      colorKey,
      up,
      down,
      width: Math.max(widthBefore, widthAfter, lane + 1),
    });
  }
  return snaps;
}

const START = { row: 0, lanes: { length: 0, slots: [] }, nextIdentity: 0 };

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
 * The lane choices of `layOut` over rows `[from.row, upTo)` with `whole`'s layout, without
 * building rows: each new lane's place among the lanes in use (`ranks`, as `layOut` records them),
 * and the lane slots before row `upTo` (`identities` of the lanes in use by slot). Lanes are keyed
 * by the rows and numbers of `index.links`, not by id.
 */
function* replay(
  index: LayoutIndex,
  upTo: number,
  whole: Layout,
  from: { row: number; lanes: LaneSnapshot; nextIdentity: number } = START,
  keepAt = -1,
): Steps<{
  ranks: number[];
  slots: Uint8Array;
  identities: Int32Array;
  kept: { slots: Uint8Array; identities: Int32Array } | null;
}> {
  // Lanes are either preferred ones or below the number of lanes in use.
  let size = from.lanes.length + 2;
  for (let row = from.row; row < upTo; row++) size = Math.max(size, whole.layout[row]! + 1) + index.links[row]!.length;
  const slots = new Uint8Array(size);
  const used = new Counts(size);
  const free = new Counts(size);
  let length = from.lanes.length;
  const identities = new Int32Array(size);
  // The slots of lanes leading to each parent, as lists through `nextSlot` (slot + 1, 0 ends);
  // parents not loaded come after the rows.
  const rows = index.links.length;
  const firstSlot = new Int32Array(rows + index.unloaded.size);
  const nextSlot = new Int32Array(size);
  const target = (id: number) => (id >= 0 ? id : rows - 1 - id);
  const ranks: number[] = [];
  let nextIdentity = from.nextIdentity;
  const lead = (i: number, id: number) => {
    const t = target(id);
    nextSlot[i] = firstSlot[t]!;
    firstSlot[t] = i + 1;
  };
  for (const [slot, lane] of from.lanes.slots) {
    if (!lane) {
      slots[slot] = FREE;
      free.add(slot, 1);
      continue;
    }
    slots[slot] = USED;
    used.add(slot, 1);
    identities[slot] = lane.identity;
    lead(slot, whole.positions.get(lane.id) ?? index.unloaded.get(lane.id)!);
  }
  const put = (i: number, id: number) => {
    if (slots[i] !== USED) {
      if (slots[i] === FREE) free.add(i, -1);
      used.add(i, 1);
      slots[i] = USED;
    }
    if (i >= length) length = i + 1;
    identities[i] = nextIdentity++;
    lead(i, id);
  };
  const release = (i: number) => {
    used.add(i, -1);
    free.add(i, 1);
    slots[i] = FREE;
  };
  const firstFree = () => {
    const i = free.first();
    return i < 0 ? length : i;
  };
  let kept: { slots: Uint8Array; identities: Int32Array } | null = null;
  for (let row = from.row; row < upTo; row++) {
    if ((row - from.row) % STEP_ROWS === STEP_ROWS - 1) yield;
    if (row === keepAt) kept = { slots: slots.slice(0, length), identities: identities.slice() };
    const links = index.links[row]!;
    // The commit's lane goes on to its first parent: it stays in use (no counts to update).
    const continues = links.length > 0 && links[0] !== SHALLOW;
    const matching = firstSlot[row]!;
    let lane: number;
    if (matching) {
      firstSlot[row] = 0;
      lane = matching - 1;
      for (let m = matching; m; m = nextSlot[m - 1]!) if (m - 1 < lane) lane = m - 1;
      for (let m = matching; m; m = nextSlot[m - 1]!) if (m - 1 !== lane || !continues) release(m - 1);
    } else {
      const preferred = whole.refAware ? preferredLane(whole.layout, row) : firstFree();
      lane = slots[preferred] !== USED ? preferred : firstFree();
      ranks.push(used.below(lane));
      if (lane >= length) length = lane + 1;
      if (!continues && slots[lane] === HOLE) {
        free.add(lane, 1);
        slots[lane] = FREE;
      }
    }
    for (let k = 0; k < links.length; k++) {
      const p = links[k]!;
      if (p === SHALLOW) continue;
      if (k === 0) put(lane, p);
      else if (!firstSlot[target(p)]) {
        const slot = firstFree();
        ranks.push(used.below(slot));
        put(slot, p);
      }
    }
    while (length && slots[length - 1] === FREE) {
      free.add(--length, -1);
      slots[length] = HOLE;
    }
  }
  return { ranks, slots: slots.subarray(0, length), identities, kept };
}

/**
 * `computeGraph`'s last-row arrows: edges into parents that are not loaded continue out of sight.
 * Decided by the parent, as {@link resolveRow} decides the kind: a lane carried from a kept lane
 * state has the kind it got while its parent was still loaded.
 */
function withUnloadedArrows(last: LaidRow, loaded: (id: string) => boolean): LaidRow {
  const down = last.down.map((s) =>
    s.target !== undefined && s.loadedKind !== "shallow" && !loaded(s.target)
      ? { ...s, arrow: "down" as const, targetRow: -1 }
      : s,
  );
  return { ...last, down };
}

/** The commit a laid out segment leads to (rows from {@link layOut} keep no targets of their own). */
const targetOf = (s: LaidSegment) => s.target!;

/**
 * `hideLongEdges` over rows `[w, …)` of a longer list, given one row at a time (`push`), `entering`
 * being its runs open before row `w` (lane → first row), as that sweep holds them there. `finish`
 * ends the list at row `n` (applying `last` to its last row) and returns the same rows as
 * `hideLongEdges`, the runs open before each row of `snapRows` and where the runs of `entering`
 * ended. A row is decided once enough rows follow it to tell whether a run through it is long, so
 * only that many rows with every lane in use are held. `minLength` Infinity draws every edge (Show
 * Long Edges on).
 */
function hideLongEdgesFrom(
  w: number,
  entering: ReadonlyMap<number, number>,
  snapRows: ReadonlySet<number>,
  minLength: number,
) {
  // A run open through `delay` rows is long, and ends more than two rows below the first of them;
  // the last row is held for `finish` in any case.
  const delay = minLength === Infinity ? 2 : minLength + LONG_EDGE_STUB + 1;
  const runs = new Map(entering);
  /** Runs that ended, by lane, the oldest first, from the first one the decided rows still meet. */
  const ended = new Map<number, Array<{ start: number; end: number }>>();
  /** The down arrow at the start of each long run still open, whose target row is its end. */
  const arrows = new Map<number, LaidSegment>();
  const snaps = new Map<number, Map<number, number>>();
  const enteringEnds = new Map<number, number>();
  const held: LaidRow[] = [];
  const rows: LaidRow[] = [];
  let pushed = w;

  const close = (lane: number, start: number, end: number) => {
    if (entering.get(lane) === start && !enteringEnds.has(lane)) enteringEnds.set(lane, end);
    const list = ended.get(lane);
    if (list) list.push({ start, end });
    else ended.set(lane, [{ start, end }]);
    const arrow = arrows.get(lane);
    if (arrow) {
      arrow.targetRow = end;
      arrows.delete(lane);
    }
  };
  /** The run of `lane` through row `index`, if it is long; `end` undefined while it is open. */
  const longRun = (lane: number, index: number) => {
    const list = ended.get(lane);
    while (list?.length && list[0]!.end <= index) list.shift();
    const closed = list?.[0];
    if (closed && closed.start <= index) return closed.end - closed.start >= minLength ? closed : undefined;
    const start = runs.get(lane);
    return start !== undefined && start <= index ? { start, end: undefined } : undefined;
  };
  const decide = (row: LaidRow, index: number): LaidRow => {
    const filter = (segments: LaidSegment[], up: boolean) => {
      const visible: LaidSegment[] = [];
      const targets: string[] = [];
      for (const s of segments) {
        const run = s.from === s.to && minLength !== Infinity ? longRun(s.from, index) : undefined;
        let shown = s;
        if (run) {
          const { start, end } = run;
          // The stubs next to each end stay; the arrows point at the row past the other end.
          const from = start + LONG_EDGE_STUB;
          const to = end === undefined ? Infinity : end - LONG_EDGE_STUB;
          if (index >= from && index < to) continue;
          if (up && index === to) shown = { ...s, arrow: "up", targetRow: start - 1 };
          else if (!up && index === from - 1) {
            shown = { ...s, arrow: "down", targetRow: end ?? -1 };
            if (end === undefined) arrows.set(s.from, shown);
          }
        }
        visible.push(shown);
        targets.push(targetOf(s));
      }
      return [visible, targets] as const;
    };
    const [up, upTargets] = filter(row.up, true);
    const [down, downTargets] = filter(row.down, false);
    return { ...row, up, down, upTargets, downTargets };
  };
  const push = (row: LaidRow) => {
    const index = pushed++;
    if (snapRows.has(index)) snaps.set(index, new Map(runs));
    const outgoing = new Set<number>();
    for (const s of row.down) if (s.from === s.to && s.from !== row.lane) outgoing.add(s.from);
    const through = new Set<number>();
    for (const s of row.up) if (s.from === s.to && outgoing.has(s.from)) through.add(s.from);
    for (const [lane, start] of runs) {
      if (through.has(lane)) continue;
      close(lane, start, index);
      runs.delete(lane);
    }
    for (const lane of through) if (!runs.has(lane)) runs.set(lane, index);
    held.push(row);
    while (held.length >= delay) {
      const at = pushed - held.length;
      rows.push(decide(held.shift()!, at));
    }
  };
  const finish = (n: number, last?: (row: LaidRow) => LaidRow) => {
    if (last && held.length) held[held.length - 1] = last(held.at(-1)!);
    for (const [lane, start] of runs) close(lane, start, n);
    runs.clear();
    for (let at = pushed - held.length; held.length; at++) rows.push(decide(held.shift()!, at));
    return { rows, snaps, enteringEnds };
  };
  return { push, finish };
}

/**
 * `straightenLaneChanges(compactLanes(rows)).slice(from)`, a stretch of rows at a time: a row of
 * the result reads the row on each side of it.
 */
function* finishRows(rows: readonly LaidRow[], from: number): Steps<LaidRow[]> {
  const out: LaidRow[] = [];
  for (let a = from; a < rows.length; a += STEP_ROWS) {
    if (a > from) yield;
    const b = Math.min(rows.length, a + STEP_ROWS);
    const context = a > 0 ? 1 : 0;
    const done = straightenLaneChanges(compactLanes(rows.slice(a - context, b + 1)));
    for (let i = a; i < b; i++) out.push(done[i - a + context] as LaidRow);
  }
  return out;
}

/** A laid out graph: the presented rows, and what laying it out again from a row needs. */
interface Paged {
  all: readonly RepoCommit[];
  graph: GraphCommit[];
  positions: Map<string, number>;
  /** Loaded commits having each id as a parent. */
  children: Map<string, number>;
  refAware: boolean;
  longEdges: boolean;
  /** `graphLayout(graph)`'s layout and owners (ref-aware layouts), and its inputs. */
  layout: ArrayLike<number>;
  owner: (row: number) => string;
  index: LayoutIndex | null;
  /** Presented rows, colours and kinds resolved by {@link resolveRow}. */
  rows: LaidRow[];
  /** Each new lane's place among the lanes in use and its row, in layout order. */
  ranks: number[];
  rankRows: number[];
  /** Rows of commits that start a lane. */
  tips: number[];
  /** Ascending; the last one is where the next page lays out again. */
  checkpoints: Checkpoint[];
  /** Rows with a long-edge arrow to another row, ascending. */
  arrowRows: number[];
  /** Colour keys of rows kept below commits made on top ({@link resync}), applied in order. */
  recolor: Recolor[];
}

/**
 * Rows `[from, to)` were laid out when a lane's colour came from another commit than it does now
 * (a lane through the old head started there, and now starts at a commit made on top): each key
 * in `keys` stands for its value. Lanes of kept lane states hold the keys as they are now.
 */
interface Recolor {
  from: number;
  to: number;
  keys: ReadonlyMap<string, string>;
}

/** `recolor`'s entries for rows `[from, to)` of its list, `shift` rows further down. */
function recolorRows(recolor: readonly Recolor[], from: number, to: number, shift = 0): Recolor[] {
  return recolor.flatMap((e) =>
    e.to <= from || e.from >= to
      ? []
      : [{ from: Math.max(e.from, from) + shift, to: Math.min(e.to, to) + shift, keys: e.keys }],
  );
}

function emptyPaged(longEdges: boolean): Paged {
  return {
    all: [],
    graph: [],
    positions: new Map(),
    children: new Map(),
    refAware: false,
    longEdges,
    layout: [],
    owner: () => "",
    index: null,
    rows: [],
    ranks: [],
    rankRows: [],
    tips: [],
    checkpoints: [
      {
        row: 0,
        lanes: { length: 0, slots: [] },
        nextColor: 0,
        nextIdentity: 0,
        ranks: 0,
        tips: 0,
        runs: new Map(),
        numbered: true,
        periodic: true,
      },
    ],
    arrowRows: [],
    recolor: [],
  };
}

const hasArrow = (row: GraphRow) =>
  row.up.some((s) => s.targetRow !== undefined && s.targetRow >= 0) ||
  row.down.some((s) => s.targetRow !== undefined && s.targetRow >= 0);

/** `segment`'s copy with `targetRow`, in a copy of `row`. */
function withTarget(row: LaidRow, index: number, targetRow: number): LaidRow {
  const down = row.down.slice();
  down[index] = { ...down[index]!, targetRow };
  return { ...row, down };
}

/** What a list is laid out with. */
interface Input {
  all: readonly RepoCommit[];
  graph: GraphCommit[];
  positions: Map<string, number>;
  children: Map<string, number>;
  refAware: boolean;
  longEdges: boolean;
  layout: ArrayLike<number>;
  owner: (row: number) => string;
  index: LayoutIndex | null;
}

/** A row from which rows above would change: lay out again from a checkpoint before it. */
interface Changed {
  changed: number;
}

/** The lanes of `cp` numbered for `whole`'s layout, or the first row whose lanes would change. */
function* lanesAt(
  prev: Paged,
  cp: Checkpoint,
  latest: boolean,
  index: LayoutIndex | null,
  whole: Layout,
): Steps<LaneSnapshot | Changed> {
  // Without refs no lane depends on the layout. The last checkpoint is numbered for the last one.
  if (!whole.refAware || !index) return cp.lanes;
  const moved = (row: number) => preferredLane(prev.layout, row) !== preferredLane(whole.layout, row);
  if (latest) {
    let i = 0;
    while (i < cp.tips && !moved(prev.tips[i]!)) i++;
    if (i === cp.tips) return cp.lanes;
  }
  const { ranks, slots, identities } = yield* replay(index, cp.row, whole);
  const differs = ranks.findIndex((r, i) => r !== prev.ranks[i]);
  if (differs >= 0) return { changed: prev.rankRows[differs]! };
  if (ranks.length !== cp.ranks) return { changed: 0 };
  return renumbered(cp.lanes, slots, identities) ?? { changed: 0 };
}

/** `lanes` in the slots {@link replay} gives them (by creation number), or null if they differ. */
function renumbered(lanes: LaneSnapshot, slots: Uint8Array, identities: ArrayLike<number>): LaneSnapshot | null {
  const byIdentity = new Map<number, Lane>();
  for (const [, lane] of lanes.slots) if (lane) byIdentity.set(lane.identity, lane);
  const out: Array<[number, Lane | null]> = [];
  for (const [i, slot] of slots.entries()) {
    if (slot === FREE) out.push([i, null]);
    else if (slot === USED) {
      const lane = byIdentity.get(identities[i]!);
      if (!lane) return null;
      out.push([i, lane]);
      byIdentity.delete(identities[i]!);
    }
  }
  return byIdentity.size ? null : { length: slots.length, slots: out };
}

/**
 * `input`'s graph laid out again from `prev`'s checkpoint `index`, keeping `prev`'s rows above it.
 * The commits before the checkpoint and `WINDOW` rows after it must be `prev`'s. `numbered` is the
 * checkpoint's lanes numbered for `input`'s layout, when the caller has them.
 */
function* resume(prev: Paged, index: number, input: Input, numbered?: LaneSnapshot): Steps<Paged | Changed> {
  const cp = prev.checkpoints[index]!;
  const { graph, positions, refAware, layout, longEdges } = input;
  const c = cp.row;
  const n = graph.length;
  const whole = { positions, layout, refAware };
  const lanes =
    numbered ?? (yield* lanesAt(prev, cp, cp.numbered && index === prev.checkpoints.length - 1, input.index, whole));
  if ("changed" in lanes) return lanes;
  const ranks = prev.ranks.slice(0, cp.ranks);
  const rankRows = prev.rankRows.slice(0, cp.ranks);
  const tips = prev.tips.slice(0, cp.tips);
  const next = Math.max(c, n - WINDOW);
  // Periodic states go on every `CHECKPOINT` rows from the last one kept (moved down with commits
  // made on top, they are no longer at multiples of it).
  const periodicKept = prev.checkpoints.slice(0, index + 1).filter((p) => p.periodic);
  const base = periodicKept.at(-1)!.row;
  const periodic = new Set<number>();
  for (let row = base + (Math.floor((c - base) / CHECKPOINT) + 1) * CHECKPOINT; row < next; row += CHECKPOINT)
    periodic.add(row);
  const snapRows = new Set([...periodic, next]);
  // A periodic state laid out again stays one.
  for (const p of periodicKept) if (snapRows.has(p.row)) periodic.add(p.row);
  const from = { lanes, nextColor: cp.nextColor, nextIdentity: cp.nextIdentity };
  const slotOf = new Map<number, number>();
  const laneOf = new Map<number, Lane>();
  for (const [slot, lane] of lanes.slots)
    if (lane) {
      slotOf.set(lane.identity, slot);
      laneOf.set(lane.identity, lane);
    }
  const entering = new Map<number, number>();
  for (const [identity, start] of cp.runs) entering.set(slotOf.get(identity)!, start);
  const hide = hideLongEdgesFrom(c, entering, snapRows, longEdges ? Infinity : LONG_EDGE);
  const snaps = yield* layOut(graph, c, from, whole, ranks, rankRows, tips, snapRows, hide.push);
  // The two rows kept before the window are context only: lanes started on them keep their place.
  const outFrom = c > 0 ? c + 2 : 0;
  const kept = below(rankRows, outFrom);
  if (kept !== below(prev.rankRows, outFrom)) return { changed: c };
  for (let i = cp.ranks; i < kept; i++) if (ranks[i] !== prev.ranks[i]) return { changed: c };
  const hidden = hide.finish(n, (row) => withUnloadedArrows(row, (id) => positions.has(id)));

  // Rows above the window are final but for the down arrows of runs open there.
  const out = prev.rows.slice(0, outFrom);
  for (const [identity, start] of cp.runs) {
    const lane = laneOf.get(identity)!;
    const edge = `${lane.source ?? ""}\0${lane.id}`;
    // `hideLongEdges` draws a hidden run's down arrow on the row after its first.
    const row = start + 1;
    const i = out[row]!.down.findIndex((s) => s.arrow === "down" && s.edge === edge);
    if (i < 0) continue;
    const end = hidden.enteringEnds.get(slotOf.get(identity)!) ?? n;
    if (out[row]!.down[i]!.targetRow !== end) out[row] = withTarget(out[row]!, i, end);
  }
  // The window's first two rows were only context: take their arrows' new targets.
  for (let r = c; r < outFrom; r++) {
    const fresh = hidden.rows[r - c]!;
    fresh.down.forEach((s, i) => {
      if (s.arrow === "down" && out[r]!.down[i]!.targetRow !== s.targetRow)
        out[r] = withTarget(out[r]!, i, s.targetRow!);
    });
  }

  // compactLanes row r reads rows r ± 1, straightenLaneChanges as well: drop one context row each.
  const presented = yield* finishRows(hidden.rows, c > 0 ? 2 : 0);
  const rows = out;
  for (const row of presented) rows.push(row);
  const arrowRows = prev.arrowRows.slice(0, below(prev.arrowRows, outFrom));
  for (let r = outFrom; r < n; r++) if (hasArrow(rows[r]!)) arrowRows.push(r);

  const checkpoints = periodicKept.filter((p) => !snapRows.has(p.row));
  const rowsAt = [...snapRows].sort((a, b) => a - b);
  for (const row of rowsAt) {
    const snap = snaps.get(row)!;
    const identityAt = new Map<number, number>();
    for (const [slot, lane] of snap.lanes.slots) if (lane) identityAt.set(slot, lane.identity);
    checkpoints.push({
      row,
      lanes: snap.lanes,
      nextColor: snap.nextColor,
      nextIdentity: snap.nextIdentity,
      ranks: snap.ranks,
      tips: snap.tips,
      runs: new Map([...hidden.snaps.get(row)!].map(([lane, start]) => [identityAt.get(lane)!, start])),
      numbered: true,
      periodic: periodic.has(row),
    });
  }
  const recolor = recolorRows(prev.recolor, 0, outFrom);
  return { ...input, rows, ranks, rankRows, tips, checkpoints, arrowRows, recolor };
}

/** `row` with its arrows' target rows moved by `shift`. */
function shifted(row: LaidRow, shift: number): LaidRow {
  const move = (s: LaidSegment) =>
    s.targetRow !== undefined && s.targetRow >= 0 ? { ...s, targetRow: s.targetRow + shift } : s;
  return { ...row, up: row.up.map(move), down: row.down.map(move) };
}

/**
 * Whether two lane states hold the same lanes in the same order (leading to the same commits, with
 * the same colours, creation numbers `identities` apart), and the place of each slot in use.
 */
function sameOrder(a: LaneSnapshot, b: LaneSnapshot, identities: number, sameColor: (a: string, b: string) => boolean) {
  const inUse = (lanes: LaneSnapshot) =>
    lanes.slots.flatMap(([slot, lane]) => (lane ? [[slot, lane] as const] : [])).sort(([x], [y]) => x - y);
  const x = inUse(a);
  const y = inUse(b);
  const same =
    x.length === y.length &&
    x.every(([, p], i) => {
      const q = y[i]![1];
      return (
        p.id === q.id &&
        p.source === q.source &&
        sameColor(p.colorKey, q.colorKey) &&
        p.dashed === q.dashed &&
        p.loadedKind === q.loadedKind &&
        p.identity === q.identity + identities
      );
    });
  return same ? { a: new Map(x.map(([slot], i) => [slot, i])), b: new Map(y.map(([slot], i) => [slot, i])) } : null;
}

/**
 * A Refresh whose changes are all near the top (commits made on top, a branch moved): from row
 * `tail` on the new list is `prev`'s, `shift` rows further down. Lays out the new list from the
 * top until its lanes and long-edge runs are the ones `prev` kept at a checkpoint, takes `prev`'s
 * rows below that (arrows moved by `shift`), then lays out again where `prev`'s list ended. Null
 * when no checkpoint matches.
 */
function* resync(prev: Paged, input: Input, shift: number, tail: number): Steps<Paged | null> {
  const { graph, positions, refAware, layout, longEdges } = input;
  const n = graph.length;
  const n0 = prev.graph.length;
  if (!refAware || !prev.refAware || !prev.index) return null;
  const whole = { positions, layout, refAware };
  const oldWhole = { positions: prev.positions, layout: prev.layout, refAware };
  // Rows of the new list that are `prev`'s: up to the end of either list.
  const shared = Math.min(n0 + shift, n);
  for (const [cpIndex, cp] of prev.checkpoints.entries()) {
    const c = cp.row;
    const at = c + shift;
    if (!c || at < tail || at < WINDOW) continue;
    // One try: the first checkpoint below the changes, with the rows after it to compare.
    if (at + 2 * WINDOW > shared) return null;
    const latest = cp.numbered && cpIndex === prev.checkpoints.length - 1;
    const old = yield* lanesAt(prev, cp, latest, prev.index, oldWhole);
    if ("changed" in old) return null;

    const ranks: number[] = [];
    const rankRows: number[] = [];
    const tips: number[] = [];
    const snapRows = new Set<number>([at]);
    for (let row = CHECKPOINT; row < at; row += CHECKPOINT) snapRows.add(row);
    const end = at + WINDOW;
    const hide = hideLongEdgesFrom(0, new Map(), snapRows, longEdges ? Infinity : LONG_EDGE);
    const snaps = yield* layOut(
      graph,
      0,
      { ...START, nextColor: 0 },
      whole,
      ranks,
      rankRows,
      tips,
      snapRows,
      hide.push,
      end,
    );
    const snap = snaps.get(at)!;
    const identities = snap.nextIdentity - cp.nextIdentity;
    // The same lanes in the same order (the layout may number them otherwise)...
    // A lane through the old head now colours like a commit made on top: the rows kept below
    // read their keys through `keys`. Only keys of commits above `at` can stand for another: a
    // lane started below it has one only through a later parent, which falls back below.
    const keys = new Map<string, string>();
    const order = sameOrder(snap.lanes, old, identities, (fresh, kept) => {
      const mapped = keys.get(kept);
      if (mapped !== undefined) return mapped === fresh;
      if (fresh !== kept && !((positions.get(kept) ?? at) < at)) return false;
      keys.set(kept, fresh);
      return true;
    });
    if (!order) return null;
    for (const [kept, fresh] of keys) if (kept === fresh) keys.delete(kept);
    // A commit below `at` with one of these as a later parent (listed after its parent) starts a
    // lane keyed by that parent, which the rows kept below must not read through `keys`.
    if (keys.size) {
      const above = new Map<string, number>();
      for (let r = 0; r < at; r++)
        for (const p of graph[r]!.parents) if (keys.has(p)) above.set(p, (above.get(p) ?? 0) + 1);
      for (const kept of keys.keys()) if ((input.children.get(kept) ?? 0) > (above.get(kept) ?? 0)) return null;
    }
    // ... each later lane taking the same place among them. A list longer or shorter than `prev`'s
    // is laid out again from the last kept state before its end: keep the lanes there.
    const restart =
      n === n0 + shift
        ? -1
        : Math.max(
            at,
            ...prev.checkpoints
              .slice(cpIndex + 1)
              .map((p) => p.row + shift)
              .filter((row) => row <= shared - WINDOW),
          );
    const later = yield* replay(input.index!, shared, whole, { row: at, ...snap }, restart);
    const before = below(prev.rankRows, shared - shift);
    if (later.ranks.length !== before - cp.ranks || later.ranks.some((rank, i) => rank !== prev.ranks[cp.ranks + i]))
      return null;
    // ... and the same long-edge runs through them.
    const hidden = hide.finish(end);
    const runs = hidden.snaps.get(at)!;
    const placeOf = new Map<number, number>();
    for (const [slot, lane] of old.slots) if (lane) placeOf.set(lane.identity, order.b.get(slot)!);
    const starts = new Map([...runs].map(([slot, start]) => [order.a.get(slot)!, start]));
    if (
      starts.size !== cp.runs.size ||
      [...cp.runs].some(([id, start]) => starts.get(placeOf.get(id)!) !== start + shift)
    )
      return null;

    // The rows above `at + 2`; down arrows of runs still open at `end` lead where `prev`'s did.
    const rows = (yield* finishRows(hidden.rows, 0)).slice(0, at + 2);
    for (const [r, row] of rows.entries())
      for (const [i, s] of row.down.entries()) {
        if (s.arrow !== "down" || s.targetRow !== end) continue;
        const before = prev.rows[r - shift]?.down.find((x) => x.arrow === "down" && x.edge === s.edge);
        if (!before) return null;
        rows[r] = withTarget(rows[r]!, i, before.targetRow! + shift);
      }
    const arrowRows = rows.flatMap((row, r) => (hasArrow(row) ? [r] : []));
    // Not `push(...rows)`: a long list overflows the call's arguments.
    for (let r = c + 2; r < prev.rows.length; r++) rows.push(prev.rows[r]!);
    for (const r of prev.arrowRows.slice(below(prev.arrowRows, c + 2))) {
      rows[r + shift] = shifted(prev.rows[r]!, shift);
      arrowRows.push(r + shift);
    }

    const checkpoints = [prev.checkpoints[0]!];
    for (const row of [...snapRows].sort((a, b) => a - b)) {
      const fresh = snaps.get(row)!;
      const identityAt = new Map<number, number>();
      for (const [slot, lane] of fresh.lanes.slots) if (lane) identityAt.set(slot, lane.identity);
      checkpoints.push({
        ...fresh,
        row,
        runs: new Map([...hidden.snaps.get(row)!].map(([lane, start]) => [identityAt.get(lane)!, start])),
        numbered: true,
        periodic: row !== at || cp.periodic,
      });
    }
    for (const p of prev.checkpoints.slice(cpIndex + 1))
      checkpoints.push({
        row: p.row + shift,
        lanes: {
          length: p.lanes.length,
          slots: p.lanes.slots.map(([slot, lane]) => [
            slot,
            lane && {
              ...lane,
              identity: lane.identity + identities,
              colorKey: keys.get(lane.colorKey) ?? lane.colorKey,
            },
          ]),
        },
        nextColor: p.nextColor,
        nextIdentity: p.nextIdentity + identities,
        ranks: p.ranks - cp.ranks + snap.ranks,
        tips: p.tips - cp.tips + snap.tips,
        runs: new Map([...p.runs].map(([id, start]) => [id + identities, start + shift])),
        // Numbered for the layout `prev` had: laying out from it replays the lanes first.
        numbered: false,
        periodic: p.periodic,
      });
    const synced: Paged = {
      ...input,
      rows,
      ranks: ranks.slice(0, snap.ranks).concat(prev.ranks.slice(cp.ranks)),
      rankRows: rankRows.slice(0, snap.ranks).concat(prev.rankRows.slice(cp.ranks).map((row) => row + shift)),
      tips: tips.slice(0, snap.tips).concat(prev.tips.slice(cp.tips).map((row) => row + shift)),
      checkpoints: spaced(checkpoints, restart),
      arrowRows,
      recolor: recolorRows(prev.recolor, c + 2, prev.rows.length, shift).concat(
        keys.size ? [{ from: at + 2, to: rows.length, keys }] : [],
      ),
    };
    if (n === n0 + shift) return synced;
    // `prev`'s rows end where its list did: lay out the rest as a page.
    const last = synced.checkpoints.findIndex((p) => p.row === restart);
    const lanes = later.kept && renumbered(synced.checkpoints[last]!.lanes, later.kept.slots, later.kept.identities);
    const next = yield* resume(synced, last, input, lanes ?? undefined);
    return "changed" in next ? null : next;
  }
  return null;
}

const prunable = (c: GraphCommit) =>
  c.parents.length >= 2 &&
  c.parents.some((_, i) => (c.edgeTypes?.[i] ?? (c.dashed?.[i] ? "filtered" : "normal")) === "filtered");

const sameList = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]));

/** Whether the graph passes read the same from both commits. */
const sameGraphCommit = (a: GraphCommit, b: GraphCommit) =>
  a.id === b.id &&
  sameList(a.parents, b.parents) &&
  sameList(a.dashed, b.dashed) &&
  sameList(a.edgeTypes, b.edgeTypes) &&
  sameList(a.refs, b.refs) &&
  // `graphLayout` reads remote names to rank a commit's refs.
  (!a.refs?.length || sameList(a.remoteNames, b.remoteNames));

/** Whether `createPagedLogGraph` computes the graph for these options (none rewrites the graph). */
export const pagesLogGraph = (options: GraphShape, fragments: { collapsed: ReadonlySet<string> }) =>
  !options.collapseLinear && !fragments.collapsed.size && !options.linearizeMerges;

export interface PagedLogGraph {
  commits: readonly RepoCommit[];
  graph: readonly GraphCommit[];
  /** Presented rows; only their geometry (lanes, widths, targets) is final. */
  rows: readonly GraphRow[];
  /** Row `index` as `presentLogGraph` returns it. */
  row(index: number): GraphRow | undefined;
  /** Rows of `graph` with this id, ascending. */
  rowsOf(id: string): readonly number[];
  /** Commits of `graph` having this id as a parent. */
  childCount(id: string): number;
}

/** `row` with its colours and edge kinds as the whole list gives them. */
function resolveRow(
  row: LaidRow,
  color: (key: string | undefined, fallback: number) => number,
  loaded: (id: string) => boolean,
): GraphRow {
  const segment = ({ colorKey, target, loadedKind, ...s }: LaidSegment): GraphSegment =>
    target === undefined || loadedKind === "shallow"
      ? { ...s, color: color(colorKey, s.color) }
      : { ...s, color: color(colorKey, s.color), kind: loaded(target) ? loadedKind : "unloaded" };
  const { colorKey, ...rest } = row;
  return { ...rest, color: color(colorKey, row.color), up: row.up.map(segment), down: row.down.map(segment) };
}

function toResult(paged: Paged): PagedLogGraph {
  const { graph, positions, owner, refAware, rows, children } = paged;
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
      colors.set(key, (value = ownerColor(index === undefined ? key : owner(index))));
    }
    return value;
  };
  const loaded = (id: string) => at(id) !== undefined;
  const resolved = new Map<number, GraphRow>();
  const colorOf = (index: number) => {
    const entries = paged.recolor.filter((e) => index >= e.from && index < e.to);
    if (!entries.length) return color;
    return (key: string | undefined, fallback: number) =>
      color(key === undefined ? key : entries.reduce((k, e) => e.keys.get(k) ?? k, key), fallback);
  };
  return {
    commits: paged.all,
    graph,
    rows,
    row(index) {
      let row = resolved.get(index);
      if (!row && rows[index]) resolved.set(index, (row = resolveRow(rows[index], colorOf(index), loaded)));
      return row;
    },
    rowsOf(id) {
      const index = at(id);
      return index === undefined ? [] : [index];
    },
    // Children come before their parents: later pages add none to a commit of this result.
    childCount: (id) => children.get(id) ?? 0,
  };
}

/**
 * `present` returns `presentLogGraph(all, options, …)` for options {@link pagesLogGraph} accepts,
 * rows resolved one at a time through `row`. Each call lays out again only from the first row the
 * previous call's commits do not give (a page appended, or a Refresh with a change somewhere).
 * Returns null when the graph has to come from `presentLogGraph` (filtered merges are pruned, or
 * two commits share a key). `reset` drops what the previous call kept. `steps` is `present` in
 * steps: what it keeps changes only once they are all taken, and a call to `steps` or `present`
 * before then would start from what the previous completed call kept, so finish or drop it first.
 */
export function createPagedLogGraph() {
  let paged: Paged | null = null;
  let result: PagedLogGraph | null = null;
  const reset = () => {
    paged = null;
    result = null;
    return null;
  };
  function* steps(all: readonly RepoCommit[], options: GraphShape): Steps<PagedLogGraph | null> {
    const { longEdges } = options;
    if (paged && result && paged.all === all && paged.longEdges === longEdges) return result;
    const prev = paged && paged.longEdges === longEdges ? paged : emptyPaged(longEdges);
    const n0 = prev.all.length;
    const n = all.length;
    let same = 0;
    while (same < n0 && same < n && prev.all[same] === all[same]) same++;
    const added: GraphCommit[] = [];
    for (let i = same; i < n; i++) {
      if ((i - same) % STEP_ROWS === STEP_ROWS - 1) yield;
      added.push(graphCommit(all[i]!));
    }
    if (added.some(prunable)) return reset();
    // Commits the store replaced (a Refresh) that the graph passes read the same.
    let unchanged = same;
    while (unchanged < n0 && unchanged < n && sameGraphCommit(prev.graph[unchanged]!, added[unchanged - same]!))
      unchanged++;
    const graph = (same === n0 ? prev.graph : prev.graph.slice(0, same)).concat(added);
    const extending = unchanged === n0;
    // Shared with the previous result while the list only grows; a newer result replaces it.
    const positions = extending ? prev.positions : new Map<string, number>();
    const children = extending ? prev.children : new Map<string, number>();
    for (let i = extending ? n0 : 0; i < n; i++) {
      if (i % STEP_ROWS === STEP_ROWS - 1) yield;
      const c = graph[i]!;
      if (positions.has(c.id)) return reset();
      positions.set(c.id, i);
      for (const p of c.parents) children.set(p, (children.get(p) ?? 0) + 1);
    }
    const hasRefs = (c: GraphCommit) => !!c.refs?.length;
    const refAware = extending ? prev.refAware || graph.slice(n0).some(hasRefs) : graph.some(hasRefs);
    if (!n) {
      paged = { ...emptyPaged(longEdges), all, refAware };
      return (result = toResult(paged));
    }
    if (extending && n === n0) {
      paged = { ...prev, all, graph };
      return (result = toResult(paged));
    }
    const index = refAware
      ? yield* indexLayout(prev.index, graph, extending && prev.refAware ? n0 : 0, positions, children)
      : null;
    const { layout, owner } = index ? layoutChains(graph, index.parents, index.heads) : { layout: [], owner: () => "" };
    const input = { all, graph, positions, children, refAware, longEdges, layout, owner, index };
    // Rows from here on may change; rows above it are kept when a checkpoint lies far enough above.
    let first = refAware === prev.refAware ? Math.min(unchanged, n0) : 0;
    // Changes near the top only (commits made on top): keep the rows below them instead.
    const anchor = !extending && first < CHECKPOINT + WINDOW ? prev.positions.get(graph[n - 1]!.id) : undefined;
    if (anchor !== undefined && prev.graph[anchor]?.id === graph[n - 1]!.id) {
      const shift = n - 1 - anchor;
      let tail = n;
      while (tail > 0 && tail - 1 - shift >= 0 && sameGraphCommit(prev.graph[tail - 1 - shift]!, graph[tail - 1]!))
        tail--;
      const synced = yield* resync(prev, input, shift, tail);
      if (synced) {
        paged = synced;
        return (result = toResult(paged));
      }
    }
    for (;;) {
      const index = prev.checkpoints.findLastIndex((cp) => cp.row === 0 || cp.row <= first - WINDOW);
      const next = yield* resume(prev, index, input);
      if (!("changed" in next)) {
        paged = next;
        return (result = toResult(paged));
      }
      first = Math.min(first, next.changed);
    }
  }
  const present = (all: readonly RepoCommit[], options: GraphShape) => run(steps(all, options));
  return { present, steps, reset };
}
