/**
 * Contract of the Git Graph bridge (fork-owned): what the graph relies on from the vcs
 * feature. A failure here after an upstream rebase means upstream changed a menu, the layout
 * or the state the graph reuses; fix `gitGraphBridge.ts`, not the graph.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Branch, Commit } from "@/bindings";
import type { MenuItem } from "@/ui";

const upstream = { name: null as string | null, outgoing: [] as string[] };

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsTags: () => Promise.resolve({ status: "ok", data: [] }),
      vcsLog: (_repo: string, q: { range?: string | null }) =>
        Promise.resolve({
          status: "ok",
          data: q.range === "@{u}..HEAD" ? upstream.outgoing.map((id) => ({ id, parents: [], refs: [] })) : [],
        }),
      vcsBranchInfo: () =>
        Promise.resolve({
          status: "ok",
          data: { head: "main", headCommit: "a", upstream: upstream.name, ahead: 0, behind: 0, operation: null },
        }),
      vcsConfigGet: () => Promise.resolve({ status: "ok", data: null }),
    },
  };
});

const copyClip = vi.fn(async (_source: unknown) => true);
vi.mock("../clip", async (importOriginal) => {
  const real = await importOriginal<typeof import("../clip")>();
  return { ...real, copyClip: (source: unknown) => copyClip(source) };
});
const openInput = vi.fn();
vi.mock("@/workbench/contributions", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/workbench/contributions")>();
  return { ...real, editorService: () => ({ openInput }) };
});

const chooseMany = vi.fn();
vi.mock("../dialogs", async (importOriginal) => {
  const real = await importOriginal<typeof import("../dialogs")>();
  return { ...real, chooseMany: (opts: unknown) => chooseMany(opts) };
});

import { createElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { gitGraphBridge, type GraphCommit } from "@/workbench/gitGraphBridge";
import { activate, retargetClipItems } from "../gitGraphBridge";
import { useVcs } from "../store";
import { useFavoriteBranches } from "../branchOps";
import { registerActions } from "@/platform/actions";

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

const disabledOf = (items: MenuItem[], id: string) => {
  const item = items.find((i) => i.kind === "action" && i.action === id);
  return item?.kind === "action" ? !!item.disabled : false;
};

let dispose: () => void;

beforeEach(() => {
  upstream.name = null;
  upstream.outgoing = [];
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

  it("keeps a slashed local branch local in a repository without remotes", () => {
    expect(bridge().refLabels(["feature/search"], new Set())).toEqual([{ kind: "local", name: "feature/search" }]);
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
    expect(ids).not.toContain("vcs.log.goToParent");
    expect(ids).not.toContain("vcs.log.goToChild");
  });

  it("disables history rewrites on commits already on the upstream", async () => {
    const local = commit("l".repeat(40), ["p".repeat(40)]);
    const pushed = commit("p".repeat(40), []);
    upstream.name = "origin/main";
    upstream.outgoing = [local.id];
    const state = (items: MenuItem[], id: string) => disabledOf(items, id);
    const onPushed = await bridge().commitMenu(pushed, [pushed]);
    for (const id of ["vcs.log.dropCommit", "vcs.log.fixup", "vcs.log.editMessage", "vcs.log.interactiveRebase"])
      expect(state(onPushed, id)).toBe(true);
    expect(state(onPushed, "vcs.log.pushUpToHere")).toBe(true);
    const onLocal = await bridge().commitMenu(local, [local]);
    expect(state(onLocal, "vcs.log.dropCommit")).toBe(false);
    expect(state(onLocal, "vcs.log.pushUpToHere")).toBe(false);
    const both = await bridge().commitMenu(local, [local, pushed]);
    expect(state(both, "vcs.log.squashCommits")).toBe(true);
  });

  it("allows rewrites and push-up-to-here without an upstream", async () => {
    const c = commit("c".repeat(40), []);
    const items = await bridge().commitMenu(c, [c]);
    const state = (id: string) => disabledOf(items, id);
    expect(state("vcs.log.dropCommit")).toBe(false);
    expect(state("vcs.log.pushUpToHere")).toBe(false);
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

  it("labels every branch entry with a title, never an action id", async () => {
    const off = registerActions([
      { id: "clip.copyBranchSeries", title: "ClipCode: Copy Branch Commits", run: () => {} },
      { id: "clip.copyBranchSeriesFull", title: "ClipCode: Copy Branch Commits (Entire History)", run: () => {} },
    ]);
    const items = await bridge().branchMenu(branch("feature"), REPO);
    const text = labels(items);
    expect(text).toContain("ClipCode: Copy Branch Commits");
    expect(text.some((l) => /^[a-z]+\.[a-zA-Z.]+$/.test(l))).toBe(false);
    off();
  });

  it("offers apply, pop, unstash and drop for a stash", () => {
    expect(labels(bridge().stashMenu(0, "wip", REPO))).toEqual(["Apply", "Pop", "Unstash…", "Drop"]);
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

  const MB = { rev: "m".repeat(40), label: "merge-base (main)" };
  const HEAD_SIDE = { rev: "feature", label: "feature" };
  const sides = (file: { path: string; kind: "added" | "modified" | "deleted" | "renamed"; oldPath: string | null }) =>
    bridge().revisionDiffInput(REPO, MB, HEAD_SIDE, file).data as {
      path: string;
      left: unknown;
      right: unknown;
      embedded: boolean;
      readOnly: boolean;
    };

  it("maps a changed file between two revisions to an embedded, read-only diff", () => {
    const input = bridge().revisionDiffInput(REPO, MB, HEAD_SIDE, { path: "a.ts", kind: "modified", oldPath: null });
    expect(input.kind).toBe("diff");
    expect(input.data).toMatchObject({
      path: `${REPO}/a.ts`,
      left: { type: "rev", rev: MB.rev, label: "merge-base (main)" },
      right: { type: "rev", rev: "feature", label: "feature" },
      embedded: true,
      readOnly: true,
    });
    expect(sides({ path: "n.ts", kind: "added", oldPath: null }).left).toEqual({
      type: "text",
      text: "",
      label: "(does not exist)",
    });
    expect(sides({ path: "d.ts", kind: "deleted", oldPath: null }).right).toEqual({
      type: "text",
      text: "",
      label: "(deleted)",
    });
    expect(sides({ path: "new.ts", kind: "renamed", oldPath: "old.ts" }).left).toMatchObject({
      rev: MB.rev,
      path: `${REPO}/old.ts`,
    });
  });

  it("opens a revision diff in an editor tab with the other files chained", async () => {
    const files = [
      { path: "a.ts", kind: "modified" as const, oldPath: null },
      { path: "b.ts", kind: "modified" as const, oldPath: null },
    ];
    await bridge().openRevisionDiff(REPO, MB, HEAD_SIDE, files, 1);
    const [input] = openInput.mock.calls[0] as [{ data: { path: string; embedded?: boolean; chain: unknown[] } }];
    expect(input.data.path).toBe(`${REPO}/b.ts`);
    expect(input.data.embedded).toBeUndefined();
    expect(input.data.chain).toHaveLength(2);
  });

  it("copies a revision range with ClipCode's Copy Changed Files", async () => {
    await bridge().copyRange(REPO, MB.rev, "feature");
    expect(copyClip).toHaveBeenCalledWith({ kind: "range", repo: REPO, base: MB.rev, tip: "feature", paths: [] });
  });

  const filterBranches = [
    branch("alpha"),
    branch("main"),
    branch("zeta"),
    branch("origin/HEAD", { remote: true }),
    branch("origin/dev", { remote: true }),
  ];
  const renderFilter = (repo: string) => {
    const props = { onSelect: vi.fn(), onSelectMany: vi.fn(), onClose: vi.fn() };
    render(
      createElement(bridge().BranchFilterPopup, {
        anchor: document.body,
        repo,
        branches: filterBranches,
        selected: [],
        ...props,
      }),
    );
    const rows = () => [...document.querySelectorAll("[role='option']")].map((el) => el.textContent?.trim() ?? "");
    return { ...props, rows, input: screen.getByRole("textbox", { name: "Search branches" }) };
  };

  it("offers the Git Log's searchable branch filter, grouped, with the repository's favorites first", () => {
    useFavoriteBranches.setState({ key: `openidea.vcs.favoriteBranches:${REPO}`, names: ["zeta"] });
    const { rows, input, onSelect } = renderFilter(REPO);
    expect(screen.getByText("Local")).toBeTruthy();
    expect(screen.getByText("Remote")).toBeTruthy();
    expect(screen.queryByText("origin/HEAD")).toBeNull();
    const order = ["zeta", "alpha", "main"].map((n) => rows().indexOf(n));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    fireEvent.change(input, { target: { value: "dev" } });
    expect(screen.queryByText("alpha")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("origin/dev");
  });

  it("uses the default favorites for a repository the vcs feature has not selected", () => {
    useFavoriteBranches.setState({ key: `openidea.vcs.favoriteBranches:${REPO}`, names: ["zeta"] });
    const { rows } = renderFilter("/other");
    const order = ["main", "alpha", "zeta"].map((n) => rows().indexOf(n));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("chooses several branches with the Select… dialog", async () => {
    chooseMany.mockResolvedValue(["HEAD", "zeta"]);
    const { onSelectMany, onClose } = renderFilter(REPO);
    fireEvent.click(screen.getByRole("button", { name: "Select…" }));
    expect(onClose).toHaveBeenCalled();
    expect(chooseMany).toHaveBeenCalledWith(
      expect.objectContaining({ options: ["HEAD", "alpha", "main", "zeta", "origin/dev"], initial: [] }),
    );
    await waitFor(() => expect(onSelectMany).toHaveBeenCalledWith(["HEAD", "zeta"]));
  });
});
