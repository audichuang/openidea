// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fitPathDetail, splitPathDetail } from "../pathDetail";

describe("splitPathDetail", () => {
  it("splits off the last directory, with its slash", () => {
    expect(splitPathDetail("src-tauri/src/commands")).toEqual({ head: "src-tauri/src", tail: "/commands" });
    expect(splitPathDetail("src/main")).toEqual({ head: "src", tail: "/main" });
  });

  it("leaves a single segment as the tail alone", () => {
    expect(splitPathDetail("languages")).toEqual({ head: "", tail: "languages" });
    expect(splitPathDetail("")).toEqual({ head: "", tail: "" });
  });

  it("keeps a head of two characters or fewer with the tail", () => {
    expect(splitPathDetail("ui/icons")).toEqual({ head: "", tail: "ui/icons" });
    expect(splitPathDetail("a/b")).toEqual({ head: "", tail: "a/b" });
  });
});

describe("fitPathDetail", () => {
  // One unit per character, so a width is a character budget.
  const measure = (text: string) => Array.from(text).length;
  const dir = "src-tauri/src/commands";

  it("keeps the whole directory when it fits", () => {
    expect(fitPathDetail(dir, 22, measure)).toBe(dir);
    expect(fitPathDetail(dir, 100, measure)).toBe(dir);
  });

  it("cuts the head first, keeping the last segment whole", () => {
    expect(fitPathDetail(dir, 21, measure)).toBe("src-tauri/s…/commands");
    expect(fitPathDetail(dir, 15, measure)).toBe("src-t…/commands");
    expect(fitPathDetail(dir, 11, measure)).toBe("s…/commands");
  });

  it("only then cuts the last segment, keeping one character of the head", () => {
    expect(fitPathDetail(dir, 10, measure)).toBe("s…/comman…");
    expect(fitPathDetail(dir, 5, measure)).toBe("s…/c…");
  });

  it("falls back to an ellipsis alone, never an empty string", () => {
    expect(fitPathDetail(dir, 4, measure)).toBe("…");
    expect(fitPathDetail(dir, 0, measure)).toBe("…");
  });

  it("cuts a directory with no head from its end", () => {
    expect(fitPathDetail("languages", 6, measure)).toBe("langu…");
    expect(fitPathDetail("ui/icons", 5, measure)).toBe("ui/i…");
  });

  it("never splits a surrogate pair", () => {
    expect(fitPathDetail("😀😀😀😀/x", 4, measure)).toBe("😀…/x");
  });
});
