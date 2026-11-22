import type { Commit } from "@/bindings";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ commits: [] as Commit[] }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  const ok = <T,>(data: T) => Promise.resolve({ status: "ok" as const, data });
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsLog: (_repo: string, query: { skip: number; limit: number | null }) =>
        ok(api.commits.slice(query.skip, query.limit ? query.skip + query.limit : undefined)),
      vcsLogRefs: () => ok({}),
      vcsBranches: () => ok([]),
      vcsTags: () => ok([]),
      vcsBranchInfo: () => ok({ upstream: null }),
      vcsConfigGet: () => ok(null),
    },
  };
});
vi.mock("../graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../graph")>();
  return { ...actual, compactLanes: vi.fn(actual.compactLanes) };
});

import * as graph from "../graph";
import { LogView } from "../GitLog";
import { DEFAULT_LOG_OPTIONS, useLogOptions } from "../logOptions";
import { PAGE, emptyFilters, loadMore, reloadLog, useGitLog } from "../logStore";
import { useVcs } from "../store";

/** A branchy history in log order: a merge every twelfth commit, and branch tips with refs. */
function history(size: number): Commit[] {
  const id = (n: number) => `c${n}`;
  return Array.from({ length: size }, (_, i) => ({
    id: id(i),
    shortId: id(i),
    parents: i + 1 >= size ? [] : i % 12 === 0 && i + 7 < size ? [id(i + 1), id(i + 7)] : [id(i + 1)],
    refs: i === 0 ? ["HEAD -> main"] : i % 250 === 0 ? [`branch-${i}`] : [],
    author: "Author",
    email: "a@example.com",
    summary: id(i),
    message: id(i),
    timeMs: 0,
  }));
}

beforeEach(() => {
  api.commits = history(3_000);
  useVcs.setState({
    root: "/repo",
    repo: "/repo",
    roots: ["/repo"],
    available: true,
    branchesLoaded: true,
    branches: [],
    branch: { head: "main", headCommit: "c0", upstream: null, ahead: 0, behind: 0, operation: null },
  });
  useGitLog.setState({
    shownLog: "log",
    tab: "log",
    logTabs: [],
    commits: [],
    filters: emptyFilters(),
    selection: [],
    selected: null,
    done: false,
    branchScope: "/repo",
    generation: useGitLog.getState().generation + 1,
  });
  useLogOptions.setState({ ...DEFAULT_LOG_OPTIONS, showBranches: false, showDetails: false });
});

afterEach(async () => {
  api.commits = [];
  await reloadLog();
});

describe("Git Log paging", () => {
  it("presents only the appended page and the rows just above it when a page arrives", async () => {
    render(<LogView />);
    const list = await screen.findByRole("listbox", { name: "Commits" });
    // The list asks for a second page while the first one fills the view.
    await waitFor(() => expect(useGitLog.getState()).toMatchObject({ commits: { length: 2 * PAGE }, loading: false }));
    while (useGitLog.getState().commits.length < 2_400) await act(() => loadMore());
    const loaded = useGitLog.getState().commits.length;
    const compactLanes = vi.mocked(graph.compactLanes);
    compactLanes.mockClear();
    await act(() => loadMore());
    expect(useGitLog.getState().commits).toHaveLength(loaded + PAGE);
    const presented = compactLanes.mock.calls.reduce((sum, [rows]) => sum + rows.length, 0);
    // The page and the 34 rows laid out again before it, not every row loaded.
    expect(presented).toBeGreaterThan(0);
    expect(presented).toBeLessThanOrEqual(PAGE + 34);
    expect(within(list).getAllByRole("option").length).toBeGreaterThan(0);
  });
});
