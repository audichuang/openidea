/**
 * Menu entries the graph adds on top of the vcs feature's (tags, upstreams, bisect, pseudo rows)
 * and the menu a drag and drop opens.
 */
import type { Branch, GraphBisectOp, GraphBisectState, GraphRefOp, Remote } from "@/bindings";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import type { MenuItem } from "@/ui";
import { gitGraphBridge, type GraphCommit, type GraphRefLabel } from "@/workbench/gitGraphBridge";
import type { GraphEntry } from "./entries";
import { useGraphView } from "./viewState";

function refOp(repo: string, title: string, op: GraphRefOp, success: string) {
  return gitGraphBridge()?.runOp(title, () => call(commands.graphRefOp(repo, op)), success);
}

export function bisect(repo: string, op: GraphBisectOp): Promise<GraphBisectState | undefined> {
  const title = op.op === "start" ? "Start Bisect" : op.op === "reset" ? "Reset Bisect" : tx`Bisect: Mark ${op.op}`;
  return gitGraphBridge()?.runOp(title, () => call(commands.graphBisect(repo, op))) ?? Promise.resolve(undefined);
}

/** Tag entries beyond the Branches popup's: delete it locally, push it, delete it on a remote. */
export function tagExtras(tag: string, repo: string, remotes: readonly Remote[]): MenuItem[] {
  const bridge = gitGraphBridge();
  if (!bridge) return [];
  return [
    { kind: "separator" },
    ...remotes.map((r): MenuItem => ({
      label: tx`Push Tag to '${r.name}'`,
      icon: "git-push",
      run: () =>
        void refOp(
          repo,
          tx`Push tag ${tag}`,
          { op: "pushTag", remote: r.name, name: tag },
          tx`Pushed tag ${tag} to ${r.name}`,
        ),
    })),
    {
      label: "Delete Tag",
      danger: true,
      icon: "trash",
      run: () =>
        void (async () => {
          if (
            !(await bridge.confirm({
              title: "Delete Tag",
              message: tx`Delete tag '${tag}'?`,
              okLabel: "Delete",
              danger: true,
            }))
          )
            return;
          await refOp(repo, tx`Delete tag ${tag}`, { op: "deleteTag", name: tag }, tx`Deleted tag ${tag}`);
        })(),
    },
    ...remotes.map((r): MenuItem => ({
      label: tx`Delete Tag from '${r.name}'`,
      danger: true,
      run: () =>
        void (async () => {
          const ok = await bridge.confirm({
            title: "Delete Remote Tag",
            message: tx`Delete tag '${tag}' from '${r.name}'?`,
            okLabel: "Delete",
            danger: true,
          });
          if (ok)
            await refOp(
              repo,
              tx`Delete tag ${tag} from ${r.name}`,
              { op: "deleteRemoteTag", remote: r.name, name: tag },
              tx`Deleted tag ${tag} from ${r.name}`,
            );
        })(),
    })),
  ];
}

/** Local branch entries beyond the Branches popup's: its upstream. */
export function branchExtras(branch: Branch, repo: string, remoteBranches: readonly string[]): MenuItem[] {
  if (branch.remote) return [];
  const bridge = gitGraphBridge();
  if (!bridge) return [];
  const suggestion = remoteBranches.find((r) => r.endsWith(`/${branch.name}`)) ?? remoteBranches[0] ?? "";
  return [
    { kind: "separator" },
    {
      label: "Set Upstream…",
      run: () =>
        void (async () => {
          const upstream = await bridge.prompt({
            title: tx`Set Upstream of '${branch.name}'`,
            label: "Upstream branch:",
            initial: branch.upstream ?? suggestion,
            okLabel: "Set",
          });
          if (upstream)
            await refOp(
              repo,
              tx`Set upstream of ${branch.name}`,
              { op: "setUpstream", branch: branch.name, upstream },
              tx`${branch.name} now tracks ${upstream}`,
            );
        })(),
    },
    ...(branch.upstream
      ? [
          {
            label: "Unset Upstream",
            run: () =>
              void refOp(
                repo,
                tx`Unset upstream of ${branch.name}`,
                { op: "unsetUpstream", branch: branch.name },
                tx`${branch.name} no longer tracks a branch`,
              ),
          } satisfies MenuItem,
        ]
      : []),
  ];
}

/** Entries for the uncommitted-changes row. */
export function workingMenu(): MenuItem[] {
  return [
    { kind: "action", action: "vcs.commit" },
    { kind: "action", action: "vcs.stash" },
    { kind: "action", action: "vcs.shelve" },
    { kind: "separator" },
    { kind: "action", action: "vcs.rollback" },
  ];
}

/** Graph entries appended to a commit's menu: file tree, bisect. */
export function commitExtras(
  c: GraphCommit,
  selection: GraphCommit[],
  bisectState: GraphBisectState | null,
): MenuItem[] {
  const items: MenuItem[] = [
    { kind: "separator" },
    {
      label: "Show Files at Revision",
      icon: "folder",
      run: () => useGraphView.setState({ panel: "tree", treeRev: c.id }),
    },
  ];
  if (bisectState?.active) {
    items.push(
      { kind: "separator" },
      { label: "Bisect: Mark Good", run: () => void bisect(c.repo, { op: "good", rev: c.id }) },
      { label: "Bisect: Mark Bad", run: () => void bisect(c.repo, { op: "bad", rev: c.id }) },
      { label: "Bisect: Skip", run: () => void bisect(c.repo, { op: "skip", rev: c.id }) },
    );
  } else if (selection.length === 2 && selection.some((s) => s.id === c.id)) {
    // Log order: the first selected row is the newer commit.
    const [newer, older] = [...selection].sort(
      (a, b) => (b.commitTimeMs ?? b.timeMs ?? 0) - (a.commitTimeMs ?? a.timeMs ?? 0),
    );
    items.push(
      { kind: "separator" },
      {
        label: tx`Bisect: Bad ${newer!.shortId}, Good ${older!.shortId}`,
        run: () => void bisect(c.repo, { op: "start", bad: newer!.id, good: older!.id }),
      },
    );
  }
  return items;
}

/** What a dragged item is: a reference pill or a commit row. */
export type DragItem = { kind: "ref"; ref: GraphRefLabel } | { kind: "commit"; commit: GraphCommit };

export const GRAPH_DRAG = "application/x-openidea-git-graph";

/**
 * The menu for `item` dropped on `target`: onto the current branch's commit, merge or rebase
 * with a branch and cherry-pick a commit; the current branch dropped elsewhere rebases or
 * resets it there.
 */
export function dropMenu(
  item: DragItem,
  target: GraphEntry,
  repo: string,
  head: { head: string | null; headCommit: string | null } | null,
): MenuItem[] {
  const bridge = gitGraphBridge();
  if (!bridge || target.kind !== "commit") return [];
  const current = head?.head ?? null;
  const onHead = target.id === head?.headCommit;
  const c = target.commit;
  if (item.kind === "commit") {
    if (item.commit.id === c.id || !onHead) return [];
    return [
      {
        kind: "action",
        action: "vcs.log.cherryPick",
        arg: item.commit,
        label: tx`Cherry-Pick ${item.commit.shortId} onto '${current ?? "HEAD"}'`,
      },
    ];
  }
  const ref = item.ref;
  if (ref.kind === "head") return [];
  if (ref.kind === "local" && ref.name === current) {
    if (onHead) return [];
    return [
      { label: tx`Rebase '${current}' onto ${c.shortId}`, run: () => void bridge.rebaseCurrentOnto(c.id, repo) },
      { kind: "action", action: "vcs.log.resetToHere", arg: c, label: tx`Reset '${current}' to ${c.shortId}…` },
    ];
  }
  if (!onHead || !current) return [];
  return [
    { label: tx`Merge '${ref.name}' into '${current}'`, run: () => void bridge.mergeIntoCurrent(ref.name, repo) },
    { label: tx`Rebase '${current}' onto '${ref.name}'`, run: () => void bridge.rebaseCurrentOnto(ref.name, repo) },
  ];
}
