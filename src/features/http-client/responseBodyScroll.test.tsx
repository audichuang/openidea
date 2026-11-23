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
    // jsdom lays nothing out: every position is at 0, in the scroller's box at 0 (on screen).
    vi.spyOn(EditorView.prototype, "coordsAtPos").mockReturnValue({ top: 0, bottom: 0, left: 0, right: 0 });
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

  it("leaves the view where it is on a width change when the match was scrolled out of view before it", async () => {
    const coords = vi.mocked(EditorView.prototype.coordsAtPos);
    const { container } = render(<ResponseBody text={text} matches={[match]} current={0} />);
    const scroller = container.querySelector(".cm-scroller") as HTMLElement;
    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(3));
    // Scrolled away: the match is below the scroller's box.
    coords.mockReturnValue({ top: 1000, bottom: 1017, left: 0, right: 0 });
    scroller.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 50));
    scroll.mockClear();
    Object.defineProperty(scroller, "clientWidth", { configurable: true, get: () => 300 });
    for (const o of observers.filter((o) => o.targets.includes(scroller)))
      o.callback([{ target: scroller } as unknown as ResizeObserverEntry], {} as ResizeObserver);
    await new Promise((r) => setTimeout(r, 50));
    expect(scroll).not.toHaveBeenCalled();
  });

  it("brings the match back when the pane was laid out narrower and scrolled before its resize observer ran", async () => {
    const coords = vi.mocked(EditorView.prototype.coordsAtPos);
    const { container } = render(<ResponseBody text={text} matches={[match]} current={0} />);
    const scroller = container.querySelector(".cm-scroller") as HTMLElement;
    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(3));
    await new Promise((r) => setTimeout(r, 50));
    scroll.mockClear();
    // A splitter drag: the pane is already narrower, its lines rewrapped push the match below, and the scroll this
    // causes is handled before the resize observer reports the new width.
    Object.defineProperty(scroller, "clientWidth", { configurable: true, get: () => 300 });
    coords.mockReturnValue({ top: 2500, bottom: 2517, left: 0, right: 0 });
    scroller.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 50));
    for (const o of observers.filter((o) => o.targets.includes(scroller)))
      o.callback([{ target: scroller } as unknown as ResizeObserverEntry], {} as ResizeObserver);
    await waitFor(() => expect(targets(scroll).at(-1)).toEqual(whole));
  });

  it("brings the match back after a splitter drag through many widths, with scrolls in between", async () => {
    const coords = vi.mocked(EditorView.prototype.coordsAtPos);
    const { container } = render(<ResponseBody text={text} matches={[match]} current={0} />);
    const scroller = container.querySelector(".cm-scroller") as HTMLElement;
    const observed = () => observers.filter((o) => o.targets.includes(scroller));
    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(3));
    await new Promise((r) => setTimeout(r, 50));
    scroll.mockClear();
    // Each step: laid out narrower (the rewrapped lines push the match below), a scroll read, then the resize
    // observer; the scroll back from one step is overtaken by the next.
    coords.mockReturnValue({ top: 2500, bottom: 2517, left: 0, right: 0 });
    for (let width = 390; width >= 300; width -= 10) {
      Object.defineProperty(scroller, "clientWidth", { configurable: true, get: () => width });
      scroller.dispatchEvent(new Event("scroll"));
      for (const o of observed())
        o.callback([{ target: scroller } as unknown as ResizeObserverEntry], {} as ResizeObserver);
      await new Promise((r) => setTimeout(r, 5));
      scroller.dispatchEvent(new Event("scroll"));
      await new Promise((r) => setTimeout(r, 5));
    }
    const during = scroll.mock.calls.length;
    // The drag has ended: the match ends up on screen once scrolled back to.
    await waitFor(() => expect(scroll.mock.calls.length).toBeGreaterThan(during));
    expect(targets(scroll).at(-1)).toEqual(whole);
  });
});
