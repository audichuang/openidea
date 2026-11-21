import { describe, expect, it, vi } from "vitest";
import type { Commit } from "@/bindings";
import * as graphModule from "../graph";
import { createLogGraphPresenter, presentLogGraph } from "../logPresentation";
import { DEFAULT_LOG_OPTIONS, type LogOptions } from "../logOptions";

vi.mock("../graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../graph")>();
  return { ...actual, compactLanes: vi.fn(actual.compactLanes) };
});

const fragments = { expanded: new Set<string>(), collapsed: new Set<string>(), merges: new Set<string>() };
const keep = new Set<string>();

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

function commit(id: string, parents: string[], refs: string[] = [], extra: Partial<Commit> = {}): Commit {
  return {
    id,
    shortId: id,
    parents,
    author: "",
    email: "",
    committer: "",
    committerEmail: "",
    timeMs: 0,
    commitTimeMs: 0,
    summary: "",
    message: "",
    messageTruncated: false,
    refs,
    ...extra,
  };
}

/**
 * A merge-heavy history in log order (children first): many branches open at once, cross merges,
 * octopus merges, parents far below (long lanes), parents outside the history (unloaded), shallow
 * boundaries, and refs on some tips (branches, remotes, tags) so lanes are laid out by branch.
 */
function history(seed: number, size: number, branches: number, refShare = 0.5): Commit[] {
  const random = rng(seed);
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
  const made: { id: string; parents: string[]; boundary?: string[] }[] = [];
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
    made.push({ id, parents, ...(random() < 0.005 ? { boundary: [`shallow${i}`] } : {}) });
    tips.push(id);
  }
  const children = new Set(made.flatMap((c) => c.parents));
  return made.reverse().map((c, i) => {
    const refs: string[] = [];
    if (i === 0) refs.push("HEAD -> main", "origin/main");
    else if (!children.has(c.id) && random() < refShare) refs.push(random() < 0.3 ? `origin/b${i}` : `b${i}`);
    else if (random() < 0.01) refs.push(`tag: v${i}`);
    return commit(c.id, c.parents, refs, {
      ...(c.boundary ? { graphBoundaryParents: c.boundary } : {}),
      ...(refs.some((r) => r.startsWith("origin/"))
        ? { remoteNames: refs.filter((r) => r.startsWith("origin/")) }
        : {}),
    });
  });
}

/** The perf probe's `fakeGitLog`: short merges, lanes skipping ahead, and long-lived branch tips. */
function probeLog(count: number, longBranches: number): Commit[] {
  const id = (n: number) => n.toString(16).padStart(40, "0");
  const commits = Array.from({ length: count }, (_, i) => {
    const merge = i % 12 === 0 && i + 7 < count;
    const next = i % 3 === 2 && i + 3 < count ? i + 3 : i + 1;
    const parents = i + 1 >= count ? [] : merge ? [id(i + 1), id(i + 7)] : [id(next)];
    return commit(
      id(i),
      parents,
      i === 0 ? ["HEAD -> main", "origin/main"] : i % 250 === 0 ? [`tag: v1.${count - i}`] : [],
    );
  });
  for (let i = 0; i < longBranches; i++) {
    commits[i] = { ...commits[i]!, parents: [commits[count - longBranches + i]!.id], refs: [`branch-${i}`] };
  }
  return commits;
}

const full = (all: readonly Commit[], options: LogOptions = DEFAULT_LOG_OPTIONS) =>
  presentLogGraph(all, options, fragments, keep);

/** Rows the presentation passes go through for one call. */
function rowsPresented(present: () => unknown) {
  const compactLanes = vi.mocked(graphModule.compactLanes);
  compactLanes.mockClear();
  present();
  return compactLanes.mock.calls.reduce((sum, [rows]) => sum + rows.length, 0);
}

/**
 * Feeds `all` page by page (sizes cycled) through one presenter, comparing every page's rows with
 * the full computation. Returns how many pages were presented without the rows above the page.
 */
function pageThrough(all: readonly Commit[], sizes: readonly number[], options: LogOptions = DEFAULT_LOG_OPTIONS) {
  const present = createLogGraphPresenter();
  let reused = 0;
  let pages = 0;
  for (let n = 0, step = 0; n < all.length; step++) {
    const before = n;
    n = Math.min(all.length, n + sizes[step % sizes.length]!);
    const prefix = all.slice(0, n);
    let got!: ReturnType<typeof present>;
    const presented = rowsPresented(() => (got = present(prefix, options, fragments, keep)));
    const want = full(prefix, options);
    expect(got.commits).toStrictEqual(want.commits);
    expect(got.graph).toStrictEqual(want.graph);
    expect(got.rows.map((_, i) => got.row(i))).toStrictEqual(want.rows);
    if (before > 40) {
      pages++;
      // The page and the window of rows laid out again before it.
      if (presented <= n - before + 34) reused++;
    }
  }
  return { reused, pages };
}

describe("paged Git Log graph", () => {
  it("gives the full computation's rows, page by page, on random merge-heavy histories", () => {
    const stats = [1, 2, 3, 4, 5, 6].map((seed) => pageThrough(history(seed, 900, 6 + seed * 8), [97, 131, 300]));
    // A page can reorder the lanes of rows above it (a branch tip's preferred lane moves past
    // another lane): those pages are computed from scratch, the others reuse what is above them.
    const reused = stats.reduce((sum, s) => sum + s.reused, 0);
    expect(reused).toBeGreaterThanOrEqual(0.8 * stats.reduce((sum, s) => sum + s.pages, 0));
  });

  it("gives the full computation's rows without refs, and with refs on every tip", () => {
    for (const seed of [7, 8]) {
      pageThrough(history(seed, 700, 40, 0), [83, 200]);
      pageThrough(history(seed, 700, 40, 1), [83, 200]);
    }
  });

  it("gives the full computation's rows with Show Long Edges on", () => {
    for (const seed of [9, 10]) pageThrough(history(seed, 700, 30), [120], { ...DEFAULT_LOG_OPTIONS, longEdges: true });
  });

  it("pages of one and two rows give the full computation", () => {
    pageThrough(history(11, 160, 12), [1, 2]);
  });

  it("reuses rows on the perf probe's history with long-lived branches", () => {
    const { reused, pages } = pageThrough(probeLog(3_000, 200), [300]);
    expect(reused).toBe(pages);
  });

  it("pages a deep history with hundreds of branches and cross merges at a cost set by the page", () => {
    const all = history(18, 12_000, 400, 0.6);
    const present = createLogGraphPresenter();
    const costs: number[] = [];
    for (let n = 300; n <= all.length; n += 300) {
      let got!: ReturnType<typeof present>;
      costs.push(rowsPresented(() => (got = present(all.slice(0, n), DEFAULT_LOG_OPTIONS, fragments, keep))));
      if (n % 6_000 === 0) expect(got.rows.map((_, i) => got.row(i))).toStrictEqual(full(all.slice(0, n)).rows);
    }
    const pages = costs.slice(1);
    expect(pages.filter((rows) => rows <= 300 + 34).length).toBeGreaterThanOrEqual(0.8 * pages.length);
  }, 120_000);

  it("starts over when the list is not an extension of the last one", () => {
    const present = createLogGraphPresenter();
    const a = history(12, 600, 20);
    const b = history(13, 600, 20);
    present(a.slice(0, 300), DEFAULT_LOG_OPTIONS, fragments, keep);
    for (const list of [b.slice(0, 400), b.slice(0, 200), [...b.slice(0, 199), { ...b[199]! }], a.slice(100, 500)]) {
      const got = present(list, DEFAULT_LOG_OPTIONS, fragments, keep);
      expect(got.rows.map((_, i) => got.row(i))).toStrictEqual(full(list).rows);
    }
  });

  it("returns the same result for the same list", () => {
    const present = createLogGraphPresenter();
    const all = history(14, 400, 20);
    const first = present(all, DEFAULT_LOG_OPTIONS, fragments, keep);
    expect(present(all, DEFAULT_LOG_OPTIONS, fragments, keep)).toBe(first);
    expect(present([...all], DEFAULT_LOG_OPTIONS, fragments, keep).rows).toBe(first.rows);
  });

  it("falls back to the full computation for options that rewrite the graph", () => {
    const all = history(15, 500, 20);
    for (const options of [
      { ...DEFAULT_LOG_OPTIONS, collapseLinear: true },
      { ...DEFAULT_LOG_OPTIONS, linearizeMerges: true },
    ]) {
      const present = createLogGraphPresenter();
      for (const n of [200, 500]) {
        const got = present(all.slice(0, n), options, fragments, keep);
        const want = full(all.slice(0, n), options);
        expect(got.rows.map((_, i) => got.row(i))).toStrictEqual(want.rows);
        expect(got.linear?.graph ?? null).toStrictEqual(want.linear?.graph ?? null);
      }
    }
  });

  it("gives the full computation's rows for a filtered log", () => {
    const all = history(16, 600, 20).map((c, i) =>
      i % 5 === 0 && c.parents.length > 1 ? { ...c, dashed: c.parents.map((_, k) => k > 0) } : c,
    );
    pageThrough(all, [150]);
  });

  it("gives the full computation's rows when commits share a key", () => {
    const all = history(17, 300, 10);
    pageThrough([...all.slice(0, 200), { ...all[50]! }, ...all.slice(200)], [120]);
  });
});
