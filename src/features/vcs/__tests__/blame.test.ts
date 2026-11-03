import { describe, expect, it } from "vitest";
import { ANNOTATE_PALETTE_SIZE, annotateColor, annotateColorIndexes, authorPalette } from "../blame";

const ZERO = "0".repeat(40);
const line = (commit: string, author: string, timeMs: number) => ({ commit, author, timeMs });

describe("annotateColorIndexes", () => {
  it("spreads commits newest first over the palette, as IDEA's order mode", () => {
    const lines = [line("a", "x", 1_000), line("b", "x", 3_000), line("a", "x", 1_000), line("c", "x", 2_000)];
    const colors = annotateColorIndexes(lines, "order", 21);
    // size * index / count: b (newest) 0, c 7, a (oldest) 14.
    expect(Object.fromEntries(colors)).toEqual({ b: 0, c: 7, a: 14 });
  });

  it("gives every commit its own colour while there are fewer commits than palette entries", () => {
    const lines = Array.from({ length: ANNOTATE_PALETTE_SIZE }, (_, i) => line(`c${i}`, "x", i));
    const colors = annotateColorIndexes(lines, "order");
    expect(new Set(colors.values()).size).toBe(ANNOTATE_PALETTE_SIZE);
    expect(Math.max(...colors.values())).toBe(ANNOTATE_PALETTE_SIZE - 1);
  });

  it("colours nothing for a single commit, uncommitted lines or mode none", () => {
    expect(annotateColorIndexes([line("a", "x", 1), line(ZERO, "Not Committed Yet", 2)], "order").size).toBe(0);
    const two = [line("a", "x", 1), line("b", "y", 2), line(ZERO, "", 3)];
    expect(annotateColorIndexes(two, "none").size).toBe(0);
    expect(annotateColorIndexes(two, "order").has(ZERO)).toBe(false);
  });

  it("colours by author alphabetically through the strided palette, one colour per author", () => {
    const lines = [line("a", "zoe", 1), line("b", "amy", 2), line("c", "zoe", 3), line("d", "bob", 4)];
    const colors = annotateColorIndexes(lines, "author");
    const palette = authorPalette();
    expect(colors.get("b")).toBe(palette[0]);
    expect(colors.get("d")).toBe(palette[1]);
    expect(colors.get("a")).toBe(palette[2]);
    expect(colors.get("c")).toBe(colors.get("a"));
    expect(annotateColorIndexes([line("a", "zoe", 1), line("b", "zoe", 2)], "author").size).toBe(0);
  });

  it("wraps authors around the palette", () => {
    const lines = Array.from({ length: ANNOTATE_PALETTE_SIZE + 1 }, (_, i) =>
      line(`c${i}`, `a${String(i).padStart(2, "0")}`, i),
    );
    const colors = annotateColorIndexes(lines, "author");
    expect(colors.get(`c${ANNOTATE_PALETTE_SIZE}`)).toBe(colors.get("c0"));
  });
});

describe("palette", () => {
  it("reads IDEA's 21-colour gradient with a stride of 4 for authors", () => {
    expect(ANNOTATE_PALETTE_SIZE).toBe(21);
    const p = authorPalette();
    expect(p.slice(0, 7)).toEqual([0, 4, 8, 12, 16, 20, 1]);
    expect([...p].sort((a, b) => a - b)).toEqual(Array.from({ length: 21 }, (_, i) => i));
  });

  it("uses the anchors and mixes the entries between them", () => {
    expect(annotateColor(0)).toBe("var(--vcs-annotate-1)");
    expect(annotateColor(5)).toBe("var(--vcs-annotate-2)");
    expect(annotateColor(20)).toBe("var(--vcs-annotate-5)");
    expect(annotateColor(1)).toBe("color-mix(in oklab, var(--vcs-annotate-1) 80%, var(--vcs-annotate-2))");
    expect(annotateColor(19)).toBe("color-mix(in oklab, var(--vcs-annotate-4) 20%, var(--vcs-annotate-5))");
  });
});
