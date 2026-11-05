import { describe, expect, it } from "vitest";
import type { FileStatus } from "@/bindings";
import { buildChangeTree } from "../changes";
import { expandedKeys } from "../changesExpansion";
import { buildStagingTree } from "../staging";

const fs = (path: string, staged: FileStatus["staged"], unstaged: FileStatus["unstaged"]): FileStatus => ({
  path,
  relPath: path.replace(/^\/r\//, ""),
  staged,
  unstaged,
  renamedFrom: null,
});

const modified = (rel: string) => fs(`/r/${rel}`, null, "modified");
const NONE = new Map<string, boolean>();

describe("default expansion of the changes tree", () => {
  it("opens groups and the single-child chain below them down to the first branching", () => {
    const tree = buildChangeTree([modified("src/main/kotlin/App.kt"), modified("src/test/AppTest.kt")], "/r", true);
    const open = expandedKeys(tree, NONE);
    expect(open.has("group:changes")).toBe(true);
    expect(open.has("changes:dir:src")).toBe(true);
    expect(open.has("changes:dir:src/main/kotlin")).toBe(false);
    expect(open.has("changes:dir:src/test")).toBe(false);
  });

  it("keeps folders closed when the group branches at its first level", () => {
    const tree = buildChangeTree([modified("src/main/kotlin/App.kt"), modified("README.md")], "/r", true);
    const open = expandedKeys(tree, NONE);
    expect(open.has("group:changes")).toBe(true);
    expect(open.has("changes:dir:src/main/kotlin")).toBe(false);
  });

  it("keeps Unversioned Files closed, with its folders", () => {
    const tree = buildChangeTree([modified("a.ts"), fs("/r/new/file.ts", null, "untracked")], "/r", true);
    const open = expandedKeys(tree, NONE);
    expect(open.has("group:changes")).toBe(true);
    expect(open.has("group:unversioned")).toBe(false);
    expect(open.has("unversioned:dir:new")).toBe(false);
  });

  it("closes repository rows when several repositories have changes, opens the only one", () => {
    const repos = ["/r", "/r/libs/core"];
    const both = buildChangeTree([modified("a.ts"), modified("libs/core/b.ts")], "/r", true, undefined, repos);
    const open = expandedKeys(both, NONE);
    expect(open.has("changes:repo:/r")).toBe(false);
    expect(open.has("changes:repo:/r/libs/core")).toBe(false);

    const one = buildChangeTree([modified("libs/core/src/b.ts")], "/r", true, undefined, repos);
    const openOne = expandedKeys(one, NONE);
    expect(openOne.has("changes:repo:/r/libs/core")).toBe(true);
    expect(openOne.has("changes@/r/libs/core:dir:src")).toBe(true);
  });

  it("opens the chain of the staging area's groups the same way", () => {
    const tree = buildStagingTree(
      [fs("/r/src/a/A.kt", "modified", null), fs("/r/src/b/B.kt", "modified", null)],
      "/r",
      true,
    );
    const open = expandedKeys(tree, NONE);
    expect(open.has("group:staged")).toBe(true);
    expect(open.has("staged:dir:src")).toBe(true);
    expect(open.has("staged:dir:src/a")).toBe(false);
  });
});

describe("expansion overrides", () => {
  const status = [modified("src/main/kotlin/App.kt"), modified("src/test/AppTest.kt")];

  it("keeps what the user closed or opened across a rebuilt tree", () => {
    const overrides = new Map([
      ["changes:dir:src", false],
      ["changes:dir:src/test", true],
      ["group:unversioned", true],
    ]);
    const before = expandedKeys(buildChangeTree(status, "/r", true), overrides);
    expect(before.has("changes:dir:src")).toBe(false);
    expect(before.has("changes:dir:src/test")).toBe(true);

    const refreshed = buildChangeTree([...status, fs("/r/x.txt", null, "untracked")], "/r", true);
    const after = expandedKeys(refreshed, overrides);
    expect(after.has("changes:dir:src")).toBe(false);
    expect(after.has("changes:dir:src/test")).toBe(true);
    expect(after.has("group:unversioned")).toBe(true);
  });

  it("opens a single child of a row the user opened", () => {
    const repos = ["/r", "/r/libs/core"];
    const tree = buildChangeTree(
      [modified("a.ts"), modified("libs/core/src/main/b.ts"), modified("libs/core/src/main/c.ts")],
      "/r",
      true,
      undefined,
      repos,
    );
    expect(expandedKeys(tree, NONE).has("changes@/r/libs/core:dir:src/main")).toBe(false);
    const open = expandedKeys(tree, new Map([["changes:repo:/r/libs/core", true]]));
    expect(open.has("changes:repo:/r/libs/core")).toBe(true);
    expect(open.has("changes@/r/libs/core:dir:src/main")).toBe(true);
  });

  it("never lists file rows", () => {
    const tree = buildChangeTree([modified("a.ts")], "/r", false);
    expect([...expandedKeys(tree, new Map([["changes:/r/a.ts", true]]))]).toEqual(["group:changes"]);
  });
});
