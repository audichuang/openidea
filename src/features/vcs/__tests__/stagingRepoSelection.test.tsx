import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileStatus } from "@/bindings";

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, call: vi.fn(async () => null) };
});

vi.mock("../DiffEditor", () => ({ DiffEditor: () => <div /> }));

import { useProject } from "@/platform/project";
import { useContextMenuStore } from "@/ui/Menu";
import { ChangesTree, CommitToolWindow } from "../CommitView";
import { planCommit } from "../changes";
import { useChangelists } from "../changelists";
import { useCommit } from "../commitStore";
import { isCommitAll, stagingChecks } from "../staging";
import { useVcs } from "../store";

// Two repositories side by side in the project (a monorepo with a nested repository works the same way).
const A = "/w/app";
const B = "/w/lib";
const roots = [A, B];

const file = (repo: string, rel: string, staged: FileStatus["staged"], unstaged: FileStatus["unstaged"]) =>
  ({ path: `${repo}/${rel}`, relPath: rel, staged, unstaged, renamedFrom: null }) satisfies FileStatus;

const included = (status: FileStatus[], excluded: string[], repos = roots) =>
  planCommit(status, stagingChecks(status, true, { roots: repos, excluded: new Set(excluded) })).included.map(
    (f) => f.path,
  );

describe("repositories left out of a staging area commit", () => {
  it("keeps an unticked repository's staged changes in its index, uncommitted", () => {
    const status = [
      file(A, "a.ts", "modified", null),
      file(B, "b.ts", "modified", null),
      file(B, "c.ts", null, "modified"),
    ];
    expect(included(status, [])).toEqual([`${A}/a.ts`, `${B}/b.ts`]);
    const plan = planCommit(status, stagingChecks(status, true, { roots, excluded: new Set([B]) }));
    expect(plan.included.map((f) => f.path)).toEqual([`${A}/a.ts`]);
    // Committed from a copy of the index that leaves the staged file out; the real index keeps it.
    expect(plan.exclude).toEqual([`${B}/b.ts`]);
    expect(plan.stage).toEqual([]);
  });

  it("leaves an unticked repository out of Commit All", () => {
    const status = [file(A, "a.ts", null, "modified"), file(B, "b.ts", null, "deleted")];
    expect(isCommitAll(status)).toBe(true);
    expect(included(status, [A])).toEqual([`${B}/b.ts`]);
  });

  it("is not Commit All of the other repositories when only an unticked one has staged changes", () => {
    const status = [file(A, "a.ts", "modified", null), file(B, "b.ts", null, "modified")];
    expect(isCommitAll(status)).toBe(false);
    expect(included(status, [A])).toEqual([]);
  });

  it("leaves out an unticked repository's staged addition deleted from disk", () => {
    const status = [file(A, "new.ts", "added", "deleted"), file(B, "b.ts", "modified", null)];
    expect(included(status, [])).toEqual([`${A}/new.ts`, `${B}/b.ts`]);
    expect(included(status, [A])).toEqual([`${B}/b.ts`]);
  });

  it("commits nothing when every repository is unticked", () => {
    const status = [file(A, "a.ts", "modified", null), file(B, "b.ts", "modified", null)];
    expect(included(status, roots)).toEqual([]);
  });

  it("ignores a stale exclusion once the project has a single repository", () => {
    const status = [file(A, "a.ts", "modified", null)];
    expect(included(status, [A], [A])).toEqual([`${A}/a.ts`]);
  });
});

function useSettings(stagingArea: boolean) {
  useProject.setState({
    project: { name: "w", root: "/w", trusted: true, isGit: true, settings: {} } as never,
    settings: { vcs: { git: { stagingArea }, commit: { nonModal: true } } } as never,
  });
}

const repoCheck = (name: string) => screen.queryByRole("checkbox", { name: `Include ${name} in commit` });

describe("the repository checkboxes of the staging area", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettings(true);
    useCommit.setState({
      groupByDir: false,
      groupByStaging: false,
      // Off by the user: the staging area still groups by repository.
      groupByRepo: false,
      checks: new Map(),
      stagingExcludedRoots: new Set(),
      selection: [],
      message: "feat: x",
      amend: false,
      checkResult: null,
      tab: "changes",
      commitDiffPreview: false,
    });
    useChangelists.setState({ state: { active: "a", lists: [{ id: "a", name: "Changes" }], files: {} } as never });
    useVcs.setState({
      available: true,
      root: A,
      repo: A,
      roots,
      heads: {},
      branch: null,
      operations: {},
      status: [file(A, "a.ts", "modified", null), file(B, "b.ts", "modified", null), file(B, "c.ts", null, "modified")],
    });
  });
  afterEach(() => useSettings(false));

  it("ticks the repositories with staged changes on their rows under Staged Changes", () => {
    render(<ChangesTree mode="commit" />);
    const app = repoCheck("app")!;
    const lib = repoCheck("lib")!;
    expect(app.getAttribute("aria-checked")).toBe("true");
    expect(lib.getAttribute("aria-checked")).toBe("true");
    // One checkbox per repository: none on Unstaged Changes' rows or on files.
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    act(() => {
      fireEvent.mouseDown(lib, { button: 0 });
    });
    expect([...useCommit.getState().stagingExcludedRoots]).toEqual([B]);
    expect(repoCheck("lib")!.getAttribute("aria-checked")).toBe("false");
  });

  it("puts the checkboxes on Unstaged Changes' rows for Commit All", () => {
    useVcs.setState({ status: [file(A, "a.ts", null, "modified"), file(B, "b.ts", null, "modified")] });
    render(<ChangesTree mode="commit" />);
    expect(screen.queryByText("Staged Changes")).toBeNull();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    act(() => {
      fireEvent.mouseDown(repoCheck("app")!, { button: 0 });
    });
    expect([...useCommit.getState().stagingExcludedRoots]).toEqual([A]);
  });

  it("does not offer Group By › Repository, which the checkboxes need", () => {
    render(<ChangesTree mode="commit" />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "View Options" }));
    });
    const labels = useContextMenuStore.getState().menu!.items.map((i) => ("label" in i ? i.label : null));
    act(() => useContextMenuStore.setState({ menu: null }));
    expect(labels).not.toContain("Repository");
  });

  it("shows no checkbox in a single-repository project", () => {
    useVcs.setState({ roots: [A], status: [file(A, "a.ts", "modified", null), file(A, "b.ts", null, "modified")] });
    render(<ChangesTree mode="commit" />);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("disables Commit once every repository is unticked", () => {
    render(<CommitToolWindow />);
    const commit = () => screen.getByRole("button", { name: "Commit" }) as HTMLButtonElement;
    expect(commit().disabled).toBe(false);
    act(() => useCommit.setState({ stagingExcludedRoots: new Set([A]) }));
    expect(commit().disabled).toBe(false);
    act(() => useCommit.setState({ stagingExcludedRoots: new Set(roots) }));
    expect(commit().disabled).toBe(true);
  });
});
