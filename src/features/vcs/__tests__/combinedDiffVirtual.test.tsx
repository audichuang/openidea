/**
 * The all-in-one diff with many files: only the blocks near the viewport keep a mounted diff
 * editor, except blocks with unsaved edits or focus, and scrolling never drops or reorders files.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../DiffEditor", () => ({
  DiffEditor: ({ input }: { input: { data: { path: string } } }) => (
    <div data-testid="block-diff" data-path={input.data.path}>
      <input aria-label={`Edit ${input.data.path}`} />
    </div>
  ),
}));

import { _addEditor, _removeEditor, type TextEditorHandle } from "@/editor/api";
import { useProject } from "@/platform/project";
import { provideEditorService } from "@/workbench/contributions";
import { CombinedDiffTab } from "../CombinedDiff";
import { combinedDiffInput, diffKey, type DiffData } from "../diffInput";

/** Height of every block (header + diff) and of the scroller, in px. */
const BLOCK = 300;
const VIEW = 600;

const diff = (path: string): DiffData => ({ path, left: { type: "rev", rev: "HEAD" }, right: { type: "worktree" } });
const files = (n: number) => Array.from({ length: n }, (_, i) => diff(`/r/src/f${String(i).padStart(5, "0")}.ts`));

let dirtyDocs: number[] = [];
const openInput = vi.fn(async () => undefined);
provideEditorService({
  openInput,
  openFile: vi.fn(async () => undefined),
  closeInput: vi.fn(),
  dirtyDocumentIds: () => dirtyDocs,
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
  dirtyDocs = [];
  openInput.mockClear();
  useProject.setState({ project: { name: "r", root: "/r", trusted: true, isGit: true, settings: {} } as never });
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
      (this as HTMLElement).scrollTop = Math.max(0, opts.top);
      this.dispatchEvent(new Event("scroll"));
    }
  } as Element["scrollTo"];
});

afterEach(() => {
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
    const handle = { view: {}, ctx: { doc: 42, path: edited } } as unknown as TextEditorHandle;
    _addEditor(handle);
    try {
      render(<CombinedDiffTab input={combinedDiffInput({ items })} />);
      const field = screen.getByLabelText(`Edit ${edited}`) as HTMLInputElement;
      act(() => {
        fireEvent.change(field, { target: { value: "typed, not saved" } });
      });
      dirtyDocs = [42];
      scroll(scroller(), items.length * BLOCK);
      // Far away, it is still there, with its edit and the document still dirty.
      expect(mounted()).toContain(edited);
      expect(mounted().length).toBeLessThanOrEqual(13);
      scroll(scroller(), 0);
      expect(screen.getByLabelText(`Edit ${edited}`)).toBe(field);
      expect(field.value).toBe("typed, not saved");
      expect(dirtyDocs).toEqual([42]);
      // Saved: it goes like any other block once out of view.
      dirtyDocs = [];
      scroll(scroller(), items.length * BLOCK);
      expect(mounted()).not.toContain(edited);
    } finally {
      _removeEditor(handle);
    }
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
    const handle = { view: {}, ctx: { doc: 43, path: edited } } as unknown as TextEditorHandle;
    _addEditor(handle);
    try {
      render(<CombinedDiffTab input={combinedDiffInput({ items })} />);
      const editedField = screen.getByLabelText(`Edit ${edited}`) as HTMLInputElement;
      act(() => {
        fireEvent.change(editedField, { target: { value: "unsaved across zero height" } });
      });
      dirtyDocs = [43];
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
      expect(screen.getByLabelText(`Edit ${edited}`)).toBe(editedField);
      expect(editedField.value).toBe("unsaved across zero height");
      expect(document.activeElement).toBe(focusedField);

      // Restore viewport height: the same editors remain mounted with edits and focus intact.
      viewHeight = VIEW;
      fireResize(scroller());
      expect(mounted()).toContain(mid);
      expect(screen.getByLabelText(`Edit ${edited}`)).toBe(editedField);
      expect(editedField.value).toBe("unsaved across zero height");
      expect(screen.getByLabelText(`Edit ${focusedPath}`)).toBe(focusedField);
      expect(document.activeElement).toBe(focusedField);
    } finally {
      _removeEditor(handle);
      window.ResizeObserver = origRO;
      window.requestAnimationFrame = origRAF;
      window.cancelAnimationFrame = origCAF;
      Object.defineProperty(HTMLElement.prototype, "clientHeight", origClientHeight);
    }
  });

  it("reaches all 5,000 mixed files with bounded editors and lets the last file be expanded and edited", () => {
    const items = Array.from({ length: 5_000 }, (_, i) =>
      diff(
        i % 25 === 24 && i !== 4_999
          ? `/r/src/img${String(i).padStart(5, "0")}.png`
          : `/r/src/f${String(i).padStart(5, "0")}.ts`,
      ),
    );
    const last = items[4_999]!.path;
    const handle = { view: {}, ctx: { doc: 99, path: last } } as unknown as TextEditorHandle;
    _addEditor(handle);
    try {
      render(<CombinedDiffTab input={combinedDiffInput({ items })} />);
      expect(screen.getByText("5000 files")).toBeTruthy();
      const initialCount = mounted().length;
      let most = initialCount;
      const end = scroller().scrollHeight;
      // Sweep from top to bottom and back across all 5,000 files in 100-file bands:
      // every band renders in order without gaps, the 5,000th file is reached, and the
      // mounted editor count stays bounded with no leak back at the top.
      const visitedBands = new Set<number>();
      for (let top = 0; top <= end; top += Math.ceil(end / 50)) {
        scroll(scroller(), top);
        most = Math.max(most, mounted().length);
        const shown = headers();
        expect(shown.length).toBeGreaterThan(0);
        const first = Number(/(\d+)\.\w+$/.exec(shown[0]!)![1]);
        expect(shown).toEqual(items.slice(first, first + shown.length).map((i) => i.path));
        visitedBands.add(Math.floor(first / 100));
      }
      scroll(scroller(), end);
      expect(headers()).toContain(last);
      most = Math.max(most, mounted().length);
      expect(visitedBands.size).toBeGreaterThanOrEqual(45);
      for (let top = end; top >= 0; top -= Math.ceil(end / 25)) {
        scroll(scroller(), top);
        most = Math.max(most, mounted().length);
      }
      scroll(scroller(), 0);
      expect(most).toBeLessThanOrEqual(12);
      // Returning to the top leaves no leaked editors.
      expect(mounted().length).toBe(initialCount);

      // Collapse all, jump to the 5,000th file, expand it, edit it, scroll back to top and return.
      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Collapse All Files" }));
      });
      scroll(scroller(), end);
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
      dirtyDocs = [99];
      scroll(scroller(), 0);
      // Still mounted with unsaved edit while scrolled 5,000 files away, and total editors stay bounded.
      expect(mounted()).toContain(last);
      expect(mounted().length).toBeLessThanOrEqual(initialCount + 1);
      scroll(scroller(), end);
      expect(screen.getByLabelText(`Edit ${last}`)).toBe(field);
      expect(field.value).toBe("edited 5000th file");
    } finally {
      _removeEditor(handle);
    }
  });
});
