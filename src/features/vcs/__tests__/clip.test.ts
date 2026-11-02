import { describe, expect, it } from "vitest";
import type { Commit } from "@/bindings";
import { DEFAULT_WORKFLOW } from "@/platform/workflowSettings";
import { commitFilesSource, commitsSource, withIgnoredPaths } from "../clip";

const commit = (id: string, parents: string[]) => ({ id, parents, summary: id }) as unknown as Commit;

describe("ClipCode: Ignore When Copying", () => {
  const base = DEFAULT_WORKFLOW.vcs.clipCode;

  it("adds project-relative exclude path rules and turns exclude filtering on, as the plugin does", () => {
    const next = withIgnoredPaths(base, ["/p/build", "/elsewhere/x.txt"], "/p");
    expect(next.filterRules).toEqual([
      { type: "PATH", action: "EXCLUDE", value: "build", enabled: true },
      { type: "PATH", action: "EXCLUDE", value: "/elsewhere/x.txt", enabled: true },
    ]);
    expect(next).toMatchObject({ useFilters: true, useExcludeFilters: true, useIncludeFilters: false });
  });

  it("re-enables an existing rule instead of adding a second one and keeps include rules when filtering was on", () => {
    const current = {
      ...base,
      useFilters: true,
      useIncludeFilters: true,
      filterRules: [{ type: "PATH" as const, action: "EXCLUDE" as const, value: "build", enabled: false }],
    };
    const next = withIgnoredPaths(current, ["/p/build"], "/p");
    expect(next.filterRules).toEqual([{ type: "PATH", action: "EXCLUDE", value: "build", enabled: true }]);
    expect(next.useIncludeFilters).toBe(true);
  });
});

describe("ClipCode copy sources from the Git log", () => {
  const a = commit("a".repeat(40), ["0".repeat(40)]);
  const b = commit("b".repeat(40), [a.id]);
  const c = commit("c".repeat(40), [b.id]);

  it("copies one commit's files, or a selection as the range from the oldest commit's parent", () => {
    expect(commitFilesSource([b])).toMatchObject({ kind: "commitFiles", rev: b.id });
    expect(commitFilesSource([c, b, a])).toMatchObject({ kind: "range", base: "0".repeat(40), tip: c.id });
  });

  it("copies a non-contiguous selection as the union of the selected commits, not the range between them", () => {
    const d = commit("d".repeat(40), [c.id]);
    expect(commitFilesSource([d, b])).toMatchObject({ kind: "commitList", revs: [d.id, b.id] });
    expect(commitFilesSource([d, c, a])).toMatchObject({ kind: "commitList", revs: [d.id, c.id, a.id] });
    expect(commitFilesSource([d, c, b])).toMatchObject({ kind: "range", base: a.id, tip: d.id });
  });

  it("keeps the whole chain when its oldest commit is a root commit", () => {
    const root = commit("e".repeat(40), []);
    const next = commit("f".repeat(40), [root.id]);
    expect(commitFilesSource([next, root])).toMatchObject({ kind: "rootRange", tip: next.id });
  });

  it("copies commits for replay with the newest selected one as the tip", () => {
    expect(commitsSource([c, b])).toMatchObject({ kind: "commits", tip: c.id, selected: [c.id, b.id] });
  });
});
