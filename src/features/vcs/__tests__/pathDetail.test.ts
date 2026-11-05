import { describe, expect, it } from "vitest";
import { splitPathDetail } from "../pathDetail";

describe("splitPathDetail", () => {
  it("keeps the last directory whole, with its slash", () => {
    expect(splitPathDetail("src-tauri/src/commands")).toEqual({ head: "src-tauri/src", tail: "/commands" });
    expect(splitPathDetail("src/main")).toEqual({ head: "src", tail: "/main" });
  });

  it("leaves a single segment as the head alone", () => {
    expect(splitPathDetail("src")).toEqual({ head: "src", tail: "" });
    expect(splitPathDetail("")).toEqual({ head: "", tail: "" });
  });
});
