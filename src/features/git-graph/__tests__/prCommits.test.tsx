import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { Branch, Commit } from "@/bindings";

// The real virtualizer: these tests pin which rows are mounted and how scrolling / keys move through them.
const vcsBranches = vi.fn();
const vcsTags = vi.fn();
const vcsMergeBase = vi.fn();
const vcsDiffRevisions = vi.fn();
const vcsLog = vi.fn();
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsBranches: (repo: string) => vcsBranches(repo),
      vcsTags: (repo: string) => vcsTags(repo),
      vcsMergeBase: (repo: string, a: string, b: string) => vcsMergeBase(repo, a, b),
      vcsDiffRevisions: (repo: string, from: string, to: string) => vcsDiffRevisions(repo, from, to),
      vcsLog: (repo: string, q: unknown) => vcsLog(repo, q),
    },
  };
});

import { provideGitGraphBridge, type GitGraphBridge } from "@/workbench/gitGraphBridge";
import { PrView } from "../PrView";
import { initialGraphView, useGraphView } from "../viewState";

const REPO = "/repo";
const MB = "m".padEnd(40, "0");
const ok = <T,>(data: T) => Promise.resolve({ status: "ok" as const, data });

const branch = (name: string, current = false): Branch => ({
  name,
  remote: false,
  current,
  upstream: null,
  ahead: 0,
  behind: 0,
  lastCommitMs: 0,
});

const commitsOf = (n: number): Commit[] =>
  Array.from({ length: n }, (_, i) => {
    const id = i.toString(16).padStart(40, "0");
    return {
      id,
      shortId: id.slice(-8),
      parents: [],
      author: `Author ${i % 5}`,
      email: `dev${i % 5}@example.com`,
      timeMs: i === 0 ? 0 : 1_700_000_000_000 - i * 86_400_000,
      summary: `commit ${i}`,
      message: `commit ${i}`,
      refs: [],
    };
  });

const realScrollTo = Element.prototype.scrollTo;
const contentHeight = (el: Element) =>
  parseFloat((el.querySelector("[role=presentation]") as HTMLElement | null)?.style.height ?? "") + 8 || 600;

let withdraw: () => void;

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return contentHeight(this);
    },
  });
  Element.prototype.scrollTo = function (this: Element, options?: ScrollToOptions | number) {
    if (typeof options !== "object" || options.top === undefined) return;
    this.scrollTop = Math.max(0, Math.min(options.top, contentHeight(this) - 600));
    this.dispatchEvent(new Event("scroll"));
  } as Element["scrollTo"];
  vcsBranches.mockImplementation(() => ok([branch("feature", true), branch("main")]));
  vcsTags.mockImplementation(() => ok([]));
  vcsMergeBase.mockImplementation(() => ok(MB));
  vcsDiffRevisions.mockImplementation(() => ok([]));
  withdraw = provideGitGraphBridge({} as GitGraphBridge);
  useGraphView.setState({
    ...initialGraphView(),
    mode: "pr",
    pr: { [REPO]: { base: "main", head: "feature", tab: "commits", file: null } },
  });
});

afterEach(() => {
  Element.prototype.scrollTo = realScrollTo;
  delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
  withdraw();
  vi.clearAllMocks();
});

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {});
};

const setupCommits = (commits: Commit[]) => {
  vcsLog.mockImplementation((_repo: string, q: { range?: string | null }) =>
    q.range === "main..feature" ? ok(commits) : ok([]),
  );
};

const currentRow = (list: Element) => {
  const id = list.getAttribute("aria-activedescendant");
  const row = id ? document.getElementById(id) : null;
  if (row) {
    expect(row.getAttribute("aria-selected")).toBe("true");
    const selected = within(list as HTMLElement)
      .queryAllByRole("option")
      .filter((r) => r.getAttribute("aria-selected") === "true");
    expect(selected).toEqual([row]);
  }
  return row;
};

describe("PR Commits virtualization", () => {
  it("keeps mounted rows bounded instead of growing with commit count", async () => {
    const small = commitsOf(1_000);
    setupCommits(small);
    const first = render(<PrView repo={REPO} current="feature" version={0} reload={0} />);
    await flush();
    const smallList = screen.getByLabelText("Commits");
    const smallMounted = smallList.querySelectorAll('[title="Show in Graph"]').length;
    first.unmount();

    const large = commitsOf(10_000);
    setupCommits(large);
    render(<PrView repo={REPO} current="feature" version={0} reload={1} />);
    await flush();
    const largeList = screen.getByLabelText("Commits");
    const largeMounted = largeList.querySelectorAll('[title="Show in Graph"]').length;

    expect(smallMounted).toBeGreaterThan(0);
    expect(smallMounted).toBeLessThan(100);
    expect(largeMounted).toBeGreaterThan(0);
    expect(largeMounted).toBeLessThan(100);
    expect(Math.abs(largeMounted - smallMounted)).toBeLessThan(10);
  });

  it("scrolls through 10,000 commits in order, reaches the last row, and reveals it in the graph", async () => {
    const commits = commitsOf(10_000);
    setupCommits(commits);
    render(<PrView repo={REPO} current="feature" version={0} reload={0} />);
    await flush();

    const list = screen.getByRole("listbox", { name: "Commits" });
    const rows = () => within(list).queryAllByRole("option");
    expect(rows()[0]!.textContent).toContain("commit 0");
    expect(rows()[0]!.getAttribute("aria-setsize")).toBe("10000");
    expect(rows()[0]!.getAttribute("aria-posinset")).toBe("1");

    // Scroll to the middle and check ordering.
    list.scrollTop = 5_000 * 24;
    fireEvent.scroll(list);
    await flush();
    const midIndexes = rows().map((r) => Number(r.getAttribute("aria-posinset")));
    expect(midIndexes[0]).toBeGreaterThan(4_900);
    expect(midIndexes[midIndexes.length - 1]).toBeLessThan(5_100);
    for (let i = 1; i < midIndexes.length; i++) expect(midIndexes[i]).toBe(midIndexes[i - 1]! + 1);

    // Scroll to the bottom: the last commit is mounted, selectable and clickable.
    list.scrollTop = 10_000 * 24;
    fireEvent.scroll(list);
    await flush();
    const lastRow = rows().at(-1)!;
    expect(lastRow.getAttribute("aria-posinset")).toBe("10000");
    expect(lastRow.textContent).toContain("commit 9999");
    expect(lastRow.textContent).toContain(commits[9_999]!.shortId);

    fireEvent.click(lastRow);
    expect(useGraphView.getState()).toMatchObject({
      mode: "graph",
      selection: { repo: REPO, ids: [commits[9_999]!.id] },
      panel: "details",
    });
  });

  it("supports keyboard navigation across unmounted rows with aria-activedescendant", async () => {
    const commits = commitsOf(10_000);
    setupCommits(commits);
    render(<PrView repo={REPO} current="feature" version={0} reload={0} />);
    await flush();

    const list = screen.getByRole("listbox", { name: "Commits" });
    act(() => list.focus());
    expect(document.activeElement).toBe(list);
    expect(currentRow(list)!.textContent).toContain("commit 0");

    fireEvent.keyDown(list, { key: "ArrowDown" });
    await flush();
    expect(currentRow(list)!.textContent).toContain("commit 1");

    fireEvent.keyDown(list, { key: "End" });
    await flush();
    expect(document.activeElement).toBe(list);
    expect(currentRow(list)!.textContent).toContain("commit 9999");
    expect(currentRow(list)!.getAttribute("aria-posinset")).toBe("10000");

    fireEvent.keyDown(list, { key: "ArrowUp" });
    await flush();
    expect(currentRow(list)!.textContent).toContain("commit 9998");

    fireEvent.keyDown(list, { key: "Home" });
    await flush();
    expect(currentRow(list)!.textContent).toContain("commit 0");

    // Wheel-scrolling the active row out of view: first Enter reveals it instead of switching tabs.
    list.scrollTop = 5_000 * 24;
    fireEvent.scroll(list);
    await flush();
    expect(list.getAttribute("aria-activedescendant")).toBeNull();
    fireEvent.keyDown(list, { key: "Enter" });
    await flush();
    expect(useGraphView.getState().mode).toBe("pr");
    expect(currentRow(list)!.textContent).toContain("commit 0");

    // Second Enter on the visible row reveals it in the graph.
    fireEvent.keyDown(list, { key: "Enter" });
    expect(useGraphView.getState()).toMatchObject({
      mode: "graph",
      selection: { repo: REPO, ids: [commits[0]!.id] },
      panel: "details",
    });
  });

  it("Space reveals the current commit like Enter and does not scroll the list", async () => {
    const commits = commitsOf(50);
    setupCommits(commits);
    render(<PrView repo={REPO} current="feature" version={0} reload={0} />);
    await flush();
    const list = screen.getByRole("listbox", { name: "Commits" });
    act(() => list.focus());
    const notPrevented = fireEvent.keyDown(list, { key: " ", code: "Space" });
    expect(notPrevented).toBe(false);
    expect(useGraphView.getState()).toMatchObject({
      mode: "graph",
      selection: { repo: REPO, ids: [commits[0]!.id] },
      panel: "details",
    });
  });

  it("ignores auto-repeating Space so holding it cannot scroll back and then reveal", async () => {
    setupCommits(commitsOf(10_000));
    render(<PrView repo={REPO} current="feature" version={0} reload={0} />);
    await flush();
    const list = screen.getByRole("listbox", { name: "Commits" });
    act(() => list.focus());
    list.scrollTop = 5_000 * 24;
    fireEvent.scroll(list);
    await flush();
    fireEvent.keyDown(list, { key: " " });
    await flush();
    expect(useGraphView.getState().mode).toBe("pr");
    fireEvent.keyDown(list, { key: " ", repeat: true });
    expect(useGraphView.getState().mode).toBe("pr");
  });

  it("shows empty state when there are no commits", async () => {
    setupCommits([]);
    render(<PrView repo={REPO} current="feature" version={0} reload={0} />);
    await flush();
    expect(screen.getByText("No commits")).toBeTruthy();
    expect(screen.queryByRole("listbox", { name: "Commits" })).toBeNull();
  });

  it("picks a visible commit when Tab focuses the list after wheel scrolling", async () => {
    const commits = commitsOf(2_000);
    setupCommits(commits);
    render(<PrView repo={REPO} current="feature" version={0} reload={0} />);
    await flush();

    const list = screen.getByRole("listbox", { name: "Commits" });
    list.scrollTop = 1_000 * 24 + 10;
    fireEvent.scroll(list);
    await flush();

    act(() => list.focus());
    const row = currentRow(list)!;
    const index = Number(row.getAttribute("aria-posinset")) - 1;
    const first = Math.floor((list.scrollTop - 4) / 24);
    const last = Math.floor((list.scrollTop + 600 - 4) / 24);
    expect(index).toBeGreaterThanOrEqual(first);
    expect(index).toBeLessThanOrEqual(last);
    expect(row.className).toMatch(/selected/);

    fireEvent.keyDown(list, { key: "Enter" });
    expect(useGraphView.getState()).toMatchObject({
      mode: "graph",
      selection: { repo: REPO, ids: [commits[index]!.id] },
      panel: "details",
    });
  });

  it("preserves commit metadata and resets scroll and selection when refs change", async () => {
    const initial = commitsOf(200);
    const swapped = commitsOf(3);
    vcsLog.mockImplementation((_repo: string, q: { range?: string | null }) =>
      q.range === "main..feature" ? ok(initial) : q.range === "feature..main" ? ok(swapped) : ok([]),
    );
    render(<PrView repo={REPO} current="feature" version={0} reload={0} />);
    await flush();

    const list = screen.getByRole("listbox", { name: "Commits" });
    const firstRow = within(list).getAllByRole("option")[0]!;
    // commit 0 has timeMs: 0 -> empty date cell, author and shortId intact.
    const cells = [...firstRow.querySelectorAll("span")].map((s) => s.textContent);
    expect(cells).toEqual(["commit 0", "Author 0", "", initial[0]!.shortId]);

    // Move to the last row of the 200-commit list, then swap base and head (3 commits).
    act(() => list.focus());
    fireEvent.keyDown(list, { key: "End" });
    await flush();
    expect(currentRow(list)!.getAttribute("aria-posinset")).toBe("200");

    fireEvent.click(screen.getByRole("button", { name: "Swap Base and Head" }));
    await flush();
    const swappedList = screen.getByRole("listbox", { name: "Commits" });
    expect(swappedList.scrollTop).toBe(0);
    expect(swappedList.getAttribute("aria-activedescendant")).toBeNull();
    expect(within(swappedList).getAllByRole("option")).toHaveLength(3);
  });
});
