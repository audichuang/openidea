import { describe, expect, it } from "vitest";
import { segmentPath } from "../GraphCell";

describe("segmentPath", () => {
  it("ends a long edge's stub in an arrow head", () => {
    expect(segmentPath({ from: 0, to: 0, color: 0, arrow: "up" }, true, 100)).toBe("M9 0L9 12M6 4L9 0L12 4");
    expect(segmentPath({ from: 1, to: 1, color: 0, arrow: "down" }, false, 100)).toBe("M23 12L23 24M20 20L23 24L26 20");
  });

  it("draws a straightened lane change straight, other lane changes as a curve", () => {
    expect(segmentPath({ from: 0, to: 1, toX: 0.5, color: 0 }, false, 100)).toBe("M9 12L16 24");
    expect(segmentPath({ from: 0, to: 1, color: 0 }, false, 100)).toMatch(/C/);
  });

  it("skips segments right of the visible column", () => {
    expect(segmentPath({ from: 50, to: 50, color: 0 }, true, 100)).toBeNull();
    expect(segmentPath({ from: 50, to: 2, color: 0 }, true, 100)).not.toBeNull();
  });
});
