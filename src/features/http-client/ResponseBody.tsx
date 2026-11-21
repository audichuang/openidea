/**
 * The response body in a read-only CodeMirror view: only the visible part of
 * the text is laid out, so a body of many megabytes (or one very long line)
 * opens, scrolls and searches without laying out all of it. Select All and
 * Copy take the whole text, as in a read-only editor.
 */
import { useEffect, useRef, type MutableRefObject } from "react";
import clsx from "clsx";
import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap, type DecorationSet } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import type { ConsoleMatch } from "@/ui/consoleFind";
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

/** Longer lines are drawn only in part (twice the editor's 10,000-character wrapped-line margin). */
const LONG_LINE = 20_000;
const measured = new WeakSet<EditorView>();

/**
 * The part of a long line that is not drawn gets a height estimated from the
 * line metrics, and once drawn that height is measured back as the line's own.
 * Until the editor's first measure the metrics are defaults (a 30-character,
 * 14 px line), so a long line put in before it would keep a wrong height: too
 * little of it drawn on screen, and parts never drawn at all. Put the text in
 * again once, after the first measure, when a long line is on screen, through
 * an empty document (a line replaced by one about as long keeps its height).
 */
const sizeLongLines = EditorView.updateListener.of((u) => {
  const { view } = u;
  if (u.transactions.length || measured.has(view)) return;
  measured.add(view);
  if (!view.viewportLineBlocks.some((b) => b.length > LONG_LINE)) return;
  const doc = u.state.doc;
  queueMicrotask(() => {
    if (view.state.doc !== doc) return;
    const kept: MarkRange[] = [];
    view.state.field(marks).between(0, doc.length, (from, to, mark) => {
      kept.push({ from, to, current: mark === currentMark });
    });
    const at = kept.find((m) => m.current);
    view.dispatch({ changes: { from: 0, to: doc.length } });
    view.dispatch({
      changes: { from: 0, insert: doc },
      effects: [setMarks.of(kept), ...(at ? [EditorView.scrollIntoView(at.from, { y: "nearest", x: "nearest" })] : [])],
    });
  });
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
    sizeLongLines,
  ];
}

/**
 * Shows `text` from its start. It replaces the document of the same state
 * rather than starting a new one: a new state starts with default line metrics
 * (see `sizeLongLines`), and a state created with a long line draws its hidden
 * part unwrapped, so its first measure finds the line short and draws all of it
 * once (over a second of layout for a 16 MB line).
 */
function show(v: EditorView, text: string) {
  v.dispatch({
    changes: { from: 0, to: v.state.doc.length, insert: text },
    selection: { anchor: 0 },
    effects: EditorView.scrollIntoView(0, { y: "start" }),
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
  const shown = useRef(text);

  useEffect(() => {
    // Created empty: a state created with a long line draws all of it once (see `show`).
    const v = new EditorView({ parent: host.current!, state: EditorState.create({ extensions: extensions() }) });
    show(v, text);
    view.current = v;
    if (viewRef) viewRef.current = v;
    return () => {
      v.destroy();
      view.current = null;
      if (viewRef) viewRef.current = null;
    };
    // The view is created once; text changes replace its state below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const v = view.current;
    if (!v || shown.current === text) return;
    shown.current = text;
    show(v, text);
  }, [text]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const doc = v.state.doc;
    const ranges = matches.map((m, i) => {
      const from = doc.line(m.line + 1).from + m.start;
      return { from, to: from + (m.end - m.start), current: i === current };
    });
    const at = ranges[current];
    v.dispatch({
      effects: [
        setMarks.of(ranges),
        ...(at ? [EditorView.scrollIntoView(at.from, { y: "nearest", x: "nearest" })] : []),
      ],
    });
  }, [text, matches, current]);

  return <div ref={host} className={styles.responseBody} />;
}
