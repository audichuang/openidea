import { describe, expect, it } from "vitest";
import type { FileStatus } from "@/bindings";
import { type CheckState, planCommit } from "../changes";
import { commitSummary } from "../commitSummary";

const fs = (rel: string, staged: FileStatus["staged"], unstaged: FileStatus["unstaged"]): FileStatus => ({
  path: `/r/${rel}`,
  relPath: rel,
  staged,
  unstaged,
  renamedFrom: null,
});

/** The summary of what `planCommit` would commit with these checks. */
const planned = (status: FileStatus[], checks: ReadonlyMap<string, CheckState> = new Map()) =>
  commitSummary(planCommit(status, checks).included, checks);

describe("commitSummary", () => {
  it("counts the included files by their change, renames as modified and unversioned as added", () => {
    const files = [
      fs("a.ts", "added", null),
      fs("b.ts", null, "modified"),
      fs("c.ts", "renamed", null),
      fs("d.ts", null, "deleted"),
      fs("e.ts", null, "untracked"),
    ];
    const all = new Map(files.map((f) => [f.path, "all" as const]));
    expect(planned(files, all)).toEqual({ added: 2, modified: 2, deleted: 1 });
  });

  it("counts the staged change with the staging area", () => {
    // Staged edit, deleted in the working tree since: the commit takes the edit.
    const files = [fs("a.ts", "modified", "deleted"), fs("b.ts", "added", "modified"), fs("c.ts", "deleted", null)];
    expect(commitSummary(files, null)).toEqual({ added: 1, modified: 1, deleted: 1 });
  });

  it("counts what the checkbox commits: a partially staged file checked for its staged part", () => {
    const status = [fs("a.ts", "modified", "deleted")];
    // Partially staged files start checked for the staged part only: the index's edit.
    expect(planned(status)).toEqual({ added: 0, modified: 1, deleted: 0 });
    expect(planned(status, new Map([["/r/a.ts", "all"]]))).toEqual({ added: 0, modified: 0, deleted: 1 });
  });

  it("counts a staged deletion re-added from the working tree as modified when it is all staged", () => {
    const status = [fs("a.ts", "deleted", "untracked")];
    // Checked by default: staging the whole file puts it back in the index.
    expect(planned(status)).toEqual({ added: 0, modified: 1, deleted: 0 });
    expect(planned(status, new Map([["/r/a.ts", "staged"]]))).toEqual({ added: 0, modified: 0, deleted: 1 });
  });

  it("is all zero without files", () => {
    expect(commitSummary([], null)).toEqual({ added: 0, modified: 0, deleted: 0 });
    expect(commitSummary([], new Map())).toEqual({ added: 0, modified: 0, deleted: 0 });
  });
});
