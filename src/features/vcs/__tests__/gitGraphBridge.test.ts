/**
 * Contract of the Git Graph bridge (fork-owned): what the graph relies on from the vcs
 * feature. A failure here after an upstream rebase means upstream changed a menu, the layout
 * or the state the graph reuses; fix `gitGraphBridge.ts`, not the graph.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Branch, Commit, FileStatus } from "@/bindings";
import type { MenuItem } from "@/ui";

const upstream = { name: null as string | null, outgoing: [] as string[] };
/** Repository roots the backend reports, with the operation each stopped in. */
const backend = {
  roots: [] as Array<{ root: string; operation: string | null }>,
};

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
      vcsRoots: () =>
        Promise.resolve({
          status: "ok",
          data: backend.roots.map((r) => ({ ...r, head: "main", headCommit: "a" })),
        }),
      vcsStatus: () => Promise.resolve({ status: "ok", data: [] }),
      vcsBranches: () => Promise.resolve({ status: "ok", data: [] }),
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
  return { ...real, editorService: () => ({ openInput }), toolWindowService: () => ({ show: showToolWindow }) };
});
const showToolWindow = vi.fn();

const controlOperation = vi.fn();
vi.mock("../operations", async (importOriginal) => {
  const real = await importOriginal<typeof import("../operations")>();
  return {
    ...real,
    controlOperation: (control: string, expected: string | null, root?: string) =>
      controlOperation(control, expected, root),
  };
});
const showConflictsDialog = vi.fn();
vi.mock("../conflictsUi", async (importOriginal) => {
  const real = await importOriginal<typeof import("../conflictsUi")>();
  return { ...real, showConflictsDialog: () => showConflictsDialog(useVcs.getState().repo) };
});
const stashChanges = vi.fn();
const showRollbackDialog = vi.fn();
vi.mock("../changeOps", async (importOriginal) => {
  const real = await importOriginal<typeof import("../changeOps")>();
  return {
    ...real,
    stashChanges: (paths: readonly string[], repo: string | null) => stashChanges(paths, repo),
    showRollbackDialog: (files: FileStatus[]) => showRollbackDialog(files.map((f) => f.path)),
  };
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
import { closeLogTab, emptyFilters, selectGitTab, useGitLog } from "../logStore";
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
  backend.roots = [{ root: REPO, operation: null }];
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

  // s branches off `base` above a 40-commit main line: its lane runs 40 rows with no node.
  // Ids and parents only, as the graph view lays them out.
  const longSide = (base: string | null) => {
    const node = (id: string, parents: string[]) => ({ id, parents });
    const main = Array.from({ length: 40 }, (_, i) => node(`m${i}`, [i < 39 ? `m${i + 1}` : (base ?? "x")]));
    return [node("s", [base ?? "y"]), ...main, ...(base ? [node(base, [])] : [])];
  };

  it("presents the Git Log's default: long edges end in arrows, lanes packed", () => {
    const commits = longSide("base");
    const laid = bridge().layout(commits).rows;
    const rows = bridge().present(laid);
    expect(rows).toHaveLength(commits.length);
    expect(laid[20]!.width).toBe(2);
    // The side lane's middle is hidden, so the main line packs into lane 0.
    expect(rows[20]).toMatchObject({ lane: 0, width: 1, up: [{ from: 0, to: 0 }], down: [{ from: 0, to: 0 }] });
    expect(rows.flatMap((r) => r.down).filter((s) => s.arrow === "down")).toHaveLength(1);
    expect(rows.flatMap((r) => r.up).filter((s) => s.arrow === "up")).toHaveLength(1);
  });

  it("points each arrow at the row at its edge's other end", () => {
    const commits = longSide("base");
    const rows = bridge().present(bridge().layout(commits).rows);
    // The side commit "s" (row 0) and its parent "base" (the last row).
    expect(rows.flatMap((r) => r.down).find((s) => s.arrow === "down")?.targetRow).toBe(commits.length - 1);
    expect(rows.flatMap((r) => r.up).find((s) => s.arrow === "up")?.targetRow).toBe(0);
  });

  it("drops the stubs of lanes still open after the last loaded row", () => {
    const rows = bridge().present(bridge().layout(longSide(null)).rows);
    // The side lane leaves with a down arrow and never comes back: no stub on the last rows.
    expect(rows.flatMap((r) => r.down).filter((s) => s.arrow === "down")).toHaveLength(1);
    expect(rows.flatMap((r) => r.up).some((s) => s.arrow === "up")).toBe(false);
    expect(Math.max(...rows.slice(10).map((r) => r.width))).toBe(1);
  });

  it("draws a lane change as one diagonal across the row boundary", () => {
    const commits = [
      commit("a", ["b", "c"]),
      commit("b", ["e"]),
      commit("c", ["d"]),
      commit("d", ["e"]),
      commit("e", []),
    ];
    const rows = bridge().present(bridge().layout(commits).rows);
    expect(rows[0]!.down.find((s) => s.from === 0 && s.to === 1)?.toX).toBe(0.5);
    expect(rows[1]!.up.find((s) => s.from === 1)?.fromX).toBe(0.5);
  });

  it("keeps a pseudo row's dashed edge through the presentation", () => {
    const rows = bridge().present(
      bridge().layout([{ id: "working", parents: ["a"], dashed: [true] }, commit("a", [])]).rows,
    );
    expect(rows[0]!.down[0]!.dashed).toBe(true);
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

  it("keeps history rewrites enabled on commits already on the upstream", async () => {
    const local = commit("l".repeat(40), ["p".repeat(40)]);
    const pushed = commit("p".repeat(40), []);
    upstream.name = "origin/main";
    upstream.outgoing = [local.id];
    const state = (items: MenuItem[], id: string) => disabledOf(items, id);
    const onPushed = await bridge().commitMenu(pushed, [pushed]);
    for (const id of [
      "vcs.log.dropCommit",
      "vcs.log.fixup",
      "vcs.log.squashInto",
      "vcs.log.editMessage",
      "vcs.log.interactiveRebase",
    ])
      expect(state(onPushed, id)).toBe(false);
    expect(state(onPushed, "vcs.log.pushUpToHere")).toBe(true);
    const onLocal = await bridge().commitMenu(local, [local]);
    expect(state(onLocal, "vcs.log.dropCommit")).toBe(false);
    expect(state(onLocal, "vcs.log.pushUpToHere")).toBe(false);
    const both = await bridge().commitMenu(local, [local, pushed]);
    expect(state(both, "vcs.log.squashCommits")).toBe(false);
    expect(state(both, "vcs.log.dropCommit")).toBe(false);
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
    expect(labels(bridge().stashMenu({ index: 0, id: "s0", base: "b0", message: "wip", timeMs: null }, REPO))).toEqual([
      "Apply",
      "Pop",
      "Unstash…",
      "Drop",
    ]);
  });

  describe("with the graph on another repository than the selected one (#367)", () => {
    const [APP, LIB] = ["/work/app", "/work/lib"];
    const changed = (path: string): FileStatus => ({
      path,
      relPath: path.split("/").pop()!,
      staged: null,
      unstaged: "modified",
      renamedFrom: null,
    });

    beforeEach(() => {
      backend.roots = [
        { root: APP, operation: null },
        { root: LIB, operation: "rebase" },
      ];
      useVcs.setState({
        root: APP,
        roots: [APP, LIB],
        repo: APP,
        status: [changed(`${APP}/a.ts`), changed(`${LIB}/b.ts`)],
      });
    });

    it("continues and aborts the graph repository's operation", async () => {
      await bridge().controlOperation(LIB, "continue", "rebase");
      expect(controlOperation).toHaveBeenLastCalledWith("continue", "rebase", LIB);
      expect(useVcs.getState().repo).toBe(LIB);
      useVcs.setState({ repo: APP });
      await bridge().controlOperation(LIB, "abort", "rebase");
      expect(controlOperation).toHaveBeenLastCalledWith("abort", "rebase", LIB);
    });

    it("opens the conflicts dialog on the graph's repository", async () => {
      await bridge().resolveConflicts(LIB);
      expect(showConflictsDialog).toHaveBeenLastCalledWith(LIB);
    });

    it("shows the graph repository's history in a Log tab of its own, leaving the main Log's filters", async () => {
      useVcs.setState({ repo: APP });
      const main = { ...emptyFilters(), repositories: [APP], paths: [`${APP}/src`] };
      useGitLog.setState({ filters: main });
      const before = useGitLog.getState().logTabs.length;
      await bridge().showLog(LIB);
      const tabs = useGitLog.getState().logTabs;
      const tab = tabs.at(-1)!;
      expect(tabs.length).toBe(before + 1);
      expect(tab).toMatchObject({ kind: "log", repositories: [LIB], target: "lib" });
      expect(useGitLog.getState().shownLog).toBe(tab.id);
      // Its own filters start empty: the main Log's repository and folder would hide this one.
      const own = useGitLog.getState().filters;
      expect(own).toMatchObject({ path: null, branches: [], text: "" });
      expect(own.paths ?? []).toEqual([]);
      expect(own.repositories ?? []).toEqual([]);
      expect(showToolWindow).toHaveBeenLastCalledWith("git", true);
      // The main Log still has the user's filters, and the next click reuses the tab.
      selectGitTab("log");
      expect(useGitLog.getState().filters).toEqual(main);
      await bridge().showLog(LIB);
      expect(useGitLog.getState().logTabs.length).toBe(before + 1);
      expect(useGitLog.getState().shownLog).toBe(tab.id);
      selectGitTab("log");
      closeLogTab(tab.id);
      useGitLog.setState({ filters: emptyFilters() });
    });

    it("stashes and rolls back the graph repository's changes, leaving the selection alone", () => {
      bridge().stashChanges(LIB);
      expect(stashChanges).toHaveBeenLastCalledWith([], LIB);
      bridge().rollback(LIB);
      expect(showRollbackDialog).toHaveBeenLastCalledWith([`${LIB}/b.ts`]);
      expect(useVcs.getState().repo).toBe(APP);
    });
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

  it("chains an embedded revision diff, handing the next file back to the host", () => {
    const files = [
      { path: "a.ts", kind: "modified" as const, oldPath: null },
      { path: "b.ts", kind: "modified" as const, oldPath: null },
    ];
    const onNeighbour = vi.fn();
    const data = bridge().revisionDiffInput(REPO, MB, HEAD_SIDE, files[0]!, { files, reveal: "last", onNeighbour })
      .data as {
      chain?: { path: string }[];
      reveal?: string;
      onNeighbour?: (next: unknown) => void;
    };
    expect(data.chain?.map((d) => d.path)).toEqual([`${REPO}/a.ts`, `${REPO}/b.ts`]);
    expect(data.reveal).toBe("last");
    // F7 past the last difference: the host gets the changed file, not a new editor tab.
    data.onNeighbour?.({ ...data.chain![1], reveal: "first" });
    expect(onNeighbour).toHaveBeenCalledWith(files[1], "first");
    expect(openInput).not.toHaveBeenCalled();
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
    useFavoriteBranches.setState({ byRepo: { [REPO]: ["zeta"] } });
    const { rows, input, onSelect } = renderFilter(REPO);
    expect(screen.getByText("Local")).toBeTruthy();
    expect(screen.getByText("Remote")).toBeTruthy();
    fireEvent.click(screen.getByText("Local"));
    fireEvent.click(screen.getByText("Remote"));
    expect(screen.getByText("origin/dev")).toBeTruthy();
    expect(screen.queryByText("origin/HEAD")).toBeNull();
    const order = ["zeta", "alpha", "main"].map((n) => rows().indexOf(n));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    fireEvent.change(input, { target: { value: "dev" } });
    expect(screen.queryByText("alpha")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("origin/dev");
  });

  it("uses a repository's own favorites, the defaults when it has none", () => {
    useFavoriteBranches.setState({ byRepo: { [REPO]: ["zeta"] } });
    const { rows } = renderFilter("/other");
    fireEvent.click(screen.getByText("Local"));
    const order = ["main", "alpha", "zeta"].map((n) => rows().indexOf(n));
    expect(order.every((i) => i >= 0)).toBe(true);
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
