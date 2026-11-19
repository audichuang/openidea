/**
 * Synchronized scrolling of the merge editor's three panes. Each side pane lines up with
 * the result through the changes between them (the diff viewer's SyncScrollSupport
 * mapping), and one side follows the other through the result.
 */
import { Chunk } from "@codemirror/merge";
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { bandAt, docOffset, extent, transferY } from "./diffScroll";
import { ideaDiffConfig } from "./diffOptions";

export type MergePane = "ours" | "result" | "theirs";
const PANES: readonly MergePane[] = ["ours", "result", "theirs"];
/** The panes a wheel over a pane is passed on to, first choice first: the result lines up with both sides. */
const RECEIVERS: Record<MergePane, readonly MergePane[]> = {
  ours: ["result", "theirs"],
  result: ["ours", "theirs"],
  theirs: ["result", "ours"],
};

/**
 * Scroll positions a pane was moved to by another one. A pane's scroll event arrives a
 * frame after the move, so it must be recognized as that move's echo: following it would
 * write back to the pane the user is scrolling and cancel the scroll in progress.
 */
export class ScrollEchoes<K> {
  private readonly moved = new Map<K, number>();

  /** `pane` was moved to `top`. */
  mark(pane: K, top: number) {
    this.moved.set(pane, top);
  }

  /** Whether a scroll event of `pane` at `top` is the echo of the last move (consumed either way). */
  take(pane: K, top: number): boolean {
    const moved = this.moved.get(pane);
    this.moved.delete(pane);
    return moved !== undefined && Math.abs(top - moved) <= 1;
  }
}

// Lined up by IDEA's line comparison. `Chunk.build` with no config runs an unbounded
// character diff, which takes minutes on a long file such as a lockfile.
const LINES = ideaDiffConfig("none", "lines");

/** Starts scrolling `views` together; returns the function that stops it. */
export function syncMergeScroll(views: Record<MergePane, EditorView>): () => void {
  const built = new Map<MergePane, { a: Text; b: Text; chunks: readonly Chunk[] }>();
  const chunks = (side: MergePane) => {
    const a = views[side].state.doc;
    const b = views.result.state.doc;
    const hit = built.get(side);
    if (hit && hit.a === a && hit.b === b) return hit.chunks;
    const fresh = Chunk.build(a, b, LINES);
    built.set(side, { a, b, chunks: fresh });
    return fresh;
  };
  /** Document y of `side` → the result (`toResult`), or back. */
  const transfer = (side: MergePane, y: number, toResult: boolean) => {
    const a = views[side];
    const b = views.result;
    const from = toResult ? "a" : "b";
    const band = bandAt(
      chunks(side),
      (c) => extent(a, c.fromA, c.toA),
      (c) => extent(b, c.fromB, c.toB),
      a.lineBlockAt(a.state.doc.length).bottom,
      b.lineBlockAt(b.state.doc.length).bottom,
      y,
      from,
    );
    return transferY([band], y, from);
  };
  const map = (from: MergePane, to: MergePane, y: number) => {
    if (to === "result") return transfer(from, y, true);
    if (from === "result") return transfer(to, y, false);
    return transfer(to, transfer(from, y, true), false);
  };

  const echoes = new ScrollEchoes<MergePane>();
  /**
   * Where a passed-on wheel left a pane: past where `from`, the pane the wheel was over, maps it,
   * in the wheel's direction `dir`. Only a wheel over `from` the other way takes that back.
   */
  const passed = new Map<MergePane, { from: MergePane; dir: number; top: number }>();
  /** Where `to` scrolls to match `from`, anchored a third down the pane. */
  const followTop = (from: MergePane, to: MergePane) => {
    const master = views[from];
    const anchor = master.scrollDOM.clientHeight / 3;
    const at = master.scrollDOM.scrollTop + anchor - docOffset(master);
    const el = views[to].scrollDOM;
    return Math.max(0, Math.min(map(from, to, at) + docOffset(views[to]) - anchor, el.scrollHeight - el.clientHeight));
  };
  /** Scrolls the other panes to match `from`. */
  const follow = (from: MergePane) => {
    for (const to of PANES) {
      if (to === from) continue;
      passed.delete(to);
      const el = views[to].scrollDOM;
      const top = followTop(from, to);
      if (Math.abs(el.scrollTop - top) < 1) continue;
      const before = el.scrollTop;
      el.scrollTop = top;
      if (el.scrollTop !== before) echoes.mark(to, el.scrollTop);
    }
  };

  const atEnd = (el: HTMLElement, dy: number) =>
    dy > 0 ? el.scrollTop + el.clientHeight >= el.scrollHeight - 1 : el.scrollTop <= 0;
  /**
   * A wheel over `side` that `side` cannot follow scrolls another pane, as in the two-pane diff
   * (`UnalignedPanes.passOn`): otherwise the end of a longer pane is reachable only with the
   * pointer over that pane. "also": `side` is at its end and a pane that can still scroll does;
   * "instead": a pane such a wheel over `side` took past where `side` maps it scrolls back first,
   * up to that position, when the wheel turns round, so `side` must not move (it would pull that
   * pane back in one jump). A pane that is elsewhere for another reason, such as a wheel passed on
   * from another pane or lines only it has above the others' first one, does not hold the wheel back.
   *
   * Over a side, one pane takes the wheel (the result first) and the others follow it. Over the
   * result, both sides take it and neither follows the other: a side past the result's end maps
   * the other one to its own end, which would skip that side's last lines.
   */
  const passOn = (side: MergePane, e: WheelEvent): "also" | "instead" | null => {
    if (!e.deltaY) return null;
    const view = views[side];
    const dy = e.deltaMode === 1 ? e.deltaY * view.defaultLineHeight : e.deltaY;
    const apart = side === "result";
    const dir = Math.sign(dy);
    /** Scrolls `panes` by the wheel, or back by no more than the `back` left to where `side` maps them. */
    const scroll = (panes: readonly MergePane[], back?: Map<MergePane, number>) => {
      for (const to of apart ? panes : panes.slice(0, 1)) {
        const el = views[to].scrollDOM;
        const before = el.scrollTop;
        const left = back?.get(to);
        el.scrollBy(0, left === undefined ? dy : dir * Math.min(Math.abs(dy), Math.abs(left)));
        if (el.scrollTop === before) continue;
        passed.set(to, { from: side, dir: back ? -dir : dir, top: el.scrollTop });
        if (apart) echoes.mark(to, el.scrollTop);
      }
    };
    const back = new Map<MergePane, number>();
    for (const to of RECEIVERS[side]) {
      const was = passed.get(to);
      if (was?.from !== side) continue;
      const left = followTop(side, to) - views[to].scrollDOM.scrollTop;
      if (Math.abs(left) <= 1) passed.delete(to);
      else if (was.dir !== dir && Math.sign(left) === dir) back.set(to, left);
    }
    if (back.size) {
      scroll([...back.keys()], back);
      return "instead";
    }
    if (!atEnd(view.scrollDOM, dy)) return null;
    const free = RECEIVERS[side].filter((to) => !atEnd(views[to].scrollDOM, dy));
    if (!free.length) return null;
    scroll(free);
    return "also";
  };

  const offs = PANES.map((pane) => {
    const el = views[pane].scrollDOM;
    const onScroll = () => {
      // Scrolled by the user since the wheel that was passed on to it.
      const left = passed.get(pane);
      if (left !== undefined && Math.abs(el.scrollTop - left.top) > 1) passed.delete(pane);
      if (!echoes.take(pane, el.scrollTop)) follow(pane);
    };
    const onWheel = (e: WheelEvent) => {
      if (passOn(pane, e) === "instead") e.preventDefault();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
    };
  });
  return () => offs.forEach((off) => off());
}
