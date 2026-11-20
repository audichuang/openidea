import { describe, expect, it } from "vitest";
import { compactLanes, computeGraph, hideLongEdges, straightenLaneChanges } from "../graph";
import { createGraphPresenter, hideLongEdgesPort, presentRows, type PresentInput } from "../gitGraphPresent";

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A merge-heavy history in log order (children first): many branches open at once, merges
 * between them (cross merges), octopus merges, parents far below (long lanes), parents outside
 * the list (unloaded), plus the graph's pseudo rows (uncommitted changes, stashes) with their
 * dashed edge.
 */
function history(seed: number, size: number, branches: number): PresentInput[] {
  const random = rng(seed);
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
  // Built oldest first, then reversed: every parent exists before its child.
  const made: { id: string; parents: string[] }[] = [];
  const tips: string[] = [];
  for (let i = 0; i < size; i++) {
    const id = `c${i}`;
    const parents: string[] = [];
    if (i === 0 || random() < 0.02) parents.push(`gone${i}`);
    else if (tips.length < branches && random() < 0.3) parents.push(made[Math.floor(random() * made.length)]!.id);
    else {
      const t = Math.floor(random() * tips.length);
      parents.push(tips[t]!);
      tips.splice(t, 1);
    }
    const roll = random();
    const extra = roll < 0.25 ? 1 : roll < 0.3 ? 2 + Math.floor(random() * 2) : 0;
    for (let k = 0; k < extra && made.length; k++) {
      const far = random() < 0.3;
      const p = far ? made[Math.floor(random() * made.length)]!.id : tips.length ? pick(tips) : made.at(-1)!.id;
      if (!parents.includes(p)) parents.push(p);
      const at = tips.indexOf(p);
      if (at >= 0 && random() < 0.5) tips.splice(at, 1);
    }
    made.push({ id, parents });
    tips.push(id);
  }
  const log: PresentInput[] = made.reverse();
  const out: PresentInput[] = [{ id: "*working*", parents: [log[0]!.id], dashed: [true] }];
  for (const [i, c] of log.entries()) {
    if (i > 0 && random() < 0.01) out.push({ id: `stash${i}`, parents: [c.id], dashed: [true] });
    out.push(c);
  }
  return out;
}

const oracle = (commits: readonly PresentInput[]) => presentRows(computeGraph(commits).rows);
/** Upstream's passes of the Git Log (`logPresentation.ts`, Show Long Edges off) on the same layout. */
const gitLog = (commits: readonly PresentInput[]) =>
  straightenLaneChanges(compactLanes(hideLongEdges(computeGraph(commits).rows)));

/** Feeds `commits` page by page (sizes cycled), checking each result against the full computation. */
function pageThrough(commits: readonly PresentInput[], sizes: readonly number[], every = true) {
  const present = createGraphPresenter();
  let n = 0;
  for (let step = 0; n < commits.length; step++) {
    n = Math.min(commits.length, n + sizes[step % sizes.length]!);
    const prefix = commits.slice(0, n);
    const rows = present(prefix);
    if (every || n === commits.length) expect(rows).toStrictEqual(oracle(prefix));
  }
}

describe("incremental git graph presentation", () => {
  it("ports upstream hideLongEdges exactly", () => {
    for (const seed of [1, 2, 3, 4]) {
      const rows = computeGraph(history(seed, 600, 8 + seed * 6)).rows;
      expect(hideLongEdgesPort(rows)).toStrictEqual(hideLongEdges(rows));
      // The port's own copy of LONG_EDGE / LONG_EDGE_STUB: a long run is hidden at all.
      expect(hideLongEdges(rows)).not.toStrictEqual(rows);
    }
  });

  it.each([
    [11, 1500, 12],
    [12, 1500, 40],
    [13, 1200, 80],
  ])(
    "pages of 300 and odd sizes give the full computation (seed %i)",
    (seed, size, branches) => {
      const commits = history(seed, size, branches);
      for (const sizes of [[300], [299], [301], [97, 3, 300, 1, 2, 64]]) pageThrough(commits, sizes);
      // Pages about as long as a hidden run's threshold, on a shorter list.
      const short = commits.slice(0, 500);
      for (const sizes of [[29], [30], [31], [32], [33]]) pageThrough(short, sizes);
    },
    60_000,
  );

  it("pages of one and two rows give the full computation", () => {
    for (const seed of [21, 22]) {
      const commits = history(seed, 160, 10);
      pageThrough(commits, [1]);
      pageThrough(commits, [2]);
    }
  }, 60_000);

  it("long lanes ending right at a page boundary", () => {
    // Lane of `s` runs 60 rows to `base`; pages end on each row around where it closes.
    const node = (id: string, parents: string[]): PresentInput => ({ id, parents });
    const main = Array.from({ length: 60 }, (_, i) => node(`m${i}`, [i < 59 ? `m${i + 1}` : "base"]));
    const commits = [node("s", ["base"]), node("t", ["m40"]), ...main, node("base", ["root"])];
    for (let first = 25; first < commits.length; first++) {
      const present = createGraphPresenter();
      present(commits.slice(0, first));
      expect(present(commits.slice(0, first + 1))).toStrictEqual(oracle(commits.slice(0, first + 1)));
      expect(present(commits)).toStrictEqual(oracle(commits));
    }
  });

  it("starts over when the list is not an extension of the last one", () => {
    const commits = history(31, 900, 30);
    const present = createGraphPresenter();
    present(commits.slice(1, 400));
    // The uncommitted-changes row appears on top once HEAD is loaded.
    expect(present(commits.slice(0, 700))).toStrictEqual(oracle(commits.slice(0, 700)));
    // A stash row disappears (its commit got loaded).
    const stash = commits.findIndex((c) => c.id.startsWith("stash"));
    const without = commits.filter((_, i) => i !== stash);
    expect(present(without)).toStrictEqual(oracle(without));
    // A reload back to the first page.
    expect(present(without.slice(0, 300))).toStrictEqual(oracle(without.slice(0, 300)));
    // Same parents but no longer dashed.
    const undashed = without.slice(0, 600).map((c, i) => (i === 0 ? { id: c.id, parents: c.parents } : c));
    expect(present(undashed)).toStrictEqual(oracle(undashed));
  });

  it("returns the same rows for the same list", () => {
    const commits = history(41, 700, 20);
    const present = createGraphPresenter();
    const rows = present(commits);
    expect(present(commits)).toBe(rows);
    expect(present(commits.map((c) => ({ ...c })))).toBe(rows);
  });
  it("matches the Git Log's presentation but for the tail stubs it drops", () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const commits = history(seed, 600, 8 + seed * 6);
      const rows = oracle(commits);
      // Dropping a stub re-packs the last two rows and the boundary above them.
      expect(rows.slice(0, -3)).toStrictEqual(gitLog(commits).slice(0, -3));
    }
  });
});

describe("merges into a long edge", () => {
  // A line of commits with `t` on row 350; row 0 and row `merge` also merge `t`, whose lane runs
  // alongside from row 0 to row 350.
  const node = (id: string, parents: string[]): PresentInput => ({ id, parents });
  const id = (i: number) => (i === 350 ? "t" : `a${i}`);
  const commits = (merge: number) =>
    Array.from({ length: 400 }, (_, i) => node(id(i), i === 0 || i === merge ? [id(i + 1), "t"] : [id(i + 1)]));

  it.each([297, 298, 299])("keeps the tail stub a merge on row %i joins", (merge) => {
    const page = commits(merge).slice(0, 300);
    const rows = oracle(page);
    // As upstream's passes draw it: the stub, its up arrow, the merge joining it.
    expect(rows).toStrictEqual(gitLog(page));
    const into = rows[merge]!.down.find((s) => s.from !== s.to)!;
    expect(into).toBeDefined();
    const next = rows[merge + 1];
    if (next) expect(next.up.some((s) => (s.fromX ?? s.from) === (into.toX ?? into.to))).toBe(true);
    else expect(rows[merge]!.down.some((s) => s.from === s.to && s.to === into.to)).toBe(true);
    expect(rows[298]!.up.some((s) => s.arrow === "up")).toBe(true);
    for (const sizes of [
      [300, 100],
      [297, 1, 1, 1, 100],
      [merge, 1, 99],
      [merge + 1, 99],
    ])
      pageThrough(commits(merge), sizes);
  });

  it("drops the tail stub no merge joins", () => {
    const page = commits(-1).slice(0, 300);
    const rows = oracle(page);
    expect(rows.slice(-2).every((r) => r.up.length === 1 && r.down.length === 1)).toBe(true);
  });

  it("leaves a merge into a hidden stretch unjoined, as upstream hideLongEdges does", () => {
    // Upstream hides the run through the merge row too, so the merge ends at the row boundary.
    // Not the fork's to change here; pinned so a change upstream shows up.
    for (const merge of [150, 299]) {
      const all = commits(merge);
      const rows = oracle(all);
      expect(rows).toStrictEqual(gitLog(all));
      expect(rows[merge]!.down.some((s) => s.from !== s.to)).toBe(true);
      expect(rows[merge + 1]!.up).toHaveLength(1);
    }
  });

  it("draws a long edge's arrow where a straightened lane change meets, as upstream does", () => {
    // Three-parent merge: lanes 0 and 1 run long, so the main line moves from lane 2 to lane 0
    // below their arrows, and straightenLaneChanges meets it at lane 1, the arrow's lane.
    const list = [node("t", ["p", "q", "a1"])];
    for (let i = 1; i < 40; i++) list.push(node(`a${i}`, [`a${i + 1}`]));
    list.push(node("a40", ["p"]), node("p", ["q"]), node("q", []));
    const rows = oracle(list);
    expect(rows).toStrictEqual(gitLog(list));
    expect(rows[2]!.down).toContainEqual(expect.objectContaining({ to: 1, arrow: "down" }));
    expect(rows[2]!.down).toContainEqual(expect.objectContaining({ from: 2, to: 2, toX: 1 }));
    expect(rows[3]!.up).toContainEqual(expect.objectContaining({ from: 2, to: 0, fromX: 1 }));
  });
});
