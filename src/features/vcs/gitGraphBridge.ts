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
} from "@/workbench/gitGraphBridge";
import { computeGraph, emptyGraphState, laneColor, type GraphState } from "./graph";
import { openDiff, withChain } from "./diffInput";
import { toLogChanges } from "./logChanges";
import { refLabels } from "./logOptions";
import { useVcs } from "./store";
import { call, commands } from "@/platform/ipc";

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
      return inRepo(repo, branchMenu(branch, current));
    },
    async tagMenu(tag, repo) {
      const { tagMenu, inRepo } = await import("./branchMenu");
      return inRepo(repo, tagMenu(tag));
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
  };
}

export function activate() {
  return provideGitGraphBridge(createGitGraphBridge());
}
