import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { Branch, ChangedFile, Commit } from "@/bindings";
import type { EditorInput } from "@/workbench/contributions";

const vcsBranches = vi.fn();
const vcsTags = vi.fn();
const vcsMergeBase = vi.fn();
const vcsDiffRevisions = vi.fn();
const vcsLog = vi.fn();
const graphRevCounts = vi.fn();

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
      graphRevCounts: (repo: string, base: string, head: string) => graphRevCounts(repo, base, head),
    },
  };
});

import { useContributions } from "@/workbench/contributions";
import { provideGitGraphBridge, type GitGraphBridge, type GraphRevisionSide } from "@/workbench/gitGraphBridge";
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

const commit = (id: string, summary: string, timeMs = 1_700_000_000_000): Commit => {
  const full = id.padStart(40, "0");
  return {
    id: full,
    shortId: full.slice(-8),
    parents: [],
    author: "Ann",
    email: "ann@example.com",
    timeMs,
    summary,
    message: summary,
    refs: [],
  };
};

const commitsOf = (n: number): Commit[] =>
  Array.from({ length: n }, (_, i) => commit(i.toString(16), `commit ${i}`, 1_700_000_000_000 - i * 86_400_000));

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
  withdraw = provideGitGraphBridge({
    revisionDiffInput: (repo: string, from: GraphRevisionSide, to: GraphRevisionSide, file: ChangedFile) => ({
      kind: "diff",
      key: `${repo}:${from.rev}:${to.rev}:${file.path}`,
      title: file.path,
    }),
  } as unknown as GitGraphBridge);
  useGraphView.setState({
    ...initialGraphView(),
    mode: "pr",
    pr: { [REPO]: { base: "main", head: "feature", tab: "commits", file: null } },
  });
});

afterEach(() => {
  Element.prototype.scrollTo = realScrollTo;
  delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
  useContributions.setState({ editorKinds: new Map() });
  withdraw();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {});
};

const setupPr = (aheadCommits: Commit[], behindCount: number, files: ChangedFile[] = []) => {
  vcsDiffRevisions.mockImplementation(() => ok(files.map((f) => ({ ...f }))));
  graphRevCounts.mockImplementation((_repo: string, base: string, head: string) =>
    base === "main" && head === "feature"
      ? ok({ ahead: aheadCommits.length, behind: behindCount })
      : ok({ ahead: behindCount, behind: aheadCommits.length }),
  );
  vcsLog.mockImplementation((_repo: string, q: { range?: string | null; skip: number; limit: number }) => {
    if (q.range === "main..feature") {
      return ok(aheadCommits.slice(q.skip, q.limit > 0 ? q.skip + q.limit : undefined));
    }
    return ok([]);
  });
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

describe("PR refresh and paging", () => {
  it("counts ahead/behind via graphRevCounts without materializing the behind commit list or using limit:0", async () => {
    const ahead = commitsOf(1_000);
    setupPr(ahead, 100_000);
    const { rerender } = render(<PrView repo={REPO} current="feature" version={0} reload={0} />);
    await flush();

    expect(screen.getByRole("status").textContent).toBe("Commits: 1000 ahead, 100000 behind main");
    expect(graphRevCounts).toHaveBeenCalledWith(REPO, "main", "feature");

    // Never fetch the behind side (feature..main) and never pass limit:0 to vcsLog.
    const logQueries = vcsLog.mock.calls.map(([, q]) => q as { range?: string | null; skip: number; limit: number });
    expect(logQueries.some((q) => q.range === "feature..main")).toBe(false);
    expect(logQueries.some((q) => q.limit === 0)).toBe(false);
    expect(logQueries).toHaveLength(1);
    expect(logQueries[0]).toMatchObject({ range: "main..feature", skip: 0 });
    expect(logQueries[0]!.limit).toBeGreaterThan(0);
    expect(logQueries[0]!.limit).toBeLessThan(1_000);

    // Refresh repeats only the count + first page, never fetching behind commits.
    vcsLog.mockClear();
    graphRevCounts.mockClear();
    rerender(<PrView repo={REPO} current="feature" version={1} reload={0} />);
    await flush();
    expect(graphRevCounts).toHaveBeenCalledTimes(1);
    const refreshQueries = vcsLog.mock.calls.map(
      ([, q]) => q as { range?: string | null; skip: number; limit: number },
    );
    expect(refreshQueries).toHaveLength(1);
    expect(refreshQueries[0]).toMatchObject({ range: "main..feature", skip: 0 });
    expect(refreshQueries[0]!.limit).toBeGreaterThan(0);
  });

  it("loads Commits pages incrementally on scroll while keeping all 1,000 commits reachable", async () => {
    const ahead = commitsOf(1_000);
    setupPr(ahead, 50_000);
    render(<PrView repo={REPO} current="feature" version={0} reload={0} />);
    await flush();

    // Only the first page was fetched initially.
    expect(vcsLog).toHaveBeenCalledTimes(1);
    const list = screen.getByRole("listbox", { name: "Commits" });
    const rows = () => within(list).queryAllByRole("option");
    expect(rows()[0]!.getAttribute("aria-setsize")).toBe("1000");
    expect(rows()[0]!.textContent).toContain("commit 0");

    // Scroll to the middle: fetches the covering page and shows commit 500 in order.
    list.scrollTop = 500 * 24;
    fireEvent.scroll(list);
    await flush();
    expect(rows().some((r) => r.textContent?.includes("commit 500"))).toBe(true);

    // Scroll to the bottom: fetches the last page and reaches commit 999.
    list.scrollTop = 1_000 * 24;
    fireEvent.scroll(list);
    await flush();
    const lastRow = rows().at(-1)!;
    expect(lastRow.getAttribute("aria-posinset")).toBe("1000");
    expect(lastRow.textContent).toContain("commit 999");

    fireEvent.click(lastRow);
    expect(useGraphView.getState()).toMatchObject({
      mode: "graph",
      selection: { repo: REPO, ids: [ahead[999]!.id] },
      panel: "details",
    });
  });

  it("compares refresh results without JSON.stringify while preserving unchanged diff inputs and updating on changes", async () => {
    const showDiff = vi.fn(({ input }: { input: EditorInput }) => <div data-testid="embedded-diff">{input.key}</div>);
    useContributions.setState({
      editorKinds: new Map([["diff", { kind: "diff", component: showDiff, title: () => "diff" }]]),
    });
    useGraphView.setState({
      ...initialGraphView(),
      mode: "pr",
      pr: { [REPO]: { base: "main", head: "feature", tab: "files", file: null } },
    });

    const ahead = commitsOf(500);
    const files: ChangedFile[] = [{ path: "src/app.ts", kind: "modified", oldPath: null }];
    setupPr(ahead, 100_000, files);

    const { rerender } = render(<PrView repo={REPO} current="feature" version={0} reload={0} />);
    await flush();
    expect(screen.getByTestId("embedded-diff")).toBeTruthy();
    const beforeInput = showDiff.mock.calls.at(-1)?.[0].input;

    const stringifySpy = vi.spyOn(JSON, "stringify");
    const prStringifyCalls = () =>
      stringifySpy.mock.calls.filter(([arg]) => {
        if (!arg || typeof arg !== "object") return false;
        const rec = arg as Record<string, unknown>;
        return "mergeBase" in rec || "commits" in rec || "behind" in rec;
      });
    rerender(<PrView repo={REPO} current="feature" version={1} reload={0} />);
    await flush();

    // Unchanged refresh must not call JSON.stringify on the PR payload and must keep the same diff input.
    expect(prStringifyCalls()).toHaveLength(0);
    expect(showDiff.mock.calls.at(-1)?.[0].input).toBe(beforeInput);

    // Changing behind count updates the status without calling JSON.stringify.
    setupPr(ahead, 100_001, files);
    rerender(<PrView repo={REPO} current="feature" version={2} reload={0} />);
    await flush();
    expect(prStringifyCalls()).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toBe("Commits: 500 ahead, 100001 behind main");

    // Changing file metadata updates the embedded diff input.
    setupPr(ahead, 100_001, [{ path: "src/app.ts", kind: "added", oldPath: null }]);
    rerender(<PrView repo={REPO} current="feature" version={3} reload={0} />);
    await flush();
    expect(prStringifyCalls()).toHaveLength(0);
    expect(showDiff.mock.calls.at(-1)?.[0].input).not.toBe(beforeInput);
  });
});

describe("PR Commits selection stability across refreshes", () => {
  it("keeps the selected commit highlighted and revealed by Enter when a refresh inserts a commit at the front", async () => {
    const c1 = commit("1", "first change");
    const c2 = commit("2", "second change");
    const c3 = commit("3", "third change");
    setupPr([c1, c2, c3], 0);

    const { rerender } = render(<PrView repo={REPO} current="feature" version={0} reload={0} />);
    await flush();

    const list = screen.getByRole("listbox", { name: "Commits" });
    act(() => list.focus());
    fireEvent.keyDown(list, { key: "ArrowDown" });
    await flush();
    expect(currentRow(list)!.textContent).toContain("second change");
    expect(currentRow(list)!.getAttribute("aria-posinset")).toBe("2");

    // Same-branch refresh inserts a brand-new commit at the front.
    const c0 = commit("a", "brand new head commit");
    setupPr([c0, c1, c2, c3], 0);
    rerender(<PrView repo={REPO} current="feature" version={1} reload={0} />);
    await flush();

    expect(currentRow(list)!.textContent).toContain("second change");
    expect(currentRow(list)!.getAttribute("aria-posinset")).toBe("3");

    fireEvent.keyDown(list, { key: "Enter" });
    expect(useGraphView.getState()).toMatchObject({
      mode: "graph",
      selection: { repo: REPO, ids: [c2.id] },
      panel: "details",
    });
  });

  it("keeps Space revealing the same commit after a front-insert refresh and clears selection when the commit disappears", async () => {
    const c1 = commit("1", "first change");
    const c2 = commit("2", "second change");
    const c3 = commit("3", "third change");
    setupPr([c1, c2, c3], 0);

    const { rerender } = render(<PrView repo={REPO} current="feature" version={0} reload={0} />);
    await flush();

    const list = screen.getByRole("listbox", { name: "Commits" });
    act(() => list.focus());
    fireEvent.keyDown(list, { key: "ArrowDown" });
    await flush();
    expect(currentRow(list)!.textContent).toContain("second change");

    // Insert a commit at the front -> Space must still reveal c2.
    const c0 = commit("b", "prepended commit");
    setupPr([c0, c1, c2, c3], 0);
    rerender(<PrView repo={REPO} current="feature" version={1} reload={0} />);
    await flush();

    fireEvent.keyDown(list, { key: " ", code: "Space" });
    expect(useGraphView.getState()).toMatchObject({
      mode: "graph",
      selection: { repo: REPO, ids: [c2.id] },
      panel: "details",
    });

    // Return to PR mode and drop c2 on the next refresh -> selection clears and Enter/Space do nothing.
    act(() => useGraphView.setState({ mode: "pr", selection: { repo: null, ids: [] } }));
    setupPr([c0, c1, c3], 0);
    rerender(<PrView repo={REPO} current="feature" version={2} reload={0} />);
    await flush();

    expect(list.getAttribute("aria-activedescendant")).toBeNull();
    expect(
      within(list)
        .queryAllByRole("option")
        .filter((r) => r.getAttribute("aria-selected") === "true"),
    ).toHaveLength(0);
    fireEvent.keyDown(list, { key: "Enter" });
    fireEvent.keyDown(list, { key: " ", code: "Space" });
    expect(useGraphView.getState().mode).toBe("pr");
  });

  it("preserves selection by id across a front-insert refresh even on a later loaded page", async () => {
    const initial = commitsOf(1_000);
    setupPr(initial, 50_000);

    const { rerender } = render(<PrView repo={REPO} current="feature" version={0} reload={0} />);
    await flush();

    const list = screen.getByRole("listbox", { name: "Commits" });
    // Scroll into page 1 (around commit 350) and focus so a visible commit on page 1 becomes selected.
    list.scrollTop = 350 * 24;
    fireEvent.scroll(list);
    await flush();
    act(() => list.focus());
    const pickedBefore = currentRow(list)!;
    const pickedIndex = Number(pickedBefore.getAttribute("aria-posinset")) - 1;
    expect(pickedIndex).toBeGreaterThanOrEqual(340);
    const pickedCommit = initial[pickedIndex]!;
    expect(pickedBefore.textContent).toContain(pickedCommit.summary);

    // Same-branch refresh prepends one new commit at index 0.
    const headNew = commit("ff", "newly pushed commit");
    setupPr([headNew, ...initial], 50_000);
    rerender(<PrView repo={REPO} current="feature" version={1} reload={0} />);
    await flush();

    const pickedAfter = currentRow(list)!;
    expect(pickedAfter.textContent).toContain(pickedCommit.summary);
    expect(Number(pickedAfter.getAttribute("aria-posinset")) - 1).toBe(pickedIndex + 1);

    fireEvent.keyDown(list, { key: "Enter" });
    expect(useGraphView.getState()).toMatchObject({
      mode: "graph",
      selection: { repo: REPO, ids: [pickedCommit.id] },
      panel: "details",
    });
  });

  it("keeps loaded commit pages and off-screen selection across a base-only refresh (behind 0->5)", async () => {
    const commits = commitsOf(2_000);
    setupPr(commits, 0);

    const { rerender } = render(<PrView repo={REPO} current="feature" version={0} reload={0} />);
    await flush();
    expect(screen.getByRole("status").textContent).toBe("Commits: 2000 ahead, 0 behind main");

    // Select commit 1999 (on page 6).
    const list = screen.getByRole("listbox", { name: "Commits" });
    act(() => list.focus());
    fireEvent.keyDown(list, { key: "End" });
    await flush();
    expect(currentRow(list)!.textContent).toContain("commit 1999");
    expect(currentRow(list)!.getAttribute("aria-posinset")).toBe("2000");

    // Scroll back to the top so commit 1999 is off-screen.
    list.scrollTop = 0;
    fireEvent.scroll(list);
    await flush();
    expect(list.getAttribute("aria-activedescendant")).toBeNull();

    // Base-only refresh: behind changes 0 -> 5 while mergeBase, ahead, and commits stay the same.
    vcsLog.mockClear();
    setupPr(commits, 5);
    rerender(<PrView repo={REPO} current="feature" version={1} reload={0} />);
    await flush();
    expect(screen.getByRole("status").textContent).toBe("Commits: 2000 ahead, 5 behind main");

    // Only page 0 was fetched by the refresh; cached extra pages were not discarded or refetched.
    expect(vcsLog).toHaveBeenCalledTimes(1);
    expect(vcsLog.mock.calls[0]![1]).toMatchObject({ range: "main..feature", skip: 0 });

    // First Enter brings commit 1999 back into view immediately (no skeleton, no refetch).
    vcsLog.mockClear();
    fireEvent.keyDown(list, { key: "Enter" });
    await flush();
    expect(useGraphView.getState().mode).toBe("pr");
    const revealed = currentRow(list);
    expect(revealed).not.toBeNull();
    expect(revealed!.getAttribute("aria-busy")).toBeNull();
    expect(revealed!.textContent).toContain("commit 1999");
    expect(revealed!.getAttribute("aria-posinset")).toBe("2000");
    expect(vcsLog).not.toHaveBeenCalled();

    // Second Enter opens commit 1999 in the graph.
    fireEvent.keyDown(list, { key: "Enter" });
    expect(useGraphView.getState()).toMatchObject({
      mode: "graph",
      selection: { repo: REPO, ids: [commits[1_999]!.id] },
      panel: "details",
    });
  });

  it("keeps visible later-page rows and selection intact without aria-busy flash on files/behind-only refreshes", async () => {
    const commits = commitsOf(2_000);
    setupPr(commits, 0, [{ path: "src/a.ts", kind: "modified", oldPath: null }]);

    const { rerender } = render(<PrView repo={REPO} current="feature" version={0} reload={0} />);
    await flush();

    const list = screen.getByRole("listbox", { name: "Commits" });
    act(() => list.focus());
    fireEvent.keyDown(list, { key: "End" });
    await flush();
    expect(currentRow(list)!.textContent).toContain("commit 1999");

    // Refresh updates both behind and files while mergeBase, ahead, and commits match.
    vcsLog.mockClear();
    setupPr(commits, 3, [{ path: "src/a.ts", kind: "added", oldPath: null }]);
    rerender(<PrView repo={REPO} current="feature" version={1} reload={0} />);
    await flush();

    expect(screen.getByRole("status").textContent).toBe("Commits: 2000 ahead, 3 behind main");
    expect(
      within(list)
        .queryAllByRole("option")
        .some((r) => r.getAttribute("aria-busy") === "true"),
    ).toBe(false);
    expect(currentRow(list)!.textContent).toContain("commit 1999");
    expect(vcsLog).toHaveBeenCalledTimes(1);
    expect(vcsLog.mock.calls[0]![1]).toMatchObject({ range: "main..feature", skip: 0 });

    fireEvent.keyDown(list, { key: " ", code: "Space" });
    expect(useGraphView.getState()).toMatchObject({
      mode: "graph",
      selection: { repo: REPO, ids: [commits[1_999]!.id] },
      panel: "details",
    });
  });
});
