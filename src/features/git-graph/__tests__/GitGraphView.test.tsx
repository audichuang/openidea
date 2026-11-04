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
    },
  };
});

const showContextMenu = vi.fn();
vi.mock("@/ui", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/ui")>();
  return { ...real, showContextMenu: (at: unknown, items: MenuItem[]) => showContextMenu(at, items) };
});

import { provideGitGraphBridge, type GitGraphBridge, type GitGraphRepoState } from "@/workbench/gitGraphBridge";
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
  filesMenu: vi.fn(async () => [{ label: "File Item" }] as MenuItem[]),
  openDiff: vi.fn(async () => {}),
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
