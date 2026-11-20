import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ChangedFile, Commit } from "@/bindings";

// The real virtualizer: these tests are about which rows are mounted.
const vcsCommitFiles = vi.fn();
const graphTree = vi.fn();
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsCommitFiles: (repo: string, id: string) => vcsCommitFiles(repo, id),
      graphTree: (repo: string, rev: string) => graphTree(repo, rev),
    },
  };
});

import { provideGitGraphBridge, type GitGraphBridge, type GraphCommit } from "@/workbench/gitGraphBridge";
import { CommitDetails } from "../Details";
import { SELECTION_DELAY, TreePanel } from "../panels";

const REPO = "/repo";
const commit = (id: string): GraphCommit =>
  ({
    id: id.padEnd(40, "0"),
    shortId: id.padEnd(8, "0"),
    parents: [],
    author: "Ann",
    email: "ann@example.com",
    timeMs: 1,
    summary: `subject ${id}`,
    message: `subject ${id}`,
    refs: [],
    repo: REPO,
  }) as Commit as GraphCommit;
const filesOf = (prefix: string, n: number): ChangedFile[] =>
  Array.from({ length: n }, (_, i) => ({ path: `${prefix}/f${i}.ts`, kind: "modified", oldPath: null }));

/** A response the test resolves when it likes. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve: (data: T) => resolve({ status: "ok", data } as T) };
}

const openDiff = vi.fn(() => Promise.resolve());
let withdraw: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  withdraw = provideGitGraphBridge({ openDiff, refLabels: () => [] } as unknown as GitGraphBridge);
});
afterEach(() => {
  withdraw();
  vi.useRealTimers();
  vi.clearAllMocks();
});

/** Runs due timers and lets resolved IPC promises reach React. */
const flush = async (ms = 0) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
  await act(async () => {});
};

const details = (c: GraphCommit) => (
  <CommitDetails commits={[c]} stash={null} onJump={() => {}} remoteBranches={new Set()} />
);
const fileRows = () => within(screen.getByRole("list", { name: "Changed Files" })).queryAllByRole("listitem");

describe("Git Graph changed files", () => {
  it("mounts only a window of rows for a large commit", async () => {
    vcsCommitFiles.mockImplementation(() => Promise.resolve({ status: "ok", data: filesOf("a", 2000) }));
    render(details(commit("a")));
    await flush();
    const rows = fileRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(100);
    expect(rows[0]!.getAttribute("aria-setsize")).toBe("2000");
    // The window follows the scroll position.
    const list = screen.getByRole("list", { name: "Changed Files" });
    list.scrollTop = 1000 * 24;
    fireEvent.scroll(list);
    await flush();
    const first = Number(fileRows()[0]!.getAttribute("aria-posinset"));
    expect(first).toBeGreaterThan(900);
    expect(fileRows().length).toBeLessThan(100);
    list.scrollTop = 0;
    fireEvent.scroll(list);
    await flush();
    fireEvent.click(fileRows()[0]!);
    expect(openDiff).toHaveBeenCalledWith(expect.objectContaining({ id: commit("a").id }), expect.any(Array), 0, true);
  });

  it("keeps the previous files, dimmed and inert, while the next commit's load", async () => {
    const next = deferred<unknown>();
    vcsCommitFiles.mockImplementation((_repo: string, id: string) =>
      id === commit("a").id ? Promise.resolve({ status: "ok", data: filesOf("a", 3) }) : next.promise,
    );
    const view = render(details(commit("a")));
    await flush();
    expect(fileRows()).toHaveLength(3);

    view.rerender(details(commit("b")));
    await flush(SELECTION_DELAY);
    const list = screen.getByRole("list", { name: "Changed Files" });
    expect(list.getAttribute("aria-busy")).toBe("true");
    expect(fileRows()).toHaveLength(3);
    fireEvent.click(fileRows()[0]!);
    fireEvent.doubleClick(fileRows()[0]!);
    expect(openDiff).not.toHaveBeenCalled();

    next.resolve(filesOf("b", 2));
    await flush();
    expect(list.getAttribute("aria-busy")).toBeNull();
    expect(fileRows().map((r) => r.title)).toEqual(["b/f0.ts", "b/f1.ts"]);
  });

  it("sends one request for the last of several quick selections", async () => {
    vcsCommitFiles.mockImplementation(() => Promise.resolve({ status: "ok", data: filesOf("x", 1) }));
    const view = render(details(commit("a")));
    await flush();
    expect(vcsCommitFiles).toHaveBeenCalledTimes(1);
    for (const id of ["b", "c", "d", "e"]) {
      view.rerender(details(commit(id)));
      await flush(SELECTION_DELAY / 4);
    }
    expect(vcsCommitFiles).toHaveBeenCalledTimes(1);
    await flush(SELECTION_DELAY);
    expect(vcsCommitFiles).toHaveBeenCalledTimes(2);
    expect(vcsCommitFiles).toHaveBeenLastCalledWith(REPO, commit("e").id);
  });

  it("loads at once when the selection was idle", async () => {
    vcsCommitFiles.mockImplementation(() => Promise.resolve({ status: "ok", data: filesOf("x", 1) }));
    const view = render(details(commit("a")));
    await flush();
    await flush(SELECTION_DELAY * 3);
    view.rerender(details(commit("b")));
    await flush();
    expect(vcsCommitFiles).toHaveBeenCalledTimes(2);
    expect(vcsCommitFiles).toHaveBeenLastCalledWith(REPO, commit("b").id);
  });

  it("ignores a response for a selection that is no longer current", async () => {
    const pending = new Map<string, ReturnType<typeof deferred<unknown>>>();
    vcsCommitFiles.mockImplementation((_repo: string, id: string) => {
      const d = deferred<unknown>();
      pending.set(id, d);
      return d.promise;
    });
    const view = render(details(commit("a")));
    await flush();
    pending.get(commit("a").id)!.resolve(filesOf("a", 1));
    await flush();
    view.rerender(details(commit("b")));
    await flush(SELECTION_DELAY);
    view.rerender(details(commit("c")));
    await flush(SELECTION_DELAY);
    expect([...pending.keys()]).toEqual([commit("a").id, commit("b").id, commit("c").id]);

    pending.get(commit("c").id)!.resolve(filesOf("c", 1));
    await flush();
    pending.get(commit("b").id)!.resolve(filesOf("b", 1));
    await flush();
    expect(fileRows().map((r) => r.title)).toEqual(["c/f0.ts"]);
    expect(screen.getByRole("list", { name: "Changed Files" }).getAttribute("aria-busy")).toBeNull();
  });
});

describe("Git Graph file tree", () => {
  it("mounts only a window of rows and keeps the previous revision's while the next loads", async () => {
    const next = deferred<unknown>();
    graphTree.mockImplementation((_repo: string, rev: string) =>
      rev === "r1"
        ? Promise.resolve({
            status: "ok",
            data: Array.from({ length: 2000 }, (_, i) => ({ path: `src/f${i}.ts`, kind: "blob", size: 1 })),
          })
        : next.promise,
    );
    const onOpen = vi.fn();
    const view = render(<TreePanel repo={REPO} rev="r1" onOpen={onOpen} />);
    await flush();
    const list = screen.getByRole("list", { name: "Files at Revision" });
    const rows = () => within(list).queryAllByRole("listitem");
    expect(screen.getByText("2000 files")).toBeTruthy();
    expect(rows().length).toBeGreaterThan(0);
    expect(rows().length).toBeLessThan(100);

    view.rerender(<TreePanel repo={REPO} rev="r2" onOpen={onOpen} />);
    await flush(SELECTION_DELAY);
    expect(list.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByText("2000 files")).toBeNull();
    fireEvent.doubleClick(rows()[0]!);
    expect(onOpen).not.toHaveBeenCalled();

    next.resolve([{ path: "lib/a.ts", kind: "blob", size: 1 }]);
    await flush();
    expect(list.getAttribute("aria-busy")).toBeNull();
    expect(rows().map((r) => r.title)).toEqual(["lib/a.ts"]);
    fireEvent.doubleClick(rows()[0]!);
    expect(onOpen).toHaveBeenCalledWith("lib/a.ts");
  });
});
