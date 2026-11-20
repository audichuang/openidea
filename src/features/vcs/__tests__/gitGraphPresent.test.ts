import { describe, expect, it } from "vitest";
import { computeGraph, hideLongEdges } from "../graph";
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
});
