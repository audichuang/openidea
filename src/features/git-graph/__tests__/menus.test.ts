import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Branch, Commit, GraphStash } from "@/bindings";
import type { MenuItem } from "@/ui";

const graphRefOp = vi.fn();
const graphBisect = vi.fn();
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      graphRefOp: (repo: string, op: unknown) => graphRefOp(repo, op),
      graphBisect: (repo: string, op: unknown) => graphBisect(repo, op),
    },
  };
});

import { provideGitGraphBridge, type GitGraphBridge, type GraphCommit } from "@/workbench/gitGraphBridge";
import { buildEntries, layoutInput, WORKING_ID, type GraphEntry } from "../entries";
import { branchExtras, commitExtras, compareExtras, dropMenu, tagExtras } from "../menus";
import { initialGraphView, useGraphView } from "../viewState";

const REPO = "/repo";
const ok = <T>(data: T) => Promise.resolve({ status: "ok" as const, data });

const commit = (id: string, parents: string[], opts: Partial<Commit> = {}): GraphCommit => ({
  id,
  shortId: id.slice(0, 8),
  parents,
  author: "Ann",
  email: "a@example.com",
  timeMs: 0,
  summary: id,
  message: id,
  refs: [],
  repo: REPO,
  ...opts,
});
const stash = (index: number, id: string, base: string): GraphStash => ({
  index,
  id,
  base,
  message: `wip ${index}`,
  timeMs: 1,
});
const branch = (name: string, opts: Partial<Branch> = {}): Branch => ({
  name,
  remote: false,
  current: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  lastCommitMs: 0,
  ...opts,
});
const entry = (c: GraphCommit): GraphEntry => ({ kind: "commit", id: c.id, parents: c.parents, commit: c });
const labels = (items: MenuItem[]) =>
  items.flatMap((i) =>
    i.kind === "separator" || i.kind === "header" ? [] : [i.kind === "action" ? (i.label ?? i.action) : i.label],
  );
const runLabel = async (items: MenuItem[], label: string) => {
  const item = items.find(
    (i) => i.kind !== "separator" && i.kind !== "header" && i.kind !== "action" && i.label === label,
  );
  if (!item || item.kind === "separator" || item.kind === "header" || item.kind === "action")
    throw new Error(`no ${label}`);
  item.run?.();
  await new Promise((r) => setTimeout(r, 0));
};

const bridge = {
  rebaseCurrentOnto: vi.fn(async () => {}),
  mergeIntoCurrent: vi.fn(async () => {}),
  confirm: vi.fn(async () => true),
  prompt: vi.fn(async (): Promise<string | null> => "origin/feature"),
  runOp: <T>(_t: string, fn: () => Promise<T>): Promise<T | undefined> => fn(),
};
let withdraw: () => void;
beforeEach(() => {
  withdraw = provideGitGraphBridge(bridge as unknown as GitGraphBridge);
  graphRefOp.mockImplementation(() => ok(null));
  graphBisect.mockImplementation(() => ok({ active: true, current: "x", culprit: null, output: "" }));
  useGraphView.setState(initialGraphView());
});
afterEach(() => {
  withdraw();
  vi.clearAllMocks();
});

describe("graph entries", () => {
  it("puts uncommitted changes first and each stash above its base", () => {
    const commits = [commit("c3", ["c2"]), commit("c2", ["c1"]), commit("c1", [])];
    const entries = buildEntries(
      commits,
      [stash(0, "s0", "c2"), stash(1, "s1", "c2"), stash(2, "gone", "missing")],
      { staged: 1, unstaged: 0, untracked: 2, conflicted: 0 },
      "c3",
      REPO,
    );
    expect(entries.map((e) => e.id)).toEqual([WORKING_ID, "c3", "s0", "s1", "c2", "c1"]);
    expect(entries[0]!.parents).toEqual(["c3"]);
    expect(layoutInput(entries)[0]).toEqual({ id: WORKING_ID, parents: ["c3"], dashed: [true] });
    expect(layoutInput(entries)[1]).toEqual({ id: "c3", parents: ["c2"] });
  });

  it("leaves out the working row when clean or when HEAD is not loaded", () => {
    const commits = [commit("c1", [])];
    const clean = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
    expect(buildEntries(commits, [], clean, "c1", REPO).map((e) => e.id)).toEqual(["c1"]);
    expect(buildEntries(commits, [], { ...clean, unstaged: 1 }, "other", REPO).map((e) => e.id)).toEqual(["c1"]);
  });
});

describe("drop menu", () => {
  const head = { head: "main", headCommit: "h" };
  const headEntry = entry(commit("h", ["p"], { refs: ["HEAD", "main"] }));
  const other = entry(commit("o", ["p"]));

  it("merges or rebases with a branch dropped on the current branch's commit", async () => {
    const items = dropMenu({ kind: "ref", ref: { kind: "local", name: "feature" } }, headEntry, REPO, head);
    expect(labels(items)).toEqual(["Merge 'feature' into 'main'", "Rebase 'main' onto 'feature'"]);
    await runLabel(items, "Merge 'feature' into 'main'");
    expect(bridge.mergeIntoCurrent).toHaveBeenCalledWith("feature", REPO);
  });

  it("rebases or resets the current branch dropped on another commit", async () => {
    const items = dropMenu({ kind: "ref", ref: { kind: "local", name: "main" } }, other, REPO, head);
    expect(labels(items)[0]).toBe("Rebase 'main' onto o");
    expect(items.some((i) => i.kind === "action" && i.action === "vcs.log.resetToHere")).toBe(true);
    await runLabel(items, "Rebase 'main' onto o");
    expect(bridge.rebaseCurrentOnto).toHaveBeenCalledWith("o", REPO);
  });

  it("cherry-picks a commit dropped on the current branch's commit", () => {
    const c = commit("x", ["p"]);
    const items = dropMenu({ kind: "commit", commit: c }, headEntry, REPO, head);
    expect(items).toEqual([expect.objectContaining({ kind: "action", action: "vcs.log.cherryPick", arg: c })]);
  });

  it("offers nothing for drops that mean nothing", () => {
    expect(dropMenu({ kind: "ref", ref: { kind: "local", name: "feature" } }, other, REPO, head)).toEqual([]);
    expect(dropMenu({ kind: "commit", commit: commit("x", []) }, other, REPO, head)).toEqual([]);
    expect(dropMenu({ kind: "ref", ref: { kind: "head", name: "HEAD" } }, headEntry, REPO, head)).toEqual([]);
    const working: GraphEntry = {
      kind: "working",
      id: WORKING_ID,
      parents: ["h"],
      state: { staged: 1, unstaged: 0, untracked: 0, conflicted: 0 },
    };
    expect(dropMenu({ kind: "ref", ref: { kind: "local", name: "feature" } }, working, REPO, head)).toEqual([]);
  });
});

describe("reference extras", () => {
  it("pushes and deletes tags locally and on each remote", async () => {
    const items = tagExtras("v1", REPO, [{ name: "origin", url: "u", pushUrl: null } as never]);
    expect(labels(items)).toEqual(["Push Tag to 'origin'", "Delete Tag", "Delete Tag from 'origin'"]);
    await runLabel(items, "Push Tag to 'origin'");
    expect(graphRefOp).toHaveBeenLastCalledWith(REPO, { op: "pushTag", remote: "origin", name: "v1" });
    await runLabel(items, "Delete Tag");
    expect(bridge.confirm).toHaveBeenCalled();
    expect(graphRefOp).toHaveBeenLastCalledWith(REPO, { op: "deleteTag", name: "v1" });
    await runLabel(items, "Delete Tag from 'origin'");
    expect(graphRefOp).toHaveBeenLastCalledWith(REPO, { op: "deleteRemoteTag", remote: "origin", name: "v1" });
  });

  it("does not delete a tag the user did not confirm", async () => {
    bridge.confirm.mockResolvedValueOnce(false);
    await runLabel(tagExtras("v1", REPO, []), "Delete Tag");
    expect(graphRefOp).not.toHaveBeenCalled();
  });

  it("sets an upstream, suggesting the same-named remote branch", async () => {
    const items = branchExtras(branch("feature"), REPO, ["origin/main", "origin/feature"]);
    expect(labels(items)).toEqual(["Set Upstream…"]);
    await runLabel(items, "Set Upstream…");
    expect(bridge.prompt).toHaveBeenCalledWith(expect.objectContaining({ initial: "origin/feature" }));
    expect(graphRefOp).toHaveBeenLastCalledWith(REPO, {
      op: "setUpstream",
      branch: "feature",
      upstream: "origin/feature",
    });
  });

  it("unsets an upstream and ignores remote branches", async () => {
    const items = branchExtras(branch("feature", { upstream: "origin/feature" }), REPO, []);
    await runLabel(items, "Unset Upstream");
    expect(graphRefOp).toHaveBeenLastCalledWith(REPO, { op: "unsetUpstream", branch: "feature" });
    expect(branchExtras(branch("origin/x", { remote: true }), REPO, [])).toEqual([]);
  });
});

describe("compare in PR view", () => {
  it("opens the PR view with the branch going into the current branch", async () => {
    await runLabel(compareExtras(branch("origin/feature", { remote: true }), REPO, "main"), "Compare in PR View");
    expect(useGraphView.getState().mode).toBe("pr");
    expect(useGraphView.getState().pr[REPO]).toEqual({
      base: "main",
      head: "origin/feature",
      tab: "files",
      file: null,
    });
  });

  it("keeps the remembered base for the current branch itself", async () => {
    useGraphView.setState({ pr: { [REPO]: { base: "develop", head: "x", tab: "commits", file: "a.ts" } } });
    await runLabel(compareExtras(branch("main", { current: true }), REPO, "main"), "Compare in PR View");
    expect(useGraphView.getState().pr[REPO]).toEqual({ base: "develop", head: "main", tab: "files", file: null });
  });
});

describe("commit extras", () => {
  const newer = commit("n".repeat(40), ["o".repeat(40)], { timeMs: 2000 });
  const older = commit("o".repeat(40), [], { timeMs: 1000 });

  it("opens the file tree at the commit", async () => {
    await runLabel(commitExtras(newer, [newer], null), "Show Files at Revision");
    expect(useGraphView.getState()).toMatchObject({ panel: "tree", treeRev: newer.id });
  });

  it("starts a bisect with the newer commit bad and the older good", async () => {
    const items = commitExtras(older, [older, newer], null);
    await runLabel(items, `Bisect: Bad ${newer.shortId}, Good ${older.shortId}`);
    expect(graphBisect).toHaveBeenCalledWith(REPO, { op: "start", bad: newer.id, good: older.id });
  });

  it("marks commits while a bisect runs", async () => {
    const items = commitExtras(newer, [newer], { active: true, current: newer.id, culprit: null, output: "" });
    expect(labels(items)).toContain("Bisect: Mark Good");
    await runLabel(items, "Bisect: Mark Bad");
    expect(graphBisect).toHaveBeenCalledWith(REPO, { op: "bad", rev: newer.id });
  });
});
