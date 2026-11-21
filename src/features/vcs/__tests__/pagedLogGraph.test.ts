import { isDeepStrictEqual } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { Commit } from "@/bindings";
import * as graphModule from "../graph";
import { createLogGraphPresenter, presentLogGraph } from "../logPresentation";
import { DEFAULT_LOG_OPTIONS, type LogOptions } from "../logOptions";

vi.mock("../graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../graph")>();
  return {
    ...actual,
    compactLanes: vi.fn(actual.compactLanes),
    graphLayout: vi.fn(actual.graphLayout),
    layoutChains: vi.fn(actual.layoutChains),
  };
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
function history(seed: number, size: number, branches: number, refShare = 0.5, unloaded = 0.02): Commit[] {
  const random = rng(seed);
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
  const made: { id: string; parents: string[]; boundary?: string[] }[] = [];
  const tips: string[] = [];
  for (let i = 0; i < size; i++) {
    const id = `c${i}`;
    const parents: string[] = [];
    if (i === 0 || random() < unloaded) parents.push(`gone${i}`);
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

/** Strict deep equality, falling back to `expect().toStrictEqual` on mismatch for its diff. */
function expectStrictEqual<T>(actual: T, expected: T) {
  if (!isDeepStrictEqual(actual, expected)) expect(actual).toStrictEqual(expected);
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
    expectStrictEqual(got.commits, want.commits);
    expectStrictEqual(got.graph, want.graph);
    expectStrictEqual(
      got.rows.map((_, i) => got.row(i)),
      want.rows,
    );
    if (before > 40) {
      pages++;
      // The page and the window of rows laid out again before it.
      if (presented <= n - before + 34) reused++;
    }
  }
  return { reused, pages };
}

/**
 * How a Refresh can return `base` (a longer history; the log shows a prefix of it): the same
 * commits as new objects, refs moved near the top and deep down, commits made on top (the
 * oldest loaded ones then fall off the end), a commit rewritten deep down, and commits dropped.
 */
function refreshed(base: readonly Commit[], seed: number): Array<[string, Commit[]]> {
  const random = rng(seed);
  const deep = Math.floor(base.length * (0.5 + 0.3 * random()));
  const copy = () => base.map((c) => ({ ...c, refs: [...c.refs] }));
  const withRefs = (rows: readonly number[]) => {
    const out = copy();
    for (const i of rows) out[i]!.refs = out[i]!.refs.length ? [] : [`moved${i}`];
    return out;
  };
  const top = { ...base[0]!, refs: base[0]!.refs.filter((r) => !r.startsWith("HEAD")) };
  const made = [
    commit("new1", ["new2", base[0]!.id], ["HEAD -> main"]),
    commit("new2", [base[0]!.id]),
    top,
    ...base.slice(1),
  ];
  const rewritten = copy();
  rewritten[deep] = { ...rewritten[deep]!, parents: [base[deep + 5]!.id, ...rewritten[deep]!.parents.slice(1)] };
  return [
    ["same commits", copy()],
    ["refs moved near the top", withRefs([1, 3])],
    ["refs moved deep down", withRefs([deep, deep + 1])],
    ["commits made on top", made],
    ["a commit rewritten deep down", rewritten],
    ["commits dropped deep down", [...base.slice(0, deep), ...base.slice(deep + 3)]],
    // Fewer commits than were loaded: parents of the last rows are not loaded any more.
    ["commits dropped at the end", copy().slice(0, deep)],
  ];
}

/**
 * Pages through `base.slice(0, loaded)`, then gives each Refresh of it and one more page after
 * that, comparing every result with the full computation. Returns the rows each Refresh presented.
 */
function refreshThrough(
  base: readonly Commit[],
  loaded: number,
  seed: number,
  options = DEFAULT_LOG_OPTIONS,
  only?: readonly string[],
) {
  const presented = new Map<string, number>();
  for (const [name, after] of refreshed(base, seed)) {
    if (only && !only.includes(name)) continue;
    const present = createLogGraphPresenter();
    for (let n = Math.min(loaded, 300); ; n = Math.min(loaded, n + 300)) {
      present(base.slice(0, n), options, fragments, keep);
      if (n === loaded) break;
    }
    for (const n of [loaded, loaded + 150]) {
      const list = after.slice(0, n);
      let got!: ReturnType<typeof present>;
      const count = rowsPresented(() => (got = present(list, options, fragments, keep)));
      if (n === loaded) presented.set(name, count);
      const want = full(list, options);
      const rows = got.rows.map((_, i) => got.row(i));
      if (!isDeepStrictEqual(rows, want.rows)) expect({ name, n, rows }).toStrictEqual({ name, n, rows: want.rows });
      expectStrictEqual(got.commits, want.commits);
      expectStrictEqual(got.graph, want.graph);
    }
  }
  return presented;
}

describe("paged Git Log graph", () => {
  it("gives the full computation's rows, page by page, on random merge-heavy histories", () => {
    const stats = [1, 2, 3, 4, 5, 6].map((seed) => pageThrough(history(seed, 900, 6 + seed * 8), [97, 131, 300]));
    // A page can reorder the lanes of rows above it (a branch tip's preferred lane moves past
    // another lane): those pages are computed from scratch, the others reuse what is above them.
    const reused = stats.reduce((sum, s) => sum + s.reused, 0);
    expect(reused).toBeGreaterThanOrEqual(0.8 * stats.reduce((sum, s) => sum + s.pages, 0));
  }, 60_000);

  it("gives the full computation's rows without refs, and with refs on every tip", () => {
    for (const seed of [7, 8]) {
      pageThrough(history(seed, 700, 40, 0), [83, 200]);
      pageThrough(history(seed, 700, 40, 1), [83, 200]);
    }
  }, 60_000);

  it("gives the full computation's rows with Show Long Edges on", () => {
    for (const seed of [9, 10]) pageThrough(history(seed, 700, 30), [120], { ...DEFAULT_LOG_OPTIONS, longEdges: true });
  }, 60_000);

  it("pages of one and two rows give the full computation", () => {
    pageThrough(history(11, 160, 12), [1, 2]);
  }, 60_000);

  it("reuses rows on the perf probe's history with long-lived branches", () => {
    const { reused, pages } = pageThrough(probeLog(3_000, 200), [300]);
    expect(reused).toBe(pages);
  }, 60_000);

  it("pages a deep history with hundreds of branches and cross merges at a cost set by the page", () => {
    const all = history(18, 4_500, 400, 0.6);
    const present = createLogGraphPresenter();
    const costs: number[] = [];
    for (let n = 300; n <= all.length; n += 300) {
      let got!: ReturnType<typeof present>;
      costs.push(rowsPresented(() => (got = present(all.slice(0, n), DEFAULT_LOG_OPTIONS, fragments, keep))));
      if (n === all.length)
        expectStrictEqual(
          got.rows.map((_, i) => got.row(i)),
          full(all.slice(0, n)).rows,
        );
    }
    const pages = costs.slice(1);
    expect(pages.filter((rows) => rows <= 300 + 34).length).toBeGreaterThanOrEqual(0.8 * pages.length);
  }, 60_000);

  it("lays the list out once on a page that cannot keep the rows above it", () => {
    // On this history the page from 97 to 228 commits renumbers lanes of rows above it.
    const all = history(3, 900, 30);
    const present = createLogGraphPresenter();
    present(all.slice(0, 97), DEFAULT_LOG_OPTIONS, fragments, keep);
    const graphLayout = vi.mocked(graphModule.graphLayout);
    const layoutChains = vi.mocked(graphModule.layoutChains);
    graphLayout.mockClear();
    layoutChains.mockClear();
    const got = present(all.slice(0, 228), DEFAULT_LOG_OPTIONS, fragments, keep);
    expect(graphLayout.mock.calls.length + layoutChains.mock.calls.length).toBe(1);
    expectStrictEqual(
      got.rows.map((_, i) => got.row(i)),
      full(all.slice(0, 228)).rows,
    );
  });

  it("gives the full computation's rows after a Refresh, and on the page after it", () => {
    refreshThrough(history(31, 500, 12), 350, 31);
    refreshThrough(history(34, 400, 12, 0), 250, 34);
    refreshThrough(history(35, 400, 12), 250, 35, { ...DEFAULT_LOG_OPTIONS, longEdges: true });
  });

  it("draws the down arrow into a parent a Refresh no longer loads", () => {
    // c1000's second parent is the oldest commit: its lane is laid out while that commit is
    // loaded, then a Refresh returns the list without it.
    const count = 1_101;
    const base = Array.from({ length: count }, (_, i) =>
      commit(
        `c${i}`,
        i + 1 < count ? [`c${i + 1}`, ...(i === 1_000 ? [`c${count - 1}`] : [])] : [],
        i ? [] : ["HEAD -> main"],
      ),
    );
    for (const refs of [true, false]) {
      const all = refs ? base : base.map((c) => ({ ...c, refs: [] }));
      const top = { ...all[0]!, refs: [] };
      for (const list of [
        all.slice(0, count - 1).map((c) => ({ ...c })),
        all.slice(0, count - 101).map((c) => ({ ...c })),
        // A commit made on top: the same number loaded again, so the oldest falls off the end.
        [commit("new", ["c0"], all[0]!.refs), top, ...all.slice(1, count - 1)],
      ]) {
        const present = createLogGraphPresenter();
        for (let n = 100; n <= 1_000; n += 100) present(all.slice(0, n), DEFAULT_LOG_OPTIONS, fragments, keep);
        present(all, DEFAULT_LOG_OPTIONS, fragments, keep);
        const got = present(list, DEFAULT_LOG_OPTIONS, fragments, keep);
        expectStrictEqual(
          got.rows.map((_, i) => got.row(i)),
          full(list).rows,
        );
      }
    }
  });

  it("lays out a Refresh again only from a kept lane state before its first change", () => {
    // Few parents outside the history, so few lanes stay open to its end.
    const deep = ["refs moved deep down", "a commit rewritten deep down", "commits dropped deep down"];
    const presented = refreshThrough(history(36, 1_400, 12, 0.5, 0.002), 1_300, 36, DEFAULT_LOG_OPTIONS, [
      "same commits",
      ...deep,
    ]);
    expect(presented.get("same commits")).toBe(0);
    for (const name of deep) expect(presented.get(name)).toBeLessThanOrEqual(1_300 - 512);
  });

  it("keeps the rows below commits made on top on Refresh", () => {
    // Commits on the newest branch, which moves to them; the oldest loaded commits then fall off
    // the end (the same number is loaded again) or stay. Show Long Edges off and on.
    for (const [made, longBranches, longEdges] of [
      [1, 20, false],
      [3, 20, false],
      [1, 60, true],
      [2, 5, false],
    ] as const) {
      const base = probeLog(1_500, longBranches);
      const options = { ...DEFAULT_LOG_OPTIONS, longEdges };
      const tip = Array.from({ length: made }, (_, i) =>
        commit(`new${i}`, [i + 1 < made ? `new${i + 1}` : base[0]!.id], i ? [] : base[0]!.refs),
      );
      const after = [...tip, { ...base[0]!, refs: [] }, ...base.slice(1)];
      for (const n of [1_300, 1_300 + made]) {
        const present = createLogGraphPresenter();
        for (let loaded = 300; loaded < 1_300; loaded += 250) present(base.slice(0, loaded), options, fragments, keep);
        present(base.slice(0, 1_300), options, fragments, keep);
        const list = after.slice(0, n);
        let got!: ReturnType<typeof present>;
        const presented = rowsPresented(() => (got = present(list, options, fragments, keep)));
        // Rows down to the first kept state below the new commits, and the last page.
        expect(presented).toBeLessThanOrEqual(512 + 2 * 34 + 300);
        expectStrictEqual(
          got.rows.map((_, i) => got.row(i)),
          full(list, options).rows,
        );
        const next = after.slice(0, n + 150);
        const paged = present(next, options, fragments, keep);
        expectStrictEqual(
          paged.rows.map((_, i) => paged.row(i)),
          full(next, options).rows,
        );
      }
    }
  });

  it("keeps the rows below a commit made on top of a history too long to pass as call arguments", () => {
    const count = 150_000;
    const base = Array.from({ length: count }, (_, i) =>
      commit(`c${i}`, i + 1 < count ? [`c${i + 1}`] : [], i ? [] : ["HEAD -> main"]),
    );
    const present = createLogGraphPresenter();
    present(base, DEFAULT_LOG_OPTIONS, fragments, keep);
    const list = [commit("new0", ["c0"], ["HEAD -> main"]), { ...base[0]!, refs: [] }, ...base.slice(1)];
    const got = present(list, DEFAULT_LOG_OPTIONS, fragments, keep);
    expect(got.rows).toHaveLength(count + 1);
    expect(got.graph[0]!.id).toBe("new0");
    expect(got.graph[count]!.id).toBe(`c${count - 1}`);
    expect(got.rows.every((row, i) => row.id === list[i]!.id)).toBe(true);
    // The root: one lane coming in from above, none going on.
    expectStrictEqual(
      got.row(count),
      full([commit(`c${count - 2}`, [`c${count - 1}`], ["HEAD -> main"]), list[count]!]).rows[1],
    );
  }, 30_000);

  it("colours the rows kept below commits made on top as the full computation does on later Refreshes", () => {
    // Refresh 1 makes a commit on top; Refresh 2 gives the old head a ref ranked above the new
    // one's, so the two no longer share a colour; Refresh 3 makes another commit on top.
    const chain = Array.from({ length: 1_310 }, (_, i) =>
      commit(`c${i}`, i + 1 < 1_310 ? [`c${i + 1}`] : [], i ? [] : ["HEAD -> main"]),
    );
    for (const [base, longEdges] of [
      [chain, false],
      [probeLog(1_500, 0), false],
      [probeLog(1_500, 0), true],
      [probeLog(1_500, 20), false],
    ] as const) {
      const options = { ...DEFAULT_LOG_OPTIONS, longEdges };
      const head = base[0]!;
      const refreshes = [
        [commit("new0", [head.id], head.refs), { ...head, refs: [] }, ...base.slice(1)],
        [commit("new0", [head.id], ["zz"]), { ...head, refs: ["HEAD"] }, ...base.slice(1)],
        [
          commit("new1", ["new0"], ["HEAD -> main"]),
          commit("new0", [head.id], ["zz"]),
          { ...head, refs: [] },
          ...base.slice(1),
        ],
      ];
      const present = createLogGraphPresenter();
      for (let n = 300; n < 1_300; n += 250) present(base.slice(0, n), options, fragments, keep);
      present(base.slice(0, 1_300), options, fragments, keep);
      for (const after of [...refreshes.map((list) => list.slice(0, 1_300)), refreshes[2]!.slice(0, 1_450)]) {
        const got = present(after, options, fragments, keep);
        expectStrictEqual(
          got.rows.map((_, i) => got.row(i)),
          full(after, options).rows,
        );
      }
    }
  });

  it("gives the full computation's rows over a series of Refreshes", () => {
    // Commits made on top (merges too), refs moved near the top, the same commits, fewer
    // commits, and pages, in a random order, each compared with the full computation.
    for (const seed of [1, 2, 3, 11]) {
      const random = rng(seed * 7919);
      const size = 1_400 + Math.floor(random() * 400);
      const base =
        seed % 3 === 0
          ? history(seed, size, 8 + (seed % 20), 0.5, 0.002)
          : seed % 3 === 1
            ? probeLog(size, seed % 40)
            : Array.from({ length: size }, (_, i) =>
                commit(`c${i}`, i + 1 < size ? [`c${i + 1}`] : [], i ? [] : ["HEAD -> main"]),
              );
      const options = { ...DEFAULT_LOG_OPTIONS, longEdges: random() < 0.3 };
      const present = createLogGraphPresenter();
      const loaded = 1_100 + Math.floor(random() * 200);
      for (let n = 300; n < loaded; n += 300) present(base.slice(0, n), options, fragments, keep);
      let list = base.slice(0, loaded);
      present(list, options, fragments, keep);
      let made = 0;
      for (let step = 0; step < 6; step++) {
        const op = Math.floor(random() * 6);
        const head = list[0]!;
        let next: Commit[];
        if (op <= 1) {
          const tip: Commit[] = [];
          for (let i = 0, k = 1 + Math.floor(random() * 2); i < k; i++) {
            const merge = random() < 0.2 ? [list[3 + Math.floor(random() * 5)]!.id] : [];
            tip.push(commit(`m${made++}`, [i + 1 < k ? `m${made}` : head.id, ...merge], i ? [] : head.refs));
          }
          next = [...tip, { ...head, refs: [] }, ...list.slice(1)];
          if (random() < 0.5) next = next.slice(0, list.length);
        } else if (op === 2) {
          const r = Math.floor(random() * 4);
          const refs = (c: Commit) =>
            c.refs.length ? (random() < 0.5 ? [] : ["HEAD"]) : [random() < 0.5 ? "zz" : "HEAD"];
          next = list.map((c, i) => ({ ...c, refs: i === r ? refs(c) : c.refs }));
        } else if (op === 3) next = list.map((c) => ({ ...c }));
        else if (op === 4) next = list.slice(0, list.length - 1 - Math.floor(random() * 50)).map((c) => ({ ...c }));
        else {
          const ids = new Set(list.map((c) => c.id));
          next = [...list, ...base.filter((c) => !ids.has(c.id)).slice(0, 150)];
        }
        list = next;
        const got = present(list, options, fragments, keep);
        const rows = got.rows.map((_, i) => got.row(i));
        const want = full(list, options).rows;
        if (!isDeepStrictEqual(rows, want))
          expect({ seed, step, op, rows }).toStrictEqual({ seed, step, op, rows: want });
      }
    }
  });

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

  it("gives the full computation's rows when a parent comes before its child", () => {
    // Clock skew: a commit listed above one of its children. Layout heads then change above a page.
    const all = history(37, 600, 12);
    const child = all.findIndex(
      (c, i) => i > 450 && c.parents.length === 1 && all.findIndex((p) => p.id === c.parents[0]) > i + 1,
    );
    const parent = all.findIndex((p) => p.id === all[child]!.parents[0]);
    const skewed = [...all.slice(0, child), all[parent]!, ...all.slice(child, parent), ...all.slice(parent + 1)];
    pageThrough(skewed, [150]);
  });

  it("gives the full computation's rows when commits share a key", () => {
    const all = history(17, 300, 10);
    pageThrough([...all.slice(0, 200), { ...all[50]! }, ...all.slice(200)], [120]);
  });
});
