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
      const { commitMenu } = await import("./GitLog");
      return withoutLogNavigation(commitMenu(commit, selection));
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
