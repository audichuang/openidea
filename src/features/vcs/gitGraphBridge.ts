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
import { computeGraph, emptyGraphState, laneColor, type GraphState } from "./graph";
import { diffInput, openDiff, withChain, type DiffData, type DiffSide } from "./diffInput";
import { repoColor } from "./model";
import { repositoryPath } from "./repositoryPaths";
import { toLogChanges } from "./logChanges";
import { refLabels } from "./logOptions";
import { focusRepo, useVcs } from "./store";
import { mergeIntoCurrent, rebaseOnto } from "./branchOps";
import { applyStash, dropStash, showUnstashDialog } from "./changeOps";
import { runOp } from "./ops";
import { confirmDialog, promptText } from "./dialogs";
import { GraphBranchFilterPopup } from "./gitGraphBranchFilter";
import { call, commands } from "@/platform/ipc";
import { getAction } from "@/platform/actions";

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

/** Entries that rewrite history: disabled on commits already on the upstream. */
const REWRITES = new Set([
  "vcs.log.editMessage",
  "vcs.log.fixup",
  "vcs.log.squashInto",
  "vcs.log.squashCommits",
  "vcs.log.dropCommit",
  "vcs.log.interactiveRebase",
]);

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

/** The commit menu's push-dependent states, from the graph's own outgoing set (same rules as the Git Log). */
export function applyPushGuard(
  items: MenuItem[],
  commit: GraphCommit,
  selection: GraphCommit[],
  outgoing: Set<string> | null,
  head: string | null,
): MenuItem[] {
  const pushed = (c: GraphCommit) => outgoing !== null && !outgoing.has(c.id);
  const targets = selection.some((c) => c.id === commit.id) ? selection : [commit];
  const anyPushed = targets.some(pushed);
  // Without an upstream there is no outgoing set: allow pushing up to any commit of HEAD.
  const canPushHere = !!head && (outgoing ? outgoing.has(commit.id) : true);
  return items.map((item) => {
    if (item.kind !== "action") return item;
    if (REWRITES.has(item.action)) return { ...item, disabled: anyPushed };
    if (item.action === "vcs.log.pushUpToHere") return { ...item, disabled: !canPushHere };
    return item;
  });
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
      const [{ commitMenu }, outgoing] = await Promise.all([import("./GitLog"), outgoingCommits(commit.repo)]);
      const head = useVcs.getState().heads[commit.repo]?.head ?? null;
      return applyPushGuard(withoutLogNavigation(commitMenu(commit, selection)), commit, selection, outgoing, head);
    },
    async branchMenu(branch, repo) {
      const { branchMenu, inRepo } = await import("./branchMenu");
      const current = useVcs.getState().heads[repo]?.head ?? null;
      return inRepo(repo, withActionLabels(branchMenu(branch, current)));
    },
    BranchFilterPopup: GraphBranchFilterPopup,
    async tagMenu(tag, repo) {
      const { tagMenu, inRepo } = await import("./branchMenu");
      return inRepo(repo, withActionLabels(tagMenu(tag)));
    },
    async filesMenu(commit, files) {
      const { changesMenu } = await import("./GitLog");
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
