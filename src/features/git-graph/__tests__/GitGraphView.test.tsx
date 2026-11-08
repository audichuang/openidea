import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Branch, Commit } from "@/bindings";
import type { MenuItem } from "@/ui";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 24,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 24, key: index })),
    scrollToIndex: () => {},
  }),
}));

const vcsLog = vi.fn();
const vcsBranches = vi.fn();
const vcsTags = vi.fn();
const vcsCommitFiles = vi.fn();
const graphStashes = vi.fn();
const graphWorkingState = vi.fn();
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
      vcsRemotes: () => Promise.resolve({ status: "ok", data: [] }),
      graphStashes: (repo: string) => graphStashes(repo),
      graphWorkingState: (repo: string) => graphWorkingState(repo),
      graphAuthorStats: () =>
        Promise.resolve({ status: "ok", data: [{ name: "Ann", email: "ann@example.com", commits: 3 }] }),
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
} from "@/workbench/gitGraphBridge";
import { GitGraphEditor } from "../GitGraphView";
import { findMatches, logBranches } from "../data";
import { initialGraphView, useGraphView } from "../viewState";

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
  stashMenu: vi.fn(() => [{ label: "Apply" }, { label: "Pop", run: popStash }] as MenuItem[]),
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
  graphStashes.mockImplementation(() => ok([]));
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
    expect(useGraphView.getState().branchFilter).toEqual(["main"]);
    expect(screen.queryByRole("dialog", { name: "Branch filter" })).toBeNull();
    // Picking a selected branch again takes it out of the filter.
    fireEvent.click(button);
    fireEvent.click(await screen.findByRole("button", { name: "pick main" }));
    expect(useGraphView.getState().branchFilter).toEqual([]);
    fireEvent.click(button);
    fireEvent.click(await screen.findByRole("button", { name: "pick many" }));
    expect(useGraphView.getState().branchFilter).toEqual(["HEAD", "origin/main"]);
    fireEvent.click(screen.getByRole("button", { name: "Show All Branches" }));
    expect(useGraphView.getState().branchFilter).toEqual([]);
    const remotes = screen.getByRole("button", { name: "Show Remote Branches" });
    expect(remotes.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(remotes);
    expect(useGraphView.getState().showRemotes).toBe(false);
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
