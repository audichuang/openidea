import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ChangedFile, Commit, GraphTreeEntry } from "@/bindings";

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

/** A press of a click: `detail` counts the presses, as a browser's mousedown does. */
const press = (el: Element, detail = 1) => {
  fireEvent.mouseDown(el, { detail });
  fireEvent.mouseUp(el, { detail });
  fireEvent.click(el, { detail });
};
const doubleClick = (el: Element) => {
  press(el, 1);
  press(el, 2);
  fireEvent.doubleClick(el, { detail: 2 });
};
/**
 * Releases a press begun on `pressed` over `under`, as a browser does: the click goes to the node
 * that holds both, or to the list when the pressed node left the page.
 */
const release = (pressed: Element, under: Element, list: Element) => {
  fireEvent.mouseUp(under, { detail: 1 });
  let target: Element | null = pressed.isConnected ? pressed : list;
  while (target && !target.contains(under)) target = target.parentElement;
  fireEvent.click(target ?? list, { detail: 1 });
};
/** The second press of a double-click whose first was released by `release`: it lands on `under`. */
const pressAgain = (under: Element) => {
  press(under, 2);
  fireEvent.doubleClick(under, { detail: 2 });
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
    press(fileRows()[0]!);
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
    expect(fileRows()[0]!.closest("[inert]")).not.toBeNull();
    doubleClick(fileRows()[0]!);
    fireEvent.keyDown(list, { key: "Home" });
    fireEvent.keyDown(list, { key: "Enter" });
    expect(openDiff).not.toHaveBeenCalled();

    next.resolve(filesOf("b", 2));
    await flush();
    expect(list.getAttribute("aria-busy")).toBeNull();
    expect(fileRows()[0]!.closest("[inert]")).toBeNull();
    expect(fileRows().map((r) => r.title)).toEqual(["b/f0.ts", "b/f1.ts"]);
  });

  it("does not let a press begun on the previous commit's rows open the next commit's file", async () => {
    const next = deferred<unknown>();
    vcsCommitFiles.mockImplementation((_repo: string, id: string) =>
      id === commit("a").id ? Promise.resolve({ status: "ok", data: filesOf("x", 3) }) : next.promise,
    );
    const view = render(details(commit("a")));
    await flush();
    view.rerender(details(commit("b")));
    await flush(SELECTION_DELAY);
    const list = screen.getByRole("list", { name: "Changed Files" });
    const pressed = fileRows()[0]!;
    fireEvent.mouseDown(pressed, { detail: 1 });

    // B has a file at the same path, so a row keyed by path alone would be the same node.
    next.resolve(filesOf("x", 3));
    await flush();
    expect(list.getAttribute("aria-busy")).toBeNull();
    release(pressed, fileRows()[0]!, list);
    expect(openDiff).not.toHaveBeenCalled();

    // The second press is a click of its own on the new row, which previews it; the double-click
    // that began on the old rows doesn't open it.
    pressAgain(fileRows()[0]!);
    expect(openDiff).toHaveBeenCalledTimes(1);
    expect(openDiff).toHaveBeenCalledWith(expect.objectContaining({ id: commit("b").id }), expect.any(Array), 0, true);

    openDiff.mockClear();
    doubleClick(fileRows()[0]!);
    expect(openDiff).toHaveBeenLastCalledWith(expect.objectContaining({ id: commit("b").id }), expect.any(Array), 0);
  });

  it("keeps keyboard focus on the list while keys move past unmounted rows", async () => {
    vcsCommitFiles.mockImplementation(() => Promise.resolve({ status: "ok", data: filesOf("a", 2000) }));
    render(details(commit("a")));
    await flush();
    const list = screen.getByRole("list", { name: "Changed Files" });
    // Tabbing in starts at the first file, as when each file was its own tab stop.
    act(() => list.focus());
    fireEvent.keyDown(list, { key: "Enter" });
    expect(openDiff).toHaveBeenLastCalledWith(expect.objectContaining({ id: commit("a").id }), expect.any(Array), 0);
    openDiff.mockClear();

    fireEvent.keyDown(list, { key: "End" });
    await flush();
    expect(document.activeElement).toBe(list);
    fireEvent.keyDown(list, { key: "Enter" });
    expect(openDiff).toHaveBeenLastCalledWith(expect.objectContaining({ id: commit("a").id }), expect.any(Array), 1999);

    fireEvent.keyDown(list, { key: "ArrowUp" });
    fireEvent.keyDown(list, { key: "Enter" });
    expect(openDiff).toHaveBeenLastCalledWith(expect.anything(), expect.any(Array), 1998);
    fireEvent.keyDown(list, { key: "Home" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "Enter" });
    expect(openDiff).toHaveBeenLastCalledWith(expect.anything(), expect.any(Array), 1);
  });

  it("does not move the active row to the first file when a press focuses the list", async () => {
    vcsCommitFiles.mockImplementation(() => Promise.resolve({ status: "ok", data: filesOf("a", 5) }));
    render(details(commit("a")));
    await flush();
    const list = screen.getByRole("list", { name: "Changed Files" });
    fireEvent.mouseDown(fileRows()[3]!, { detail: 1 });
    act(() => list.focus());
    expect(fileRows().some((r) => /selected/.test(r.className))).toBe(false);
    fireEvent.click(fileRows()[3]!, { detail: 1 });
    expect(fileRows()[3]!.className).toMatch(/selected/);
    fireEvent.keyDown(list, { key: "Enter" });
    expect(openDiff).toHaveBeenLastCalledWith(expect.anything(), expect.any(Array), 3);
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
    expect(rows()[0]!.closest("[inert]")).not.toBeNull();
    expect(screen.queryByText("2000 files")).toBeNull();
    doubleClick(rows()[0]!);
    fireEvent.keyDown(list, { key: "Home" });
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onOpen).not.toHaveBeenCalled();

    next.resolve([{ path: "lib/a.ts", kind: "blob", size: 1 }]);
    await flush();
    expect(list.getAttribute("aria-busy")).toBeNull();
    expect(rows()[0]!.closest("[inert]")).toBeNull();
    expect(rows().map((r) => r.title)).toEqual(["lib/a.ts"]);
    doubleClick(rows()[0]!);
    expect(onOpen).toHaveBeenCalledWith("lib/a.ts");
  });

  const tree = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ path: `src/f${i}.ts`, kind: "blob", size: 1 }) as GraphTreeEntry);

  it("does not let a press begun on the previous revision's rows open the next revision's file", async () => {
    const next = deferred<unknown>();
    graphTree.mockImplementation((_repo: string, rev: string) =>
      rev === "r1" ? Promise.resolve({ status: "ok", data: tree(3) }) : next.promise,
    );
    const onOpen = vi.fn();
    const view = render(<TreePanel repo={REPO} rev="r1" onOpen={onOpen} />);
    await flush();
    view.rerender(<TreePanel repo={REPO} rev="r2" onOpen={onOpen} />);
    await flush(SELECTION_DELAY);
    const list = screen.getByRole("list", { name: "Files at Revision" });
    const rows = () => within(list).queryAllByRole("listitem");
    const pressed = rows()[0]!;
    fireEvent.mouseDown(pressed, { detail: 1 });

    next.resolve(tree(3));
    await flush();
    expect(list.getAttribute("aria-busy")).toBeNull();
    release(pressed, rows()[0]!, list);
    pressAgain(rows()[0]!);
    expect(onOpen).not.toHaveBeenCalled();

    doubleClick(rows()[0]!);
    expect(onOpen).toHaveBeenCalledWith("src/f0.ts");
  });

  it("keeps keyboard focus on the list while keys move past unmounted rows", async () => {
    graphTree.mockImplementation(() => Promise.resolve({ status: "ok", data: tree(2000) }));
    const onOpen = vi.fn();
    render(<TreePanel repo={REPO} rev="r1" onOpen={onOpen} />);
    await flush();
    const list = screen.getByRole("list", { name: "Files at Revision" });
    act(() => list.focus());
    expect(document.activeElement).toBe(list);
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onOpen).toHaveBeenLastCalledWith("src/f0.ts");

    fireEvent.keyDown(list, { key: "End" });
    await flush();
    expect(document.activeElement).toBe(list);
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onOpen).toHaveBeenLastCalledWith("src/f1999.ts");
    fireEvent.keyDown(list, { key: "ArrowUp" });
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onOpen).toHaveBeenLastCalledWith("src/f1998.ts");

    // The filter starts the active row over.
    fireEvent.change(screen.getByLabelText("Filter files"), { target: { value: "f19" } });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onOpen).toHaveBeenLastCalledWith("src/f19.ts");
  });
});
