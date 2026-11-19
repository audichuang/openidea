import { describe, expect, it, vi } from "vitest";
import { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { ScrollEchoes, syncMergeScroll, type MergePane } from "../mergeScroll";

describe("ScrollEchoes", () => {
  it("recognizes the scroll event a move causes, once", () => {
    const echoes = new ScrollEchoes<string>();
    echoes.mark("result", 120);
    // The browser may round the position it scrolled to.
    expect(echoes.take("result", 120.5)).toBe(true);
    // The next event of that pane is the user's.
    expect(echoes.take("result", 120.5)).toBe(false);
  });

  it("treats a pane the user scrolled past the move as the user's", () => {
    const echoes = new ScrollEchoes<string>();
    echoes.mark("theirs", 120);
    expect(echoes.take("theirs", 180)).toBe(false);
    expect(echoes.take("ours", 0)).toBe(false);
  });

  it("keeps moves of each pane apart", () => {
    const echoes = new ScrollEchoes<string>();
    echoes.mark("ours", 10);
    echoes.mark("theirs", 40);
    expect(echoes.take("theirs", 40)).toBe(true);
    expect(echoes.take("ours", 10)).toBe(true);
  });
});

describe("wheel over a pane that cannot scroll further", () => {
  const LINE = 20;
  const HEIGHT = 500;

  /** Panes of `lines` lines each, LINE px tall, sharing their first lines: a longer pane has more at its end. */
  function panes(lines: Record<MergePane, number>) {
    const view = (count: number) => {
      const text = Text.of(Array.from({ length: count }, (_, i) => `line ${i}`));
      const scrollDOM = document.createElement("div");
      Object.defineProperty(scrollDOM, "scrollHeight", { value: count * LINE });
      Object.defineProperty(scrollDOM, "clientHeight", { value: HEIGHT });
      scrollDOM.scrollBy = vi.fn() as unknown as typeof scrollDOM.scrollBy;
      return {
        scrollDOM,
        defaultLineHeight: LINE,
        state: { doc: text },
        get documentTop() {
          return -scrollDOM.scrollTop;
        },
        lineBlockAt: (pos: number) => {
          const line = text.lineAt(pos).number;
          return { top: (line - 1) * LINE, bottom: line * LINE };
        },
      } as unknown as EditorView;
    };
    const views = { ours: view(lines.ours), result: view(lines.result), theirs: view(lines.theirs) };
    const stop = syncMergeScroll(views);
    const el = (pane: MergePane) => views[pane].scrollDOM;
    const wheel = (pane: MergePane, deltaY: number, deltaMode = 0) => {
      const e = new WheelEvent("wheel", { deltaY, deltaMode, cancelable: true });
      el(pane).dispatchEvent(e);
      return e.defaultPrevented;
    };
    /** The user scrolls `pane` to `top`; the others follow. */
    const scroll = (pane: MergePane, top: number) => {
      el(pane).scrollTop = top;
      el(pane).dispatchEvent(new Event("scroll"));
    };
    const passed = (pane: MergePane) => vi.mocked(el(pane).scrollBy);
    return { el, wheel, scroll, passed, stop };
  }

  it("passes a wheel over the result at its end to the side that has more below", () => {
    const p = panes({ ours: 200, result: 50, theirs: 50 });
    const end = 50 * LINE - HEIGHT;
    p.scroll("result", end);
    // The dead end: the result is at its end and ours stays where the result maps it, far from its own.
    expect(p.el("ours").scrollTop).toBeLessThan(end + 2 * LINE);
    expect(200 * LINE - HEIGHT).toBeGreaterThan(end + 100 * LINE);

    expect(p.wheel("result", 120)).toBe(false);
    expect(p.passed("ours")).toHaveBeenLastCalledWith(0, 120);
    // One pane takes the wheel: the others follow it.
    expect(p.passed("theirs")).not.toHaveBeenCalled();
    p.stop();
  });

  it("passes it to the other side once the first one is at its end too", () => {
    const p = panes({ ours: 200, result: 50, theirs: 300 });
    p.scroll("result", 50 * LINE - HEIGHT);
    p.el("ours").scrollTop = 200 * LINE - HEIGHT;
    p.wheel("result", 120);
    expect(p.passed("ours")).not.toHaveBeenCalled();
    expect(p.passed("theirs")).toHaveBeenLastCalledWith(0, 120);
    p.stop();
  });

  it("passes a wheel over a side at its end to the result", () => {
    const p = panes({ ours: 25, result: 200, theirs: 200 });
    p.scroll("ours", 0);
    expect(p.wheel("ours", 120)).toBe(false);
    expect(p.passed("result")).toHaveBeenLastCalledWith(0, 120);
    expect(p.passed("theirs")).not.toHaveBeenCalled();
    p.stop();
  });

  it("scrolls a pane back first when it went past where this one maps it", () => {
    const p = panes({ ours: 200, result: 50, theirs: 50 });
    p.scroll("result", 50 * LINE - HEIGHT);
    p.el("ours").scrollTop = 3000;
    // Instead of the result, whose own scroll would pull ours back in one jump.
    expect(p.wheel("result", -3, WheelEvent.DOM_DELTA_LINE)).toBe(true);
    expect(p.passed("ours")).toHaveBeenLastCalledWith(0, -3 * LINE);
    expect(p.passed("theirs")).not.toHaveBeenCalled();
    expect(p.passed("result")).not.toHaveBeenCalled();
    p.stop();
  });

  it("leaves the wheel to a pane that can scroll and has the others where it maps them", () => {
    const p = panes({ ours: 200, result: 50, theirs: 50 });
    expect(p.wheel("ours", 120)).toBe(false);
    p.scroll("result", 200);
    expect(p.wheel("result", 120)).toBe(false);
    expect(p.wheel("result", -120)).toBe(false);
    for (const pane of ["ours", "result", "theirs"] as const) expect(p.passed(pane)).not.toHaveBeenCalled();
    p.stop();
  });

  it("stops with the synchronization", () => {
    const p = panes({ ours: 200, result: 25, theirs: 25 });
    p.stop();
    p.wheel("result", 120);
    expect(p.passed("ours")).not.toHaveBeenCalled();
  });
});
