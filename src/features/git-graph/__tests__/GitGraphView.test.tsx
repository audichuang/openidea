import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Branch, ChangedFile, Commit } from "@/bindings";
import type { EditorInput } from "@/workbench/contributions";
import type { MenuItem } from "@/ui";

const { scrollToIndex } = vi.hoisted(() => ({ scrollToIndex: vi.fn() }));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 24,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 24, key: index })),
    scrollToIndex,
    measure: () => {},
    measureElement: () => {},
  }),
}));

const vcsLog = vi.fn();
const vcsBranches = vi.fn();
const vcsTags = vi.fn();
const vcsCommitFiles = vi.fn();
const graphTree = vi.fn();
const vcsMergeBase = vi.fn();
const vcsDiffRevisions = vi.fn();
const graphStashes = vi.fn();
const graphWorkingState = vi.fn();
const graphReflog = vi.fn();
const graphAuthorStats = vi.fn();
const popStash = vi.fn();
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsLog: (repo: string, q: unknown) => vcsLog(repo, q),
      vcsBranches: (repo: string) => vcsBranches(repo),
      vcsTags: (repo: string) => vcsTags(repo),
      vcsCommitFiles: (repo: string, id: string) => vcsCommitFiles(repo, id),
      graphTree: (repo: string, rev: string) => graphTree(repo, rev),
      vcsMergeBase: (repo: string, a: string, b: string) => vcsMergeBase(repo, a, b),
      vcsDiffRevisions: (repo: string, from: string, to: string) => vcsDiffRevisions(repo, from, to),
      vcsRemotes: () => Promise.resolve({ status: "ok", data: [] }),
      graphStashes: (repo: string) => graphStashes(repo),
      graphWorkingState: (repo: string) => graphWorkingState(repo),
      graphReflog: (repo: string) => graphReflog(repo),
      graphAuthorStats: (repo: string) => graphAuthorStats(repo),
      graphBisectState: () =>
        Promise.resolve({ status: "ok", data: { active: false, current: null, culprit: null, output: "" } }),
    },
  };
});

const showContextMenu = vi.fn();
vi.mock("@/ui", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/ui")>();
  return { ...real, showContextMenu: (at: unknown, items: MenuItem[]) => showContextMenu(at, items) };
});

import {
  provideGitGraphBridge,
  type GitGraphBridge,
  type GitGraphRepoState,
  type GraphBranchFilterProps,
  type GraphDiffNavigation,
  type GraphLaneRow,
  type GraphRevisionSide,
} from "@/workbench/gitGraphBridge";
import { GitGraphEditor } from "../GitGraphView";
import { findMatches, logBranches } from "../data";
import { defaultPrRefs } from "../PrView";
import { registerActions } from "@/platform/actions";
import { useContributions } from "@/workbench/contributions";
import { initialGraphView, useGraphView } from "../viewState";
import { SELECTION_DELAY } from "../panels";

const REPO = "/repo";
const ok = <T,>(data: T) => Promise.resolve({ status: "ok" as const, data });

const commit = (id: string, parents: string[], opts: Partial<Commit> = {}): Commit => ({
  id: id.padEnd(40, "0"),
  shortId: id.padEnd(8, "0"),
  parents: parents.map((p) => p.padEnd(40, "0")),
  author: "Ann",
  email: "ann@example.com",
  timeMs: 1_700_000_000_000,
  summary: `subject ${id}`,
  message: `subject ${id}\n\nbody ${id}`,
  refs: [],
  ...opts,
});

const branch = (name: string, opts: Partial<Branch> = {}): Branch => ({
  name,
  remote: false,
  current: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  lastCommitMs: 0,
  ...opts,
});

let state: GitGraphRepoState;
const listeners = new Set<() => void>();
const bridge = {
  state: () => state,
  subscribe: (fn: () => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  layout: (commits: readonly { id: string }[]) => ({
    rows: commits.map(() => ({ lane: 0, color: 0, up: [], down: [], width: 1 })),
    state: { _layout: null },
  }),
  present: <T,>(rows: readonly T[]) => [...rows],
  // Through `layout`, which tests spy on to count layouts.
  presenter:
    () =>
    (commits: readonly { id: string }[]): GraphLaneRow[] =>
      bridge.layout(commits).rows,
  laneColor: () => "var(--accent)",
  repoColor: () => null,
  refLabels: (refs: readonly string[]) =>
    refs.map((r) =>
      r === "HEAD"
        ? { kind: "head" as const, name: "HEAD" }
        : r.startsWith("tag: ")
          ? { kind: "tag" as const, name: r.slice(5) }
          : { kind: (r.includes("/") ? "remote" : "local") as "remote" | "local", name: r },
    ),
  commitMenu: vi.fn(async () => [{ label: "Commit Item" }] as MenuItem[]),
  branchMenu: vi.fn(async () => [{ label: "Branch Item" }] as MenuItem[]),
  tagMenu: vi.fn(async () => [{ label: "Tag Item" }] as MenuItem[]),
  BranchFilterPopup: vi.fn((p: GraphBranchFilterProps) => (
    <div role="dialog" aria-label="Branch filter">
      {p.branches.map((b) => (
        <button key={b.name} type="button" onClick={() => p.onSelect(b.name)}>
          {`pick ${b.name}`}
        </button>
      ))}
      <button type="button" onClick={() => p.onSelectMany(["HEAD", "origin/main"])}>
        pick many
      </button>
    </div>
  )),
  filesMenu: vi.fn(async () => [{ label: "File Item" }] as MenuItem[]),
  openDiff: vi.fn(async () => {}),
  openRevisionFile: vi.fn(async () => {}),
  revisionDiffInput: vi.fn(
    (
      _repo: string,
      from: GraphRevisionSide,
      to: GraphRevisionSide,
      file: ChangedFile,
      _nav?: GraphDiffNavigation,
    ): EditorInput => ({
      kind: "diff",
      key: `${from.rev}:${to.rev}:${file.path}`,
      data: { from, to, file },
    }),
  ),
  openRevisionDiff: vi.fn(async () => {}),
  copyRange: vi.fn(async () => true),
  stashMenu: vi.fn(() => [{ label: "Apply" }, { label: "Pop", run: popStash }] as MenuItem[]),
  controlOperation: vi.fn(async () => {}),
  resolveConflicts: vi.fn(async () => {}),
  stashChanges: vi.fn(),
  rollback: vi.fn(),
  showLog: vi.fn(async () => {}),
  mergeIntoCurrent: vi.fn(async () => {}),
  rebaseCurrentOnto: vi.fn(async () => {}),
  runOp: <T,>(_title: string, fn: () => Promise<T>): Promise<T | undefined> => fn(),
  confirm: vi.fn(async () => true),
  prompt: vi.fn(async () => null),
} satisfies GitGraphBridge;

let withdraw: () => void;

beforeEach(() => {
  state = {
    roots: [REPO],
    repo: REPO,
    heads: { [REPO]: { head: "main", headCommit: "a".padEnd(40, "0") } },
    operations: {},
    version: 0,
  };
  vcsLog.mockImplementation(() =>
    ok([
      commit("a", ["b"], { refs: ["HEAD", "main", "origin/main"] }),
      commit("b", ["c"], { refs: ["tag: v1"] }),
      commit("c", [], { author: "Bob", summary: "initial import", message: "initial import" }),
    ]),
  );
  vcsBranches.mockImplementation(() =>
    ok([branch("main", { current: true }), branch("origin/main", { remote: true })]),
  );
  vcsTags.mockImplementation(() => ok(["v1"]));
  vcsCommitFiles.mockImplementation(() => ok([{ path: "src/app.ts", kind: "modified", oldPath: null }]));
  graphTree.mockImplementation(() => ok([{ path: "src/app.ts", kind: "blob", size: 12 }]));
  graphStashes.mockImplementation(() => ok([]));
  graphReflog.mockImplementation(() =>
    ok([{ selector: "HEAD@{0}", id: "a".padEnd(40, "0"), action: "commit: subject a", timeMs: 1 }]),
  );
  graphAuthorStats.mockImplementation(() => ok([{ name: "Ann", email: "ann@example.com", commits: 3 }]));
  graphWorkingState.mockImplementation(() => ok({ staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }));
  withdraw = provideGitGraphBridge(bridge);
  useGraphView.setState(initialGraphView());
});

afterEach(() => {
  withdraw();
  vi.clearAllMocks();
  listeners.clear();
});

const rowOf = (text: string) =>
  within(screen.getByRole("grid", { name: "Commits" }))
    .getByText(text)
    .closest('[role="row"]') as HTMLElement;

describe("Git Graph view", () => {
  it("shows every commit with its references, date, author and hash", async () => {
    render(<GitGraphEditor />);
    await screen.findByText("subject a");
    expect(screen.getByText("initial import")).toBeTruthy();
    expect(screen.getByRole("button", { name: "main" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "origin/main" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "v1" })).toBeTruthy();
    expect(screen.getByText("Bob")).toBeTruthy();
    expect(screen.getByText("c0000000")).toBeTruthy();
    // Every branch: no branch list sent to the log.
    expect(vcsLog).toHaveBeenCalledWith(REPO, expect.objectContaining({ branches: [], order: "topo", skip: 0 }));
  });

  it("shows the selected commit's message and files and opens a diff", async () => {
    render(<GitGraphEditor />);
    await screen.findByText("subject a");
    fireEvent.click(rowOf("subject a"));
    expect(await screen.findByText("body a")).toBeTruthy();
    const file = await screen.findByText("app.ts");
    expect(vcsCommitFiles).toHaveBeenCalledWith(REPO, "a".padEnd(40, "0"));
    fireEvent.click(file);
    expect(bridge.openDiff).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a".padEnd(40, "0"), repo: REPO }),
      expect.any(Array),
      0,
      true,
    );
    fireEvent.contextMenu(file);
    await waitFor(() => expect(showContextMenu).toHaveBeenCalledWith(expect.anything(), [{ label: "File Item" }]));
  });

  it("keeps the selection when the tab is hidden and shown again", async () => {
    const first = render(<GitGraphEditor />);
    await screen.findByText("subject a");
    fireEvent.click(rowOf("subject b"));
    first.unmount();
    render(<GitGraphEditor />);
    await screen.findByText("subject a");
    expect(rowOf("subject b").getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByText("body b")).toBeTruthy();
  });

  it("re-renders neither the toolbar nor the graph cells when the selection changes", async () => {
    // The toolbar paints the repository swatch (shown with two roots) and every graph cell its lane colours on each render.
    state = { ...state, roots: [REPO, "/other"] };
    const repoColor = vi.spyOn(bridge, "repoColor");
    const laneColor = vi.spyOn(bridge, "laneColor");
    render(<GitGraphEditor />);
    await screen.findByText("subject a");
    fireEvent.click(rowOf("subject a"));
    expect(await screen.findByText("body a")).toBeTruthy();
    expect(repoColor).toHaveBeenCalled();
    expect(laneColor).toHaveBeenCalled();
    repoColor.mockClear();
    laneColor.mockClear();
    fireEvent.click(rowOf("subject b"));
    expect(await screen.findByText("body b")).toBeTruthy();
    expect(rowOf("subject b").getAttribute("aria-selected")).toBe("true");
    expect(repoColor).not.toHaveBeenCalled();
    expect(laneColor).not.toHaveBeenCalled();
  });

  it("opens the commit menu for the selection", async () => {
    render(<GitGraphEditor />);
    await screen.findByText("subject a");
    fireEvent.click(rowOf("subject a"));
    fireEvent.click(rowOf("subject b"), { metaKey: true });
    fireEvent.contextMenu(rowOf("subject b"));
    await waitFor(() => expect(bridge.commitMenu).toHaveBeenCalled());
    const [target, selection] = bridge.commitMenu.mock.calls[0] as unknown as [Commit, Commit[]];
    expect(target.summary).toBe("subject b");
    expect(selection.map((c) => c.summary)).toEqual(["subject a", "subject b"]);
    expect(screen.getByText("2 commits selected")).toBeTruthy();
  });

  it("opens branch and tag menus from the reference labels", async () => {
    render(<GitGraphEditor />);
    fireEvent.click(await screen.findByRole("button", { name: "origin/main" }));
    await waitFor(() =>
      expect(bridge.branchMenu).toHaveBeenCalledWith(
        expect.objectContaining({ name: "origin/main", remote: true }),
        REPO,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "v1" }));
    await waitFor(() => expect(bridge.tagMenu).toHaveBeenCalledWith("v1", REPO));
  });

  it("filters branches through the vcs feature's branch filter popup", async () => {
    render(<GitGraphEditor />);
    await screen.findByText("subject a");
    const button = screen.getByRole("button", { name: "Branches" });
    expect(screen.queryByRole("dialog", { name: "Branch filter" })).toBeNull();
    fireEvent.click(button);
    await screen.findByRole("dialog", { name: "Branch filter" });
    expect(bridge.BranchFilterPopup).toHaveBeenLastCalledWith(
      expect.objectContaining({ repo: REPO, selected: [], anchor: button }),
      undefined,
    );
    fireEvent.click(screen.getByRole("button", { name: "pick main" }));
    expect(useGraphView.getState().branchFilter).toEqual({ [REPO]: ["main"] });
    expect(screen.queryByRole("dialog", { name: "Branch filter" })).toBeNull();
    // Picking a selected branch again takes it out of the filter.
    fireEvent.click(button);
    fireEvent.click(await screen.findByRole("button", { name: "pick main" }));
    expect(useGraphView.getState().branchFilter[REPO]).toEqual([]);
    fireEvent.click(button);
    fireEvent.click(await screen.findByRole("button", { name: "pick many" }));
    expect(useGraphView.getState().branchFilter[REPO]).toEqual(["HEAD", "origin/main"]);
    fireEvent.click(screen.getByRole("button", { name: "Show All Branches" }));
    expect(useGraphView.getState().branchFilter[REPO]).toEqual([]);
    const remotes = screen.getByRole("button", { name: "Show Remote Branches" });
    expect(remotes.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(remotes);
    expect(useGraphView.getState().showRemotes).toBe(false);
  });

  it("keeps each repository's branch filter apart (#379)", async () => {
    const [app, lib] = ["/work/app", "/work/lib"];
    const head = state.heads[REPO]!;
    state = { ...state, roots: [app, lib], repo: app, heads: { [app]: head, [lib]: head } };
    const lastLog = () => vcsLog.mock.calls.at(-1) as [string, { branches: string[] }];
    render(<GitGraphEditor />);
    await screen.findByText("subject a");
    fireEvent.click(screen.getByRole("button", { name: "Branches" }));
    fireEvent.click(await screen.findByRole("button", { name: "pick main" }));
    await waitFor(() => expect(lastLog()).toEqual([app, expect.objectContaining({ branches: ["main"] })]));
    // The other repository starts unfiltered.
    act(() => useGraphView.setState({ repo: lib }));
    await waitFor(() => expect(lastLog()).toEqual([lib, expect.objectContaining({ branches: [] })]));
    expect(screen.getByRole("button", { name: "Branches" }).textContent).toBe("All branches");
    // Back on the first one, its filter is as it was left.
    act(() => useGraphView.setState({ repo: app }));
    await waitFor(() => expect(lastLog()).toEqual([app, expect.objectContaining({ branches: ["main"] })]));
    expect(screen.getByRole("button", { name: "Branches" }).textContent).toBe("main");
  });

  it("keeps each repository's File Tree revision apart (#379)", async () => {
    const [app, lib] = ["/work/app", "/work/lib"];
    const head = state.heads[REPO]!;
    state = { ...state, roots: [app, lib], repo: app, heads: { [app]: head, [lib]: head } };
    const rev = "b".padEnd(40, "0");
    render(<GitGraphEditor />);
    await screen.findByText("subject a");
    fireEvent.contextMenu(rowOf("subject b"));
    await waitFor(() => expect(showContextMenu).toHaveBeenCalled());
    const items = showContextMenu.mock.calls.at(-1)![1] as MenuItem[];
    const showFiles = items.find((i) => "label" in i && i.label === "Show Files at Revision");
    act(() => (showFiles as { run: () => void }).run());
    await waitFor(() => expect(graphTree).toHaveBeenCalledWith(app, rev));
    // The other repository lists no revision of the first one.
    act(() => useGraphView.setState({ repo: lib }));
    expect(await screen.findByText("Select a commit")).toBeTruthy();
    // Past the selection delay, so a delayed load would have been sent.
    await act(() => new Promise((r) => setTimeout(r, SELECTION_DELAY + 50)));
    expect(graphTree).not.toHaveBeenCalledWith(lib, expect.anything());
    act(() => useGraphView.setState({ repo: app }));
    expect(await screen.findByText("1 files")).toBeTruthy();
  });

  it("finds commits and steps through the matches", async () => {
    render(<GitGraphEditor />);
    await screen.findByText("subject a");
    fireEvent.change(screen.getByRole("textbox", { name: "Find commit" }), { target: { value: "subject" } });
    expect(screen.getByText("1/2")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Find commit" }), { key: "Enter" });
    expect(screen.getByText("2/2")).toBeTruthy();
    expect(rowOf("subject b").getAttribute("aria-selected")).toBe("true");
  });

  it("reloads after a vcs refresh only when references moved", async () => {
    render(<GitGraphEditor />);
    await screen.findByText("subject a");
    expect(vcsLog).toHaveBeenCalledTimes(1);
    await act(async () => {
      state = { ...state, version: 1 };
      listeners.forEach((fn) => fn());
    });
    await waitFor(() => expect(vcsBranches).toHaveBeenCalledTimes(2));
    expect(vcsLog).toHaveBeenCalledTimes(1);
    vcsTags.mockImplementation(() => ok(["v1", "v2"]));
    await act(async () => {
      state = { ...state, version: 2 };
      listeners.forEach((fn) => fn());
    });
    await waitFor(() => expect(vcsLog).toHaveBeenCalledTimes(2));
    // The old graph stays while the new one loads.
    expect(screen.getByText("subject a")).toBeTruthy();
  });

  it("reveals the selection again when the list is replaced, not when a vcs refresh reloads it in place", async () => {
    render(<GitGraphEditor />);
    await screen.findByText("subject a");
    fireEvent.click(rowOf("initial import"));
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    const reloaded = async (logs: number) => {
      await waitFor(() => expect(vcsLog).toHaveBeenCalledTimes(logs));
      await waitFor(() => rowOf("initial import"));
      await act(async () => {});
    };

    vcsTags.mockImplementation(() => ok(["v1", "v2"]));
    await act(async () => {
      state = { ...state, version: 1 };
      listeners.forEach((fn) => fn());
    });
    await reloaded(2);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Show Remote Branches" }));
    await reloaded(3);
    expect(scrollToIndex).toHaveBeenCalledTimes(2);
    expect(scrollToIndex).toHaveBeenLastCalledWith(2, { align: "auto" });

    // A reload: nothing is revealed while the old rows are still shown, once when the new list has the row.
    let branches!: (v: unknown) => void;
    const result = vcsBranches.getMockImplementation()!();
    vcsBranches.mockImplementationOnce(() => new Promise((resolve) => (branches = resolve)));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await act(async () => {});
    expect(rowOf("initial import")).toBeTruthy();
    expect(scrollToIndex).toHaveBeenCalledTimes(2);
    await act(async () => branches(await result));
    await reloaded(4);
    expect(scrollToIndex).toHaveBeenCalledTimes(3);
  });
});

describe("Git Graph pseudo rows and panels", () => {
  it("shows uncommitted changes above HEAD and opens its menu", async () => {
    graphWorkingState.mockImplementation(() => ok({ staged: 1, unstaged: 2, untracked: 0, conflicted: 0 }));
    render(<GitGraphEditor />);
    await screen.findByText("Uncommitted Changes");
    const row = document.querySelector<HTMLElement>('[data-entry="*working*"]')!;
    expect(row.textContent).toContain("(3)");
    fireEvent.click(row);
    expect(await screen.findByText("Staged")).toBeTruthy();
    fireEvent.contextMenu(row);
    await waitFor(() =>
      expect(showContextMenu).toHaveBeenCalledWith(
        expect.anything(),
        expect.arrayContaining([expect.objectContaining({ kind: "action", action: "vcs.commit" })]),
      ),
    );
  });

  it("shows a stash above its base with apply and pop", async () => {
    graphStashes.mockImplementation(() =>
      ok([{ index: 0, id: "s".padEnd(40, "0"), base: "b".padEnd(40, "0"), message: "On main: wip", timeMs: 1 }]),
    );
    render(<GitGraphEditor />);
    await screen.findByText("On main: wip");
    const rows = within(screen.getByRole("grid", { name: "Commits" })).getAllByRole("row");
    expect(rows.map((r) => r.textContent).findIndex((t) => t?.includes("On main: wip"))).toBe(1);
    fireEvent.click(rowOf("On main: wip"));
    fireEvent.click(await screen.findByRole("button", { name: "Pop" }));
    expect(bridge.stashMenu).toHaveBeenCalledWith(0, "On main: wip", REPO);
    expect(popStash).toHaveBeenCalled();
  });

  it("switches the bottom pane to statistics", async () => {
    render(<GitGraphEditor />);
    await screen.findByText("subject a");
    fireEvent.click(screen.getByRole("tab", { name: "Statistics" }));
    expect(await screen.findByText("Commits: 3, authors: 1")).toBeTruthy();
  });

  it("keeps Reflog and Statistics shown while a vcs refresh reloads them (#375)", async () => {
    const refresh = () =>
      act(async () => {
        state = { ...state, version: state.version + 1 };
        listeners.forEach((fn) => fn());
      });
    render(<GitGraphEditor />);
    await screen.findByText("subject a");
    for (const [tab, load, shown] of [
      ["Statistics", graphAuthorStats, "Commits: 3, authors: 1"],
      ["Reflog", graphReflog, "commit: subject a"],
    ] as const) {
      fireEvent.click(screen.getByRole("tab", { name: tab }));
      const row = await screen.findByText(shown);
      // The reload is still running: the list stays instead of a spinner.
      let finish!: (v: unknown) => void;
      const result = load.getMockImplementation()!();
      load.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
      await refresh();
      expect(load).toHaveBeenCalledTimes(2);
      expect(screen.getByText(shown)).toBe(row);
      await act(async () => finish(await result));
      expect(screen.getByText(shown)).toBe(row);
    }
    // A refresh that changed the result still updates the panel.
    graphReflog.mockImplementation(() =>
      ok([{ selector: "HEAD@{0}", id: "d".padEnd(40, "0"), action: "reset", timeMs: 2 }]),
    );
    await refresh();
    expect(await screen.findByText("reset")).toBeTruthy();
  });

  it("does not lay the graph out again after a vcs refresh that changed nothing (#375)", async () => {
    const layout = vi.spyOn(bridge, "layout");
    try {
      render(<GitGraphEditor />);
      await screen.findByText("subject a");
      const refresh = () =>
        act(async () => {
          state = { ...state, version: state.version + 1 };
          listeners.forEach((fn) => fn());
        });
      await act(async () => {});
      const before = layout.mock.calls.length;
      await refresh();
      await waitFor(() => expect(graphWorkingState).toHaveBeenCalledTimes(2));
      await act(async () => {});
      expect(layout).toHaveBeenCalledTimes(before);
      // New uncommitted changes add their row.
      graphWorkingState.mockImplementation(() => ok({ staged: 0, unstaged: 1, untracked: 0, conflicted: 0 }));
      await refresh();
      await screen.findByText("Uncommitted Changes");
      expect(layout.mock.calls.length).toBeGreaterThan(before);
    } finally {
      layout.mockRestore();
    }
  });

  it("filters the repository dropdown by typing and picks with Enter", async () => {
    const roots = ["/work/app", "/work/billing-api", "/work/billing-web"];
    state = { ...state, roots, repo: roots[0]!, heads: { [roots[0]!]: state.heads[REPO]! } };
    render(<GitGraphEditor />);
    await screen.findByText("subject a");
    fireEvent.click(screen.getByRole("button", { name: "Repository" }));
    const search = await screen.findByRole("textbox", { name: "Search repositories" });
    const list = screen.getByRole("listbox", { name: "Repositories" });
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["app", "billing-api", "billing-web"]);
    fireEvent.change(search, { target: { value: "bweb" } });
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["billing-web"]);
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect(useGraphView.getState().repo).toBe("/work/billing-web"));
    expect(screen.queryByRole("listbox", { name: "Repositories" })).toBeNull();
  });

  it("pulls and pushes the repository picked in the toolbar, not the primary one (#361)", async () => {
    const roots = ["/work/app", "/work/lib"];
    state = { ...state, roots, repo: roots[0]!, heads: { [roots[1]!]: state.heads[REPO]! } };
    useGraphView.setState({ repo: roots[1]! });
    const run = vi.fn();
    const off = registerActions(
      ["vcs.fetch", "vcs.pull", "vcs.push"].map((id) => ({
        id,
        title: id,
        run: ({ arg }: { arg?: unknown }) => run(id, arg),
      })),
    );
    try {
      render(<GitGraphEditor />);
      await screen.findByText("subject a");
      fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
      fireEvent.click(screen.getByRole("button", { name: "Pull…" }));
      fireEvent.click(screen.getByRole("button", { name: "Push…" }));
      await waitFor(() => expect(run).toHaveBeenCalledTimes(3));
      expect(run).toHaveBeenCalledWith("vcs.fetch", { repo: "/work/lib" });
      expect(run).toHaveBeenCalledWith("vcs.pull", { repo: "/work/lib" });
      expect(run).toHaveBeenCalledWith("vcs.push", { repo: "/work/lib" });
    } finally {
      off();
    }
  });

  it("continues, aborts, stashes, rolls back and shows the log of the toolbar's repository (#367)", async () => {
    const roots = ["/work/app", "/work/lib"];
    const lib = roots[1]!;
    state = { ...state, roots, repo: roots[0]!, heads: { [lib]: state.heads[REPO]! }, operations: { [lib]: "rebase" } };
    useGraphView.setState({ repo: lib });
    graphWorkingState.mockImplementation(() => ok({ staged: 0, unstaged: 1, untracked: 0, conflicted: 0 }));
    render(<GitGraphEditor />);
    await screen.findByText("Uncommitted Changes");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(bridge.controlOperation).toHaveBeenLastCalledWith(lib, "continue", "rebase");
    fireEvent.click(screen.getByRole("button", { name: "Abort" }));
    expect(bridge.controlOperation).toHaveBeenLastCalledWith(lib, "abort", "rebase");
    fireEvent.click(screen.getByRole("button", { name: "Show Git Log" }));
    expect(bridge.showLog).toHaveBeenCalledWith(lib);
    fireEvent.click(document.querySelector<HTMLElement>('[data-entry="*working*"]')!);
    fireEvent.click(await screen.findByRole("button", { name: "Stash Changes…" }));
    expect(bridge.stashChanges).toHaveBeenCalledWith(lib);
    fireEvent.click(screen.getByRole("button", { name: "Rollback…" }));
    expect(bridge.rollback).toHaveBeenCalledWith(lib);
    // The row's own menu does the same.
    fireEvent.contextMenu(document.querySelector<HTMLElement>('[data-entry="*working*"]')!);
    await waitFor(() => expect(showContextMenu).toHaveBeenCalled());
    const items = showContextMenu.mock.calls.at(-1)![1] as Array<{ label?: string; run?: () => void }>;
    items.find((i) => i.label === "Stash Changes…")!.run!();
    items.find((i) => i.label === "Rollback…")!.run!();
    expect(bridge.stashChanges).toHaveBeenCalledTimes(2);
    expect(bridge.rollback).toHaveBeenCalledTimes(2);

    state = { ...state, operations: { [lib]: "merge" } };
    await act(async () => listeners.forEach((fn) => fn()));
    fireEvent.click(screen.getByRole("button", { name: "Resolve Conflicts…" }));
    expect(bridge.resolveConflicts).toHaveBeenCalledWith(lib);
  });
});

describe("Git Graph PR view", () => {
  const MB = "m".padEnd(40, "0");
  const showDiff = vi.fn(({ input }: { input: EditorInput }) => <div data-testid="embedded-diff">{input.key}</div>);

  beforeEach(() => {
    state = { ...state, heads: { [REPO]: { head: "feature", headCommit: "a".padEnd(40, "0") } } };
    vcsBranches.mockImplementation(() =>
      ok([
        branch("feature", { current: true }),
        branch("main"),
        branch("origin/HEAD", { remote: true }),
        branch("origin/main", { remote: true }),
      ]),
    );
    vcsMergeBase.mockImplementation(() => ok(MB));
    vcsDiffRevisions.mockImplementation(() =>
      ok([
        { path: "src/app.ts", kind: "modified", oldPath: null },
        { path: "src/new.ts", kind: "renamed", oldPath: "src/old.ts" },
      ]),
    );
    vcsLog.mockImplementation((_repo: string, q: { range?: string | null }) =>
      q.range === "main..feature"
        ? ok([commit("f2", ["f1"], { summary: "second change" }), commit("f1", [MB], { summary: "first change" })])
        : q.range === "feature..main"
          ? ok([commit("x", [MB])])
          : ok([commit("a", ["b"], { refs: ["HEAD", "feature"] }), commit("b", [])]),
    );
    useContributions.setState({
      editorKinds: new Map([["diff", { kind: "diff", component: showDiff, title: () => "diff" }]]),
    });
  });

  afterEach(() => {
    useContributions.setState({ editorKinds: new Map() });
  });

  const openPr = async () => {
    render(<GitGraphEditor />);
    fireEvent.click(screen.getByRole("tab", { name: "PR" }));
    return screen.findByText(/ ahead, /);
  };

  it("switches between the graph and the PR view, keeping the shared toolbar actions", async () => {
    render(<GitGraphEditor />);
    await screen.findByText("subject a");
    expect(screen.getByRole("tab", { name: "Graph" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "PR" }));
    expect(useGraphView.getState().mode).toBe("pr");
    expect(screen.queryByRole("grid", { name: "Commits" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Branches" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Find commit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show Remote Branches" })).toBeNull();
    for (const name of ["Refresh", "Fetch", "Pull…", "Push…", "Commit…", "Show Git Log"])
      expect(screen.getByRole("button", { name })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Graph" }));
    expect(await screen.findByRole("grid", { name: "Commits" })).toBeTruthy();
  });

  it("compares the current branch into main by default, three-dot from the merge base", async () => {
    const summary = await openPr();
    expect(summary.textContent).toBe("Commits: 2 ahead, 1 behind main");
    expect(screen.getByRole("button", { name: "Base Branch" }).textContent).toBe("main");
    expect(screen.getByRole("button", { name: "Head Branch" }).textContent).toBe("feature");
    expect(vcsMergeBase).toHaveBeenCalledWith(REPO, "main", "feature");
    expect(vcsDiffRevisions).toHaveBeenCalledWith(REPO, MB, "feature");
    // Grouped by directory (#226): the folder, then its files with the rename's source.
    const files = screen.getByRole("tree", { name: "Changed Files" });
    expect(
      within(files)
        .getAllByRole("treeitem")
        .map((f) => f.textContent),
    ).toEqual(["src2 files", "app.ts", "new.tsrenamed from old.ts"]);
    // The first file's diff is embedded: merge base on the left, head on the right.
    expect(screen.getByTestId("embedded-diff").textContent).toBe(`${MB}:feature:src/app.ts`);
    expect(bridge.revisionDiffInput).toHaveBeenLastCalledWith(
      REPO,
      { rev: MB, label: "merge-base (main)" },
      { rev: "feature", label: "feature" },
      expect.objectContaining({ path: "src/app.ts" }),
      // The tree's files are the chain, so F7 past the last difference moves along the tree.
      expect.objectContaining({
        files: [expect.objectContaining({ path: "src/app.ts" }), expect.objectContaining({ path: "src/new.ts" })],
      }),
    );
    // F7 past the last difference: the host moves the tree's selection to the next file.
    const nav = bridge.revisionDiffInput.mock.lastCall![4]!;
    act(() => nav.onNeighbour(nav.files[1]!, "first"));
    expect(screen.getByTestId("embedded-diff").textContent).toBe(`${MB}:feature:src/new.ts`);
    expect(within(files).getByText("new.ts").closest("[role=treeitem]")).toHaveAttribute("aria-selected", "true");
    expect(bridge.revisionDiffInput.mock.lastCall![4]!.reveal).toBe("first");
    // Picking files in the tree drops the pending reveal: back on new.ts, nothing is selected or focused.
    fireEvent.mouseDown(within(files).getByText("app.ts"));
    fireEvent.mouseDown(within(files).getByText("new.ts"));
    expect(bridge.revisionDiffInput.mock.lastCall![4]!.reveal).toBeUndefined();
    act(() => nav.onNeighbour(nav.files[0]!, "last"));
    // A directory row takes the selection; the diff keeps showing the last file.
    fireEvent.mouseDown(within(files).getByText("src"));
    expect(within(files).getByText("src").closest("[role=treeitem]")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("embedded-diff").textContent).toBe(`${MB}:feature:src/app.ts`);
    fireEvent.mouseDown(within(files).getByText("app.ts"));
    const firstViewer = screen.getByTestId("embedded-diff");
    fireEvent.mouseDown(within(files).getByText("new.ts"));
    expect(screen.getByTestId("embedded-diff").textContent).toBe(`${MB}:feature:src/new.ts`);
    // Another file mounts a fresh viewer instead of rebuilding the previous one (#226).
    expect(screen.getByTestId("embedded-diff")).not.toBe(firstViewer);
    fireEvent.doubleClick(within(files).getByText("new.ts"));
    expect(bridge.openRevisionDiff).toHaveBeenCalledWith(
      REPO,
      { rev: MB, label: "merge-base (main)" },
      { rev: "feature", label: "feature" },
      expect.any(Array),
      1,
    );
  });

  it("keeps the embedded diff's input across a vcs refresh that changed nothing (#362)", async () => {
    await openPr();
    await screen.findByTestId("embedded-diff");
    const inputs = () => showDiff.mock.calls.map(([p]) => p.input);
    const before = inputs().at(-1);
    const loads = vcsDiffRevisions.mock.calls.length;
    await act(async () => {
      state = { ...state, version: state.version + 1 };
      listeners.forEach((fn) => fn());
    });
    await waitFor(() => expect(vcsDiffRevisions.mock.calls.length).toBeGreaterThan(loads));
    await act(async () => {});
    expect(new Set(inputs().slice(inputs().indexOf(before!)))).toEqual(new Set([before]));
    // A refresh that changed the pull request still updates the diff.
    vcsDiffRevisions.mockImplementation(() => ok([{ path: "src/app.ts", kind: "added", oldPath: null }]));
    await act(async () => {
      state = { ...state, version: state.version + 1 };
      listeners.forEach((fn) => fn());
    });
    await waitFor(() => expect(inputs().at(-1)).not.toBe(before));
  });

  it("copies the changed files from the merge base with ClipCode", async () => {
    await openPr();
    fireEvent.click(screen.getByRole("button", { name: "ClipCode: Copy Changed Files" }));
    expect(bridge.copyRange).toHaveBeenCalledWith(REPO, MB, "f2".padEnd(40, "0"));
  });

  it("filters the base picker by typing, grouped HEAD / Local / Remote / Tags", async () => {
    await openPr();
    fireEvent.click(screen.getByRole("button", { name: "Base Branch" }));
    const search = await screen.findByRole("textbox", { name: "Search branches and tags" });
    const list = screen.getByRole("listbox", { name: "Branches and Tags" });
    const options = () =>
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent);
    // origin/HEAD is an alias, not a branch to compare with.
    expect(options()).toEqual(["HEAD", "feature", "main", "origin/main", "v1"]);
    for (const section of ["Local", "Remote", "Tags"]) expect(within(list).getByText(section)).toBeTruthy();
    fireEvent.change(search, { target: { value: "v1" } });
    expect(options()).toEqual(["v1"]);
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect(useGraphView.getState().pr[REPO]?.base).toBe("v1"));
    await waitFor(() => expect(vcsMergeBase).toHaveBeenLastCalledWith(REPO, "v1", "feature"));
  });

  it("swaps base and head", async () => {
    await openPr();
    fireEvent.click(screen.getByRole("button", { name: "Swap Base and Head" }));
    expect(useGraphView.getState().pr[REPO]).toMatchObject({ base: "feature", head: "main" });
    await waitFor(() => expect(vcsMergeBase).toHaveBeenLastCalledWith(REPO, "feature", "main"));
  });

  it("asks for a base when no default branch exists", async () => {
    vcsBranches.mockImplementation(() => ok([branch("feature", { current: true })]));
    render(<GitGraphEditor />);
    fireEvent.click(screen.getByRole("tab", { name: "PR" }));
    expect(await screen.findByText("Choose a base branch to compare")).toBeTruthy();
    expect(vcsMergeBase).not.toHaveBeenCalled();
  });

  it("says when the branches share no history instead of diffing them directly", async () => {
    vcsMergeBase.mockImplementation(() => ok(null));
    render(<GitGraphEditor />);
    fireEvent.click(screen.getByRole("tab", { name: "PR" }));
    expect(await screen.findByText("No common history")).toBeTruthy();
    expect(screen.getByText("main and feature have no common commit to compare from.")).toBeTruthy();
    expect(vcsDiffRevisions).not.toHaveBeenCalled();
  });

  it("shows an empty state for the same branch and an inline error on failure", async () => {
    useGraphView.setState({ pr: { [REPO]: { base: "feature", head: null, tab: "files", file: null } } });
    render(<GitGraphEditor />);
    fireEvent.click(screen.getByRole("tab", { name: "PR" }));
    expect(await screen.findByText("Base and head are the same")).toBeTruthy();
    vcsMergeBase.mockImplementation(() => Promise.resolve({ status: "error", error: { message: "bad revision" } }));
    act(() => useGraphView.setState({ pr: { [REPO]: { base: "nope", head: null, tab: "files", file: null } } }));
    expect((await screen.findByRole("alert")).textContent).toContain("bad revision");
  });

  it("lists the commits and shows one in the graph", async () => {
    await openPr();
    fireEvent.click(screen.getByRole("tab", { name: /Commits/ }));
    const list = screen.getByRole("listbox", { name: "Commits" });
    expect(
      within(list)
        .getAllByRole("option")
        .map((b) => b.textContent),
    ).toEqual([expect.stringContaining("second change"), expect.stringContaining("first change")]);
    fireEvent.click(within(list).getByText("first change"));
    expect(useGraphView.getState()).toMatchObject({
      mode: "graph",
      selection: { repo: REPO, ids: ["f1".padEnd(40, "0")] },
    });
  });

  it("keeps each repository's base and head apart", async () => {
    const OTHER = "/other";
    state = { ...state, roots: [REPO, OTHER], heads: { ...state.heads, [OTHER]: { head: "dev", headCommit: null } } };
    vcsBranches.mockImplementation((repo: string) =>
      repo === OTHER
        ? ok([branch("dev", { current: true }), branch("master")])
        : ok([branch("feature", { current: true }), branch("main")]),
    );
    useGraphView.setState({ pr: { [REPO]: { base: "v1", head: "main", tab: "files", file: null } } });
    render(<GitGraphEditor />);
    fireEvent.click(screen.getByRole("tab", { name: "PR" }));
    await waitFor(() => expect(vcsMergeBase).toHaveBeenLastCalledWith(REPO, "v1", "main"));
    act(() => useGraphView.setState({ repo: OTHER }));
    await waitFor(() => expect(vcsMergeBase).toHaveBeenLastCalledWith(OTHER, "master", "dev"));
    expect(screen.getByRole("button", { name: "Base Branch" }).textContent).toBe("master");
    expect(useGraphView.getState().pr[REPO]).toMatchObject({ base: "v1", head: "main" });
    expect(useGraphView.getState().pr[OTHER]).toBeUndefined();
  });
});

describe("PR view defaults", () => {
  it("heads from the current branch into main, master or develop, else a remote one, else none", () => {
    expect(defaultPrRefs([branch("feature"), branch("master"), branch("develop")], "feature")).toEqual({
      base: "master",
      head: "feature",
    });
    expect(defaultPrRefs([branch("main"), branch("develop")], "main")).toEqual({ base: "develop", head: "main" });
    expect(defaultPrRefs([branch("x"), branch("origin/main", { remote: true })], null)).toEqual({
      base: "origin/main",
      head: "HEAD",
    });
    expect(defaultPrRefs([branch("x")], "x")).toEqual({ base: null, head: "x" });
  });
});

describe("graph data helpers", () => {
  it("walks local branches only when remotes are hidden", () => {
    const branches = [branch("main"), branch("origin/main", { remote: true })];
    expect(logBranches({ branches: [], showRemotes: true }, branches)).toEqual([]);
    expect(logBranches({ branches: [], showRemotes: false }, branches)).toEqual(["HEAD", "main"]);
    expect(logBranches({ branches: ["dev"], showRemotes: false }, branches)).toEqual(["dev"]);
  });

  it("matches message, author and hash prefix", () => {
    const commits = [commit("abc", []), commit("def", [], { author: "Zed" })].map((c) => ({ ...c, repo: REPO }));
    expect(findMatches(commits, "zed")).toEqual([1]);
    expect(findMatches(commits, "abc")).toEqual([0]);
    expect(findMatches(commits, "  ")).toEqual([]);
  });
});
