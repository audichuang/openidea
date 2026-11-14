// @vitest-environment node
import { describe, expect, it } from "vitest";
import { pruneFilteredEdges, type GraphCommit } from "../graph";

type Kind = NonNullable<GraphCommit["edgeTypes"]>[number];

// The implementation before reachability was reused across rows (upstream's, including l0ng-ai/openidea#5421's
// handling of targets below the page), kept verbatim as the oracle.
function oldPruneFilteredEdges(commits: readonly GraphCommit[]): GraphCommit[] {
  const positions = new Map(commits.map((c, i) => [c.id, i]));
  const kindOf = (c: GraphCommit, i: number) => c.edgeTypes?.[i] ?? (c.dashed?.[i] ? "filtered" : "normal");
  // Rows whose history continues below the page (parents come later in the log).
  const leavesPage: boolean[] = [];
  for (let at = commits.length - 1; at >= 0; at--) {
    leavesPage[at] = commits[at]!.parents.some((p) => {
      const pos = positions.get(p);
      return pos == null || (pos > at && leavesPage[pos]!);
    });
  }
  return commits.map((c) => {
    if (c.parents.length < 2) return c;
    if (!c.parents.some((_, i) => kindOf(c, i) === "filtered")) return c;
    // Walk the loaded parents shallowest first, tracking the rows the kept connections
    // reach: a filtered parent already covered by them adds nothing (and a dropped one
    // was covered itself, so its own reach is covered too). Parents only appear later
    // in the log, so no walk goes past the deepest parent of the commit.
    const limit = Math.max(...c.parents.map((p) => positions.get(p) ?? -1));
    const drop = new Set<number>();
    const covered = new Set<number>();
    const indices = c.parents.map((_, i) => i);
    const loaded = indices.filter((i) => positions.has(c.parents[i]!));
    for (const i of loaded.sort((a, b) => positions.get(c.parents[a]!)! - positions.get(c.parents[b]!)!)) {
      const pos = positions.get(c.parents[i]!)!;
      if (kindOf(c, i) === "filtered" && covered.has(pos)) {
        drop.add(i);
        continue;
      }
      for (const stack = [pos]; stack.length;) {
        const at = stack.pop()!;
        if (covered.has(at)) continue;
        covered.add(at);
        for (const p of commits[at]!.parents) {
          const next = positions.get(p);
          if (next != null && next <= limit) stack.push(next);
        }
      }
    }
    // Targets below the page: one connection leading there is enough until they load.
    const unloaded = indices.filter((i) => !positions.has(c.parents[i]!));
    const filteredBelow = unloaded.filter((i) => kindOf(c, i) === "filtered");
    const leads =
      unloaded.some((i) => kindOf(c, i) !== "filtered") ||
      loaded.some((i) => !drop.has(i) && leavesPage[positions.get(c.parents[i]!)!]);
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

let reads = 0;
const counted = (c: GraphCommit): GraphCommit => {
  const { parents, ...rest } = c;
  return Object.defineProperty({ ...rest }, "parents", {
    enumerable: true,
    get() {
      reads++;
      return parents;
    },
  }) as GraphCommit;
};
const filteredEdge = (id: string, parents: string[], kinds: Kind[]): GraphCommit =>
  counted({ id, parents, dashed: kinds.map((k) => k !== "normal"), edgeTypes: kinds });

// Mulberry32: deterministic random inputs.
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

function randomLog(rand: () => number, n: number, backward: boolean): GraphCommit[] {
  const kinds: Kind[] = ["normal", "filtered", "collapsed", "shallow", "unloaded"];
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  return Array.from({ length: n }, (_, i) => {
    const count = rand() < 0.15 ? 1 : 2 + Math.floor(rand() * 3);
    const parents = Array.from({ length: count }, () => {
      const r = rand();
      if (r < 0.1) return `missing${Math.floor(rand() * 3)}`;
      if (backward && r < 0.2) return `c${Math.floor(rand() * n)}`;
      if (i + 1 >= n) return `missing${Math.floor(rand() * 3)}`;
      // Mostly near parents, some far ones, and duplicates by chance.
      const j =
        r < 0.7 ? i + 1 + Math.floor(rand() * Math.min(4, n - i - 1)) : i + 1 + Math.floor(rand() * (n - i - 1));
      return `c${j}`;
    });
    const style = rand();
    const id = rand() < 0.03 && i > 0 ? `c${i - 1}` : `c${i}`;
    if (style < 0.2) return { id, parents };
    if (style < 0.45) return { id, parents, dashed: parents.map(() => rand() < 0.6) };
    return { id, parents, dashed: parents.map(() => rand() < 0.5), edgeTypes: parents.map(() => pick(kinds)) };
  });
}

describe("pruneFilteredEdges cost", () => {
  // An author filter on Alice: each of her merges brings in a Bob branch that started at the
  // root, so every row connects to the previous merge and, filtered, to the root.
  it("does not walk the whole mainline again for every merge", () => {
    const n = 3000;
    const commits = Array.from({ length: n }, (_, i) =>
      i === n - 1
        ? counted({ id: "root", parents: [] })
        : i === n - 2
          ? filteredEdge(`m${i}`, ["root"], ["normal"])
          : filteredEdge(`m${i}`, [`m${i + 1}`, "root"], ["normal", "filtered"]),
    );
    reads = 0;
    const pruned = pruneFilteredEdges(commits);
    expect(pruned[0]!.parents).toEqual(["m1"]);
    expect(reads).toBeLessThan(20 * n);
  });

  it("does not rescan the chain for distinct deep filtered ancestors", () => {
    const n = 3000;
    const commits = Array.from({ length: n }, (_, i) =>
      i < n / 2
        ? filteredEdge(`c${i}`, [`c${i + 1}`, `c${n - 1 - i}`], ["normal", "filtered"])
        : filteredEdge(`c${i}`, i + 1 < n ? [`c${i + 1}`] : [], ["normal"]),
    );
    reads = 0;
    const pruned = pruneFilteredEdges(commits);
    expect(pruned[0]!.parents).toEqual(["c1"]);
    expect(reads).toBeLessThan(20 * n);
  });

  it("matches the previous implementation on random logs", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const rand = random(seed);
      const n = 2 + Math.floor(rand() * 40);
      const commits = randomLog(rand, n, seed % 4 === 0);
      const expected = oldPruneFilteredEdges(commits);
      const actual = pruneFilteredEdges(commits);
      expect(actual, `seed ${seed}`).toStrictEqual(expected);
      actual.forEach((c, i) => expect(c === commits[i], `seed ${seed} row ${i}`).toBe(expected[i] === commits[i]));
    }
  });
});
