import { describe, expect, it } from "vitest";
import { findInLines, type FindOptions } from "@/ui/consoleFind";
import { findInBody, lineStarts } from "./bodyFind";

const split = (text: string) => text.split("\n").map((t, id) => ({ id, text: t }));

const OPTIONS: FindOptions[] = [false, true].flatMap((caseSensitive) =>
  [false, true].flatMap((wholeWord) => [false, true].map((regex) => ({ caseSensitive, wholeWord, regex }))),
);

/** A deterministic pseudo-random generator, so a failure names its seed. */
function random(seed: number) {
  let s = seed;
  return (n: number) => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s % n;
  };
}

const ALPHABET = ["a", "b", "A", "B", " ", "\n", "\r", "-", "_", "é", "É", "😀", "ß", "."];

describe("findInBody", () => {
  it("returns what findInLines returns for the lines, for every option", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const next = random(seed);
      const text = Array.from({ length: next(200) }, () => ALPHABET[next(ALPHABET.length)]).join("");
      const query = Array.from({ length: 1 + next(3) }, () => ALPHABET[next(ALPHABET.length)]).join("");
      const lines = split(text);
      const starts = lineStarts(text);
      for (const options of OPTIONS)
        for (const limit of [3, 2000])
          expect(
            findInBody(text, starts, () => lines, query, options, limit),
            `seed ${seed} ${JSON.stringify(options)}`,
          ).toEqual(findInLines(lines, query, options, limit));
    }
  });

  it("places matches on the first, middle and last line, and caps them like findInLines", () => {
    const text = `last-item\n${"x\n".repeat(5000)}a last-item b\nlast-item`;
    const lines = split(text);
    const starts = lineStarts(text);
    const options = { caseSensitive: false, wholeWord: true, regex: false };
    const found = findInBody(text, starts, () => lines, "LAST-item", options);
    expect(found).toEqual(findInLines(lines, "LAST-item", options));
    expect(found.matches.map((m) => [m.line, m.start, m.end])).toEqual([
      [0, 0, 9],
      [5001, 2, 11],
      [5002, 0, 9],
    ]);
    expect(findInBody(text, starts, () => lines, "x", options)).toEqual(findInLines(lines, "x", options));
    expect(findInBody(text, starts, () => lines, "x", options).overflow).toBe(true);
  });

  it("splits the body into lines only for a regular expression", () => {
    const text = "a\nb";
    const lines = () => {
      throw new Error("split");
    };
    expect(
      findInBody(text, lineStarts(text), lines, "b", { caseSensitive: false, wholeWord: false, regex: false }).matches,
    ).toHaveLength(1);
    expect(() =>
      findInBody(text, lineStarts(text), lines, "b", { caseSensitive: false, wholeWord: false, regex: true }),
    ).toThrow("split");
  });
});
