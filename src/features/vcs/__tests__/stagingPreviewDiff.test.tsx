import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, call: vi.fn() };
});

vi.mock("../DiffEditor", () => ({
  DiffEditor: ({ input }: { input: { data: { path: string; left: unknown; right: unknown } } }) => (
    <div
      data-testid="diff-preview"
      data-path={input.data.path}
      data-left={JSON.stringify(input.data.left)}
      data-right={JSON.stringify(input.data.right)}
    />
  ),
}));

import { useProject } from "@/platform/project";
import { CommitToolWindow, LocalChangesView } from "../CommitView";
import { setCommitDiffPreview, useCommit } from "../commitStore";
import { useVcs } from "../store";

/** Partially staged: in both Staged and Unstaged. */
const A = { path: "/p/a.ts", relPath: "a.ts", staged: "modified", unstaged: "modified", renamedFrom: null } as const;
const B = { path: "/p/b.ts", relPath: "b.ts", staged: "modified", unstaged: null, renamedFrom: null } as const;

function setStaging(on: boolean) {
  useProject.setState({ settings: { vcs: { git: { stagingArea: on }, commit: { nonModal: true } } } } as never);
}

beforeEach(() => {
  localStorage.clear();
  useVcs.setState({ available: true, root: "/p", repo: "/p", roots: ["/p"], status: [A, B] } as never);
  useCommit.setState({ commitDiffPreview: false, selection: [], checks: new Map() });
});

afterEach(() => setStaging(false));

const rows = () => screen.getAllByRole("treeitem");
/** Selects the row at `index` (tree order) with the keyboard, as a user does. */
function selectRow(index: number) {
  const tree = screen.getByRole("tree", { name: "Changes" });
  tree.focus();
  fireEvent.keyDown(tree, { key: "Home" });
  for (let i = 0; i < index; i++) fireEvent.keyDown(tree, { key: "ArrowDown" });
}
const preview = () => {
  const p = screen.getByTestId("diff-preview");
  return { left: JSON.parse(p.dataset.left!), right: JSON.parse(p.dataset.right!) };
};
const rowIndex = (label: string, nth = 0) =>
  rows()
    .map((r, i) => [r.textContent ?? "", i] as const)
    .filter(([t]) => t.includes(label))[nth]![1];

describe("Commit tool window Preview Diff with the staging area", () => {
  beforeEach(() => {
    setStaging(true);
    render(<CommitToolWindow />);
    act(() => setCommitDiffPreview(true));
  });

  it("previews HEAD ↔ index for a file under Staged", () => {
    selectRow(rowIndex("a.ts", 0));
    expect(preview().left).toMatchObject({ type: "rev", rev: "HEAD" });
    expect(preview().right).toMatchObject({ type: "rev", rev: ":0" });
  });

  it("previews index ↔ working tree for a file under Unstaged", () => {
    selectRow(rowIndex("a.ts", 1));
    expect(preview().left).toMatchObject({ type: "rev", rev: ":0" });
    expect(preview().right).toMatchObject({ type: "worktree" });
  });

  it("shows the empty state for a group header, even with a single file under it", () => {
    selectRow(rowIndex("Unstaged"));
    expect(screen.queryByTestId("diff-preview")).toBeNull();
    expect(screen.getByText("Select a file to preview its changes")).toBeTruthy();
  });
});

describe("Local Changes Preview Diff with the staging area", () => {
  it("previews the selected node's side of the index", () => {
    setStaging(true);
    useCommit.setState({ diffPreview: true });
    render(<LocalChangesView />);
    selectRow(rowIndex("a.ts", 1));
    expect(preview().left).toMatchObject({ type: "rev", rev: ":0" });
    expect(preview().right).toMatchObject({ type: "worktree" });
    selectRow(rowIndex("a.ts", 0));
    expect(preview().left).toMatchObject({ type: "rev", rev: "HEAD" });
    expect(preview().right).toMatchObject({ type: "rev", rev: ":0" });
  });
});

describe("Commit tool window Preview Diff without the staging area", () => {
  it("still previews HEAD ↔ working tree, also for a header with a single file", () => {
    useVcs.setState({ status: [B] });
    render(<CommitToolWindow />);
    act(() => setCommitDiffPreview(true));
    selectRow(0);
    expect(preview().left).toMatchObject({ type: "rev", rev: "HEAD" });
    expect(preview().right).toMatchObject({ type: "worktree" });
  });
});
