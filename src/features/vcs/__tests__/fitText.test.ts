import { describe, expect, it } from "vitest";
import { chars, fitName, fitPath } from "../fitText";

/** One unit per character, whatever the character: the ellipsis counts as one. */
const unit = (s: string) => chars(s).length;

const name = "shared-prefix-for-long-image-names-in-preview-alpha-001.png";
const dir = `d12/${"folder-segment-".repeat(9)}x/`;

describe("fitName", () => {
  it("returns the name whole when it fits", () => {
    expect(fitName("", name, name.length, unit)).toBe(name);
  });

  it("shortens in the middle on whole characters, keeping the end and extension", () => {
    for (let w = 16; w < name.length; w++) {
      const out = fitName("", name, w, unit);
      expect(unit(out), `width ${w}`).toBeLessThanOrEqual(w);
      expect(out.endsWith("-alpha-001.png".slice(-Math.min(14, w - 1)))).toBe(true);
      // The ellipsis is a character of the string itself: nothing is left between it and the tail.
      const [head, tail] = out.split("…");
      expect(name.startsWith(head!)).toBe(true);
      expect(name.endsWith(tail!)).toBe(true);
    }
  });

  it("never cuts inside a grapheme cluster", () => {
    const n = "é".repeat(30) + "\u{1F600}".repeat(10) + "-tail.png";
    for (let w = 6; w < 20; w++) {
      const out = fitName("", n, w, unit);
      const [head] = out.split("…");
      expect(
        chars(head!).every((c) => c === "é" || c === "\u{1F600}"),
        out,
      ).toBe(true);
    }
  });

  it("fills the width exactly: the head keeps every character that fits", () => {
    const out = fitName("", name, 30, unit);
    expect(unit(out)).toBe(30);
  });
});

describe("fitPath", () => {
  const path = `${dir}${name}`;

  it("shortens the folder part first, to its first segment and an ellipsis, with the name whole", () => {
    const w = name.length + "d12/…/".length;
    expect(fitPath(path, w, unit)).toBe(`d12/…/${name}`);
    const roomy = fitPath(path, w + 10, unit);
    expect(roomy.endsWith(`…/${name}`)).toBe(true);
    expect(unit(roomy)).toBe(w + 10);
  });

  it("drops name characters only after the folder is down to its first segment", () => {
    const out = fitPath(path, name.length, unit);
    expect(out.startsWith("d12/…/")).toBe(true);
    expect(out.endsWith("alpha-001.png")).toBe(true);
    expect(unit(out)).toBeLessThanOrEqual(name.length);
  });

  it("returns a path that fits unchanged, and a bare name as a name", () => {
    expect(fitPath("a/b.png", 20, unit)).toBe("a/b.png");
    expect(fitPath(name, 20, unit)).toBe(fitName("", name, 20, unit));
  });
});
