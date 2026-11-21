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

/** The find matches; the document never changes (a new body is a new state). */
const marks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
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

function extensions(): Extension[] {
  return [
    EditorState.readOnly.of(true),
    // Lines as the find bar counts them (`\n` only), and `\r` kept in the text and copies.
    EditorState.lineSeparator.of("\n"),
    EditorView.lineWrapping,
    keymap.of(defaultKeymap),
    EditorView.contentAttributes.of({ "aria-label": tx("Response body") }),
    marks,
  ];
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
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({ doc: text, extensions: extensions() }),
    });
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
    v.setState(EditorState.create({ doc: text, extensions: extensions() }));
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
