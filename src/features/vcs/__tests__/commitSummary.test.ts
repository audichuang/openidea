import { describe, expect, it } from "vitest";
import type { FileStatus } from "@/bindings";
import { commitSummary } from "../commitSummary";

const fs = (rel: string, staged: FileStatus["staged"], unstaged: FileStatus["unstaged"]): FileStatus => ({
  path: `/r/${rel}`,
  relPath: rel,
  staged,
  unstaged,
  renamedFrom: null,
});

describe("commitSummary", () => {
  it("counts the included files by their change, renames as modified and unversioned as added", () => {
    const files = [
      fs("a.ts", "added", null),
      fs("b.ts", null, "modified"),
      fs("c.ts", "renamed", null),
      fs("d.ts", null, "deleted"),
      fs("e.ts", null, "untracked"),
    ];
    expect(commitSummary(files, false)).toEqual({ added: 2, modified: 2, deleted: 1 });
  });

  it("counts the staged change with the staging area", () => {
    // Staged edit, deleted in the working tree since: the commit takes the edit.
    const files = [fs("a.ts", "modified", "deleted"), fs("b.ts", "added", "modified"), fs("c.ts", "deleted", null)];
    expect(commitSummary(files, true)).toEqual({ added: 1, modified: 1, deleted: 1 });
    expect(commitSummary(files, false)).toEqual({ added: 1, modified: 0, deleted: 2 });
  });

  it("is all zero without files", () => {
    expect(commitSummary([], true)).toEqual({ added: 0, modified: 0, deleted: 0 });
  });
});
