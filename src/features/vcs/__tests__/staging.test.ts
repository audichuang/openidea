import { describe, expect, it } from "vitest";
import type { FileStatus } from "@/bindings";
import type { ChangeNode } from "../changes";
import {
  buildStagingTree,
  stagePaths,
  stagedFiles,
  stagingDiffData,
  stagingGroups,
  stagingPlan,
  unstagePaths,
} from "../staging";

const fs = (
  rel: string,
  staged: FileStatus["staged"],
  unstaged: FileStatus["unstaged"],
  renamedFrom: string | null = null,
): FileStatus => ({ path: `/r/${rel}`, relPath: rel, staged, unstaged, renamedFrom });

const status = [
  fs("src/App.kt", null, "modified"),
  fs("src/Partial.kt", "modified", "modified"),
  fs("src/New.kt", "added", null),
  fs("Gone.kt", "added", "deleted"),
  fs("notes.txt", null, "untracked"),
  fs("conf.yml", null, "conflicted"),
  fs("out/", null, "ignored"),
];

const shape = (nodes: ChangeNode[], depth = 0): string[] =>
  nodes.flatMap((n) => [
    `${"  ".repeat(depth)}${n.label}${n.type === "file" ? ` (${n.kind})` : ""}`,
    ...shape(n.children ?? [], depth + 1),
  ]);

const keys = (nodes: ChangeNode[]): string[] => nodes.flatMap((n) => [n.key, ...keys(n.children ?? [])]);

describe("staging area tree", () => {
  it("shows the index: a partially staged file under both Staged and Unstaged, each colored by its own side", () => {
    expect(shape(buildStagingTree(status, "/r", false))).toEqual([
      "Merge Conflicts",
      "  conf.yml (conflicted)",
      "Staged",
      "  Gone.kt (added)",
      "  New.kt (added)",
      "  Partial.kt (modified)",
      "Unstaged",
      "  App.kt (modified)",
      "  Gone.kt (deleted)",
      "  Partial.kt (modified)",
      "Unversioned Files",
      "  notes.txt (untracked)",
    ]);
  });

  it("puts unversioned files under Unstaged as VS Code does, when asked", () => {
    expect(shape(buildStagingTree(status, "/r", false, [], true))).toEqual([
      "Merge Conflicts",
      "  conf.yml (conflicted)",
      "Staged",
      "  Gone.kt (added)",
      "  New.kt (added)",
      "  Partial.kt (modified)",
      "Unstaged",
      "  App.kt (modified)",
      "  Gone.kt (deleted)",
      "  notes.txt (untracked)",
      "  Partial.kt (modified)",
    ]);
    expect(stagingGroups(fs("n", null, "untracked"), true)).toEqual(["unstaged"]);
    // Staged once (`git add`), a file is no longer unversioned.
    expect(stagingGroups(fs("n", "added", null), true)).toEqual(["staged"]);
  });

  it("keeps node keys unique when a file is in two groups", () => {
    const all = keys(buildStagingTree(status, "/r", true));
    expect(new Set(all).size).toBe(all.length);
  });

  it("puts conflicts only under Merge Conflicts and hides ignored files", () => {
    expect(stagingGroups(fs("a", "conflicted", "modified"))).toEqual(["conflicts"]);
    expect(stagingGroups(fs("out/", null, "ignored"))).toEqual([]);
    expect(stagingGroups(fs("b", "added", "modified"))).toEqual(["staged", "unstaged"]);
  });
});

describe("staging area commit", () => {
  it("commits the index as it is: no staging or unstaging, only staged files", () => {
    const plan = stagingPlan(status);
    expect(plan.stage).toEqual([]);
    expect(plan.unstage).toEqual([]);
    expect(plan.partial).toEqual([]);
    expect(plan.included.map((f) => f.relPath)).toEqual(["src/Partial.kt", "src/New.kt", "Gone.kt"]);
    expect(stagedFiles([fs("x", null, "modified")])).toEqual([]);
  });
});

describe("staging area stage / unstage", () => {
  it("unstages a rename together with its source", () => {
    expect(unstagePaths([fs("b.kt", "renamed", null, "a.kt"), fs("c.kt", null, "modified")])).toEqual([
      "/r/b.kt",
      "/r/a.kt",
    ]);
  });

  it("stages unstaged edits and unversioned files, not conflicts", () => {
    expect(stagePaths(status)).toEqual(["/r/src/App.kt", "/r/src/Partial.kt", "/r/Gone.kt", "/r/notes.txt"]);
  });
});

describe("staging area diffs", () => {
  it("diffs Staged as HEAD ↔ index and Unstaged as index ↔ working file", () => {
    const partial = fs("src/Partial.kt", "modified", "modified");
    expect(stagingDiffData(partial, "staged")).toEqual({
      path: "/r/src/Partial.kt",
      left: { type: "rev", rev: "HEAD" },
      right: { type: "rev", rev: ":0" },
    });
    expect(stagingDiffData(partial, "unstaged")).toEqual({
      path: "/r/src/Partial.kt",
      left: { type: "rev", rev: ":0" },
      right: { type: "worktree" },
    });
  });

  it("shows added, deleted and renamed sides", () => {
    expect(stagingDiffData(fs("n.kt", "added", null), "staged")?.left).toMatchObject({ type: "text" });
    expect(stagingDiffData(fs("d.kt", "deleted", null), "staged")?.right).toMatchObject({ type: "text" });
    expect(stagingDiffData(fs("g.kt", "added", "deleted"), "unstaged")?.right).toMatchObject({ type: "text" });
    expect(stagingDiffData(fs("b.kt", "renamed", null, "a.kt"), "staged")?.left).toEqual({
      type: "rev",
      rev: "HEAD",
      path: "/r/a.kt",
      label: "HEAD (a.kt)",
    });
    expect(stagingDiffData(fs("u.txt", null, "untracked"), "unversioned")).toBeNull();
    // Under Unstaged an unversioned file has no index side yet.
    const u = stagingDiffData(fs("u.txt", null, "untracked"), "unstaged");
    expect(u?.left).toMatchObject({ type: "text", label: "(does not exist)" });
    expect(u?.right).toEqual({ type: "worktree" });
  });
});
