/**
 * Fork-owned: provides the Git Graph view's bridge (`workbench/gitGraphBridge.ts`) from the
 * vcs feature's own menus, diff editor, lane layout and state. This file is the only place
 * the graph depends on vcs internals; `__tests__/gitGraphBridge.test.ts` pins what it relies on.
 */
import type { ChangedFile } from "@/bindings";
import type { MenuItem } from "@/ui";
import {
  provideGitGraphBridge,
  type GitGraphBridge,
  type GraphCommit,
  type GraphLayoutState,
  type GraphRevisionSide,
} from "@/workbench/gitGraphBridge";
import {
  compactLanes,
  computeGraph,
  emptyGraphState,
  hideLongEdges,
  laneColor,
  straightenLaneChanges,
  type GraphRow,
  type GraphSegment,
  type GraphState,
} from "./graph";
import { diffInput, openDiff, withChain, type DiffData, type DiffSide } from "./diffInput";
import { repoColor } from "./model";
import { repositoryPath } from "./repositoryPaths";
import { toLogChanges } from "./logChanges";
import { refLabels } from "./logOptions";
import { currentRepo, focusRepo, repoName, repoOf, useVcs } from "./store";
import { emptyFilters, openLogTab, selectGitTab, setLogFilters, useGitLog } from "./logStore";
import { toolWindowService } from "@/workbench/contributions";
import { mergeIntoCurrent, rebaseOnto } from "./branchOps";
import {
  applyStash,
  dropStash,
  rollbackCandidates,
  showRollbackDialog,
  showUnstashDialog,
  stashChanges,
} from "./changeOps";
import { runOp } from "./ops";
import { confirmDialog, promptText } from "./dialogs";
import { GraphBranchFilterPopup } from "./gitGraphBranchFilter";
import { call, commands } from "@/platform/ipc";
import { executeAction, getAction } from "@/platform/actions";

/** The Git Log changes menu's ClipCode entry reads the log's selection; point it at the graph's. */
export function retargetClipItems(items: MenuItem[], commits: GraphCommit[]): MenuItem[] {
  return items.map((item) =>
    item.kind === "action" && item.action === "clip.copyLogChanges" && item.arg && typeof item.arg === "object"
      ? { ...item, arg: { ...(item.arg as object), commits } }
      : item,
  );
}

/** Go to Child / Parent move the Git Log's own selection; the graph links parents in its details. */
const LOG_NAVIGATION = new Set(["vcs.log.goToChild", "vcs.log.goToParent"]);

export function withoutLogNavigation(items: MenuItem[]): MenuItem[] {
  return items.filter((i) => i.kind !== "action" || !LOG_NAVIGATION.has(i.action));
}

/**
 * Commits of HEAD not on its upstream (`@{u}..HEAD`); null without an upstream. The Git Log's
 * own pushed check only knows the commits that log has loaded, so the graph asks itself.
 */
async function outgoingCommits(repo: string): Promise<Set<string> | null> {
  try {
    const info = await call(commands.vcsBranchInfo(repo));
    if (!info.upstream) return null;
    const commits = await call(
      commands.vcsLog(repo, {
        branch: "HEAD",
        path: null,
        author: null,
        text: null,
        range: "@{u}..HEAD",
        skip: 0,
        limit: 0,
      }),
    );
    return new Set(commits.map((c) => c.id));
  } catch {
    return null;
  }
}

/**
 * Push up to Here from the graph's own outgoing set (same rule as the Git Log). History
 * rewrites stay enabled on pushed commits: running one asks for confirmation first.
 */
export function applyPushGuard(
  items: MenuItem[],
  commit: GraphCommit,
  outgoing: Set<string> | null,
  head: string | null,
): MenuItem[] {
  // Without an upstream there is no outgoing set: allow pushing up to any commit of HEAD.
  const canPushHere = !!head && (outgoing ? outgoing.has(commit.id) : true);
  return items.map((item) =>
    item.kind === "action" && item.action === "vcs.log.pushUpToHere" ? { ...item, disabled: !canPushHere } : item,
  );
}

/**
 * `inRepo` turns action entries into plain ones labelled with the action id when they carry
 * no label; give them the action's title first so the menu reads "ClipCode: …", not an id.
 */
export function withActionLabels(items: MenuItem[]): MenuItem[] {
  return items.map((i) =>
    i.kind === "action" && !i.label ? { ...i, label: getAction(i.action)?.title ?? i.action } : i,
  );
}

/** `file` changed between two revisions (Compare Branches' mapping): added and deleted files get an empty side. */
export function revisionFileDiff(
  repo: string,
  from: GraphRevisionSide,
  to: GraphRevisionSide,
  file: ChangedFile,
): DiffData {
  const missing = (label: string): DiffSide => ({ type: "text", text: "", label });
  return {
    path: repositoryPath(repo, file.path),
    left:
      file.kind === "added" || file.kind === "untracked"
        ? missing("(does not exist)")
        : {
            type: "rev",
            rev: from.rev,
            label: from.label,
            path: file.oldPath ? repositoryPath(repo, file.oldPath) : undefined,
          },
    right: file.kind === "deleted" ? missing("(deleted)") : { type: "rev", rev: to.rev, label: to.label },
  };
}

/**
 * `hideLongEdges` ends every run still open after the last loaded row there, so each lane heading
 * to commits not loaded yet gets an up-arrow stub on the last rows: hundreds of lanes side by side
 * on a merge-heavy history. Such a lane continues out of sight below; its down arrow where it
 * disappears says so, so drop the tail stub (from its up arrow to the last row).
 */
function dropTailStubs(rows: readonly GraphRow[]): GraphRow[] {
  const last = rows.at(-1);
  if (!last) return rows.slice();
  const straight = (list: readonly GraphSegment[], lane: number) => list.some((s) => s.from === lane && s.to === lane);
  const through = (row: GraphRow, lane: number) =>
    row.lane !== lane && straight(row.up, lane) && straight(row.down, lane);
  const upArrow = (row: GraphRow, lane: number) =>
    row.up.some((s) => s.arrow === "up" && s.from === lane && s.to === lane);
  // Lane → first row of its tail stub.
  const cut = new Map<number, number>();
  for (const s of last.up) {
    const lane = s.from;
    if (s.to !== lane || cut.has(lane)) continue;
    let r = rows.length - 1;
    while (r >= 0 && through(rows[r]!, lane) && !upArrow(rows[r]!, lane)) r--;
    if (r >= 0 && through(rows[r]!, lane) && upArrow(rows[r]!, lane)) cut.set(lane, r);
  }
  if (!cut.size) return rows.slice();
  const hidden = (s: GraphSegment, r: number) => s.from === s.to && r >= (cut.get(s.from) ?? Infinity);
  const filter = (list: GraphSegment[], targets: string[] | undefined, r: number) => {
    const kept = list.flatMap((s, i) => (hidden(s, r) ? [] : [i]));
    if (kept.length === list.length) return [list, targets] as const;
    return [kept.map((i) => list[i]!), targets && kept.map((i) => targets[i]!)] as const;
  };
  return rows.map((row, r) => {
    const [up, upTargets] = filter(row.up, row.upTargets, r);
    const [down, downTargets] = filter(row.down, row.downTargets, r);
    return up === row.up && down === row.down ? row : { ...row, up, down, upTargets, downTargets };
  });
}

/** Matches no branch name (git refuses NUL in ref names). */
const NO_REMOTES: ReadonlySet<string> = new Set(["\0"]);

export function createGitGraphBridge(): GitGraphBridge {
  return {
    state() {
      const s = useVcs.getState();
      return { roots: s.roots, repo: s.repo, heads: s.heads, operations: s.operations, version: s.version };
    },
    subscribe(listener) {
      return useVcs.subscribe((s, prev) => {
        if (
          s.version !== prev.version ||
          s.roots !== prev.roots ||
          s.repo !== prev.repo ||
          s.heads !== prev.heads ||
          s.operations !== prev.operations
        )
          listener();
      });
    },
    layout(commits, state) {
      const prev = (state?._layout as GraphState | undefined) ?? emptyGraphState();
      const { rows, state: next } = computeGraph(commits, prev);
      return { rows, state: { _layout: next } satisfies GraphLayoutState };
    },
    present(rows) {
      // The Git Log's default (Show Long Edges off), as in `logPresentation.ts`.
      return straightenLaneChanges(compactLanes(dropTailStubs(hideLongEdges(rows))));
    },
    laneColor,
    repoColor,
    refLabels(refs, remoteBranches) {
      // An empty set makes `refLabels` guess remotes from a `/` in the name (`feature/x`);
      // the graph always knows the repository's remote branches, so never let it guess.
      const remotes = remoteBranches.size ? remoteBranches : NO_REMOTES;
      return refLabels(refs, { compact: false, tagNames: true }, remotes).map((l) => ({
        kind: l.kind,
        name: l.kind === "head" ? "HEAD" : l.title,
      }));
    },
    async commitMenu(commit, selection) {
      const [{ commitMenu }, outgoing] = await Promise.all([import("./log/commitMenu"), outgoingCommits(commit.repo)]);
      const head = useVcs.getState().heads[commit.repo]?.head ?? null;
      return applyPushGuard(withoutLogNavigation(commitMenu(commit, selection)), commit, outgoing, head);
    },
    async branchMenu(branch, repo) {
      const { branchMenu, inRepo } = await import("./branchMenu");
      const current = useVcs.getState().heads[repo]?.head ?? null;
      return inRepo(repo, withActionLabels(branchMenu(branch, current, undefined, undefined, repo)));
    },
    BranchFilterPopup: GraphBranchFilterPopup,
    async tagMenu(tag, repo) {
      const { tagMenu, inRepo } = await import("./branchMenu");
      return inRepo(repo, withActionLabels(tagMenu(tag)));
    },
    async filesMenu(commit, files) {
      const { changesMenu } = await import("./log/CommitDetails");
      return retargetClipItems(changesMenu(toLogChanges(files, commit, commit.repo)), [commit]);
    },
    async openDiff(commit, files: ChangedFile[], index, preview = false) {
      const diffs = toLogChanges(files, commit, commit.repo).map((c) => c.diff);
      if (!diffs[index]) return;
      await openDiff(withChain(diffs, index), preview ? { preview: true, focus: false } : {});
    },
    revisionDiffInput(repo, from, to, file, nav) {
      const embedded = (f: ChangedFile): DiffData => ({
        ...revisionFileDiff(repo, from, to, f),
        embedded: true,
        readOnly: true,
      });
      const index = nav ? nav.files.indexOf(file) : -1;
      if (!nav || index < 0 || nav.files.length < 2) return diffInput(embedded(file));
      const items = nav.files.map(embedded);
      return diffInput({
        ...withChain(items, index),
        reveal: nav.reveal,
        onNeighbour: (next) => {
          const f = nav.files[items.findIndex((d) => d.path === next.path)];
          if (f) nav.onNeighbour(f, next.reveal ?? "first");
        },
      });
    },
    async openRevisionDiff(repo, from, to, files, index) {
      const diffs = files.map((f) => revisionFileDiff(repo, from, to, f));
      if (!diffs[index]) return;
      await openDiff(withChain(diffs, index));
    },
    async copyRange(repo, base, tip) {
      const { copyClip } = await import("./clip");
      return copyClip({ kind: "range", repo, base, tip, paths: [] });
    },
    async openRevisionFile(repo, rev, path) {
      await openDiff({
        path: repositoryPath(repo, path),
        left: { type: "rev", rev, label: rev.slice(0, 8) },
        right: { type: "worktree" },
      });
    },
    stashMenu(index, message, repo) {
      return [
        { label: "Apply", run: () => void applyStash(index, false, repo) },
        { label: "Pop", run: () => void applyStash(index, true, repo) },
        { label: "Unstash…", run: () => showUnstashDialog(index, repo) },
        { kind: "separator" },
        { label: "Drop", danger: true, icon: "trash", run: () => void dropStash(index, message, repo) },
      ];
    },
    // `repo` is passed down: the selection may change while the status refreshes. It is selected
    // too, as `inRepo` does, for the conflicts dialog a refused Continue opens.
    async controlOperation(repo, control, operation) {
      const { controlOperation, inProgress } = await import("./operations");
      await focusRepo(repo);
      await controlOperation(control, inProgress(operation), repo);
    },
    // Reads the selected repository's operation, so `repo` is selected first.
    async resolveConflicts(repo) {
      const { showConflictsDialog } = await import("./conflictsUi");
      await focusRepo(repo);
      if (currentRepo() === repo) showConflictsDialog();
    },
    stashChanges(repo) {
      void stashChanges([], repo);
    },
    rollback(repo) {
      showRollbackDialog(rollbackCandidates().filter((f) => repoOf(f.path) === repo));
    },
    async showLog(repo) {
      await focusRepo(repo);
      if (currentRepo() !== repo) return;
      // One repository: the main Log is that repository's.
      if (useVcs.getState().roots.length < 2) return void (await executeAction("vcs.showLog"));
      // Several: a Log tab of its own for the graph's repository, reused on the next click; the
      // main Log keeps the user's filters (#389).
      const existing = useGitLog
        .getState()
        .logTabs.find((t) => t.kind === "log" && t.repositories?.length === 1 && t.repositories[0] === repo);
      if (existing) selectGitTab(existing.id);
      else {
        openLogTab("log", repoName(repo), "toolWindow", [repo]);
        // A new "log" tab starts from the main Log's filters, which may name another repository.
        setLogFilters({ ...emptyFilters(), paths: undefined, repositories: undefined });
      }
      toolWindowService().show("git", true);
    },
    async mergeIntoCurrent(branch, repo) {
      await focusRepo(repo);
      await mergeIntoCurrent(branch);
    },
    async rebaseCurrentOnto(branch, repo) {
      await focusRepo(repo);
      await rebaseOnto(branch);
    },
    runOp(title, fn, success) {
      return runOp(title, fn, { success });
    },
    confirm(opts) {
      return confirmDialog(opts);
    },
    async prompt(opts) {
      return (await promptText(opts))?.value ?? null;
    },
  };
}

export function activate() {
  return provideGitGraphBridge(createGitGraphBridge());
}
