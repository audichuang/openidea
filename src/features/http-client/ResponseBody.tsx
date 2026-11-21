/**
 * The response body in a read-only CodeMirror view: only the visible part of
 * the text is laid out, so a body of many megabytes opens, scrolls and
 * searches without laying out all of it. Long lines are split for display
 * (`displayLines.ts`). Select All and Copy take the whole text as received,
 * as in a read-only editor.
 */
import { useEffect, useRef, type MutableRefObject } from "react";
import clsx from "clsx";
import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap, type DecorationSet } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import type { ConsoleMatch } from "@/ui/consoleFind";
import { displayText, displayed, docPosition, setDisplayText, textBetween } from "./displayLines";
import { tx } from "@/platform/i18n";
import styles from "./HttpClient.module.css";

interface MarkRange {
  from: number;
  to: number;
  current: boolean;
}

const setMarks = StateEffect.define<MarkRange[]>();

const matchMark = Decoration.mark({ tagName: "mark", class: styles.match });
const currentMark = Decoration.mark({
  tagName: "mark",
  class: clsx(styles.match, styles.matchCurrent),
  attributes: { "data-find-current": "" },
});

/** The find matches. */
const marks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects)
      if (e.is(setMarks))
        value = Decoration.set(
          e.value.map((m) => (m.current ? currentMark : matchMark).range(m.from, m.to)),
          true,
        );
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const resync = StateEffect.define<number>();
let resyncs = 0;

/** A one-character mark whose only purpose is to make the editor redraw its lines. */
const resyncMark = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects)
      if (e.is(resync) && e.value < tr.state.doc.length)
        value = Decoration.set(
          Decoration.mark({ attributes: { "data-resync": String(++resyncs) } }).range(e.value, e.value + 1),
        );
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * A body taller than the editor's DOM height limit is drawn scaled. A jump far
 * into it (the scrollbar dragged to the end) can end the measure loop with
 * "Viewport failed to stabilize": the new viewport is recorded but its lines
 * are never drawn, leaving a blank gap until the next scroll. When the drawn
 * lines lie outside the viewport (and the selection's lines), redraw.
 */
const redrawStaleViewport = EditorView.updateListener.of((u) => {
  if (u.transactions.length || !u.viewportChanged) return;
  const { view } = u;
  const { from, to } = view.viewport;
  const { anchor, head } = view.state.selection.main;
  const drawn = (pos: number) =>
    (pos >= from && pos <= to) || [anchor, head].some((p) => view.state.doc.lineAt(p).from === pos);
  const lines = view.contentDOM.querySelectorAll(".cm-line");
  const ends = [lines[0], lines[lines.length - 1]].filter((l) => l != null);
  if (ends.some((l) => !drawn(view.state.doc.lineAt(view.posAtDOM(l)).from)))
    view.dispatch({ effects: resync.of(from) });
});

/**
 * The browser's Select All (WebKit's Edit menu, `execCommand`) selects only the
 * lines drawn. CodeMirror takes that for the whole document in Chrome and iOS
 * only; do the same in every browser: a selection read from the page that
 * grows to cover the drawn lines exactly selects all.
 */
const selectAllDrawn = EditorView.updateListener.of((u) => {
  if (!u.transactions.some((tr) => tr.isUserEvent("select") && !tr.isUserEvent("select.pointer"))) return;
  const { view } = u;
  const { from, to } = view.state.selection.main;
  const before = u.startState.selection.main;
  if (from > before.from || to < before.to) return;
  const { viewport } = view;
  const length = view.state.doc.length;
  if (from === to || (viewport.from === 0 && viewport.to === length)) return;
  const fromTop = from === 0 || viewport.from - from === 0 || viewport.from - from === 1;
  const toBottom = to === length || viewport.to - to === 0 || viewport.to - to === -1;
  if (fromTop && toBottom && (from > 0 || to < length)) view.dispatch({ selection: { anchor: 0, head: length } });
});

function extensions(): Extension[] {
  return [
    EditorState.readOnly.of(true),
    // Lines as the find bar counts them (`\n` only), and `\r` kept in the text and copies.
    EditorState.lineSeparator.of("\n"),
    EditorView.lineWrapping,
    keymap.of(defaultKeymap),
    EditorView.contentAttributes.of({ "aria-label": tx("Response body") }),
    marks,
    resyncMark,
    redrawStaleViewport,
    selectAllDrawn,
    displayed,
    // Copies and drags take the text as received, without the splits of long lines.
    EditorView.clipboardOutputFilter.of((copied, state) => {
      const ranges = state.selection.ranges.filter((r) => !r.empty);
      return ranges.length ? ranges.map((r) => textBetween(state, r.from, r.to)).join(state.lineBreak) : copied;
    }),
  ];
}

/**
 * Puts `text` into the view, from its start. It replaces the document of the
 * same state rather than starting a new one, which keeps the line metrics the
 * view has measured.
 */
function show(v: EditorView, text: string) {
  const d = displayText(text);
  v.dispatch({
    changes: { from: 0, to: v.state.doc.length, insert: d.doc },
    selection: { anchor: 0 },
    effects: [setDisplayText.of(d), EditorView.scrollIntoView(0, { y: "start" })],
  });
}

/** Marks the find matches, scrolling to the current one. */
function mark(v: EditorView, matches: readonly ConsoleMatch[], current: number) {
  const d = v.state.field(displayed);
  const ranges = matches.map((m, i) => ({
    from: docPosition(d, m.line, m.start),
    to: docPosition(d, m.line, m.end, true),
    current: i === current,
  }));
  const at = ranges[current];
  v.dispatch({
    effects: [setMarks.of(ranges), ...(at ? [EditorView.scrollIntoView(at.from, { y: "nearest", x: "nearest" })] : [])],
  });
}

export function ResponseBody({
  text,
  matches,
  current,
  viewRef,
}: {
  text: string;
  /** Find matches in `text` split at `\n`, in document order. */
  matches: readonly ConsoleMatch[];
  current: number;
  viewRef?: MutableRefObject<EditorView | null>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  /** The text in the document. */
  const shown = useRef(text);

  useEffect(() => {
    const v = new EditorView({ parent: host.current!, state: EditorState.create({ extensions: extensions() }) });
    view.current = v;
    if (viewRef) viewRef.current = v;
    show(v, text);
    return () => {
      v.destroy();
      view.current = null;
      if (viewRef) viewRef.current = null;
    };
    // The view is created once; text changes replace its document below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const v = view.current;
    if (!v || shown.current === text) return;
    shown.current = text;
    show(v, text);
  }, [text]);

  // After the effects above: the marks are for the text in the document.
  useEffect(() => {
    const v = view.current;
    if (v) mark(v, matches, current);
  }, [text, matches, current]);

  return <div ref={host} className={styles.responseBody} />;
}
