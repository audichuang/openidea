/**
 * Commit graph lanes for the Git log (computed client-side from parents, for
 * commits in topological order, children before parents), plus the graph
 * transformations of the log's Graph / View options.
 */

export type EdgeKind = "normal" | "filtered" | "collapsed" | "shallow" | "unloaded";

export interface GraphSegment {
  edge?: string;
  kind?: EdgeKind;
  source?: string;
  /** Lane at the segment's start (top edge for `up`, node level for `down`). */
  from: number;
  /** Lane at the segment's end (node level for `up`, bottom edge for `down`). */
  to: number;
  color: number;
  /** Stands for collapsed commits (Collapse Linear Branches). */
  dashed?: true;
  /** A long edge continues out of sight in this direction (Show Long Edges off). */
  arrow?: "up" | "down";
  /** Destination row of a long-edge arrow in the displayed graph. */
  targetRow?: number;
  /** Drawn lane positions when they differ from `from` / `to` (see {@link straightenLaneChanges}). */
  fromX?: number;
  toX?: number;
}

export interface GraphRow {
  id?: string;
  /** Lane of the commit's node. */
  lane: number;
  color: number;
  /** Top half of the row: lines entering from the previous row. */
  up: GraphSegment[];
  /** Bottom half: lines leaving towards the next row. */
  down: GraphSegment[];
  /** Number of lane slots this row spans. */
  width: number;
  /** Graph ids corresponding to each half-edge, for fragment actions. */
  upTargets?: string[];
  downTargets?: string[];
}

interface Lane {
  id: string;
  source?: string;
  kind?: EdgeKind;
  color: number;
  dashed?: true;
}

export interface GraphState {
  lanes: Array<Lane | null>;
  nextColor: number;
}

export interface GraphCommit {
  id: string;
  parents: readonly string[];
  /** Per parent: the link skips collapsed commits. */
  dashed?: readonly boolean[];
  refs?: readonly string[];
  remoteNames?: readonly string[];
  edgeTypes?: readonly ("normal" | "filtered" | "collapsed" | "shallow" | "unloaded")[];
}

export const emptyGraphState = (): GraphState => ({ lanes: [], nextColor: 0 });

const seg = (from: number, to: number, color: number, dashed?: boolean): GraphSegment =>
  dashed ? { from, to, color, dashed: true } : { from, to, color };

const laneOf = (id: string, color: number, dashed: boolean): Lane =>
  dashed ? { id, color, dashed: true } : { id, color };

/** Inserts `value` into the ascending `list` (no-op if present). */
function insertSorted(list: number[], value: number) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  if (list[lo] !== value) list.splice(lo, 0, value);
}

function removeSorted(list: number[], value: number) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  if (list[lo] === value) list.splice(lo, 1);
}

/**
 * The lane slots of the layout. A lane may sit at a high slot number (the preferred lane of
 * a commit is its branch's layout number, which grows with the log), so the slots are kept
 * sparsely: a row then costs the number of live lanes, not the highest slot number.
 * A slot is a lane, `null` (vacated: the next free slot, see {@link firstFree}) or absent
 * (never used, which counts as unoccupied but is not offered as the next free slot).
 */
class LaneSlots {
  /** Slot count (the highest slot ever extended to, less trimmed vacated tail slots). */
  length: number;
  private readonly slots = new Map<number, Lane | null>();
  /** Slot numbers holding a lane, ascending. */
  private readonly live: number[] = [];
  /** Slot numbers holding `null`, ascending. */
  private readonly vacated: number[] = [];

  constructor(initial: ReadonlyArray<Lane | null | undefined>) {
    this.length = initial.length;
    initial.forEach((lane, i) => {
      if (lane === undefined) return;
      this.slots.set(i, lane);
      (lane ? this.live : this.vacated).push(i);
    });
  }

  get(i: number): Lane | null | undefined {
    return this.slots.get(i);
  }

  /** Lanes in slot order. */
  forEachLane(fn: (lane: Lane, slot: number) => void) {
    for (const i of this.live) fn(this.slots.get(i) as Lane, i);
  }

  /** Slots of the lanes leading to `id`, in slot order. */
  slotsOf(id: string): number[] {
    return this.live.filter((i) => (this.slots.get(i) as Lane).id === id);
  }

  /** The first vacated slot, else one past the last. */
  firstFree(): number {
    return this.vacated.length ? this.vacated[0]! : this.length;
  }

  vacate(i: number) {
    if (i >= this.length) this.length = i + 1;
    removeSorted(this.live, i);
    this.slots.set(i, null);
    insertSorted(this.vacated, i);
  }

  set(i: number, lane: Lane) {
    if (i >= this.length) this.length = i + 1;
    removeSorted(this.vacated, i);
    insertSorted(this.live, i);
    this.slots.set(i, lane);
  }

  /** Drops vacated slots at the end. */
  trim() {
    while (this.length && this.slots.get(this.length - 1) === null) {
      this.vacated.pop();
      this.slots.delete(this.length - 1);
      this.length--;
    }
  }

  toArray(): Array<Lane | null> {
    const out = new Array<Lane | null>(this.length);
    for (const [i, lane] of this.slots) out[i] = lane;
    return out;
  }
}

/**
 * Lays out `commits` (continuing from `state`, so pages can be appended).
 * Each lane keeps its position while it lives; freed slots are reused.
 */
export function computeGraph(
  commits: ReadonlyArray<GraphCommit>,
  state: GraphState = emptyGraphState(),
): { rows: GraphRow[]; state: GraphState } {
  const lanes = new LaneSlots(state.lanes);
  const track = commits.some((c) => c.refs !== undefined);
  const positions = new Map(commits.map((c, i) => [c.id, i]));
  const layout = graphLayout(commits);
  const refAware = commits.some((c) => c.refs?.length);
  const stableColor = (id: string, fallback: number) => {
    if (!refAware) return fallback;
    const index = positions.get(id);
    const owner = index == null ? id : layout.owners[index]!;
    let hash = 2166136261;
    for (const char of owner) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return hash >>> 0;
  };
  const describe = (s: GraphSegment, lane: Lane) =>
    track ? { ...s, edge: `${lane.source ?? ""}\0${lane.id}`, source: lane.source, kind: lane.kind } : s;
  // A lane keeps its slot until it reaches its target, so the rows it passes can share one
  // straight segment (later passes copy a segment before editing it). Only tracked segments
  // are shared: an untracked one is cheaper to rebuild than to look up.
  const straight = new WeakMap<Lane, GraphSegment>();
  const straightOf = (l: Lane, i: number) => {
    let s = straight.get(l);
    if (!s) straight.set(l, (s = describe(seg(i, i, l.color, l.dashed), l)));
    return s;
  };

  let nextColor = state.nextColor;
  const rows: GraphRow[] = [];

  for (const c of commits) {
    const matching = lanes.slotsOf(c.id);
    let lane: number;
    let color: number;
    if (matching.length) {
      lane = matching[0]!;
      color = lanes.get(lane)!.color;
    } else {
      const preferred = refAware ? Math.max(0, layout.layout[positions.get(c.id)!]! - 1) : lanes.firstFree();
      lane = !lanes.get(preferred) ? preferred : lanes.firstFree();
      color = stableColor(c.id, nextColor++);
    }
    const widthBefore = lanes.length;

    const up: GraphSegment[] = [];
    const upTargets: string[] = [];
    lanes.forEachLane((l, i) => {
      up.push(
        track && (l.id !== c.id || lane === i)
          ? straightOf(l, i)
          : describe(seg(i, l.id === c.id ? lane : i, l.color, l.dashed), l),
      );
      upTargets.push(l.id);
    });
    for (const m of matching) lanes.vacate(m);
    lanes.vacate(lane);

    const down: GraphSegment[] = [];
    const downTargets: string[] = [];
    lanes.forEachLane((l, i) => {
      down.push(track ? straightOf(l, i) : seg(i, i, l.color, l.dashed));
      downTargets.push(l.id);
    });

    c.parents.forEach((p, k) => {
      const dashed = !!c.dashed?.[k];
      const kind = c.edgeTypes?.[k] ?? (dashed ? "filtered" : "normal");
      const info = {
        id: p,
        source: c.id,
        kind: !positions.has(p) && kind !== "shallow" ? ("unloaded" as const) : kind,
      };
      if (track && kind === "shallow") {
        down.push({
          ...describe(seg(lane, lane, color, dashed), { ...info, color }),
          kind: kind === "shallow" ? "shallow" : "unloaded",
          arrow: "down",
          targetRow: -1,
        });
        downTargets.push(p);
        return;
      }
      // The first parent continues this lane even if another lane also leads to it
      // (both lines then converge at the parent's node, like `git log --graph`).
      if (k === 0) {
        lanes.set(lane, { ...laneOf(p, color, dashed), ...info });
        down.push(describe(seg(lane, lane, color, dashed), { ...info, color }));
        downTargets.push(p);
        return;
      }
      const existing = lanes.slotsOf(p)[0] ?? -1;
      if (existing >= 0) {
        down.push(
          describe(seg(lane, existing, lanes.get(existing)!.color, dashed), {
            ...info,
            color: lanes.get(existing)!.color,
          }),
        );
        downTargets.push(p);
        return;
      }
      const slot = lanes.firstFree();
      const col = stableColor(p, nextColor++);
      lanes.set(slot, { ...laneOf(p, col, dashed), ...info });
      down.push(describe(seg(lane, slot, col, dashed), { ...info, color: col }));
      downTargets.push(p);
    });

    lanes.trim();
    const widthAfter = down.reduce((width, segment) => Math.max(width, segment.to + 1), 0);
    rows.push({
      ...(track ? { id: c.id } : {}),
      lane,
      color,
      up,
      down,
      upTargets,
      downTargets,
      width: Math.max(widthBefore, widthAfter, lane + 1),
    });
  }
  if (track && rows.length) {
    const last = rows.at(-1)!;
    last.down = last.down.map((s) => (s.kind === "unloaded" ? { ...s, arrow: "down", targetRow: -1 } : s));
  }
  return { rows, state: { lanes: lanes.toArray(), nextColor } };
}

/**
 * Collapse Linear Branches: hides the commits of linear chains (one parent, one child,
 * no references) so that only branch points, merges, tips and referenced commits stay,
 * linked by dashed edges. Commits in `keep` (HEAD) stay visible.
 */
export function collapseLinear<
  C extends {
    id: string;
    parents: readonly string[];
    refs: readonly string[];
    dashed?: readonly boolean[];
    edgeTypes?: readonly EdgeKind[];
  },
>(
  commits: readonly C[],
  keep: ReadonlySet<string>,
  only?: ReadonlySet<string>,
): { commits: C[]; graph: GraphCommit[] } {
  const byId = new Map(commits.map((c) => [c.id, c]));
  const children = new Map<string, number>();
  for (const c of commits) for (const p of c.parents) children.set(p, (children.get(p) ?? 0) + 1);
  const hidden = (c: C | undefined): boolean =>
    !!c &&
    c.parents.length === 1 &&
    children.get(c.id) === 1 &&
    !c.refs.length &&
    !keep.has(c.id) &&
    (!only || only.has(c.id));

  const visible: C[] = [];
  const graph: GraphCommit[] = [];
  for (const c of commits) {
    if (hidden(c)) continue;
    const dashed: boolean[] = [];
    const parents: string[] = [];
    const edgeTypes: EdgeKind[] = [];
    for (const [i, p] of c.parents.entries()) {
      let cur = p;
      let skipped = !!c.dashed?.[i];
      let kind = c.edgeTypes?.[i] ?? (skipped ? "filtered" : "normal");
      for (let next = byId.get(cur), guard = 0; next && guard < commits.length && hidden(next); guard++) {
        cur = next.parents[0]!;
        next = byId.get(cur);
        skipped = true;
        kind = "collapsed";
      }
      // Two collapsed lines can lead to the same commit: draw one edge.
      const seen = parents.indexOf(cur);
      if (seen >= 0) dashed[seen] = dashed[seen]! || skipped;
      else {
        parents.push(cur);
        dashed.push(skipped);
        edgeTypes.push(kind);
      }
    }
    visible.push(c);
    graph.push({ ...c, id: c.id, parents, dashed, edgeTypes });
  }
  return { commits: visible, graph };
}

/**
 * A filtered log connects a commit to the nearest matching ancestor along every merge
 * path. Ancestors that another of the commit's connections already reaches would each
 * open a lane of their own without adding one, so their filtered edges are dropped;
 * real parents and collapsed-fragment connections stay as they are. Whether a target
 * below the loaded page is reached cannot be told yet: while another connection
 * already leads below the page, its filtered edge waits until the target is loaded.
 */
export function pruneFilteredEdges(commits: readonly GraphCommit[]): GraphCommit[] {
  const positions = new Map(commits.map((c, i) => [c.id, i]));
  const kindOf = (c: GraphCommit, i: number) => c.edgeTypes?.[i] ?? (c.dashed?.[i] ? "filtered" : "normal");
  const pruned = (c: GraphCommit) => c.parents.length >= 2 && c.parents.some((_, i) => kindOf(c, i) === "filtered");
  if (!commits.some(pruned)) return [...commits];
  const reaches = filteredReachability(commits, positions);
  // Rows whose history continues below the page (parents come later in the log).
  const leavesPage: boolean[] = [];
  for (let at = commits.length - 1; at >= 0; at--) {
    leavesPage[at] = commits[at]!.parents.some((p) => {
      const pos = positions.get(p);
      return pos == null || (pos > at && leavesPage[pos]!);
    });
  }
  return commits.map((c, row) => {
    if (!pruned(c)) return c;
    // Walk the loaded parents shallowest first: a filtered parent that a kept connection already
    // reaches adds nothing (and a dropped one was reached itself, so what it reaches is too).
    const drop = new Set<number>();
    const kept: number[] = [];
    const indices = c.parents.map((_, i) => i);
    const loaded = indices.filter((i) => positions.has(c.parents[i]!));
    for (const i of loaded.sort((a, b) => positions.get(c.parents[a]!)! - positions.get(c.parents[b]!)!)) {
      const pos = positions.get(c.parents[i]!)!;
      if (kindOf(c, i) === "filtered" && reaches(row, kept, pos)) drop.add(i);
      else kept.push(pos);
    }
    // Targets below the page: one connection leading there is enough until they load.
    const unloaded = indices.filter((i) => !positions.has(c.parents[i]!));
    const filteredBelow = unloaded.filter((i) => kindOf(c, i) === "filtered");
    const leads = unloaded.some((i) => kindOf(c, i) !== "filtered") || kept.some((pos) => leavesPage[pos]);
    for (const i of leads ? filteredBelow : filteredBelow.slice(1)) drop.add(i);
    if (!drop.size) return c;
    const keep = indices.filter((i) => !drop.has(i));
    return {
      ...c,
      parents: keep.map((i) => c.parents[i]!),
      ...(c.dashed ? { dashed: keep.map((i) => c.dashed![i]!) } : {}),
      ...(c.edgeTypes ? { edgeTypes: keep.map((i) => c.edgeTypes![i]!) } : {}),
    };
  });
}

/**
 * `reaches(row, from, target)`: whether row `target` is in `from` or an ancestor of one of
 * them, walking only rows no deeper than the deepest parent of row `row`.
 *
 * In log order (parents after their children) that depth bound never cuts a path to a
 * parent of `c`, so the answer depends only on the two rows and is shared between rows:
 * a spanning-forest interval proves most hits at once, a post-order bound rules out most
 * misses, and the remaining walks are memoised per target. Logs with a parent listed
 * above its child keep a bounded walk per row.
 */
function filteredReachability(commits: readonly GraphCommit[], positions: ReadonlyMap<string, number>) {
  const n = commits.length;
  const parents = commits.map((c) =>
    c.parents.flatMap((p) => {
      const at = positions.get(p);
      return at == null ? [] : [at];
    }),
  );
  if (parents.some((ps, i) => ps.some((p) => p <= i))) {
    // One walk per row as before, extended as `from` grows within the row.
    let current = -1;
    let covered = new Set<number>();
    let walked = 0;
    return (row: number, from: readonly number[], target: number) => {
      if (row !== current) {
        current = row;
        covered = new Set();
        walked = 0;
      }
      const limit = Math.max(...commits[row]!.parents.map((p) => positions.get(p) ?? -1));
      for (const stack = from.slice(walked); stack.length;) {
        const at = stack.pop()!;
        if (covered.has(at)) continue;
        covered.add(at);
        for (const p of parents[at]!) if (p <= limit) stack.push(p);
      }
      walked = from.length;
      return covered.has(target);
    };
  }

  // Depth-first spanning forest from the top rows: pre/post order intervals, and `low`,
  // the smallest post order among everything a row reaches (descendants finish first).
  const pre = new Int32Array(n).fill(-1);
  const post = new Int32Array(n);
  const low = new Int32Array(n);
  let clock = 0;
  let finished = 0;
  for (let root = 0; root < n; root++) {
    if (pre[root] !== -1) continue;
    pre[root] = clock++;
    const stack = [root];
    const next = [0];
    while (stack.length) {
      const at = stack.at(-1)!;
      const ps = parents[at]!;
      const k = next.at(-1)!;
      if (k < ps.length) {
        next[next.length - 1] = k + 1;
        const p = ps[k]!;
        if (pre[p] === -1) {
          pre[p] = clock++;
          stack.push(p);
          next.push(0);
        }
        continue;
      }
      post[at] = finished++;
      let min = post[at]!;
      for (const p of ps) min = Math.min(min, low[p]!);
      low[at] = min;
      stack.pop();
      next.pop();
    }
  }
  const inTree = (from: number, target: number) => pre[from]! <= pre[target]! && post[target]! <= post[from]!;
  const excluded = (from: number, target: number) =>
    from > target || post[target]! < low[from]! || post[target]! > post[from]!;

  // Walk results per target, dropped once they outgrow the log so memory stays linear.
  const memo = new Map<number, Map<number, boolean>>();
  let memoSize = 0;
  const reachesOne = (from: number, target: number): boolean => {
    if (from === target || inTree(from, target)) return true;
    if (excluded(from, target)) return false;
    if (memoSize > 4 * n) {
      memo.clear();
      memoSize = 0;
    }
    let known = memo.get(target);
    if (!known) memo.set(target, (known = new Map()));
    const cached = known.get(from);
    if (cached != null) return cached;
    const path = [from];
    const next = [0];
    const settle = (value: boolean, nodes: readonly number[]) => {
      for (const at of nodes) known.set(at, value);
      memoSize += nodes.length;
      return value;
    };
    while (path.length) {
      const at = path.at(-1)!;
      const ps = parents[at]!;
      const k = next.at(-1)!;
      if (k === ps.length) {
        settle(false, [at]);
        path.pop();
        next.pop();
        continue;
      }
      next[next.length - 1] = k + 1;
      const p = ps[k]!;
      if (p === target || inTree(p, target) || known.get(p) === true) return settle(true, path);
      if (excluded(p, target) || known.has(p)) continue;
      path.push(p);
      next.push(0);
    }
    return false;
  };
  return (_row: number, from: readonly number[], target: number) => from.some((at) => reachesOne(at, target));
}

/** Ids reachable from the given heads (log order: children before parents). */
export function reachableFrom(
  commits: ReadonlyArray<{ id: string; parents: readonly string[] }>,
  heads: Iterable<string>,
): Set<string> {
  const out = new Set(heads);
  if (!out.size) return out;
  for (const c of commits) if (out.has(c.id)) for (const p of c.parents) out.add(p);
  return out;
}

const refRank = (c: GraphCommit, ref: string) =>
  `${ref === "HEAD" ? 0 : ref === "main" || ref === "master" ? 1 : ref.startsWith("tag: ") ? 4 : c.remoteNames?.includes(ref) ? 3 : 2}${ref}`;

/** The order `graphLayout` takes heads in (`localeCompare`): by their best ref, refless ones by id. */
export const headPriority = (c: GraphCommit) =>
  c.refs?.length ? c.refs.map((r) => refRank(c, r)).sort()[0]! : `5${c.id}`;

/**
 * `graphLayout`'s DFS, given each commit's loaded parents (rows, in parent order) and the heads in
 * the order it takes them. Owners are built when asked for.
 */
export function layoutChains(
  commits: readonly GraphCommit[],
  parents: readonly (readonly number[])[],
  heads: readonly number[],
) {
  const layout = new Int32Array(commits.length);
  // The head whose DFS reached each commit, and the layout that DFS started at.
  const headOf = new Int32Array(commits.length);
  const starts = new Map<number, number>();
  // Parents before a commit's cursor are laid out already: they stay so.
  const cursor = new Int32Array(commits.length);
  let next = 1;
  const stack: number[] = [];
  for (const head of heads) {
    if (layout[head]) continue;
    starts.set(head, next);
    stack.push(head);
    while (stack.length) {
      const node = stack[stack.length - 1]!;
      const first = !layout[node];
      if (first) {
        layout[node] = next;
        headOf[node] = head;
      }
      const own = parents[node]!;
      let k = cursor[node]!;
      while (k < own.length && layout[own[k]!]) k++;
      cursor[node] = k;
      if (k < own.length) stack.push(own[k]!);
      else {
        if (first) next++;
        stack.pop();
      }
    }
  }
  const names = new Map<number, string>();
  const owner = (i: number) => {
    const head = headOf[i]!;
    let name = names.get(head);
    if (name === undefined) {
      const c = commits[head]!;
      name =
        c.refs?.filter((r) => r !== "HEAD").sort((a, b) => refRank(c, a).localeCompare(refRank(c, b)))[0] ??
        (c.refs?.includes("HEAD") ? "HEAD" : c.id);
      names.set(head, name);
    }
    return `${name}\0${layout[i]! - starts.get(head)!}`;
  };
  return { layout, owner };
}

/** Ref-priority DFS layout, shared by Bek fragment recognition and lane colours.
 * Adapted from IntelliJ GraphLayoutBuilder (JetBrains contributors, Apache-2.0). */
export function graphLayout(commits: readonly GraphCommit[]) {
  const positions = new Map(commits.map((c, i) => [c.id, i]));
  const parents = commits.map((c) =>
    c.parents.flatMap((id) => {
      const i = positions.get(id);
      return i == null ? [] : [i];
    }),
  );
  const children = commits.map(() => [] as number[]);
  parents.forEach((ps, i) => ps.forEach((p) => children[p]!.push(i)));
  const heads = commits.flatMap((c, i) => (!children[i]!.length || c.refs?.length ? [i] : []));
  const priorities = new Map(heads.map((i) => [i, headPriority(commits[i]!)]));
  heads.sort((a, b) => priorities.get(a)!.localeCompare(priorities.get(b)!));
  const { layout, owner } = layoutChains(commits, parents, heads);
  return { layout, owners: commits.map((_, i) => owner(i)), parents, children };
}

/** LinearBek fragment recognition and nested expansion.
 * Adapted from JetBrains LinearBekGraphBuilder, Copyright 2000-2025, Apache-2.0. */
export function linearizeMerges(commits: readonly GraphCommit[], expanded: ReadonlySet<string> = new Set()) {
  const positions = new Map(commits.map((c, i) => [c.id, i]));
  const { layout } = graphLayout(commits);
  const expand = new Set(expanded);
  const build = () => {
    const graph = commits.map((c) => ({
      ...c,
      parents: [...c.parents],
      dashed: c.parents.map((_, i) => !!c.dashed?.[i]),
    }));
    const fragments = new Map<string, string>();
    const nodes = new Map<string, Set<string>>();
    for (let merge = graph.length - 1; merge >= 0; merge--) {
      const down = graph[merge]!.parents.flatMap((p) => {
        const i = positions.get(p);
        return i == null ? [] : [i];
      }).sort((a, b) => a - b);
      if (down.length !== 2 || graph[merge]!.parents.length !== 2) continue;
      const [right, left] = down as [number, number];
      const body = new Set<number>(),
        tails = new Set<number>();
      const tailEdges = new Map<number, Set<string>>();
      const queue: Array<{ up: number; down: number | undefined; id: string }> = [];
      const add = (up: number) => graph[up]!.parents.forEach((id) => queue.push({ up, down: positions.get(id), id }));
      const magic = new Set<number>();
      const pending = [...graph[left]!.parents];
      while (pending.length) {
        const id = pending.pop()!,
          i = positions.get(id);
        if (i == null || i > left + LONG_EDGE || magic.has(i)) continue;
        magic.add(i);
        pending.push(...graph[i]!.parents);
      }
      let rows = 1,
        size = 1,
        old = false,
        valid = true;
      const visited = new Set<string>();
      add(right);
      while (queue.length && valid) {
        queue.sort((a, b) => (b.down ?? Infinity) - (a.down ?? Infinity));
        const e = queue.pop()!;
        const key = `${e.up}\0${e.id}`;
        if (visited.has(key)) continue;
        visited.add(key);
        const next = e.down;
        if (next == null) {
          if (!body.has(e.up)) tails.add(e.up);
          continue;
        }
        if (next === left) {
          if (!body.has(e.up)) tails.add(e.up);
          old = true;
        } else if (next >= right + rows && next < left) {
          rows = next - right + 1;
          size++;
          add(next);
          body.add(e.up);
        } else if (next > left) {
          const li = layout[next]!,
            ll = layout[left]!,
            rl = layout[right]!;
          let allowed: boolean;
          if (ll > rl && !old) allowed = next <= left + LONG_EDGE && magic.has(next);
          else if ((li > ll && li < rl) || li === ll) allowed = true;
          else if (li >= rl) allowed = false;
          else allowed = next > left + LONG_EDGE ? tailEdges.has(e.up) || body.has(e.up) : magic.has(next);
          if (!allowed) {
            valid = false;
            break;
          }
          if (!body.has(e.up)) {
            tails.add(e.up);
            tailEdges.set(e.up, new Set([...(tailEdges.get(e.up) ?? []), e.id]));
          }
        }
        if (size >= 200) valid = false;
      }
      if (!valid || !tails.size) continue;
      const id = graph[merge]!.id;
      nodes.set(id, new Set([merge, left, right, ...body, ...tails].map((i) => graph[i]!.id)));
      if (expand.has(id)) continue;
      for (const [up, removed] of tailEdges) {
        const c = graph[up]!;
        c.dashed = c.dashed.filter((_, i) => !removed.has(c.parents[i]!));
        c.parents = c.parents.filter((p) => !removed.has(p));
      }
      for (const tail of tails) {
        const c = graph[tail]!,
          target = graph[left]!.id;
        const index = c.parents.indexOf(target);
        if (index < 0) {
          c.parents.push(target);
          c.dashed.push(true);
        } else c.dashed[index] = true;
        fragments.set(`${c.id}\0${target}`, id);
      }
      const c = graph[merge]!,
        target = graph[left]!.id;
      c.dashed = c.dashed.filter((_, i) => c.parents[i] !== target);
      c.parents = c.parents.filter((p) => p !== target);
    }
    for (const c of graph) {
      const original = commits[positions.get(c.id)!]!;
      c.edgeTypes = c.parents.map((p, i) =>
        fragments.has(`${c.id}\0${p}`)
          ? "collapsed"
          : (original.edgeTypes?.[original.parents.indexOf(p)] ?? (c.dashed[i] ? "filtered" : "normal")),
      );
    }
    return { graph, fragments, nodes };
  };
  let result = build();
  // Expanding a containing merge restores its nested fragments as well.
  for (;;) {
    let changed = false;
    for (const id of [...expand])
      for (const node of result.nodes.get(id) ?? [])
        if (node !== id && result.nodes.has(node) && !expand.has(node)) {
          expand.add(node);
          changed = true;
        }
    if (!changed) return result;
    result = build();
  }
}

const LONG_EDGE = 30;
/** Rows of a hidden long edge still drawn next to each of its ends. */
const LONG_EDGE_STUB = 2;

/**
 * Show Long Edges off: the middle of a straight run of a lane through `minLength` or
 * more rows is not drawn; the visible stubs end in arrows (IDEA's long-edge arrows).
 */
export function hideLongEdges(rows: readonly GraphRow[], minLength = LONG_EDGE): GraphRow[] {
  type Run = { lane: number; from: number; to: number; start: number; end: number };
  const starts = new Map<number, Run[]>();
  const ends = new Map<number, Run[]>();
  const runs = new Map<number, number>();
  const record = (events: Map<number, Run[]>, at: number, run: Run) => {
    const existing = events.get(at);
    if (existing) existing.push(run);
    else events.set(at, [run]);
  };
  const finish = (lane: number, start: number, end: number) => {
    if (end - start < minLength) return;
    const from = start + LONG_EDGE_STUB;
    const to = end - LONG_EDGE_STUB;
    const run = { lane, from, to, start, end };
    record(starts, from - 1, run);
    record(ends, to, run);
  };

  for (const [index, row] of rows.entries()) {
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
  for (const [lane, start] of runs) finish(lane, start, rows.length);
  if (!starts.size) return rows.slice();

  // Sweep the intervals together so a row crossed by many long edges is only
  // filtered once. Both half-edges keep their matching navigation targets.
  const hidden = new Map<number, Run>();
  return rows.map((row, index) => {
    for (const run of starts.get(index) ?? []) hidden.set(run.lane, run);
    if (!hidden.size) return row;
    const filter = (segments: GraphSegment[], targets: string[] | undefined, up: boolean) => {
      const visible: GraphSegment[] = [];
      const visibleTargets = targets ? ([] as string[]) : undefined;
      for (const [i, s] of segments.entries()) {
        const run = s.from === s.to ? hidden.get(s.from) : undefined;
        if (run && index >= run.from && index < run.to) continue;
        const targetRow =
          run && (up && index === run.to ? run.start - 1 : !up && index === run.from - 1 ? run.end : undefined);
        visible.push(targetRow === undefined ? s : { ...s, arrow: up ? "up" : "down", targetRow });
        visibleTargets?.push(targets![i]!);
      }
      return [visible, visibleTargets] as const;
    };
    const [up, upTargets] = filter(row.up, row.upTargets, true);
    const [down, downTargets] = filter(row.down, row.downTargets, false);
    for (const run of ends.get(index) ?? []) hidden.delete(run.lane);
    return { ...row, up, down, upTargets, downTargets };
  });
}

/**
 * Packs each row's lanes side by side, in their order: lanes laid out by branch leave
 * gaps (one per branch) and hidden long edges free theirs. Each row boundary and each
 * node level is packed on its own; adjacent rows share the boundary, so lines stay joined.
 */
export function compactLanes(rows: readonly GraphRow[]): GraphRow[] {
  const ranks = (lanes: Iterable<number>) => new Map([...new Set(lanes)].sort((a, b) => a - b).map((l, i) => [l, i]));
  const boundaries = Array.from({ length: rows.length + 1 }, (_, r) =>
    ranks([...(rows[r]?.up.map((s) => s.from) ?? []), ...(rows[r - 1]?.down.map((s) => s.to) ?? [])]),
  );
  return rows.map((row, r) => {
    const node = ranks([row.lane, ...row.up.map((s) => s.to), ...row.down.map((s) => s.from)]);
    const top = boundaries[r]!;
    const bottom = boundaries[r + 1]!;
    return {
      ...row,
      lane: node.get(row.lane)!,
      up: row.up.map((s) => ({ ...s, from: top.get(s.from)!, to: node.get(s.to)! })),
      down: row.down.map((s) => ({ ...s, from: node.get(s.from)!, to: bottom.get(s.to)! })),
      width: Math.max(node.size, top.size, bottom.size),
    };
  });
}

/**
 * Draws a lane change as one straight diagonal across the row boundary, like IDEA: a half-row
 * segment that changes lane and the vertical half of the neighbouring row that continues it meet
 * halfway between the two lanes. Only the drawn positions change; `from` / `to` stay the lanes.
 */
export function straightenLaneChanges(rows: readonly GraphRow[]): GraphRow[] {
  const out = rows.map((r) => ({ ...r, up: [...r.up], down: [...r.down] }));
  const vertical = (s: GraphSegment, lane: number) => s.from === lane && s.to === lane && !s.arrow;
  for (let r = 0; r < out.length; r++) {
    const row = out[r]!;
    // Leaving the node towards another lane: continues straight down in the next row.
    const next = out[r + 1];
    // Another line ending at the same lane (a merge into a lane that continues) keeps its position.
    const shared = (list: readonly GraphSegment[], lane: number, end: "from" | "to") =>
      list.filter((x) => x[end] === lane).length > 1;
    row.down.forEach((s, i) => {
      if (s.from === s.to || s.arrow || !next || shared(row.down, s.to, "to")) return;
      const j = next.up.findIndex((u) => vertical(u, s.to) && u.edge === s.edge && u.fromX === undefined);
      if (j < 0) return;
      const mid = (s.from + s.to) / 2;
      row.down[i] = { ...s, toX: mid };
      next.up[j] = { ...next.up[j]!, fromX: mid };
    });
    // Converging into the node from another lane: continues a vertical line of the previous row.
    const prev = out[r - 1];
    row.up.forEach((s, i) => {
      if (s.from === s.to || s.arrow || !prev || shared(prev.down, s.from, "to")) return;
      const j = prev.down.findIndex((d) => vertical(d, s.from) && d.edge === s.edge && d.toX === undefined);
      if (j < 0) return;
      const mid = (s.from + s.to) / 2;
      row.up[i] = { ...s, fromX: mid };
      prev.down[j] = { ...prev.down[j]!, toX: mid };
    });
  }
  return out;
}

/** Lane colours (tokens), cycled by colour index. */
export const LANE_COLORS = [
  "var(--accent)",
  "var(--vcs-added)",
  "var(--vcs-modified)",
  "var(--syn-annotation)",
  "var(--syn-number)",
  "var(--syn-string)",
  "var(--syn-type)",
  "var(--danger)",
];

export const laneColor = (i: number) => LANE_COLORS[i % LANE_COLORS.length]!;
