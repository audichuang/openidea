import { describe, expect, it, vi } from "vitest";
import type { Commit } from "@/bindings";
import * as graph from "../graph";
import { presentLogGraph } from "../logPresentation";
import { DEFAULT_LOG_OPTIONS } from "../logOptions";

vi.mock("../graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../graph")>();
  return { ...actual, computeGraph: vi.fn(actual.computeGraph) };
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

/** Rows `computeGraph` lays out when one page is appended to `loaded` rows, as the Git Log presents it. */
function rowsLaidOutForPage(all: readonly Commit[], loaded: number) {
  const computeGraph = vi.mocked(graph.computeGraph);
  presentLogGraph(all.slice(0, loaded), DEFAULT_LOG_OPTIONS, fragments, new Set());
  computeGraph.mockClear();
  presentLogGraph(all.slice(0, loaded + PAGE), DEFAULT_LOG_OPTIONS, fragments, new Set());
  return computeGraph.mock.calls.reduce((sum, [commits]) => sum + commits.length, 0);
}

describe("Git Log deep paging", () => {
  // Red: every page lays out the whole loaded history again, so a page at row 20,000 costs
  // 30 times a page at row 600. Expected to flip once a page lays out only its own rows.
  it.fails("lays out the same number of rows per page at any depth", () => {
    const all = history(21_000);
    const shallow = rowsLaidOutForPage(all, 600);
    const deep = rowsLaidOutForPage(all, 20_000);
    expect(deep).toBeLessThanOrEqual(shallow);
  });
});
