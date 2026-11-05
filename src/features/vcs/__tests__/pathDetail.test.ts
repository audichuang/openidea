import { describe, expect, it } from "vitest";
import { splitPathDetail } from "../pathDetail";

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
