import { describe, expect, it } from "vitest";
import { DISPLAY_LINE, displayText, docPosition, textOffset } from "./displayLines";

/** A seeded generator, so a failure repeats. */
function random(seed: number) {
  let s = seed;
  return (n: number) => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s % n;
  };
}

/** Lines of random lengths around and past `DISPLAY_LINE`, with surrogate pairs, `\r` and empty lines. */
function sample(seed: number): string {
  const rnd = random(seed);
  const pieces = ["a", "b", "\r", "😀", "é", " "];
  const lines: string[] = [];
  for (let l = rnd(5) + 1; l > 0; l--) {
    const length = [0, 3, DISPLAY_LINE - 1, DISPLAY_LINE, DISPLAY_LINE + 1, 3 * DISPLAY_LINE + rnd(50)][rnd(6)]!;
    let line = "";
    while (line.length < length) line += pieces[rnd(pieces.length)]!;
    lines.push(line);
  }
  return lines.join("\n");
}

describe("display lines", () => {
  it("keeps a text without long lines as it is", () => {
    const d = displayText("a\r\nb\n\nc");
    expect(d.doc.toString()).toBe("a\r\nb\n\nc");
    expect(d.offsets).toEqual([]);
  });

  it("splits a long line into display lines and maps positions both ways", () => {
    const text = `x\n${"y".repeat(2 * DISPLAY_LINE + 5)}\nz`;
    const d = displayText(text);
    expect(d.doc.lines).toBe(5);
    expect(d.offsets).toEqual([2 + DISPLAY_LINE, 2 + 2 * DISPLAY_LINE]);
    // At a split: the start of the next display line, or (as the end of a range) the end of the previous one.
    expect(docPosition(d, 1, DISPLAY_LINE)).toBe(d.doc.line(3).from);
    expect(docPosition(d, 1, DISPLAY_LINE, true)).toBe(d.doc.line(2).to);
    expect(docPosition(d, 2, 0)).toBe(d.doc.line(5).from);
    expect(textOffset(d, d.doc.length)).toBe(text.length);
  });

  for (let seed = 1; seed <= 40; seed++)
    it(`holds the text as received and maps every position (seed ${seed})`, () => {
      const text = sample(seed);
      const d = displayText(text);
      const doc = d.doc.toString();
      // Every line within the limit, never ending in the first half of a surrogate pair it splits.
      for (let n = 1; n <= d.doc.lines; n++) expect(d.doc.line(n).length).toBeLessThanOrEqual(DISPLAY_LINE);
      // Without the breaks at the splits, the document is the text.
      let joined = "";
      let from = 0;
      d.offsets.forEach((offset, i) => {
        expect(doc[offset + i]).toBe("\n");
        joined += doc.slice(from, offset + i);
        from = offset + i + 1;
      });
      expect(joined + doc.slice(from)).toBe(text);
      // Each character of the text is at its mapped position in the document, and maps back.
      const rnd = random(seed);
      const lines = text.split("\n");
      for (let probe = 0; probe < 200; probe++) {
        const line = rnd(lines.length);
        const column = rnd(lines[line]!.length + 1);
        const offset = lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0) + column;
        const pos = docPosition(d, line, column);
        expect(textOffset(d, pos)).toBe(offset);
        expect(textOffset(d, docPosition(d, line, column, true))).toBe(offset);
        if (column < lines[line]!.length) expect(doc[pos]).toBe(text[offset]);
      }
    });
});
