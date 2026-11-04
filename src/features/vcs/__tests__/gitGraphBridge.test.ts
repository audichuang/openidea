/**
 * Contract of the Git Graph bridge (fork-owned): what the graph relies on from the vcs
 * feature. A failure here after an upstream rebase means upstream changed a menu, the layout
 * or the state the graph reuses; fix `gitGraphBridge.ts`, not the graph.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Branch, Commit } from "@/bindings";
import type { MenuItem } from "@/ui";

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsTags: () => Promise.resolve({ status: "ok", data: [] }),
      vcsLog: () => Promise.resolve({ status: "ok", data: [] }),
      vcsConfigGet: () => Promise.resolve({ status: "ok", data: null }),
    },
  };
});

import { gitGraphBridge, type GraphCommit } from "@/workbench/gitGraphBridge";
import { activate, retargetClipItems } from "../gitGraphBridge";
import { useVcs } from "../store";

const REPO = "/repo";

const commit = (id: string, parents: string[], opts: Partial<Commit> = {}): GraphCommit => ({
  id,
  shortId: id.slice(0, 8),
  parents,
  author: "A",
  email: "a@example.com",
  timeMs: 0,
  summary: `commit ${id}`,
  message: `commit ${id}`,
  refs: [],
  repo: REPO,
  ...opts,
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

const actionIds = (items: MenuItem[]) => items.flatMap((i) => (i.kind === "action" ? [i.action] : []));
const labels = (items: MenuItem[]) =>
  items.flatMap((i) => (i.kind === "separator" || i.kind === "header" || i.kind === "action" ? [] : [i.label]));

let dispose: () => void;

beforeEach(() => {
  dispose = activate();
  useVcs.setState({
    available: true,
    root: REPO,
    roots: [REPO],
    repo: REPO,
    heads: { [REPO]: { head: "main", headCommit: "a" } },
    branchesLoaded: true,
  });
});

afterEach(() => {
  dispose();
});

const bridge = () => {
  const b = gitGraphBridge();
  if (!b) throw new Error("bridge not provided");
  return b;
};

describe("git graph bridge", () => {
  it("is provided on activation and withdrawn on dispose", () => {
    expect(gitGraphBridge()).not.toBeNull();
    dispose();
    expect(gitGraphBridge()).toBeNull();
    dispose = activate();
  });

  it("exposes the vcs state and notifies on refresh", () => {
    expect(bridge().state()).toMatchObject({ roots: [REPO], repo: REPO, heads: { [REPO]: { head: "main" } } });
    const listener = vi.fn();
    const off = bridge().subscribe(listener);
    useVcs.setState((s) => ({ version: s.version + 1 }));
    expect(listener).toHaveBeenCalledTimes(1);
    useVcs.setState({ loading: true });
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });

  it("lays out a branch and merge with one colour per branch line", () => {
    // a ← merge of b (main line) and c (side branch), both from d.
    const commits = [commit("a", ["b", "c"]), commit("b", ["d"]), commit("c", ["d"]), commit("d", [])];
    const { rows } = bridge().layout(commits);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 1, 0]);
    expect(rows[1]!.color).toBe(rows[0]!.color);
    expect(rows[2]!.color).not.toBe(rows[0]!.color);
    expect(rows[0]!.down.some((s) => s.from === 0 && s.to === 1)).toBe(true);
    expect(rows[3]!.up.some((s) => s.from === 1 && s.to === 0)).toBe(true);
  });

  it("continues the layout across pages", () => {
    const first = bridge().layout([commit("a", ["b"])]);
    const next = bridge().layout([commit("b", [])], first.state);
    expect(next.rows[0]!.lane).toBe(0);
    expect(next.rows[0]!.color).toBe(first.rows[0]!.color);
    expect(bridge().laneColor(0)).toMatch(/^var\(--/);
  });

  it("splits decorations into one label per reference", () => {
    const refs = ["HEAD", "main", "origin/main", "tag: v1"];
    expect(bridge().refLabels(refs, new Set(["origin/main"]))).toEqual([
      { kind: "head", name: "HEAD" },
      { kind: "local", name: "main" },
      { kind: "remote", name: "origin/main" },
      { kind: "tag", name: "v1" },
    ]);
  });

  it("offers the Git Log commit operations for one commit", async () => {
    const c = commit("b".repeat(40), ["c".repeat(40)]);
    const ids = actionIds(await bridge().commitMenu(c, [c]));
    for (const id of [
      "vcs.log.copyRevision",
      "clip.copyCommits",
      "vcs.log.cherryPick",
      "vcs.log.checkoutRevision",
      "vcs.log.compareWithLocal",
      "vcs.log.resetToHere",
      "vcs.log.revert",
      "vcs.log.newBranch",
      "vcs.log.newTag",
      "vcs.log.interactiveRebase",
    ])
      expect(ids).toContain(id);
  });

  it("offers the multi-commit operations for a selection", async () => {
    const a = commit("a".repeat(40), ["b".repeat(40)]);
    const b = commit("b".repeat(40), ["c".repeat(40)]);
    const ids = actionIds(await bridge().commitMenu(a, [a, b]));
    for (const id of ["vcs.log.cherryPick", "vcs.log.compareVersions", "vcs.log.squashCommits", "clip.copyCommits"])
      expect(ids).toContain(id);
  });

  it("offers checkout, merge, rebase and delete for a branch", async () => {
    const items = await bridge().branchMenu(branch("feature"), REPO);
    const text = labels(items).join("\n");
    expect(text).toContain("Checkout");
    expect(text).toMatch(/Merge 'feature' into 'main'/);
    expect(text).toMatch(/Rebase 'main' onto 'feature'/);
    expect(text).toContain("Delete");
  });

  it("offers checkout and new branch for a tag", async () => {
    const text = labels(await bridge().tagMenu("v1", REPO)).join("\n");
    expect(text).toContain("Checkout");
    expect(text).toMatch(/New Branch from 'v1'/);
  });

  it("offers the changed-file operations with ClipCode on the graph's commit", async () => {
    const c = commit("b".repeat(40), ["c".repeat(40)]);
    const items = await bridge().filesMenu(c, [{ path: "src/a.ts", kind: "modified", oldPath: null }]);
    const ids = actionIds(items);
    for (const id of ["vcs.log.changes.showDiff", "vcs.log.changes.compareWithLocal", "clip.copyLogChanges"])
      expect(ids).toContain(id);
    const clip = items.find((i) => i.kind === "action" && i.action === "clip.copyLogChanges");
    expect(clip && clip.kind === "action" && (clip.arg as { commits: GraphCommit[] }).commits).toEqual([c]);
  });

  it("retargets only the ClipCode entry", () => {
    const c = commit("a", []);
    const items: MenuItem[] = [
      { kind: "action", action: "clip.copyLogChanges", arg: { commits: [], changes: [1] } },
      { kind: "action", action: "vcs.log.changes.showDiff", arg: [1] },
    ];
    expect(retargetClipItems(items, [c])).toEqual([
      { kind: "action", action: "clip.copyLogChanges", arg: { commits: [c], changes: [1] } },
      { kind: "action", action: "vcs.log.changes.showDiff", arg: [1] },
    ]);
  });
});
