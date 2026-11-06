/**
 * Per-change controls of the diff viewer, as in IDEA: ">>" / "<<" apply arrows
 * in the divider (toward each editable side) and a Revert button shown while
 * hovering a change in an editable pane.
 */
import { StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from "@codemirror/view";
import { getChunks, getOriginalDoc, type Chunk, type MergeView } from "@codemirror/merge";
import { tx } from "@/platform/i18n";
import { iconMarkup } from "@/ui";
import { transferChunk } from "./diffOptions";

/** Copies chunk `index` of `mv` from `source` to the other side (an undoable user edit). */
export function applyChunk(mv: MergeView, index: number, source: "a" | "b") {
  const chunk = mv.chunks[index];
  if (!chunk) return;
  const [src, dst] = source === "a" ? [mv.a, mv.b] : [mv.b, mv.a];
  dst.dispatch({ changes: transferChunk(chunk, source, src.state.doc, dst.state.doc), userEvent: "revert" });
}

/** Reverts a unified change with the same line-boundary handling as the split viewer. */
export function revertUnifiedChunk(view: EditorView, pos: number) {
  const chunk = getChunks(view.state)?.chunks.find((c) => c.fromB <= pos && c.endB >= pos);
  if (!chunk) return;
  view.dispatch({
    changes: transferChunk(chunk, "a", getOriginalDoc(view.state), view.state.doc),
    userEvent: "revert",
  });
}

export type ArrowDir = "a-to-b" | "b-to-a";
/** `apply` copies the chunk across; `revert` is that copy onto the working copy of a
 * staging diff (index ↔ working tree); `stage` adds the working copy's hunk to the index. */
export type ArrowAction = "apply" | "revert" | "stage";
export interface DiffArrow {
  dir: ArrowDir;
  action: ArrowAction;
}

export interface ArrowSides {
  /** The left side is editable. */
  toA: boolean;
  /** The right side is editable. */
  toB: boolean;
  /** Index ↔ working tree: the right-hand arrow discards, and a stage control is added. */
  staging?: boolean;
}

/** The per-chunk controls of a split diff, in display order. */
export function diffArrows(sides: ArrowSides): DiffArrow[] {
  const staging = !!sides.staging && sides.toB;
  const arrows: DiffArrow[] = [];
  if (sides.toB) arrows.push({ dir: "a-to-b", action: staging ? "revert" : "apply" });
  if (sides.toA) arrows.push({ dir: "b-to-a", action: "apply" });
  if (staging) arrows.push({ dir: "b-to-a", action: "stage" });
  return arrows;
}

/** Tooltip and icon of a control. */
export function arrowLook(arrow: DiffArrow): { label: string; icon: string } {
  switch (arrow.action) {
    case "revert":
      return { label: tx("Revert to staged version"), icon: "revert" };
    case "stage":
      return { label: tx("Stage this change (git add hunk)"), icon: "plus" };
    default:
      return arrow.dir === "a-to-b"
        ? { label: tx("Apply change to the right (Replace ›››)"), icon: "chevron-right" }
        : { label: tx("Apply change to the left (‹‹‹ Replace)"), icon: "chevron-left" };
  }
}

/** Runs `arrow` on a chunk of a split diff; `stage` stages that chunk. */
export function runArrow(mv: MergeView | null, arrow: DiffArrow, index: number, stage?: (index: number) => void) {
  if (arrow.action === "stage") stage?.(index);
  else if (mv) applyChunk(mv, index, arrow.dir === "a-to-b" ? "a" : "b");
}

/** A divider control; the chunk index comes from the nearest `data-chunk` (itself included). */
export function arrowButton(arrow: DiffArrow, run: (chunkIndex: number) => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `cm-diffArrow cm-diffArrow-${arrow.dir} cm-diffArrow-${arrow.action}`;
  const { label, icon } = arrowLook(arrow);
  btn.setAttribute("aria-label", label);
  btn.title = label;
  btn.innerHTML = iconMarkup(icon, 12) ?? "";
  btn.addEventListener("mousedown", (e) => {
    // Handled here rather than by MergeView's own (one-directional) revert handler.
    e.preventDefault();
    e.stopPropagation();
    const holder = (e.currentTarget as HTMLElement).closest<HTMLElement>("[data-chunk]");
    const index = Number(holder?.dataset.chunk);
    if (Number.isInteger(index)) run(index);
  });
  return btn;
}

/**
 * `renderRevertControl` for MergeView: the controls of `diffArrows` per chunk.
 * `stage` stages chunk `index` of a staging diff.
 */
export function arrowControls(
  getView: () => MergeView | null,
  sides: ArrowSides,
  stage?: (index: number) => void,
): () => HTMLElement {
  const arrows = diffArrows(sides);
  return () => {
    const box = document.createElement("div");
    box.className = "cm-diffArrows";
    // The wrapper carries `data-chunk`; a press between buttons must not reach MergeView's a-to-b revert.
    box.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    for (const arrow of arrows) box.appendChild(arrowButton(arrow, (i) => runArrow(getView(), arrow, i, stage)));
    return box;
  };
}

const setHover = StateEffect.define<number | null>();

class RevertWidget extends WidgetType {
  constructor(
    readonly index: number,
    readonly onRevert: (view: EditorView, index: number) => void,
    readonly label: string,
  ) {
    super();
  }
  eq(other: RevertWidget) {
    return other.index === this.index && other.label === this.label;
  }
  toDOM(view: EditorView) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cm-diffHoverRevert";
    btn.title = this.label;
    btn.setAttribute("aria-label", this.label);
    btn.innerHTML = `${iconMarkup("revert", 12) ?? ""}<span>Revert</span>`;
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onRevert(view, this.index);
    });
    return btn;
  }
  ignoreEvent() {
    return true;
  }
}

export function chunkAt(chunks: readonly Chunk[], side: "a" | "b", pos: number, docLength: number): number {
  return chunks.findIndex((c) => {
    const [from, to] = side === "a" ? [c.fromA, c.toA] : [c.fromB, c.toB];
    return from === to ? pos === from : pos >= from && pos < Math.max(to, from + 1) && pos <= docLength;
  });
}

/**
 * A "Revert" button at the first line of the change under the mouse, for an
 * editable pane of a split diff. `onRevert` copies the other side's content.
 */
export function hoverRevert(
  onRevert: (view: EditorView, index: number) => void,
  label = "Revert this change",
): Extension {
  const field = StateField.define<{ index: number | null; deco: DecorationSet }>({
    create: () => ({ index: null, deco: Decoration.none }),
    update(value, tr) {
      let index = value.index;
      for (const e of tr.effects) if (e.is(setHover)) index = e.value;
      const info = getChunks(tr.state);
      if (index !== null && (!info || index >= info.chunks.length)) index = null;
      if (index === value.index && !tr.docChanged && getChunks(tr.startState) === info) return value;
      const decos: Range<Decoration>[] = [];
      const chunk = index !== null ? info?.chunks[index] : undefined;
      if (chunk && info?.side) {
        const from = info.side === "a" ? chunk.fromA : chunk.fromB;
        const line = tr.state.doc.lineAt(Math.min(from, tr.state.doc.length));
        decos.push(Decoration.line({ class: "cm-diffHoverLine" }).range(line.from));
        decos.push(Decoration.widget({ widget: new RevertWidget(index!, onRevert, label), side: 1 }).range(line.to));
      }
      return { index, deco: Decoration.set(decos, true) };
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
  });
  const tracker = ViewPlugin.fromClass(
    class {
      constructor(readonly view: EditorView) {}
      set(index: number | null) {
        if (this.view.state.field(field).index !== index) this.view.dispatch({ effects: setHover.of(index) });
      }
    },
    {
      eventHandlers: {
        mousemove(e) {
          const info = getChunks(this.view.state);
          if (!info?.side) return;
          const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
          const line = this.view.state.doc.lineAt(pos);
          const i = chunkAt(info.chunks, info.side, line.from, this.view.state.doc.length);
          this.set(i >= 0 ? i : null);
        },
        mouseleave() {
          this.set(null);
        },
      },
    },
  );
  return [field, tracker];
}
