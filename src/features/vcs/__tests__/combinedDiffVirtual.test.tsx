/**
 * The all-in-one diff with many files: only the blocks near the viewport keep a mounted diff
 * editor, except blocks with unsaved edits or focus, and scrolling never drops or reorders files.
 */
import { useEffect, useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dirtyDocs = new Set<number>();
const unmountedPaths: string[] = [];
/** Paths of the diff editors mounted, in mount order. */
const mountedPaths: string[] = [];
let nextDocId = 1;

vi.mock("../DiffEditor", () => ({
  DiffEditor: ({ input }: { input: { data: { path: string } } }) => {
    const path = input.data.path;
    const [docId] = useState(() => nextDocId++);
    useEffect(() => {
      const handle = { view: {}, ctx: { doc: docId, path } } as unknown as TextEditorHandle;
      mountedPaths.push(path);
      _addEditor(handle);
      return () => {
        _removeEditor(handle);
        // Mirror real DiffEditor unmount: releasing the view drops its unsaved document state.
        dirtyDocs.delete(docId);
        unmountedPaths.push(path);
      };
    }, [docId, path]);
    return (
      <div data-testid="block-diff" data-path={path}>
        <input aria-label={`Edit ${path}`} onChange={() => dirtyDocs.add(docId)} />
      </div>
    );
  },
}));

import { _addEditor, _removeEditor, editorsFor, type TextEditorHandle } from "@/editor/api";
import { useProject } from "@/platform/project";
import { provideEditorService } from "@/workbench/contributions";
import { CombinedDiffTab } from "../CombinedDiff";
import { combinedDiffInput, diffKey, type DiffData } from "../diffInput";

/** Height of every block (header + diff) and of the scroller, in px. */
const BLOCK = 300;
const VIEW = 600;

const diff = (path: string): DiffData => ({ path, left: { type: "rev", rev: "HEAD" }, right: { type: "worktree" } });
const files = (n: number) => Array.from({ length: n }, (_, i) => diff(`/r/src/f${String(i).padStart(5, "0")}.ts`));

const openInput = vi.fn(async () => undefined);
provideEditorService({
  openInput,
  openFile: vi.fn(async () => undefined),
  closeInput: vi.fn(),
  dirtyDocumentIds: () => [...dirtyDocs],
} as never);

/**
 * jsdom has no layout. Blocks measure `BLOCK` tall; an IntersectionObserver reports a block
 * near once the scroller's viewport (plus the observer's bottom margin) reaches it, from the
 * block's position among its siblings, as a browser would with blocks of that height.
 */
class FakeIntersectionObserver {
  static all = new Set<FakeIntersectionObserver>();
  private readonly targets = new Set<Element>();
  constructor(
    private readonly callback: IntersectionObserverCallback,
    private readonly options: IntersectionObserverInit = {},
  ) {
    FakeIntersectionObserver.all.add(this);
  }
  observe(el: Element) {
    this.targets.add(el);
    this.check();
  }
  unobserve(el: Element) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
    FakeIntersectionObserver.all.delete(this);
  }
  takeRecords() {
    return [];
  }
  check() {
    const root = this.options.root as HTMLElement | null;
    if (!root) return;
    const below = Number(/(\d+)px 0px$/.exec(this.options.rootMargin ?? "")?.[1] ?? 0);
    const blocks = [...root.querySelectorAll("[data-combined-block]")];
    const entries = [...this.targets].flatMap((el) => {
      const at = blocks.indexOf(el);
      const top = at * BLOCK - root.scrollTop;
      return top < VIEW + below && top + BLOCK > 0 ? [{ target: el, isIntersecting: true }] : [];
    });
    if (entries.length) this.callback(entries as never, this as never);
  }
}

const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!;
const scrollHeight = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight")!;
const scrollTo = Element.prototype.scrollTo;

beforeEach(() => {
  localStorage.clear();
  dirtyDocs.clear();
  unmountedPaths.length = 0;
  mountedPaths.length = 0;
  nextDocId = 1;
  openInput.mockClear();
  useProject.setState({ project: { name: "r", root: "/r", trusted: true, isGit: true, settings: {} } as never });
  // The view's scroll speed is measured against the clock: held still, each `scroll` below is a
  // jump rather than a fling (the fast-scroll tests move it on themselves).
  // A plain replacement (a spy would record each of React's many reads of the clock).
  performance.now = () => 0;
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute("data-index") || this.hasAttribute("data-combined-block") ? BLOCK : VIEW;
    },
  });
  // The scroller's content: the blocks' full height.
  Object.defineProperty(Element.prototype, "scrollHeight", {
    configurable: true,
    get(this: Element) {
      const content = this.hasAttribute("data-combined-scroll") ? this.firstElementChild : null;
      return content instanceof HTMLElement ? parseFloat(content.style.height) || 0 : 0;
    },
  });
  Element.prototype.scrollTo = function (this: Element, opts?: ScrollToOptions | number) {
    // Called inside React updates (a click, the first layout): no act of its own.
    if (typeof opts === "object" && opts.top != null) {
      const top = Math.max(0, opts.top);
      // As in a browser, scrolling to where the view already is fires no scroll event.
      if (top === this.scrollTop) return;
      (this as HTMLElement).scrollTop = top;
      this.dispatchEvent(new Event("scroll"));
    }
  } as Element["scrollTo"];
});

afterEach(() => {
  // Back to `Performance.prototype.now`.
  delete (performance as { now?: unknown }).now;
  vi.unstubAllGlobals();
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeight);
  Object.defineProperty(Element.prototype, "scrollHeight", scrollHeight);
  Element.prototype.scrollTo = scrollTo;
});

const scroller = () => document.querySelector<HTMLElement>("[data-combined-scroll]")!;
const mounted = () => screen.queryAllByTestId("block-diff").map((b) => b.dataset.path!);
const headers = () =>
  [...document.querySelectorAll<HTMLElement>("[data-combined-block]")].map((b) => b.dataset.combinedBlock!);

function scroll(el: HTMLElement, top: number) {
  act(() => {
    el.scrollTop = Math.max(0, top);
    fireEvent.scroll(el);
    FakeIntersectionObserver.all.forEach((o) => o.check());
  });
}

/** Scrolls a screen at a time to the end of `n` blocks and back, calling `seen` at each stop. */
function scrollDownAndBack(n: number, seen: () => void = () => {}) {
  const end = n * BLOCK;
  for (let top = 0; top <= end; top += VIEW) {
    scroll(scroller(), top);
    seen();
  }
  for (let top = end; top >= 0; top -= VIEW) {
    scroll(scroller(), top);
    seen();
  }
  scroll(scroller(), 0);
}

describe("the all-in-one diff with many files", () => {
  it.each([40, 160])("keeps a bounded number of diff editors mounted while scrolling %i files", (n) => {
    render(<CombinedDiffTab input={combinedDiffInput({ items: files(n) })} />);
    let most = mounted().length;
    scrollDownAndBack(n, () => (most = Math.max(most, mounted().length)));
    // A window around the viewport, whatever the number of files scrolled past.
    expect(most).toBeLessThanOrEqual(12);
    expect(mounted().length).toBeLessThanOrEqual(12);
    expect(mounted()[0]).toBe(files(n)[0]!.path);
  });

  it("shows every file, in order, on the way down", () => {
    const items = files(100);
    render(<CombinedDiffTab input={combinedDiffInput({ items })} />);
    expect(screen.getByText("100 files")).toBeTruthy();
    const seen = new Set<string>();
    scrollDownAndBack(items.length, () => {
      const shown = headers();
      // In the files' order, without gaps.
      const first = items.findIndex((i) => i.path === shown[0]);
      expect(shown).toEqual(items.slice(first, first + shown.length).map((i) => i.path));
      shown.forEach((p) => seen.add(p));
    });
    expect(seen.size).toBe(items.length);
  });

  it("keeps a block with unsaved edits mounted however far it is scrolled, until they are saved", () => {
    const items = files(120);
    const edited = items[2]!.path;
    render(<CombinedDiffTab input={combinedDiffInput({ items })} />);
    const field = screen.getByLabelText(`Edit ${edited}`) as HTMLInputElement;
    act(() => {
      fireEvent.change(field, { target: { value: "typed, not saved" } });
    });
    // Ensure focus is outside the scroller so only the unsaved-edits guard keeps the block mounted.
    field.blur();
    expect(scroller().contains(document.activeElement)).toBe(false);
    const docId = editorsFor(edited)[0]!.ctx.doc;
    expect(dirtyDocs.has(docId)).toBe(true);

    scroll(scroller(), items.length * BLOCK);
    // Far away, it is still mounted, never unmounted, with its edit and dirty doc intact.
    expect(mounted()).toContain(edited);
    expect(unmountedPaths).not.toContain(edited);
    expect(dirtyDocs.has(docId)).toBe(true);
    expect(editorsFor(edited)).toHaveLength(1);
    expect(mounted().length).toBeLessThanOrEqual(13);

    scroll(scroller(), 0);
    expect(screen.getByLabelText(`Edit ${edited}`)).toBe(field);
    expect(field.value).toBe("typed, not saved");
    expect(dirtyDocs.has(docId)).toBe(true);

    // Saved: it unmounts and releases its document once scrolled out of view.
    dirtyDocs.delete(docId);
    scroll(scroller(), items.length * BLOCK);
    expect(mounted()).not.toContain(edited);
    expect(unmountedPaths).toContain(edited);
    expect(editorsFor(edited)).toHaveLength(0);
  });

  it("keeps the focused block mounted while it is scrolled away", () => {
    const items = files(120);
    const focused = items[1]!.path;
    render(<CombinedDiffTab input={combinedDiffInput({ items })} />);
    const field = screen.getByLabelText(`Edit ${focused}`);
    field.focus();
    scroll(scroller(), items.length * BLOCK);
    expect(mounted()).toContain(focused);
    expect(document.activeElement).toBe(field);
    field.blur();
    scroll(scroller(), 30 * BLOCK);
    expect(mounted()).not.toContain(focused);
  });

  it("moves to the next and previous file, and opens at the file asked for", () => {
    const items = files(120);
    const { unmount } = render(<CombinedDiffTab input={combinedDiffInput({ items })} />);
    // The file moved to sits at the top of the view.
    const top = (i: number) => {
      const slot = document.querySelector<HTMLElement>(`[data-index="${i}"]`)!;
      return parseFloat(slot.style.top);
    };
    fireEvent.click(screen.getByRole("button", { name: "Next File" }));
    expect(scroller().scrollTop).toBeGreaterThan(0);
    expect(scroller().scrollTop).toBe(top(1));
    fireEvent.click(screen.getByRole("button", { name: "Next File" }));
    expect(scroller().scrollTop).toBe(top(2));
    fireEvent.click(screen.getByRole("button", { name: "Previous File" }));
    expect(scroller().scrollTop).toBe(top(1));
    unmount();

    render(<CombinedDiffTab input={combinedDiffInput({ items, reveal: items[80]!.path })} />);
    expect(headers()).toContain(items[80]!.path);
    expect(scroller().scrollTop).toBe(top(80));
    expect(mounted()).toContain(items[80]!.path);
    expect(mounted().length).toBeLessThanOrEqual(12);
  });

  it("keys partially staged files separately so Next File advances past duplicate paths without key errors", () => {
    const staged = (path: string): DiffData => ({
      path,
      left: { type: "rev", rev: "HEAD" },
      right: { type: "rev", rev: ":0", label: "Index" },
    });
    const unstaged = (path: string): DiffData => ({
      path,
      left: { type: "rev", rev: ":0", label: "Index" },
      right: { type: "worktree" },
    });
    const items = [
      staged("/r/src/a.ts"),
      staged("/r/src/b.ts"),
      unstaged("/r/src/a.ts"),
      unstaged("/r/src/c.ts"),
      unstaged("/r/src/d.ts"),
      unstaged("/r/src/e.ts"),
      unstaged("/r/src/f.ts"),
      unstaged("/r/src/g.ts"),
    ];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { unmount } = render(<CombinedDiffTab input={combinedDiffInput({ items })} />);
      const top = (i: number) => {
        const slot = document.querySelector<HTMLElement>(`[data-index="${i}"]`)!;
        return parseFloat(slot.style.top);
      };
      const tops: number[] = [];
      const expectedTops: number[] = [];
      for (let k = 0; k < 6; k++) {
        fireEvent.click(screen.getByRole("button", { name: "Next File" }));
        tops.push(scroller().scrollTop);
        if (k < 4) expectedTops.push(top(k + 1));
      }
      // Must advance past unstaged a.ts (index 2) to c.ts (index 3) and d.ts (index 4), never looping back to 0.
      expect(tops.slice(0, 4)).toEqual(expectedTops);
      expect(expectedTops[1]).toBeGreaterThan(expectedTops[0]!);
      expect(expectedTops[2]).toBeGreaterThan(expectedTops[1]!);
      expect(expectedTops[3]).toBeGreaterThan(expectedTops[2]!);
      const keyWarnings = consoleError.mock.calls.filter((args) =>
        args.some((a) => typeof a === "string" && a.includes("same key")),
      );
      expect(keyWarnings).toEqual([]);

      // Collapsing staged a.ts must not collapse unstaged a.ts.
      scroll(scroller(), 0);
      const collapseButtons = screen.getAllByRole("button", { name: "Collapse File" });
      act(() => {
        fireEvent.click(collapseButtons[0]!);
      });
      const unstagedSlot = document.querySelector<HTMLElement>('[data-index="2"]')!;
      expect(unstagedSlot.querySelector('[data-testid="block-diff"]')?.closest("[hidden]")).toBeNull();
      unmount();

      // Opening with revealKey targets the unstaged entry rather than the earlier staged entry.
      render(
        <CombinedDiffTab input={combinedDiffInput({ items, reveal: "/r/src/a.ts", revealKey: diffKey(items[2]!) })} />,
      );
      expect(scroller().scrollTop).toBe(top(2));
    } finally {
      consoleError.mockRestore();
    }
  });

  it("goes back to one tab per file at the file in view", async () => {
    const items = files(120);
    render(<CombinedDiffTab input={combinedDiffInput({ items, reveal: items[40]!.path })} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show Files in Separate Diff Tabs" }));
    });
    expect((openInput.mock.calls[0] as unknown as [{ path: string }])[0].path).toBe(items[40]!.path);
  });

  it("reads no other file's data to expand and collapse a file, however many there are", () => {
    /** Reads of the files' paths while the first file is expanded and collapsed again, with `n` files. */
    const readsPerToggle = (n: number) => {
      let reads = 0;
      const input = combinedDiffInput({ items: files(n) });
      const data = input.data as { items: DiffData[] };
      data.items = data.items.map(({ path, ...rest }) =>
        Object.defineProperty({ ...rest }, "path", { enumerable: true, get: () => (reads++, path) }),
      ) as DiffData[];
      const { unmount } = render(<CombinedDiffTab input={input} />);
      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Collapse All Files" }));
      });
      reads = 0;
      act(() => {
        fireEvent.click(screen.getAllByRole("button", { name: "Expand File" })[0]!);
      });
      act(() => {
        fireEvent.click(screen.getAllByRole("button", { name: "Collapse File" })[0]!);
      });
      expect(screen.getByRole("button", { name: "Expand All Files" })).toBeTruthy();
      unmount();
      return reads;
    };
    expect(readsPerToggle(4_000)).toBe(readsPerToggle(40));
  });

  it("reads no other file's data when a block near the top changes height, however many files follow it", () => {
    const observers: Array<{ cb: ResizeObserverCallback; targets: Set<Element> }> = [];
    class ControlledResizeObserver {
      private readonly targets = new Set<Element>();
      constructor(cb: ResizeObserverCallback) {
        observers.push({ cb, targets: this.targets });
      }
      observe(el: Element) {
        this.targets.add(el);
      }
      unobserve(el: Element) {
        this.targets.delete(el);
      }
      disconnect() {
        this.targets.clear();
      }
    }
    vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
    /** Reads of the files' paths while the first block grows, then shrinks back, with `n` files. */
    const readsPerResize = (n: number) => {
      let reads = 0;
      const input = combinedDiffInput({ items: files(n) });
      const data = input.data as { items: DiffData[] };
      data.items = data.items.map(({ path, ...rest }) =>
        Object.defineProperty({ ...rest }, "path", { enumerable: true, get: () => (reads++, path) }),
      ) as DiffData[];
      const { unmount } = render(<CombinedDiffTab input={input} />);
      const slot = document.querySelector<HTMLElement>('[data-index="0"]')!;
      const resize = (blockSize: number) =>
        act(() => {
          for (const o of observers.filter((o) => o.targets.has(slot)))
            o.cb([{ target: slot, borderBoxSize: [{ blockSize, inlineSize: 800 }] } as never], {} as never);
        });
      reads = 0;
      resize(BLOCK + 60);
      resize(BLOCK);
      unmount();
      observers.length = 0;
      return reads;
    };
    expect(readsPerResize(4_000)).toBe(readsPerResize(40));
  });

  it("loads no diff for a collapsed file scrolled into view, and loads it when expanded", () => {
    const items = files(120);
    render(<CombinedDiffTab input={combinedDiffInput({ items })} />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Collapse All Files" }));
    });
    scroll(scroller(), 80 * BLOCK);
    const shown = headers();
    expect(shown.length).toBeGreaterThan(0);
    // Headers only: none of these files was expanded while in view.
    expect(mounted()).toEqual([]);
    act(() => {
      fireEvent.click(screen.getAllByRole("button", { name: "Expand File" })[0]!);
    });
    expect(mounted()).toContain(shown[0]);
    // One file open: the toolbar offers to collapse all again, and to expand all once it is closed.
    expect(screen.getByRole("button", { name: "Collapse All Files" })).toBeTruthy();
    act(() => {
      fireEvent.click(screen.getAllByRole("button", { name: "Collapse File" })[0]!);
    });
    expect(screen.getByRole("button", { name: "Expand All Files" })).toBeTruthy();
  });

  it("does not revert pending scroll movement when an above-fold block resizes before its scroll event", () => {
    const observers: Array<{ cb: ResizeObserverCallback; targets: Set<Element> }> = [];
    const origRO = window.ResizeObserver;
    class ControlledResizeObserver {
      private readonly targets = new Set<Element>();
      constructor(cb: ResizeObserverCallback) {
        observers.push({ cb, targets: this.targets });
      }
      observe(el: Element) {
        this.targets.add(el);
      }
      unobserve(el: Element) {
        this.targets.delete(el);
      }
      disconnect() {
        this.targets.clear();
      }
    }
    vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
    window.ResizeObserver = ControlledResizeObserver as unknown as typeof ResizeObserver;
    try {
      const items = files(500);
      render(<CombinedDiffTab input={combinedDiffInput({ items })} />);
      // Scroll into the middle so overscan blocks sit above scrollTop.
      scroll(scroller(), 20 * BLOCK);
      const before = scroller().scrollTop;
      const aboveSlot = [...document.querySelectorAll<HTMLElement>("[data-index]")].find(
        (s) => parseFloat(s.style.top) < before,
      )!;
      expect(aboveSlot).toBeTruthy();
      const ro = observers.find((o) => o.targets.has(aboveSlot));
      expect(ro).toBeTruthy();

      // Simulate a scrollTop advance (e.g. inside rAF) whose scroll event has not fired yet,
      // followed in the same frame by ResizeObserver firing for an above-fold block whose
      // initial loading height (60px) is smaller than the 200px estimate (delta = -140px).
      const step = 3_000;
      const loadingHeight = 60;
      const delta = loadingHeight - 200;
      scroller().scrollTop = before + step;
      act(() => {
        ro!.cb(
          [{ target: aboveSlot, borderBoxSize: [{ blockSize: loadingHeight, inlineSize: 800 }] } as never],
          {} as never,
        );
      });
      // The adjustment applies to the live scrollTop rather than reverting to `before + delta`.
      expect(scroller().scrollTop).toBe(before + step + delta);
    } finally {
      window.ResizeObserver = origRO;
    }
  });

  it("keeps dirty and focused blocks mounted when the scroller height collapses to 0 and restores", () => {
    const observers: Array<{ cb: ResizeObserverCallback; targets: Set<Element> }> = [];
    const origRO = window.ResizeObserver;
    const origClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight")!;
    const origRAF = window.requestAnimationFrame;
    const origCAF = window.cancelAnimationFrame;
    let viewHeight = VIEW;
    const rafs = new Map<number, FrameRequestCallback>();
    let rafId = 1;
    class ControlledResizeObserver {
      private readonly targets = new Set<Element>();
      constructor(cb: ResizeObserverCallback) {
        observers.push({ cb, targets: this.targets });
      }
      observe(el: Element) {
        this.targets.add(el);
      }
      unobserve(el: Element) {
        this.targets.delete(el);
      }
      disconnect() {
        this.targets.clear();
      }
    }
    vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
    window.ResizeObserver = ControlledResizeObserver as unknown as typeof ResizeObserver;
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      const id = rafId++;
      rafs.set(id, cb);
      return id;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = ((id: number) => {
      rafs.delete(id);
    }) as typeof window.cancelAnimationFrame;
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return viewHeight;
      },
    });
    const fireResize = (el: Element) => {
      const matching = observers.filter((o) => o.targets.has(el));
      expect(matching.length).toBeGreaterThan(0);
      act(() => {
        for (const o of matching) o.cb([{ target: el } as never], {} as never);
        const pending = [...rafs.entries()];
        rafs.clear();
        for (const [, cb] of pending) cb(0);
      });
    };

    const items = files(120);
    const edited = items[2]!.path;
    const focusedPath = items[1]!.path;
    try {
      render(<CombinedDiffTab input={combinedDiffInput({ items })} />);
      const editedField = screen.getByLabelText(`Edit ${edited}`) as HTMLInputElement;
      act(() => {
        fireEvent.change(editedField, { target: { value: "unsaved across zero height" } });
      });
      const editedDocId = editorsFor(edited)[0]!.ctx.doc;
      expect(dirtyDocs.has(editedDocId)).toBe(true);
      const focusedField = screen.getByLabelText(`Edit ${focusedPath}`) as HTMLInputElement;
      focusedField.focus();

      scroll(scroller(), 60 * 200);
      const mid = items[60]!.path;
      expect(mounted()).toContain(edited);
      expect(mounted()).toContain(focusedPath);
      expect(mounted()).toContain(mid);

      // Collapse viewport height to 0 (as when maximizing a tool window hides the editor area).
      viewHeight = 0;
      fireResize(scroller());
      // Non-pinned viewport blocks unmount at height 0, confirming virtual-core saw outerSize === 0.
      expect(mounted()).not.toContain(mid);
      // Both the dirty block and the focused block stay mounted in place.
      expect(mounted()).toContain(edited);
      expect(mounted()).toContain(focusedPath);
      expect(unmountedPaths).not.toContain(edited);
      expect(dirtyDocs.has(editedDocId)).toBe(true);
      expect(screen.getByLabelText(`Edit ${edited}`)).toBe(editedField);
      expect(editedField.value).toBe("unsaved across zero height");
      expect(document.activeElement).toBe(focusedField);

      // Restore viewport height: the same editors remain mounted with edits and focus intact.
      viewHeight = VIEW;
      fireResize(scroller());
      expect(mounted()).toContain(mid);
      expect(screen.getByLabelText(`Edit ${edited}`)).toBe(editedField);
      expect(editedField.value).toBe("unsaved across zero height");
      expect(dirtyDocs.has(editedDocId)).toBe(true);
      expect(screen.getByLabelText(`Edit ${focusedPath}`)).toBe(focusedField);
      expect(document.activeElement).toBe(focusedField);
    } finally {
      window.ResizeObserver = origRO;
      window.requestAnimationFrame = origRAF;
      window.cancelAnimationFrame = origCAF;
      Object.defineProperty(HTMLElement.prototype, "clientHeight", origClientHeight);
    }
  });

  it("reaches, expands, edits, and reads back every one of 5,000 editable files without skipping ranges", () => {
    const items = files(5_000);
    render(<CombinedDiffTab input={combinedDiffInput({ items })} />);
    expect(screen.getByText("5000 files")).toBeTruthy();
    const initialCount = mounted().length;
    let most = initialCount;

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Collapse All Files" }));
    });

    const seenIndexes = new Set<number>();
    const seenPaths = new Set<string>();
    const verified = new Set<number>();
    let maxSeen = -1;
    // Step at most one viewport (VIEW) per stop so no index can be skipped between frames.
    for (let top = 0; ; top += VIEW) {
      scroll(scroller(), top);
      const slots = [...document.querySelectorAll<HTMLElement>("[data-index]")];
      expect(slots.length).toBeGreaterThan(0);
      const idxs = slots.map((s) => Number(s.dataset.index));
      for (let k = 1; k < idxs.length; k++) expect(idxs[k]).toBe(idxs[k - 1]! + 1);
      if (maxSeen >= 0) expect(idxs[0]!).toBeLessThanOrEqual(maxSeen + 1);
      for (let k = 0; k < slots.length; k++) {
        const idx = idxs[k]!;
        const block = slots[k]!.querySelector<HTMLElement>("[data-combined-block]")!;
        const path = block.dataset.combinedBlock!;
        expect(path).toBe(items[idx]!.path);
        seenIndexes.add(idx);
        seenPaths.add(path);
        if (idx > maxSeen) maxSeen = idx;
        if (verified.has(idx)) continue;

        const expandBtn = block.querySelector<HTMLButtonElement>('button[aria-label="Expand File"]');
        if (expandBtn) act(() => void fireEvent.click(expandBtn));
        most = Math.max(most, mounted().length);
        const field = block.querySelector<HTMLInputElement>(`input[aria-label="Edit ${path}"]`)!;
        expect(field).toBeTruthy();
        const marker = `edit-${idx}`;
        act(() => void fireEvent.change(field, { target: { value: marker } }));
        expect(field.value).toBe(marker);
        const docId = editorsFor(path)[0]!.ctx.doc;
        expect(dirtyDocs.has(docId)).toBe(true);
        // Save so the block unmounts cleanly once scrolled out of view.
        dirtyDocs.delete(docId);
        const collapseBtn = block.querySelector<HTMLButtonElement>('button[aria-label="Collapse File"]');
        if (collapseBtn) act(() => void fireEvent.click(collapseBtn));
        verified.add(idx);
      }
      if (top >= scroller().scrollHeight) break;
    }

    expect(seenIndexes.size).toBe(5_000);
    expect(seenPaths.size).toBe(5_000);
    expect(verified.size).toBe(5_000);
    expect(most).toBeLessThanOrEqual(12);
    // Scroll back to top and confirm no leaked editors.
    scroll(scroller(), 0);
    expect(mounted().length).toBeLessThanOrEqual(initialCount);
  }, 30_000);

  it("reaches all 5,000 mixed files without skipping ranges and expands binary, large, and last files", () => {
    const bigAt = Math.floor(5_000 / 3);
    const items = Array.from({ length: 5_000 }, (_, i) =>
      diff(
        i === bigAt
          ? `/r/src/Generated${String(i).padStart(5, "0")}.ts`
          : i % 25 === 24 && i !== 4_999
            ? `/r/src/img${String(i).padStart(5, "0")}.png`
            : `/r/src/f${String(i).padStart(5, "0")}.ts`,
      ),
    );
    const binary = items[24]!.path;
    const big = items[bigAt]!.path;
    const last = items[4_999]!.path;
    render(<CombinedDiffTab input={combinedDiffInput({ items })} />);
    expect(screen.getByText("5000 files")).toBeTruthy();
    const initialCount = mounted().length;
    let most = initialCount;
    const seenIndexes = new Set<number>();
    const seenPaths = new Set<string>();
    let maxSeen = -1;
    // Sweep top → bottom stepping at most one viewport (VIEW) per stop, asserting every index/path is seen.
    for (let top = 0; ; top += VIEW) {
      scroll(scroller(), top);
      most = Math.max(most, mounted().length);
      const slots = [...document.querySelectorAll<HTMLElement>("[data-index]")];
      expect(slots.length).toBeGreaterThan(0);
      const idxs = slots.map((s) => Number(s.dataset.index));
      for (let k = 1; k < idxs.length; k++) expect(idxs[k]).toBe(idxs[k - 1]! + 1);
      if (maxSeen >= 0) expect(idxs[0]!).toBeLessThanOrEqual(maxSeen + 1);
      for (let k = 0; k < slots.length; k++) {
        const idx = idxs[k]!;
        const path = slots[k]!.querySelector<HTMLElement>("[data-combined-block]")!.dataset.combinedBlock!;
        expect(path).toBe(items[idx]!.path);
        seenIndexes.add(idx);
        seenPaths.add(path);
        if (idx > maxSeen) maxSeen = idx;
      }
      if (top >= scroller().scrollHeight) break;
    }
    expect(seenIndexes.size).toBe(5_000);
    expect(seenPaths.size).toBe(5_000);
    for (let top = scroller().scrollHeight; top >= 0; top -= VIEW) {
      scroll(scroller(), top);
      most = Math.max(most, mounted().length);
    }
    scroll(scroller(), 0);
    expect(most).toBeLessThanOrEqual(12);
    // Returning to the top leaves no leaked editors.
    expect(mounted().length).toBe(initialCount);

    // Collapse all, then reach and expand a binary file, the large file, and the 5,000th file.
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Collapse All Files" }));
    });
    for (const [idx, path] of [
      [24, binary],
      [bigAt, big],
    ] as const) {
      scroll(scroller(), idx * 200);
      expect(headers()).toContain(path);
      const blockEl = document.querySelector<HTMLElement>(`[data-combined-block="${path}"]`)!;
      act(() => void fireEvent.click(blockEl.querySelector<HTMLButtonElement>('button[aria-label="Expand File"]')!));
      expect(mounted()).toContain(path);
    }

    scroll(scroller(), scroller().scrollHeight);
    expect(headers()).toContain(last);
    expect(mounted()).toEqual([]);
    const lastBlock = document.querySelector<HTMLElement>(`[data-combined-block="${last}"]`)!;
    act(() => {
      fireEvent.click(lastBlock.querySelector<HTMLButtonElement>('button[aria-label="Expand File"]')!);
    });
    expect(mounted()).toContain(last);
    const field = screen.getByLabelText(`Edit ${last}`) as HTMLInputElement;
    act(() => {
      fireEvent.change(field, { target: { value: "edited 5000th file" } });
    });
    field.blur();
    const lastDocId = editorsFor(last)[0]!.ctx.doc;
    expect(dirtyDocs.has(lastDocId)).toBe(true);
    scroll(scroller(), 0);
    // Still mounted with unsaved edit while scrolled 5,000 files away, and total editors stay bounded.
    expect(mounted()).toContain(last);
    expect(dirtyDocs.has(lastDocId)).toBe(true);
    expect(mounted().length).toBeLessThanOrEqual(initialCount + 1);
    scroll(scroller(), scroller().scrollHeight);
    expect(screen.getByLabelText(`Edit ${last}`)).toBe(field);
    expect(field.value).toBe("edited 5000th file");
    expect(dirtyDocs.has(lastDocId)).toBe(true);
  }, 30_000);
});

describe("the all-in-one diff while it scrolls fast", () => {
  /** What `performance.now()` reports: the tests move it on a frame at a time. */
  let clock = 0;
  const raf = new Map<number, FrameRequestCallback>();
  let rafId = 1;
  const origRAF = window.requestAnimationFrame;
  const origCAF = window.cancelAnimationFrame;

  beforeEach(() => {
    clock = 1_000;
    raf.clear();
    performance.now = () => clock;
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      const id = rafId++;
      raf.set(id, cb);
      return id;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = ((id: number) => void raf.delete(id)) as typeof window.cancelAnimationFrame;
  });
  afterEach(() => {
    window.requestAnimationFrame = origRAF;
    window.cancelAnimationFrame = origCAF;
  });

  /** The next animation frame: runs the frame callbacks asked for so far. */
  function frame() {
    clock += 16;
    act(() => {
      const due = [...raf.values()];
      raf.clear();
      due.forEach((cb) => cb(clock));
    });
  }

  /** The block at the top of the view. */
  function atTop() {
    const top = scroller().scrollTop;
    // The last slot starting at or above it (blocks not measured yet sit at the estimated height).
    const slot = [...document.querySelectorAll<HTMLElement>("[data-index]")]
      .filter((s) => parseFloat(s.style.top) <= top + 1)
      .at(-1)!;
    return slot.querySelector<HTMLElement>("[data-combined-block]")!;
  }

  /** Scrolls a viewport each frame from `from` to `to`, as a fling or a dragged scrollbar does. */
  function fling(from: number, to: number, seen: () => void = () => {}) {
    const dir = to >= from ? 1 : -1;
    for (let top = from; dir > 0 ? top <= to : top >= to; top += dir * VIEW) {
      frame();
      scroll(scroller(), top);
      seen();
    }
  }

  it.each([40, 400, 2_000])("mounts no diff editor while %i files fly by, and shows every header in order", (n) => {
    const items = files(n);
    render(<CombinedDiffTab input={combinedDiffInput({ items })} />);
    const before = mountedPaths.length;
    expect(before).toBeGreaterThan(0);
    const seen = new Set<string>();
    fling(0, n * BLOCK, () => {
      const shown = headers();
      const first = items.findIndex((i) => i.path === shown[0]);
      expect(shown).toEqual(items.slice(first, first + shown.length).map((i) => i.path));
      shown.forEach((p) => seen.add(p));
    });
    expect(seen.size).toBe(n);
    // Each file flown past costs its header only, however many there are.
    expect(mountedPaths.slice(before)).toEqual([]);
  });

  /** Diff editors mounted since `from` (an index into `mountedPaths`). */
  const mountedSince = (from: number) => mountedPaths.slice(from);

  it("holds off the diffs when the view first jumps far after sitting still, then mounts them one a frame", () => {
    render(<CombinedDiffTab input={combinedDiffInput({ items: files(500) })} />);
    clock += 500;
    const before = mountedPaths.length;
    // One scroll event, as a click on the scrollbar track sends.
    scroll(scroller(), 20_000);
    expect(mountedSince(before)).toEqual([]);
    let previous = mounted().length;
    for (let i = 0; i < 30; i++) {
      frame();
      expect(mounted().length - previous).toBeLessThanOrEqual(1);
      previous = mounted().length;
    }
    expect([...mounted()].sort()).toEqual([...headers()].sort());
  });

  it("holds off the diffs when the view jumps a screen and a half after sitting still a while", () => {
    render(<CombinedDiffTab input={combinedDiffInput({ items: files(500) })} />);
    frame();
    scroll(scroller(), BLOCK);
    // Sitting still, the browser goes on drawing frames.
    for (let i = 0; i < 18; i++) frame();
    const before = mountedPaths.length;
    scroll(scroller(), BLOCK + 900);
    expect(mountedSince(before)).toEqual([]);
  });

  it.each([249, 250, 400])(
    "mounts the diff a steady scroll brings into view at once, even after a %i ms frame",
    (ms) => {
      render(<CombinedDiffTab input={combinedDiffInput({ items: files(500) })} />);
      frame();
      scroll(scroller(), 2_860);
      for (let i = 0; i < 20; i++) frame();
      // Scrolling at 2.4 px/ms...
      frame();
      scroll(scroller(), 2_900);
      // ...through a frame that blocks the page for `ms` (no frame drawn): the view kept moving at that pace.
      clock += ms;
      const before = mountedPaths.length;
      scroll(scroller(), 2_900 + Math.round(2.4 * ms));
      expect(mountedSince(before).length).toBeGreaterThan(0);
    },
  );

  it("mounts the diff a mouse wheel notch brings into view at once", () => {
    render(<CombinedDiffTab input={combinedDiffInput({ items: files(500) })} />);
    frame();
    scroll(scroller(), 10 * BLOCK);
    for (let i = 0; i < 20; i++) frame();
    clock += 300;
    const before = mountedPaths.length;
    scroll(scroller(), 10 * BLOCK + 120);
    expect(mountedSince(before).length).toBeGreaterThan(0);
  });

  it("mounts the diff a slow read brings into view at once, even after a long frame", () => {
    render(<CombinedDiffTab input={combinedDiffInput({ items: files(500) })} />);
    frame();
    scroll(scroller(), 2_860);
    for (let i = 0; i < 20; i++) frame();
    // Reading at 40 px a frame...
    frame();
    scroll(scroller(), 2_900);
    // ...when a frame takes 67 ms (a diff mounting): the view kept moving at the same pace meanwhile.
    clock += 67;
    const before = mountedPaths.length;
    scroll(scroller(), 2_900 + 160);
    expect(mountedSince(before).length).toBeGreaterThan(0);
  });

  /**
   * Has the blocks report their size as a browser does once they are laid out: the returned
   * function lays out the blocks not laid out yet, each `size()` tall.
   */
  function layoutBlocks(size: () => number = () => BLOCK) {
    const observed: Array<{ cb: ResizeObserverCallback; targets: Set<Element> }> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        private readonly targets = new Set<Element>();
        constructor(cb: ResizeObserverCallback) {
          observed.push({ cb, targets: this.targets });
        }
        observe(el: Element) {
          this.targets.add(el);
        }
        unobserve(el: Element) {
          this.targets.delete(el);
        }
        disconnect() {
          this.targets.clear();
        }
      },
    );
    const laidOut = new WeakSet<Element>();
    return () =>
      act(() => {
        for (const { cb, targets } of observed)
          for (const el of targets) {
            if (laidOut.has(el) || !el.isConnected) continue;
            laidOut.add(el);
            cb([{ target: el, borderBoxSize: [{ blockSize: size(), inlineSize: 800 }] } as never], {} as never);
          }
      });
  }

  it("mounts no diff editor while flung up through blocks not measured yet", () => {
    const layout = layoutBlocks();
    // A browser sends one scroll event a frame: the view's own moves arrive merged into the
    // next one the fling sends.
    let adjusted = 0;
    Element.prototype.scrollTo = function (this: Element, opts?: ScrollToOptions | number) {
      if (typeof opts !== "object" || opts.top == null) return;
      adjusted++;
      (this as HTMLElement).scrollTop = Math.max(0, opts.top);
    } as Element["scrollTo"];
    render(<CombinedDiffTab input={combinedDiffInput({ items: files(500) })} />);
    layout();
    clock += 500;
    // Far down at once: the blocks above were never shown, so each one laid out on the way up
    // (taller than estimated) moves the view to keep its content in place.
    scroll(scroller(), 400 * 200);
    layout();
    for (let i = 0; i < 30; i++) frame();
    layout();
    const before = mountedPaths.length;
    adjusted = 0;
    fling(scroller().scrollTop, scroller().scrollTop - 40 * VIEW, layout);
    expect(adjusted).toBeGreaterThan(0);
    expect(mountedSince(before)).toEqual([]);
  });

  it("mounts no diff editor while flung up from the end through blocks taller than the view can scroll to yet", () => {
    let size = BLOCK;
    const layout = layoutBlocks(() => size);
    // The view is `VIEW` tall and, as in a browser, stops at the end of its content without a scroll
    // event of its own: a block above growing moves the view less than it asks until the content
    // has grown too, and the virtualizer then asks again.
    const clientHeight = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight")!;
    Object.defineProperty(Element.prototype, "clientHeight", {
      configurable: true,
      get(this: Element) {
        return this.hasAttribute("data-combined-scroll") ? VIEW : 0;
      },
    });
    const writes: number[] = [];
    Element.prototype.scrollTo = function (this: Element, opts?: ScrollToOptions | number) {
      if (typeof opts !== "object" || opts.top == null) return;
      writes.push(opts.top);
      (this as HTMLElement).scrollTop = Math.max(0, Math.min(opts.top, this.scrollHeight - VIEW));
    } as Element["scrollTo"];
    try {
      render(<CombinedDiffTab input={combinedDiffInput({ items: files(500) })} />);
      layout();
      frame();
      scroll(scroller(), scroller().scrollHeight - VIEW);
      layout();
      for (let i = 0; i < 30; i++) frame();
      layout();
      const before = mountedPaths.length;
      writes.length = 0;
      // The blocks above were never shown: each comes into view far taller than estimated.
      size = 3_000;
      fling(scroller().scrollTop, scroller().scrollTop - 10 * VIEW, layout);
      // Some move asked of the view was held back by the end of the content and asked again.
      expect(writes.some((top, i) => writes.indexOf(top) < i)).toBe(true);
      expect(mountedSince(before)).toEqual([]);
    } finally {
      Object.defineProperty(Element.prototype, "clientHeight", clientHeight);
    }
  });

  it("mounts the diffs in view once the scroll settles, one a frame, the top of the view first", () => {
    const items = files(400);
    render(<CombinedDiffTab input={combinedDiffInput({ items })} />);
    fling(0, 200 * BLOCK);
    const top = Number(atTop().parentElement!.dataset.index);
    const start = mountedPaths.length;
    let previous = mounted().length;
    for (let i = 0; i < 60; i++) {
      frame();
      expect(mounted().length - previous).toBeLessThanOrEqual(1);
      previous = mounted().length;
    }
    // Every block in range has its diff, the block at the top of the view first.
    expect([...mounted()].sort()).toEqual([...headers()].sort());
    expect(mountedPaths.slice(start)[0]).toBe(items[top]!.path);
    expect(mountedPaths.slice(start)[1]).toBe(items[top + 1]!.path);
  });

  it("keeps an edited block's diff, the same editor, through a fling far away and back", () => {
    const items = files(400);
    const edited = items[2]!.path;
    render(<CombinedDiffTab input={combinedDiffInput({ items })} />);
    const field = screen.getByLabelText(`Edit ${edited}`) as HTMLInputElement;
    act(() => {
      fireEvent.change(field, { target: { value: "typed during a fling" } });
    });
    field.blur();
    fling(0, 300 * BLOCK);
    fling(300 * BLOCK, 0);
    for (let i = 0; i < 30; i++) frame();
    expect(screen.getByLabelText(`Edit ${edited}`)).toBe(field);
    expect(field.value).toBe("typed during a fling");
    expect(mountedPaths.filter((p) => p === edited)).toHaveLength(1);
    expect(unmountedPaths).not.toContain(edited);
  });

  it("mounts a diff expanded during a fling at once, and the file Next File moves to within a frame", () => {
    const items = files(400);
    render(<CombinedDiffTab input={combinedDiffInput({ items })} />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Collapse All Files" }));
    });
    fling(0, 100 * BLOCK);
    const block = atTop();
    act(() => {
      fireEvent.click(block.querySelector<HTMLButtonElement>('button[aria-label="Expand File"]')!);
    });
    expect(mounted()).toContain(block.dataset.combinedBlock);

    // Back to every file expanded (Collapse All, then Expand All).
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Collapse All Files" }));
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Expand All Files" }));
    });
    fling(100 * BLOCK, 200 * BLOCK);
    const from = Number(atTop().parentElement!.dataset.index);
    fireEvent.click(screen.getByRole("button", { name: "Next File" }));
    frame();
    expect(atTop().dataset.combinedBlock).toBe(items[from + 1]!.path);
    expect(mounted()).toContain(items[from + 1]!.path);
  });
});
