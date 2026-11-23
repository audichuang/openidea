import { describe, expect, it, vi } from "vitest";
import type { Commit } from "@/bindings";
import * as graph from "../graph";
import { createLogGraphPresenter, presentLogGraph } from "../logPresentation";
import { DEFAULT_LOG_OPTIONS } from "../logOptions";

vi.mock("../graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../graph")>();
  return { ...actual, compactLanes: vi.fn(actual.compactLanes) };
});

const PAGE = 300;
const fragments = { expanded: new Set<string>(), collapsed: new Set<string>(), merges: new Set<string>() };

/** A branchy log in log order (children first), with HEAD and a few branch refs. */
function history(size: number): Commit[] {
  const id = (n: number) => `c${n}`;
  return Array.from({ length: size }, (_, i) => {
    const parents = i + 1 >= size ? [] : i % 12 === 0 && i + 7 < size ? [id(i + 1), id(i + 7)] : [id(i + 1)];
    return {
      id: id(i),
      shortId: id(i),
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
      refs: i === 0 ? ["HEAD -> main"] : i % 250 === 0 ? [`branch-${i}`] : [],
    };
  });
}

/**
 * A mainline in log order: every tenth commit merges a short side chain (no refs) that forks
 * from the mainline a few commits down, as date order interleaves them.
 */
function mainline(size: number): Commit[] {
  const commit = (id: string, parents: string[]): Commit => ({
    ...history(1)[0]!,
    id,
    shortId: id,
    parents,
    refs: id === "m0" ? ["HEAD -> main"] : [],
  });
  const out: Commit[] = [];
  for (let m = 0; out.length < size; m++) {
    if (m % 10 !== 5) {
      out.push(commit(`m${m}`, [`m${m + 1}`]));
      continue;
    }
    const side = Array.from({ length: 1 + (m % 3) }, (_, k) => `s${m}.${k}`);
    out.push(commit(`m${m}`, [`m${m + 1}`, side[0]!]), commit(`m${m + 1}`, [`m${m + 2}`]));
    side.forEach((id, k) => out.push(commit(id, [side[k + 1] ?? `m${m + 3}`])));
    out.push(commit(`m${m + 2}`, [`m${m + 3}`]));
    m += 2;
  }
  return out;
}

/** Rows presented again when one page is appended to `loaded` rows, as the Git Log presents it. */
function rowsPresentedForPage(all: readonly Commit[], loaded: number) {
  const compactLanes = vi.mocked(graph.compactLanes);
  const present = createLogGraphPresenter();
  present(all.slice(0, loaded), DEFAULT_LOG_OPTIONS, fragments, new Set());
  compactLanes.mockClear();
  present(all.slice(0, loaded + PAGE), DEFAULT_LOG_OPTIONS, fragments, new Set());
  return compactLanes.mock.calls.reduce((sum, [rows]) => sum + rows.length, 0);
}

/** Rows presented again when the loaded history comes back from a Refresh as `refreshed`. */
function rowsPresentedForRefresh(loaded: readonly Commit[], refreshed: readonly Commit[]) {
  const compactLanes = vi.mocked(graph.compactLanes);
  const present = createLogGraphPresenter();
  present(loaded, DEFAULT_LOG_OPTIONS, fragments, new Set());
  compactLanes.mockClear();
  const got = present(refreshed, DEFAULT_LOG_OPTIONS, fragments, new Set());
  const rows = compactLanes.mock.calls.reduce((sum, [rows]) => sum + rows.length, 0);
  return { rows, got };
}

describe("Git Log deep paging", () => {
  // Every page used to lay out and present the whole loaded history again, so a page at row
  // 20,000 cost 30 times a page at row 600.
  it("presents the same number of rows per page at any depth", () => {
    const all = history(21_000);
    const shallow = rowsPresentedForPage(all, 600);
    const deep = rowsPresentedForPage(all, 20_000);
    expect(deep).toBeLessThanOrEqual(shallow);
  });

  // Refresh replaces every commit object; it used to lay out and present the whole history again.
  it("presents no more rows than a page when a Refresh returns the same history", () => {
    const loaded = history(20_000);
    const { rows, got } = rowsPresentedForRefresh(
      loaded,
      loaded.map((c) => ({ ...c, refs: [...c.refs] })),
    );
    expect(rows).toBeLessThanOrEqual(PAGE + 34);
    expect(got.rows).toHaveLength(20_000);
  });

  it("presents only the rows from a change deep in the history on Refresh", () => {
    const loaded = history(20_000);
    const refreshed = loaded.map((c, i) => (i === 19_500 ? { ...c, refs: ["renamed"] } : { ...c }));
    const { rows, got } = rowsPresentedForRefresh(loaded, refreshed);
    expect(rows).toBeLessThanOrEqual(2_000);
    const want = presentLogGraph(refreshed, DEFAULT_LOG_OPTIONS, fragments, new Set()).rows;
    for (const i of [0, 9_999, 18_000, 19_499, 19_500, 19_999]) expect(got.row(i)).toStrictEqual(want[i]);
  });

  // The Git Log draws from `row(index)`; nothing reads a whole-list width, so no page computes one.
  it("returns only what the Git Log reads, paged or not", () => {
    const fields = ["childCount", "collapsed", "commits", "graph", "linear", "pending", "row", "rows", "rowsOf"];
    const present = createLogGraphPresenter();
    const all = history(1_000);
    expect(Object.keys(present(all, DEFAULT_LOG_OPTIONS, fragments, new Set())).sort()).toEqual(fields);
    const linearized = { ...DEFAULT_LOG_OPTIONS, linearizeMerges: true };
    expect(Object.keys(present(all, linearized, fragments, new Set())).sort()).toEqual(fields);
  });

  // With refs the lane colours come from `graphLayout` over the whole loaded list, whose owner
  // suffixes count the side chains below each one: a page arriving recolours merged side-branch
  // lanes up to the top of the log. The paged presenter resolves colours per drawn row to follow.
  it("recolours rows far above the loaded end when a page arrives, and the presenter follows", () => {
    const all = mainline(1_300);
    const before = presentLogGraph(all.slice(0, 1_000), DEFAULT_LOG_OPTIONS, fragments, new Set()).rows;
    const after = presentLogGraph(all, DEFAULT_LOG_OPTIONS, fragments, new Set()).rows;
    expect(after.slice(0, 900)).not.toStrictEqual(before.slice(0, 900));
    const present = createLogGraphPresenter();
    present(all.slice(0, 1_000), DEFAULT_LOG_OPTIONS, fragments, new Set());
    const paged = present(all, DEFAULT_LOG_OPTIONS, fragments, new Set());
    expect(after.map((_, i) => paged.row(i))).toStrictEqual(after);
  });
});
