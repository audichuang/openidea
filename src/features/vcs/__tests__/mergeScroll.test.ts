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

  /**
   * Panes of `lines` lines each, LINE px tall, sharing their first lines: a longer pane has more at
   * its end. A pane's `lead` lines come above those, and only it has them.
   */
  function panes(lines: Record<MergePane, number>, lead: Partial<Record<MergePane, number>> = {}) {
    const view = (shared: number, own = 0) => {
      const count = own + shared;
      const text = Text.of(Array.from({ length: count }, (_, i) => (i < own ? `lead ${i}` : `line ${i - own}`)));
      const scrollDOM = document.createElement("div");
      Object.defineProperty(scrollDOM, "scrollHeight", { value: count * LINE });
      Object.defineProperty(scrollDOM, "clientHeight", { value: HEIGHT });
      scrollDOM.scrollBy = vi.fn((_x: number, y: number) => {
        scrollDOM.scrollTop = Math.max(0, Math.min(scrollDOM.scrollTop + y, count * LINE - HEIGHT));
      }) as unknown as typeof scrollDOM.scrollBy;
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
    const views = {
      ours: view(lines.ours, lead.ours),
      result: view(lines.result, lead.result),
      theirs: view(lines.theirs, lead.theirs),
    };
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
    /** The scroll events of the panes moved since the last call arrive. */
    const seen = { ours: 0, result: 0, theirs: 0 };
    const settle = () => {
      const moved = (["ours", "result", "theirs"] as const).filter((pane) => el(pane).scrollTop !== seen[pane]);
      for (const pane of moved) el(pane).dispatchEvent(new Event("scroll"));
      for (const pane of ["ours", "result", "theirs"] as const) seen[pane] = el(pane).scrollTop;
    };
    const passed = (pane: MergePane) => vi.mocked(el(pane).scrollBy);
    return { el, wheel, scroll, settle, passed, stop };
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
    // Theirs is at its end as well.
    expect(p.passed("theirs")).not.toHaveBeenCalled();
    p.stop();
  });

  it("passes it to both sides, each scrolling through its own end", () => {
    const p = panes({ ours: 200, result: 50, theirs: 300 });
    p.scroll("result", 50 * LINE - HEIGHT);
    const [ours, theirs] = [p.el("ours").scrollTop, p.el("theirs").scrollTop];
    p.settle();
    for (let i = 0; i < 10; i++) {
      p.wheel("result", 120);
      p.settle();
    }
    // Neither follows the other: ours past the result's end would map theirs to its very end.
    expect(p.el("ours").scrollTop).toBe(ours + 1200);
    expect(p.el("theirs").scrollTop).toBe(theirs + 1200);
    expect(p.el("result").scrollTop).toBe(50 * LINE - HEIGHT);
    // Ours at its end: theirs goes on alone.
    p.el("ours").scrollTop = 200 * LINE - HEIGHT;
    p.passed("ours").mockClear();
    p.wheel("result", 120);
    expect(p.passed("ours")).not.toHaveBeenCalled();
    expect(p.el("theirs").scrollTop).toBe(theirs + 1320);

    // Back up: both sides return to where the result maps them before the result moves.
    expect(p.wheel("result", -120)).toBe(true);
    p.settle();
    expect(p.el("ours").scrollTop).toBe(200 * LINE - HEIGHT - 120);
    expect(p.el("theirs").scrollTop).toBe(theirs + 1200);
    expect(p.passed("result")).not.toHaveBeenCalled();
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

  /** Ours taken to 3000 by wheels over the result at its end, past where the result maps it. */
  function oursPassedOn() {
    const p = panes({ ours: 200, result: 50, theirs: 50 });
    p.scroll("result", 50 * LINE - HEIGHT);
    p.settle();
    p.wheel("result", 3000 - p.el("ours").scrollTop);
    p.settle();
    expect(p.el("ours").scrollTop).toBe(3000);
    return p;
  }

  it("scrolls a pane back first when a passed-on wheel took it past where this one maps it", () => {
    const p = oursPassedOn();
    // Instead of the result, whose own scroll would pull ours back in one jump.
    expect(p.wheel("result", -3, WheelEvent.DOM_DELTA_LINE)).toBe(true);
    expect(p.passed("ours")).toHaveBeenLastCalledWith(0, -3 * LINE);
    // Theirs is where the result maps it, and does not follow ours.
    p.settle();
    expect(p.passed("theirs")).not.toHaveBeenCalled();
    expect(p.passed("result")).not.toHaveBeenCalled();
    expect(p.el("theirs").scrollTop).toBeLessThan(50 * LINE - HEIGHT + 2 * LINE);
    expect(p.el("ours").scrollTop).toBe(3000 - 3 * LINE);
    // And on the next wheel as well.
    expect(p.wheel("result", -120)).toBe(true);
    p.settle();
    expect(p.el("ours").scrollTop).toBe(3000 - 3 * LINE - 120);
    p.stop();
  });

  it("leaves the wheel to a pane whose sides are elsewhere without a wheel passed on", () => {
    // Ours starts with 1,000 lines of its own: the result's first lines map far down it.
    const p = panes({ ours: 300, result: 300, theirs: 300 }, { ours: 1000 });
    for (let i = 0; i < 3; i++) {
      expect(p.wheel("result", 120)).toBe(false);
      p.settle();
    }
    expect(p.passed("ours")).not.toHaveBeenCalled();
    expect(p.passed("theirs")).not.toHaveBeenCalled();
    p.stop();
  });

  it("forgets a passed-on wheel once the user scrolls that pane", () => {
    const p = oursPassedOn();
    p.scroll("ours", 2000);
    p.passed("ours").mockClear();
    expect(p.wheel("result", -120)).toBe(false);
    expect(p.passed("ours")).not.toHaveBeenCalled();
    p.stop();
  });

  it("forgets a passed-on wheel once that pane is back where this one maps it", () => {
    const p = panes({ ours: 200, result: 50, theirs: 50 });
    p.scroll("result", 50 * LINE - HEIGHT);
    p.settle();
    p.wheel("result", 120);
    p.settle();
    expect(p.wheel("result", -120)).toBe(true);
    p.settle();
    p.passed("ours").mockClear();
    expect(p.wheel("result", -120)).toBe(false);
    // Elsewhere again, by something other than a wheel passed on.
    p.el("ours").scrollTop = 3000;
    expect(p.wheel("result", -120)).toBe(false);
    expect(p.passed("ours")).not.toHaveBeenCalled();
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
