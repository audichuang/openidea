import type { Commit } from "@/bindings";
import { usePlatform } from "@/platform/platformInfo";
import { copyMenuFor, useContextMenuStore } from "@/ui";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const keyCalls = vi.hoisted(() => ({ count: 0 }));
const formatCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("../multiRoot", async (original) => {
  const real = await original<typeof import("../multiRoot")>();
  return {
    ...real,
    commitKey: (...args: Parameters<typeof real.commitKey>) => {
      keyCalls.count++;
      return real.commitKey(...args);
    },
  };
});

vi.mock("../log/CommitMessage", async (original) => {
  const real = await original<typeof import("../log/CommitMessage")>();
  return {
    ...real,
    compactCommitText: (...args: Parameters<typeof real.compactCommitText>) => {
      formatCalls.count++;
      return real.compactCommitText(...args);
    },
  };
});

const api = vi.hoisted(() => ({
  commitsChanges: vi.fn(),
  commitFiles: vi.fn(),
  detailsBatch: vi.fn(),
  writeClipboardText: vi.fn(),
}));

vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsCommitsChanges: (...args: unknown[]) => api.commitsChanges(...args),
      vcsCommitFiles: (...args: unknown[]) => api.commitFiles(...args),
      vcsLogDetailsBatch: (...args: unknown[]) => api.detailsBatch(...args),
      vcsConfigGet: () => Promise.resolve({ status: "ok", data: null }),
    },
  };
});

vi.mock("@/platform/clipboard", () => ({
  writeClipboardText: (text: string) => api.writeClipboardText(text),
}));

import { CommitDetails } from "../log/CommitDetails";
import { DEFAULT_LOG_OPTIONS, useLogOptions } from "../logOptions";
import { emptyFilters, useGitLog } from "../logStore";
import { commitKey, type RepoCommit } from "../multiRoot";
import { useVcs } from "../store";

function makeCommit(i: number, total: number, repo?: string): RepoCommit {
  const id = (i + 1).toString(16).padStart(40, "0");
  const parent = i + 1 < total ? [(i + 2).toString(16).padStart(40, "0")] : [];
  const summary =
    i % 3 === 0
      ? `feat(log): commit ${i} with a longer subject line that wraps across multiple lines in a narrow details pane`
      : `fix(log): commit ${i}`;
  return {
    id,
    shortId: id.slice(-8),
    parents: parent,
    refs: i === 0 ? ["HEAD -> main"] : i % 50 === 0 ? [`tag: v0.${i}`] : [],
    author: `Author ${i % 5}`,
    email: `author${i % 5}@example.com`,
    timeMs: Date.UTC(2026, 0, 1) - i * 60_000,
    summary,
    message: `${summary}\n\nDetailed body for commit ${i}`,
    ...(repo ? { repo } : {}),
  };
}

function makeCommits(count: number, repo?: string): RepoCommit[] {
  return Array.from({ length: count }, (_, i) => makeCommit(i, count, repo));
}

function messageBoxOf(container: HTMLElement): HTMLElement {
  const box = container.querySelector<HTMLElement>('[class*="messageBox"]');
  if (!box) throw new Error("messageBox not found");
  return box;
}

function mountedMessageButtons(container: HTMLElement): HTMLElement[] {
  return [...messageBoxOf(container).querySelectorAll<HTMLElement>('button[title="Copy revision number"]')];
}

beforeEach(() => {
  api.commitsChanges.mockReset().mockResolvedValue({
    status: "ok",
    data: [
      { path: "src/alpha.ts", kind: "modified", oldPath: null, before: "base", after: "head" },
      { path: "src/beta.ts", kind: "added", oldPath: null, before: null, after: "head" },
    ],
  });
  api.commitFiles.mockReset().mockResolvedValue({
    status: "ok",
    data: [{ path: "src/single.ts", kind: "modified", oldPath: null }],
  });
  api.detailsBatch.mockReset().mockImplementation(async (_repo: string, ids: string[]) => ({
    status: "ok",
    data: ids.map((id) => ({
      message: `Full message for ${id}\n\nBody paragraph loaded on demand`,
      containingBranches: ["main"],
      signature: "G",
      signer: "Author 0",
      key: "KEY",
      fingerprint: "FP",
    })),
  }));
  api.writeClipboardText.mockReset().mockResolvedValue(undefined);
  useVcs.setState({
    root: "/repo",
    repo: "/repo",
    roots: ["/repo"],
    available: true,
    version: useVcs.getState().version + 1,
  });
  useGitLog.setState({
    shownLog: "log",
    tab: "log",
    commits: [],
    selection: [],
    selected: null,
    filters: emptyFilters(),
  });
  useLogOptions.setState({ ...DEFAULT_LOG_OPTIONS });
  usePlatform.setState({ os: "macos" });
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  useContextMenuStore.setState({ menu: null });
  useGitLog.setState({ commits: [], selection: [], selected: null, filters: emptyFilters() });
  useLogOptions.setState({ ...DEFAULT_LOG_OPTIONS });
  usePlatform.setState({ os: "macos" });
});

describe("CommitDetails multi-selection virtualization", () => {
  it("keeps mounted CommitMessage count bounded instead of growing with selection size", () => {
    const small = makeCommits(200);
    const smallKeys = small.map(commitKey);
    useGitLog.setState({ commits: small, selected: smallKeys[0]!, selection: smallKeys });
    const first = render(<CommitDetails commits={small} />);
    const mountedAt200 = mountedMessageButtons(first.container).length;
    first.unmount();

    const large = makeCommits(2_000);
    const largeKeys = large.map(commitKey);
    useGitLog.setState({ commits: large, selected: largeKeys[0]!, selection: largeKeys });
    const second = render(<CommitDetails commits={large} />);
    const mountedAt2000 = mountedMessageButtons(second.container).length;

    expect(mountedAt200).toBeGreaterThan(0);
    expect(mountedAt200).toBeLessThan(40);
    expect(mountedAt2000).toBeLessThan(40);
    // Mounted count must stay roughly constant between 200 and 2,000 selected commits.
    expect(Math.abs(mountedAt2000 - mountedAt200)).toBeLessThanOrEqual(4);
  });

  it("reaches the last selected commit out of 10,000 by scrolling while keeping mounted count bounded", () => {
    const commits = makeCommits(10_000);
    const keys = commits.map(commitKey);
    useGitLog.setState({ commits, selected: keys[0]!, selection: keys });
    const { container } = render(<CommitDetails commits={commits} />);

    const box = messageBoxOf(container);
    expect(box.textContent).toContain("commit 0");
    expect(box.textContent).not.toContain("commit 9999");
    expect(mountedMessageButtons(container).length).toBeLessThan(40);

    const list = box.firstElementChild as HTMLElement;
    const totalHeight = parseFloat(list.style.height);
    expect(totalHeight).toBeGreaterThan(100_000);

    // Scroll to the very bottom to reach the last selected commit.
    act(() => {
      box.scrollTop = totalHeight;
      fireEvent.scroll(box);
    });
    expect(box.textContent).toContain("commit 9999");
    expect(box.textContent).not.toContain("commit 0");
    expect(mountedMessageButtons(container).length).toBeLessThan(40);

    // Scroll back to the top and verify the first commit returns.
    act(() => {
      box.scrollTop = 0;
      fireEvent.scroll(box);
    });
    expect(box.textContent).toContain("commit 0");
  });

  it.each([2_000, 10_000])("does not rescan all %i rows on each scroll while heights are unchanged", (count) => {
    const raw = makeCommits(count);
    const keys = raw.map(commitKey);
    useGitLog.setState({ commits: raw, selected: keys[0]!, selection: keys });
    const { container } = render(<CommitDetails commits={raw} />);
    const box = messageBoxOf(container);

    keyCalls.count = 0;
    for (let i = 1; i <= 10; i++) {
      act(() => {
        box.scrollTop = i * 500;
        fireEvent.scroll(box);
      });
    }
    // A stable getItemKey keeps the measurement cache; an inline one re-reads every row per scroll.
    expect(keyCalls.count).toBeLessThan(count);
  });

  it("measures variable-height commit messages and positions items without overlap", () => {
    const commits = makeCommits(40);
    const keys = commits.map(commitKey);
    useGitLog.setState({ commits, selected: keys[0]!, selection: keys });

    const heightForIndex = (index: number) => (index % 2 === 0 ? 136 : 74);
    const origRect = Element.prototype.getBoundingClientRect;
    const origOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const idx = this.getAttribute("data-index");
      if (idx != null) return new DOMRect(0, 0, 360, heightForIndex(Number(idx)));
      return origRect.call(this);
    });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) {
        const idx = this.getAttribute("data-index");
        if (idx != null) return heightForIndex(Number(idx));
        return origOffsetHeight?.get?.call(this) ?? 600;
      },
    });

    try {
      const { container } = render(<CommitDetails commits={commits} />);
      const box = messageBoxOf(container);
      const items = [...box.querySelectorAll<HTMLElement>("[data-index]")];
      expect(items.length).toBeGreaterThan(3);

      const yOf = (el: HTMLElement) => {
        const m = /translateY\(([-\d.]+)px\)/.exec(el.style.transform);
        return m ? Number(m[1]) : NaN;
      };

      expect(yOf(items[0]!)).toBe(0);
      for (let i = 1; i < Math.min(items.length, 6); i++) {
        const prevIndex = Number(items[i - 1]!.dataset.index);
        expect(yOf(items[i]!)).toBe(yOf(items[i - 1]!) + heightForIndex(prevIndex));
      }
    } finally {
      if (origOffsetHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", origOffsetHeight);
      vi.restoreAllMocks();
    }
  });

  it("preserves order, copy-hash, text selection, and combined changed-files view for multi-selection", async () => {
    const commits = makeCommits(500);
    const keys = commits.map(commitKey);
    useGitLog.setState({ commits, selected: keys[0]!, selection: keys });
    const { container } = render(<CommitDetails commits={commits} />);

    // Combined changed-files view calls vcsCommitsChanges with oldest-first commit IDs.
    expect(await screen.findByText("alpha.ts")).toBeInTheDocument();
    expect(screen.getByText("beta.ts")).toBeInTheDocument();
    expect(screen.getByText("2 files in 500 commits")).toBeInTheDocument();
    expect(api.commitsChanges).toHaveBeenCalledTimes(1);
    const [, passedIds] = api.commitsChanges.mock.calls[0] as [string | null, string[]];
    expect(passedIds).toHaveLength(500);
    expect(passedIds[0]).toBe(commits[499]!.id);
    expect(passedIds[499]).toBe(commits[0]!.id);

    // Order is newest first; hash button copies the full revision id.
    const buttons = mountedMessageButtons(container);
    expect(buttons[0]!.textContent).toBe(commits[0]!.shortId);
    expect(buttons[1]!.textContent).toBe(commits[1]!.shortId);
    fireEvent.click(buttons[0]!);
    expect(api.writeClipboardText).toHaveBeenCalledWith(commits[0]!.id);

    // Selected text inside a virtualized commit message is copyable via the standard copy menu.
    const box = messageBoxOf(container);
    const subjectEl = box.querySelector<HTMLElement>('[class*="subjectLine"]')!;
    const range = document.createRange();
    range.selectNodeContents(subjectEl);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const menu = copyMenuFor(subjectEl);
    expect(menu?.[0]).toMatchObject({ id: "copy", disabled: false });

    // Scroll to the last selected commit and verify its hash is also copyable.
    const list = box.firstElementChild as HTMLElement;
    act(() => {
      box.scrollTop = parseFloat(list.style.height);
      fireEvent.scroll(box);
    });
    const lastButtons = mountedMessageButtons(container);
    const lastBtn = lastButtons.find((b) => b.textContent === commits[499]!.shortId);
    expect(lastBtn).toBeDefined();
    fireEvent.click(lastBtn!);
    expect(api.writeClipboardText).toHaveBeenLastCalledWith(commits[499]!.id);
  });

  it("keeps single-commit details unchanged with full body, branches, and signature", async () => {
    const commits: Commit[] = [makeCommit(0, 2), makeCommit(1, 2)];
    const key0 = commitKey(commits[0]!);
    useGitLog.setState({ commits, selected: key0, selection: [key0] });
    render(<CommitDetails commits={commits} />);

    expect(await screen.findByText("single.ts")).toBeInTheDocument();
    expect(await screen.findByText("Body paragraph loaded on demand")).toBeInTheDocument();
    expect(screen.getByText(/Containing branches:/)).toBeInTheDocument();
    expect(screen.getByText(/Signature:.*Verified/)).toBeInTheDocument();
    expect(api.commitsChanges).not.toHaveBeenCalled();
  });

  it("handles multi-root multi-selection and transitions cleanly back to single selection", async () => {
    const repoA = makeCommits(3, "/repo-a");
    const repoB = makeCommits(2, "/repo-b");
    const commits = [...repoA, ...repoB];
    const keys = commits.map(commitKey);
    useVcs.setState({ root: "/repo-a", repo: "/repo-a", roots: ["/repo-a", "/repo-b"] });
    useGitLog.setState({ commits, selected: keys[0]!, selection: keys });
    const { container } = render(<CommitDetails commits={commits} />);

    await waitFor(() => expect(api.commitsChanges).toHaveBeenCalledTimes(2));
    expect(mountedMessageButtons(container)).toHaveLength(5);

    // Shrink selection to a single commit without remounting CommitDetails.
    act(() => {
      useGitLog.setState({ selected: keys[0]!, selection: [keys[0]!] });
    });
    expect(await screen.findByText("Body paragraph loaded on demand")).toBeInTheDocument();
    expect(mountedMessageButtons(container)).toHaveLength(1);
  });

  it("selects the whole list on Cmd+A and copies all 2,000 commit messages in order", () => {
    const commits = makeCommits(2_000);
    const keys = commits.map(commitKey);
    useGitLog.setState({ commits, selected: keys[0]!, selection: keys });
    const outside = document.createElement("p");
    outside.textContent = "outside workbench chrome";
    document.body.append(outside);

    try {
      const { container } = render(<CommitDetails commits={commits} />);
      const box = messageBoxOf(container);
      box.focus();

      const selectAll = new KeyboardEvent("keydown", {
        key: "a",
        code: "KeyA",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      box.dispatchEvent(selectAll);
      expect(selectAll.defaultPrevented).toBe(true);
      const sel = window.getSelection()!;
      expect(sel.isCollapsed).toBe(false);
      expect(box.contains(sel.anchorNode) && box.contains(sel.focusNode)).toBe(true);
      expect(sel.toString()).not.toContain("outside workbench chrome");

      const copied = new Map<string, string>();
      const copyEvent = new Event("copy", { bubbles: true, cancelable: true });
      Object.defineProperty(copyEvent, "clipboardData", {
        value: { setData: (type: string, data: string) => copied.set(type, data) },
      });
      box.dispatchEvent(copyEvent);

      expect(copyEvent.defaultPrevented).toBe(true);
      const text = copied.get("text/plain") ?? "";
      expect(text).toContain(commits[0]!.summary);
      expect(text).toContain(commits[1_000]!.summary);
      expect(text).toContain(commits[1_999]!.summary);
      expect(text).toContain(commits[0]!.shortId);
      expect(text).toContain(commits[1_999]!.shortId);
      expect(text).toContain("HEAD -> main");
      expect(text).toContain("v0.50");
      expect(text).not.toContain("Detailed body for commit");

      // Every commit summary appears in order (newest first).
      let cursor = -1;
      for (const c of commits) {
        const pos = text.indexOf(c.summary, cursor + 1);
        expect(pos).toBeGreaterThan(cursor);
        cursor = pos;
      }

      // Keyboard Cmd+C also copies all 2,000 commits.
      fireEvent.keyDown(box, { key: "c", code: "KeyC", metaKey: true });
      expect(api.writeClipboardText).toHaveBeenCalledWith(text);

      // Right-click Copy menu also copies all 2,000 commits.
      fireEvent.contextMenu(box);
      const menu = useContextMenuStore.getState().menu;
      const copyItem = menu?.items.find((item) => "id" in item && item.id === "copy");
      expect(copyItem).toBeDefined();
      if (copyItem && "run" in copyItem && copyItem.run) copyItem.run();
      expect(api.writeClipboardText).toHaveBeenLastCalledWith(text);

      // Scrolling after Select All still copies all 2,000 commits.
      act(() => {
        box.scrollTop = 50_000;
        fireEvent.scroll(box);
      });
      copied.clear();
      const copyAfterScroll = new Event("copy", { bubbles: true, cancelable: true });
      Object.defineProperty(copyAfterScroll, "clipboardData", {
        value: { setData: (type: string, data: string) => copied.set(type, data) },
      });
      box.dispatchEvent(copyAfterScroll);
      expect(copyAfterScroll.defaultPrevented).toBe(true);
      expect(copied.get("text/plain")).toBe(text);
    } finally {
      outside.remove();
    }
  });

  it("selects all on Ctrl+A and copies all 2,000 commits on Windows/Linux", () => {
    usePlatform.setState({ os: "windows" });
    const commits = makeCommits(2_000);
    const keys = commits.map(commitKey);
    useGitLog.setState({ commits, selected: keys[0]!, selection: keys });
    const { container } = render(<CommitDetails commits={commits} />);
    const box = messageBoxOf(container);
    box.focus();

    const selectAll = new KeyboardEvent("keydown", {
      key: "a",
      code: "KeyA",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    box.dispatchEvent(selectAll);
    expect(selectAll.defaultPrevented).toBe(true);

    fireEvent.keyDown(box, { key: "c", code: "KeyC", ctrlKey: true });
    expect(api.writeClipboardText).toHaveBeenCalledTimes(1);
    const text = api.writeClipboardText.mock.calls[0]![0] as string;
    expect(text).toContain(commits[0]!.summary);
    expect(text).toContain(commits[1_999]!.summary);
    expect(text.split("\n\n")).toHaveLength(2_000);
  });

  it("copies all 2,000 commits when selectAllChildren is applied to the message pane", () => {
    const commits = makeCommits(2_000);
    const keys = commits.map(commitKey);
    useGitLog.setState({ commits, selected: keys[0]!, selection: keys });
    const { container } = render(<CommitDetails commits={commits} />);
    const box = messageBoxOf(container);

    window.getSelection()!.selectAllChildren(box);
    const copied = new Map<string, string>();
    const copyEvent = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(copyEvent, "clipboardData", {
      value: { setData: (type: string, data: string) => copied.set(type, data) },
    });
    box.dispatchEvent(copyEvent);

    expect(copyEvent.defaultPrevented).toBe(true);
    const text = copied.get("text/plain") ?? "";
    expect(text).toContain(commits[0]!.summary);
    expect(text).toContain(commits[1_999]!.summary);
    expect(text.split("\n\n")).toHaveLength(2_000);
  });

  it("copies every commit between the first and last selected rows during a scrolled drag-selection", () => {
    const commits = makeCommits(2_000);
    const keys = commits.map(commitKey);
    useGitLog.setState({ commits, selected: keys[0]!, selection: keys });
    const { container } = render(<CommitDetails commits={commits} />);
    const box = messageBoxOf(container);

    // Start dragging on row 2, then scroll far down so intermediate rows unmount.
    const row2 = box.querySelector<HTMLElement>('[data-index="2"]')!;
    expect(row2).not.toBeNull();
    fireEvent.mouseDown(row2, { button: 0 });

    act(() => {
      box.scrollTop = 50_000;
      fireEvent.scroll(box);
    });

    // Anchor row stays mounted for the active drag while total mounted rows remain bounded.
    const pinnedRow2 = box.querySelector<HTMLElement>('[data-index="2"]');
    const mountedRows = [...box.querySelectorAll<HTMLElement>("[data-index]")];
    const endRow = mountedRows[mountedRows.length - 1]!;
    const endIndex = Number(endRow.dataset.index);
    expect(pinnedRow2).not.toBeNull();
    expect(endIndex).toBeGreaterThan(400);
    expect(mountedMessageButtons(container).length).toBeLessThan(40);

    const range = document.createRange();
    range.setStart(pinnedRow2!.querySelector('[class*="subjectLine"]')!.firstChild!, 0);
    range.setEnd(endRow.querySelector('[class*="subjectLine"]')!.firstChild!, 5);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    fireEvent.mouseUp(document);

    const copied = new Map<string, string>();
    const copyEvent = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(copyEvent, "clipboardData", {
      value: { setData: (type: string, data: string) => copied.set(type, data) },
    });
    box.dispatchEvent(copyEvent);

    expect(copyEvent.defaultPrevented).toBe(true);
    const text = copied.get("text/plain") ?? "";
    const midIndex = Math.floor((2 + endIndex) / 2);
    // Summaries are prefixes of each other ("commit 1" / "commit 10"), so check the start and the count.
    expect(text.startsWith(commits[2]!.summary + "\n")).toBe(true);
    expect(text).toContain(commits[midIndex]!.summary);
    expect(text).toContain(commits[endIndex]!.summary);
    expect(text.split("\n\n")).toHaveLength(endIndex - 2 + 1);
  });

  it("leaves single-row partial selections and triple-click boundaries to normal text copy", () => {
    const commits = makeCommits(200);
    const keys = commits.map(commitKey);
    useGitLog.setState({ commits, selected: keys[0]!, selection: keys });
    const { container } = render(<CommitDetails commits={commits} />);
    const box = messageBoxOf(container);

    const row0Subject = box.querySelector<HTMLElement>('[data-index="0"] [class*="subjectLine"]')!;
    const range = document.createRange();
    range.setStart(row0Subject.firstChild!, 0);
    range.setEnd(row0Subject.firstChild!, 9);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    const setData = vi.fn();
    const copyEvent = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(copyEvent, "clipboardData", { value: { setData } });
    box.dispatchEvent(copyEvent);
    expect(copyEvent.defaultPrevented).toBe(false);
    expect(setData).not.toHaveBeenCalled();

    fireEvent.keyDown(box, { key: "c", code: "KeyC", metaKey: true });
    expect(api.writeClipboardText).toHaveBeenCalledWith(commits[0]!.summary.slice(0, 9));

    // A triple-click ending at offset 0 of the next row selects only row 0, not row 1.
    const row1Subject = box.querySelector<HTMLElement>('[data-index="1"] [class*="subjectLine"]')!;
    const triple = document.createRange();
    triple.setStart(row0Subject.firstChild!, 0);
    triple.setEnd(row1Subject.firstChild!, 0);
    sel.removeAllRanges();
    sel.addRange(triple);
    const tripleCopy = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(tripleCopy, "clipboardData", { value: { setData } });
    box.dispatchEvent(tripleCopy);
    expect(tripleCopy.defaultPrevented).toBe(false);
    expect(setData).not.toHaveBeenCalled();
  });

  it("defers formatting selected commits on context menu open until Copy is run", () => {
    const commits = makeCommits(2_000);
    const keys = commits.map(commitKey);
    useGitLog.setState({ commits, selected: keys[0]!, selection: keys });
    const { container } = render(<CommitDetails commits={commits} />);
    const box = messageBoxOf(container);
    box.focus();

    window.getSelection()!.selectAllChildren(box);
    formatCalls.count = 0;

    // Opening and cancelling the context menu must not format every selected commit.
    fireEvent.contextMenu(box);
    const menu = useContextMenuStore.getState().menu;
    const copyItem = menu?.items.find((item) => "id" in item && item.id === "copy");
    expect(copyItem).toBeDefined();
    expect(formatCalls.count).toBe(0);

    // Cancelling leaves formatting untouched and writes nothing to the clipboard.
    useContextMenuStore.setState({ menu: null });
    expect(formatCalls.count).toBe(0);
    expect(api.writeClipboardText).not.toHaveBeenCalled();

    // Invoking Copy formats the captured range on demand and copies every selected commit.
    if (copyItem && "run" in copyItem && copyItem.run) copyItem.run();
    expect(formatCalls.count).toBe(2_000);
    expect(api.writeClipboardText).toHaveBeenCalledTimes(1);
    const text = api.writeClipboardText.mock.calls[0]![0] as string;
    expect(text).toContain(commits[0]!.summary);
    expect(text).toContain(commits[1_999]!.summary);
    expect(text.split("\n\n")).toHaveLength(2_000);
  });
});
