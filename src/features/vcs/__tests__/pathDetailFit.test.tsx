import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { ChangesTree } from "../CommitView";
import { useCommit } from "../commitStore";
import { useVcs } from "../store";

const DIR = "src/main/initialization";

type Callback = (entries: ResizeObserverEntry[]) => void;
const observers: { callback: Callback; targets: Element[] }[] = [];
let charWidth = 5;

class RecordingResizeObserver {
  private readonly record: { callback: Callback; targets: Element[] };
  constructor(callback: Callback) {
    this.record = { callback, targets: [] };
    observers.push(this.record);
  }
  observe(target: Element) {
    this.record.targets.push(target);
  }
  unobserve() {}
  disconnect() {
    this.record.targets = [];
  }
}

/** Fires every observer watching `target`, as the browser does when that box's size changes. */
function resized(target: Element, width: number) {
  for (const o of observers.filter((o) => o.targets.includes(target)))
    o.callback([{ target, contentRect: { width } } as unknown as ResizeObserverEntry]);
}

beforeEach(() => {
  observers.length = 0;
  charWidth = 5;
  vi.stubGlobal("ResizeObserver", RecordingResizeObserver);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    font: "",
    measureText: (t: string) => ({ width: Array.from(t).length * charWidth }),
  } as unknown as CanvasRenderingContext2D);
  useVcs.setState({
    root: "/p",
    roots: ["/p"],
    status: [
      {
        path: `/p/${DIR}/Main.java`,
        relPath: `${DIR}/Main.java`,
        staged: null,
        unstaged: "modified",
        renamedFrom: null,
      },
    ],
  });
  useCommit.setState({ groupByDir: false, checks: new Map(), selection: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("flat-mode path detail", () => {
  it("refits when the font changes while its box keeps the same width", () => {
    render(<ChangesTree mode="commit" />);
    const box = screen.getByTitle(DIR);
    const sizer = box.firstElementChild!;
    const text = box.lastElementChild!;
    // 23 characters at 5px fit a 120px box.
    act(() => resized(box, 120));
    expect(text.textContent).toBe(DIR);

    // A wider UI font (or a web font finishing loading) grows only the full-path sizer.
    charWidth = 10;
    act(() => resized(sizer, DIR.length * charWidth));
    expect(text.textContent).not.toBe(DIR);
    expect(Array.from(text.textContent!).length * charWidth).toBeLessThanOrEqual(120);
    expect(text.textContent).toContain("…");
  });
});
