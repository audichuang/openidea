import { describe, expect, it } from "vitest";
import type { FileStatus } from "@/bindings";
import type { MenuItem } from "@/ui";
import type { ChangeNode } from "../changes";

const { nodeMenu } = await import("../CommitView");

const file = (rel: string, unstaged: FileStatus["unstaged"]): ChangeNode => {
  const f: FileStatus = { path: `/p/${rel}`, relPath: rel, staged: null, unstaged, renamedFrom: null };
  return { key: f.path, type: "file", label: rel, group: "unversioned", files: [f], path: f.path };
};
const disabled = (menu: MenuItem[], action: string) => {
  const item = menu.find((i) => i.kind === "action" && i.action === action);
  return !!(item && "disabled" in item && item.disabled);
};

describe("Commit view menu for unversioned files", () => {
  it("disables Shelve and Create Patch while only unversioned files are selected", () => {
    const only = nodeMenu([file("a.txt", "untracked"), file("b.txt", "untracked")], ["/p"]);
    expect(disabled(only, "vcs.shelve")).toBe(true);
    expect(disabled(only, "vcs.createPatch")).toBe(true);
    const mixed = nodeMenu([file("a.txt", "untracked"), file("c.txt", "modified")], ["/p"]);
    expect(disabled(mixed, "vcs.shelve")).toBe(false);
    expect(disabled(mixed, "vcs.createPatch")).toBe(false);
  });
});
