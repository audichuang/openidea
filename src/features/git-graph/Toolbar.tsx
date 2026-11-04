/** The Git Graph tab's toolbar: repository, branch filter, find, and the remote / commit actions. */
import type { MouseEvent as ReactMouseEvent } from "react";
import type { Branch } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { Icon, IconButton, SearchField, showContextMenu, Spinner, T, type MenuItem } from "@/ui";
import styles from "./GitGraph.module.css";

interface ToolbarProps {
  roots: string[];
  repo: string | null;
  onRepo: (r: string) => void;
  branches: Branch[];
  branchFilter: string[];
  onBranchFilter: (b: string[]) => void;
  showRemotes: boolean;
  onShowRemotes: (v: boolean) => void;
  query: string;
  onQuery: (q: string) => void;
  matchText: string;
  onStep: (dir: 1 | -1) => void;
  loading: boolean;
  onRefresh: () => void;
  operation: string | null;
}

const repoName = (root: string) =>
  root
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() ?? root;

export function Toolbar(p: ToolbarProps) {
  const branchMenu = (e: ReactMouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const toggle = (name: string) =>
      p.onBranchFilter(
        p.branchFilter.includes(name) ? p.branchFilter.filter((b) => b !== name) : [...p.branchFilter, name],
      );
    const items: MenuItem[] = [
      { label: "Show All Branches", checked: !p.branchFilter.length, run: () => p.onBranchFilter([]) },
      { label: "Show Remote Branches", checked: p.showRemotes, run: () => p.onShowRemotes(!p.showRemotes) },
      { kind: "separator" },
      { kind: "header", label: "Local" },
      ...p.branches
        .filter((b) => !b.remote)
        .map((b): MenuItem => ({
          label: b.name,
          verbatim: true,
          checked: p.branchFilter.includes(b.name),
          run: () => toggle(b.name),
        })),
      { kind: "header", label: "Remote" },
      ...p.branches
        .filter((b) => b.remote)
        .map((b): MenuItem => ({
          label: b.name,
          verbatim: true,
          checked: p.branchFilter.includes(b.name),
          run: () => toggle(b.name),
        })),
    ];
    showContextMenu({ x: r.left, y: r.bottom + 2 }, items);
  };
  const repoMenu = (e: ReactMouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    showContextMenu(
      { x: r.left, y: r.bottom + 2 },
      p.roots.map((root) => ({
        label: repoName(root),
        verbatim: true,
        checked: root === p.repo,
        run: () => p.onRepo(root),
      })),
    );
  };
  const branchLabel = p.branchFilter.length
    ? p.branchFilter.length === 1
      ? p.branchFilter[0]!
      : tx`${p.branchFilter.length} branches`
    : tx("All branches");
  return (
    <div className={styles.toolbar} role="toolbar" aria-label={tx("Git Graph")}>
      {p.roots.length > 1 && p.repo ? (
        <button type="button" className={styles.dropdown} onClick={repoMenu} aria-label={tx("Repository")}>
          <Icon name="folder" size={14} />
          <span>{repoName(p.repo)}</span>
          <Icon name="chevron-down" size={12} />
        </button>
      ) : null}
      <button type="button" className={styles.dropdown} onClick={branchMenu} aria-label={tx("Branches")}>
        <Icon name="branch" size={14} />
        <span>{branchLabel}</span>
        <Icon name="chevron-down" size={12} />
      </button>
      <SearchField
        className={styles.search}
        value={p.query}
        onChange={p.onQuery}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            p.onStep(e.shiftKey ? -1 : 1);
          }
        }}
        placeholder={tx("Find commit (message, author, hash)")}
        aria-label={tx("Find commit")}
      />
      {p.matchText ? <span className={styles.matchText}>{p.matchText}</span> : null}
      <IconButton icon="arrow-up" title="Previous Match" onClick={() => p.onStep(-1)} disabled={!p.query} />
      <IconButton icon="arrow-down" title="Next Match" onClick={() => p.onStep(1)} disabled={!p.query} />
      <span className={styles.spacer} />
      {p.operation && !/bisect/i.test(p.operation) ? <OperationBar operation={p.operation} /> : null}
      {p.loading ? <Spinner size={14} /> : null}
      <IconButton icon="refresh" title="Refresh" onClick={p.onRefresh} />
      <IconButton icon="git-fetch" title="Fetch" action="vcs.fetch" />
      <IconButton icon="git-pull" title="Pull…" action="vcs.pull" />
      <IconButton icon="git-push" title="Push…" action="vcs.push" />
      <IconButton icon="commit" title="Commit…" action="vcs.commit" />
      <IconButton icon="history" title="Show Git Log" action="vcs.showLog" />
    </div>
  );
}

/** Continue / Abort for a merge, rebase, cherry-pick or revert in progress. */
function OperationBar({ operation }: { operation: string }) {
  const op = operation.toLowerCase();
  const kind = op.includes("rebase")
    ? "rebase"
    : op.includes("cherry")
      ? "cherryPick"
      : op.includes("revert")
        ? "revert"
        : op.includes("merge")
          ? "merge"
          : null;
  return (
    <span className={styles.operation} role="status">
      <Icon name="warning" size={14} />
      <span>{operation}</span>
      {kind && kind !== "merge" ? (
        <button type="button" className={styles.opButton} onClick={() => void executeAction(`vcs.${kind}.continue`)}>
          <T>Continue</T>
        </button>
      ) : null}
      {kind === "merge" ? (
        <button type="button" className={styles.opButton} onClick={() => void executeAction("vcs.resolveConflicts")}>
          <T>Resolve Conflicts…</T>
        </button>
      ) : null}
      {kind ? (
        <button type="button" className={styles.opButton} onClick={() => void executeAction(`vcs.${kind}.abort`)}>
          <T>Abort</T>
        </button>
      ) : null}
    </span>
  );
}
