import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const commit = vi.hoisted(() => vi.fn());

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  const ok = (data: unknown) => Promise.resolve({ status: "ok" as const, data });
  return {
    ...real,
    isTauri: () => false,
    call: async (p: Promise<{ status: "ok"; data: unknown }>) => (await p).data,
    commands: { ...real.commands, vcsCommit: commit.mockImplementation(() => ok("commit1")) },
  };
});

import type { CommitSelection, FileStatus } from "@/bindings";
import { useProject } from "@/platform/project";
import { maybeCommitService, registerCommitCheckProvider } from "@/workbench/contributions";
import { commitChanges } from "../changeOps";
import { draftRevision, installDraftRevision, provideCommit } from "../commitSelection";
import { useCommit } from "../commitStore";
import { useVcs } from "../store";

const files: FileStatus[] = ["a", "b"].map((n) => ({
  path: `/p/${n}.ts`,
  relPath: `${n}.ts`,
  staged: null,
  unstaged: "modified",
  renamedFrom: null,
}));

let disposers: Array<() => void> = [];

function setStaging(on: boolean) {
  useProject.setState({ settings: { vcs: { git: { stagingArea: on }, commit: { nonModal: true } } } } as never);
}

beforeEach(() => {
  localStorage.clear();
  setStaging(false);
  commit.mockClear();
  useVcs.setState({
    available: false,
    root: "/p",
    repo: "/p",
    roots: ["/p"],
    status: files,
    branch: null,
    operations: {},
  });
  useCommit.setState({
    message: "feat: x",
    amend: false,
    checks: new Map([["/p/b.ts", "none" as const]]),
    excludedHunks: new Map(),
    checkProblems: [],
    stagingExcludedRoots: new Set(),
  });
  disposers = [installDraftRevision(), provideCommit()];
});

afterEach(() => disposers.reverse().forEach((d) => d()));

describe("the commit plugins see", () => {
  it("is what Commit would commit, and the message is replaced only at its revision", async () => {
    const service = maybeCommitService()!;
    const selection = (await service.selection())!;
    expect(selection.message).toBe("feat: x");
    expect(selection.repositories).toEqual([
      { root: "/p", options: expect.objectContaining({ stage: ["/p/a.ts"], exclude: [], partial: [] }) },
    ]);

    // The user types meanwhile: the plugin's message would overwrite it.
    useCommit.setState({ message: "feat: typed" });
    expect(service.setMessage(selection.revision, "generated")).toBe(false);
    expect(useCommit.getState().message).toBe("feat: typed");

    expect(service.setMessage(draftRevision(), "generated")).toBe(true);
    expect(useCommit.getState().message).toBe("generated");
    // Including another file is a new draft too.
    const before = draftRevision();
    useCommit.setState({ checks: new Map() });
    expect(draftRevision()).toBeGreaterThan(before);
  });

  it("leaves another repository's staged files out of the only repository committed", async () => {
    const staged: FileStatus = {
      path: "/w/b/new.yml",
      relPath: "new.yml",
      staged: "added",
      unstaged: null,
      renamedFrom: null,
    };
    const changed: FileStatus = { ...files[0]!, path: "/w/a/Foo.java", relPath: "Foo.java" };
    useVcs.setState({ root: "/w", repo: "/w/a", roots: ["/w/a", "/w/b"], status: [changed, staged] });
    useCommit.setState({ checks: new Map([["/w/b/new.yml", "none" as const]]) });
    const selection = (await maybeCommitService()!.selection())!;
    expect(selection.repositories).toEqual([
      { root: "/w/a", options: expect.objectContaining({ stage: ["/w/a/Foo.java"], exclude: [] }) },
    ]);
  });

  it("is null without a repository", async () => {
    useVcs.setState({ root: null });
    expect(await maybeCommitService()!.selection()).toBeNull();
    expect(maybeCommitService()!.setMessage(draftRevision(), "x")).toBe(false);
  });
});

describe("the commit plugins see with the staging area", () => {
  /** b.ts is staged but unticked: the checkboxes and the index disagree. */
  const staged: FileStatus[] = [files[0]!, { ...files[1]!, staged: "modified", unstaged: null }];

  it("is the index as Commit commits it, not the checkboxes", async () => {
    useVcs.setState({ status: staged });
    expect((await maybeCommitService()!.selection())!.repositories).toEqual([
      { root: "/p", options: expect.objectContaining({ stage: ["/p/a.ts"], exclude: ["/p/b.ts"], partial: [] }) },
    ]);

    setStaging(true);
    expect((await maybeCommitService()!.selection())!.repositories).toEqual([
      { root: "/p", options: expect.objectContaining({ stage: [], exclude: [], partial: [] }) },
    ]);
  });

  it("leaves out the repositories unticked on their Staged node", async () => {
    setStaging(true);
    const q: FileStatus = { ...staged[1]!, path: "/q/c.ts", relPath: "c.ts" };
    useVcs.setState({ roots: ["/p", "/q"], status: [...staged, q] });
    useCommit.setState({ stagingExcludedRoots: new Set(["/p"]) });
    const selection = (await maybeCommitService()!.selection())!;
    expect(selection.repositories.map((r) => r.root)).toEqual(["/q"]);
  });

  it("is a new draft when the mode, the unticked repositories or the index change", () => {
    useVcs.setState({ status: staged });
    let before = draftRevision();
    setStaging(true);
    expect(draftRevision()).toBeGreaterThan(before);

    before = draftRevision();
    useCommit.setState({ stagingExcludedRoots: new Set(["/p"]) });
    expect(draftRevision()).toBeGreaterThan(before);

    // A refresh that finds the same index keeps the draft.
    before = draftRevision();
    useVcs.setState({ status: staged.map((f) => ({ ...f })) });
    expect(draftRevision()).toBe(before);

    useVcs.setState({ status: staged.map((f) => ({ ...f, staged: "modified" as const })) });
    expect(draftRevision()).toBeGreaterThan(before);
  });

  it("keeps the draft when an unstaged edit appears without the staging area", () => {
    useVcs.setState({ status: staged });
    const before = draftRevision();
    useVcs.setState({ status: staged.map((f) => ({ ...f, staged: "modified" as const })) });
    expect(draftRevision()).toBe(before);
  });
});

describe("contributed before-commit checks", () => {
  it("stop the commit with their problems, and run on what it commits", async () => {
    const seen: Array<{ selection: CommitSelection; keys: string[] }> = [];
    disposers.push(
      registerCommitCheckProvider({
        checks: () => [{ key: "acme/markers", title: "Markers" }],
        run: async (selection, keys) => {
          seen.push({ selection, keys });
          return [{ title: "Markers", message: "Remove the marker.", path: "/p/a.ts", line: 3 }];
        },
      }),
    );
    expect(await commitChanges()).toBeUndefined();
    expect(commit).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.keys).toEqual(["acme/markers"]);
    expect(seen[0]!.selection.repositories[0]!.options.stage).toEqual(["/p/a.ts"]);
    const [problem] = useCommit.getState().checkProblems;
    expect(problem).toMatchObject({ title: "Markers", text: "Remove the marker.", details: { label: "a.ts:4" } });

    // Commit Anyway: the shown problems are not asked again.
    expect(await commitChanges()).toBe("commit1");
    expect(seen).toHaveLength(1);
  });
});
