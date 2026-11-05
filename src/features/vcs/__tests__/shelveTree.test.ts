import { describe, expect, it } from "vitest";
import type { FileStatus } from "@/bindings";
import { buildShelveTree, firstFile, nodeCheck, nodePaths, toggleNode } from "../shelveTree";

const fs = (path: string): FileStatus => ({
  path,
  relPath: path,
  staged: null,
  unstaged: "modified",
  renamedFrom: null,
});
const files = [fs("/repo/src/app/a.ts"), fs("/repo/src/app/b.ts"), fs("/repo/src/lib/c.ts"), fs("/repo/README.md")];

describe("shelve dialog tree", () => {
  const tree = buildShelveTree(files, "/repo");
  const src = tree.find((n) => n.name === "src")!;
  const app = src.children.find((n) => n.name === "app")!;

  it("groups by directory relative to the root, with file counts, directories first", () => {
    expect(tree.map((n) => [n.name, n.count])).toEqual([
      ["src", 3],
      ["README.md", 1],
    ]);
    expect(src.children.map((n) => n.name)).toEqual(["app", "lib"]);
    expect(nodePaths(app)).toEqual(["/repo/src/app/a.ts", "/repo/src/app/b.ts"]);
    expect(firstFile(tree)?.file?.path).toBe("/repo/src/app/a.ts");
  });

  it("derives folder checks from the files below", () => {
    const all = new Set(files.map((f) => f.path));
    expect(nodeCheck(src, all)).toEqual({ checked: true, indeterminate: false });
    const some = new Set(["/repo/src/app/a.ts"]);
    expect(nodeCheck(src, some)).toEqual({ checked: false, indeterminate: true });
    expect(nodeCheck(src, new Set())).toEqual({ checked: false, indeterminate: false });
  });

  it("toggles a folder: excludes it when fully included, else includes every file below", () => {
    const all = new Set(files.map((f) => f.path));
    const without = toggleNode(app, all);
    expect([...without].sort()).toEqual(["/repo/README.md", "/repo/src/lib/c.ts"]);
    const partial = new Set(["/repo/src/app/a.ts"]);
    expect([...toggleNode(src, partial)].sort()).toEqual([
      "/repo/src/app/a.ts",
      "/repo/src/app/b.ts",
      "/repo/src/lib/c.ts",
    ]);
    // Input is not mutated.
    expect(partial.size).toBe(1);
  });

  it("strips a trailing slash of unversioned directories", () => {
    const [node] = buildShelveTree([fs("/repo/new-dir/")], "/repo");
    expect(node?.name).toBe("new-dir");
    expect(node?.file?.path).toBe("/repo/new-dir/");
  });
});
