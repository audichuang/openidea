import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, call: vi.fn() };
});

import type { MenuItem } from "@/ui/Menu";
import { useProject } from "@/platform/project";
import { nodeMenu } from "../CommitView";
import { buildChangeTree, type ChangeNode } from "../changes";
import { useCommit } from "../commitStore";
import { buildStagingTree } from "../staging";
import { useVcs } from "../store";

/** Partially staged: in both Staged and Unstaged. */
const A = { path: "/p/a.ts", relPath: "a.ts", staged: "modified", unstaged: "modified", renamedFrom: null } as const;
const B = { path: "/p/b.ts", relPath: "b.ts", staged: "modified", unstaged: null, renamedFrom: null } as const;

function setStaging(on: boolean) {
  useProject.setState({ settings: { vcs: { git: { stagingArea: on }, commit: { nonModal: true } } } } as never);
}

function fileNode(nodes: readonly ChangeNode[], path: string): ChangeNode | undefined {
  for (const n of nodes) {
    if (n.type === "file" && n.path === path) return n;
    const found = n.children && fileNode(n.children, path);
    if (found) return found;
  }
}

const labels = (items: MenuItem[]) => items.map((i) => ("label" in i ? i.label : undefined));

beforeEach(() => {
  localStorage.clear();
  useVcs.setState({ available: true, root: "/p", repo: "/p", roots: ["/p"], status: [A, B] } as never);
  useCommit.setState({ commitDiffPreview: false, selection: [], checks: new Map() });
});

afterEach(() => setStaging(false));

describe("Commit File… with the staging area", () => {
  it("is not offered: a commit takes the whole index, not the picked files", () => {
    setStaging(true);
    const staged = buildStagingTree([A, B], "/p", false).find((n) => n.group === "staged")!;
    const node = fileNode([staged], "/p/a.ts")!;
    expect(labels(nodeMenu([node], ["/p"]))).not.toContain("Commit File…");
  });

  it("is still offered without the staging area", () => {
    setStaging(false);
    const node = fileNode(buildChangeTree([A, B], "/p", false, undefined, ["/p"], false), "/p/a.ts")!;
    expect(labels(nodeMenu([node], ["/p"]))).toContain("Commit File…");
  });
});
