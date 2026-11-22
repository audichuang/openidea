import type { Commit } from "@/bindings";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ commits: [] as Commit[], pages: 0 }));
/** Layout slices of `steps` steps (unlimited by default), the later ones run by `flush`. */
const slices = vi.hoisted(() => ({ steps: Infinity, queue: [] as Array<() => void> }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  const ok = <T,>(data: T) => Promise.resolve({ status: "ok" as const, data });
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsLog: (_repo: string, query: { skip: number; limit: number | null }) => {
        if (query.skip) api.pages++;
        return ok(api.commits.slice(query.skip, query.limit ? query.skip + query.limit : undefined));
      },
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
vi.mock("../logPresentation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logPresentation")>();
  return {
    ...actual,
    createLogGraphPresenter: (onReady?: () => void) =>
      actual.createLogGraphPresenter(onReady, {
        start() {
          let left = slices.steps;
          return () => --left <= 0;
        },
        later: (run) => void slices.queue.push(run),
      }),
  };
});
vi.mock("../multiRoot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../multiRoot")>();
  return { ...actual, commitKey: vi.fn(actual.commitKey), graphCommit: vi.fn(actual.graphCommit) };
});

import * as graph from "../graph";
import { LogView } from "../GitLog";
import { CommitList } from "../log/CommitList";
import { DEFAULT_LOG_OPTIONS, useLogOptions } from "../logOptions";
import * as multiRoot from "../multiRoot";
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
  slices.steps = Infinity;
  slices.queue.length = 0;
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

  // Head commits, the current-branch highlight, the selected row and the scroll anchor used to
  // go over every loaded commit again on each page.
  it("goes over only the appended commits when a page arrives", async () => {
    render(<LogView />);
    await screen.findByRole("listbox", { name: "Commits" });
    await waitFor(() => expect(useGitLog.getState()).toMatchObject({ commits: { length: 2 * PAGE }, loading: false }));
    while (useGitLog.getState().commits.length < 2_400) await act(() => loadMore());
    const graphCommit = vi.mocked(multiRoot.graphCommit);
    const commitKey = vi.mocked(multiRoot.commitKey);
    graphCommit.mockClear();
    commitKey.mockClear();
    await act(() => loadMore());
    expect(useGitLog.getState().commits).toHaveLength(2_400 + PAGE);
    expect(graphCommit.mock.calls.length).toBeLessThanOrEqual(PAGE);
    expect(commitKey.mock.calls.length).toBeLessThanOrEqual(6 * PAGE);
  });

  // File History's list puts author and date before the subject and pages like the log.
  it("pages the File History list with its own column order", async () => {
    render(<CommitList fileHistory />);
    const list = await screen.findByRole("listbox", { name: "Commits" });
    await act(() => reloadLog());
    while (useGitLog.getState().commits.length < 2_400) await act(() => loadMore());
    const compactLanes = vi.mocked(graph.compactLanes);
    compactLanes.mockClear();
    await act(() => loadMore());
    expect(useGitLog.getState().commits).toHaveLength(2_400 + PAGE);
    const presented = compactLanes.mock.calls.reduce((sum, [rows]) => sum + rows.length, 0);
    expect(presented).toBeLessThanOrEqual(PAGE + 34);
    const newest = within(list).getAllByRole("option")[0]!;
    const author = within(newest).getByText("Author", { exact: true });
    const subject = within(newest).getByText("c0", { exact: true });
    expect(author.compareDocumentPosition(subject) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

/**
 * 300 commits on 120 long-lived branches merging into each other, newest first, and the same
 * history after a merge was made on top of the newest branch (`c300`, merging another tip).
 */
function mergingBranches() {
  const tips = new Map<string, number>();
  const made: number[][] = [];
  for (let i = 1; i <= 301; i++) {
    const branch = `b${(i * 7) % 120}`;
    const parents = i > 1 ? [tips.get(branch) ?? 1] : [];
    if (i > 120 && (i === 301 || i % 5 === 0)) {
      const other = [...tips.values()].find((t) => !parents.includes(t) && t % 3 === i % 3);
      if (other !== undefined) parents.push(other);
    }
    made.push(parents);
    tips.set(branch, i);
  }
  const commit = (i: number, refs: string[]): Commit => ({
    ...history(1)[0]!,
    id: `c${i}`,
    shortId: `c${i}`,
    summary: `c${i}`,
    message: `c${i}`,
    parents: made[i - 1]!.map((p) => `c${p}`),
    refs,
  });
  const list = (top: number) => {
    const refs = new Map<number, string[]>();
    for (const [branch, tip] of tips) {
      const at = tip === 301 ? (top === 301 ? 301 : made[300]![0]!) : tip;
      refs.set(at, [...(refs.get(at) ?? []), tip === 301 ? `HEAD -> ${branch}` : branch]);
    }
    return Array.from({ length: top }, (_, k) => commit(top - k, refs.get(top - k) ?? []));
  };
  return { before: list(300), after: list(301) };
}

describe("Git Log laid out over several tasks", () => {
  it("shows the previous rows and asks for no page until a Refresh's layout is done", async () => {
    const { before, after } = mergingBranches();
    api.commits = before;
    render(<LogView />);
    const list = await screen.findByRole("listbox", { name: "Commits" });
    await waitFor(() => expect(useGitLog.getState()).toMatchObject({ done: true, loading: false }));
    expect(within(list).getAllByRole("option")[0]).toHaveTextContent("c300");

    // The merge made on top reorders the lanes below it: the list is laid out again, in slices.
    slices.steps = 1;
    api.commits = after;
    api.pages = 0;
    // The log's Refresh keeps the rows shown while it loads.
    await act(() => reloadLog({ preserve: true }));
    expect(useGitLog.getState().commits[0]!.id).toBe("c301");
    expect(slices.queue.length).toBeGreaterThan(0);
    const top = () => within(screen.getByRole("listbox", { name: "Commits" })).getAllByRole("option")[0];
    expect(top()).toHaveTextContent("c300");
    // Its last rows are not shown yet: the next page waits.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(api.pages).toBe(0);

    await act(async () => {
      while (slices.queue.length) slices.queue.shift()!();
    });
    expect(top()).toHaveTextContent("c301");
    await waitFor(() => expect(api.pages).toBeGreaterThan(0));
  });
});
