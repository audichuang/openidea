import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { EditorView } from "@codemirror/view";
import type { ConsoleMatch } from "@/ui/consoleFind";
import { ResponseBody } from "./ResponseBody";
import { DISPLAY_LINE, displayText, docPosition } from "./displayLines";

/** A line longer than a display line, with `needle` across its first split. */
const text = `${"a".repeat(DISPLAY_LINE - 1)}needle${"b".repeat(100)}`;
const match: ConsoleMatch = { line: 0, lineId: 0, start: DISPLAY_LINE - 1, end: DISPLAY_LINE + 5 };
const d = displayText(text);
const whole = { from: docPosition(d, 0, match.start), to: docPosition(d, 0, match.end, true) };

type ScrollSpy = MockInstance<typeof EditorView.scrollIntoView>;

/** The document range each `EditorView.scrollIntoView` call targets. */
function targets(spy: ScrollSpy) {
  return spy.mock.calls.map(([pos]) =>
    typeof pos === "number" ? { from: pos, to: pos } : { from: pos.from, to: pos.to },
  );
}

const observers: { callback: ResizeObserverCallback; targets: Element[] }[] = [];

describe("response body scroll to the current find match", () => {
  let scroll: ScrollSpy;
  beforeEach(() => {
    Element.prototype.scrollIntoView ??= () => {};
    observers.length = 0;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        entry: { callback: ResizeObserverCallback; targets: Element[] };
        constructor(callback: ResizeObserverCallback) {
          this.entry = { callback, targets: [] };
          observers.push(this.entry);
        }
        observe(el: Element) {
          this.entry.targets.push(el);
        }
        unobserve() {}
        disconnect() {}
      },
    );
    scroll = vi.spyOn(EditorView, "scrollIntoView");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("scrolls to the whole of a match that spans a split of a long line, also once the font has loaded", async () => {
    render(<ResponseBody text={text} matches={[match]} current={0} />);
    expect(d.doc.lineAt(whole.from).number).not.toBe(d.doc.lineAt(whole.to).number);
    // To the start of the text shown, then to the match.
    expect(targets(scroll)).toEqual([{ from: 0, to: 0 }, whole]);
    // jsdom loads no fonts: the scroll after the font has loaded follows at once.
    await waitFor(() => expect(targets(scroll)).toEqual([{ from: 0, to: 0 }, whole, whole]));
  });

  it("scrolls to the current match again when the pane's width changes, not its height", async () => {
    const { container } = render(<ResponseBody text={text} matches={[match]} current={0} />);
    const scroller = container.querySelector(".cm-scroller") as HTMLElement;
    const resize = (width: number) => {
      Object.defineProperty(scroller, "clientWidth", { configurable: true, get: () => width });
      for (const o of observers.filter((o) => o.targets.includes(scroller)))
        o.callback([{ target: scroller } as unknown as ResizeObserverEntry], {} as ResizeObserver);
    };
    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(3));
    scroll.mockClear();
    resize(400); // The width it had: a height change only.
    await new Promise((r) => setTimeout(r, 50));
    expect(scroll).not.toHaveBeenCalled();
    resize(300);
    await waitFor(() => expect(targets(scroll).at(-1)).toEqual(whole));
  });
});
