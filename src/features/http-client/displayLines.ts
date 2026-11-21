/**
 * The response body as the editor view holds it: lines longer than
 * `DISPLAY_LINE` are split into display lines of that length, and positions
 * map between the text as received and the document.
 *
 * A wrapped line much taller than the editor's scaling limit (7,000,000 px: a
 * 16 MB line in a pane narrower than ~400 px) is more than CodeMirror can
 * draw: its scaling divides by zero and the line goes blank. Lines no longer
 * than its wrapped-line margin are also drawn whole, with exact heights.
 * Each split shows as a line break; copies and find matches use the text as
 * received.
 */
import { StateEffect, StateField, Text, type EditorState } from "@codemirror/state";

/** The longest line in the document (CodeMirror's wrapped-line margin). */
export const DISPLAY_LINE = 10_000;

export interface DisplayText {
  /** The text as received. */
  readonly text: string;
  /** The text as display lines. */
  readonly doc: Text;
  /** Each split, in order: its offset in `text`, and its line (0-based, at `\n`) and column there. */
  readonly offsets: readonly number[];
  readonly lines: readonly number[];
  readonly columns: readonly number[];
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

export function displayText(text: string): DisplayText {
  const source = text.split("\n");
  const offsets: number[] = [];
  const lines: number[] = [];
  const columns: number[] = [];
  if (!source.some((line) => line.length > DISPLAY_LINE))
    return { text, doc: Text.of(source), offsets, lines, columns };
  const out: string[] = [];
  let start = 0;
  source.forEach((line, i) => {
    let column = 0;
    while (line.length - column > DISPLAY_LINE) {
      let cut = column + DISPLAY_LINE;
      // Never between the halves of a surrogate pair.
      if (isHighSurrogate(line.charCodeAt(cut - 1))) cut--;
      out.push(line.slice(column, cut));
      offsets.push(start + cut);
      lines.push(i);
      columns.push(cut);
      column = cut;
    }
    out.push(column ? line.slice(column) : line);
    start += line.length + 1;
  });
  return { text, doc: Text.of(out), offsets, lines, columns };
}

/** The number of `i` in [0, n) for which `before(i)` holds (it holds for a prefix). */
function count(n: number, before: (i: number) => boolean): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (before(mid)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The document position of `column` in `line` of the text. At a split, the
 * start of the next display line, or with `end` the end of the previous one.
 */
export function docPosition(d: DisplayText, line: number, column: number, end = false): number {
  const k = count(
    d.offsets.length,
    (i) => d.lines[i]! < line || (d.lines[i] === line && (end ? d.columns[i]! < column : d.columns[i]! <= column)),
  );
  const from = k > 0 && d.lines[k - 1] === line ? d.columns[k - 1]! : 0;
  return d.doc.line(line + k + 1).from + column - from;
}

/** The offset in the text of a document position (a split's line break counts as the start of the next line). */
export function textOffset(d: DisplayText, pos: number): number {
  return pos - count(d.offsets.length, (i) => d.offsets[i]! + i < pos);
}

export const setDisplayText = StateEffect.define<DisplayText>();

/** The text shown, set with the document it goes in with. */
export const displayed = StateField.define<DisplayText>({
  create: () => displayText(""),
  update: (value, tr) => tr.effects.find((e) => e.is(setDisplayText))?.value ?? value,
});

/** The text as received between two document positions. */
export function textBetween(state: EditorState, from: number, to: number): string {
  const d = state.field(displayed);
  return d.text.slice(textOffset(d, from), textOffset(d, to));
}
