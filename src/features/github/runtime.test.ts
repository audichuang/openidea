import { describe, expect, it } from "vitest";
import { runs } from "./runtime";

describe("GitHub action runtime", () => {
  it("implements the ClipCode pull request actions the menus offer", () => {
    expect(runs["github.pullRequest.clipCopyFiles"]).toBeTypeOf("function");
    expect(runs["github.pullRequest.clipCopyCommits"]).toBeTypeOf("function");
  });
});
