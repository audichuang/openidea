/** The Git Graph tab's toolbar: repository, branch filter, find, and the remote / commit actions. */
import { useState, type ReactNode } from "react";
import clsx from "clsx";
import type { Branch } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { Icon, IconButton, SearchField, Spinner, T } from "@/ui";
import { gitGraphBridge } from "@/workbench/gitGraphBridge";
import { PickerPopup } from "./PickerPopup";
import type { GraphMode } from "./viewState";
import styles from "./GitGraph.module.css";

interface ToolbarProps {
  mode: GraphMode;
  onMode: (mode: GraphMode) => void;
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
  const [branchAnchor, setBranchAnchor] = useState<HTMLElement | null>(null);
  const BranchFilterPopup = gitGraphBridge()?.BranchFilterPopup;
  const toggleBranch = (name: string) =>
    p.onBranchFilter(
      p.branchFilter.includes(name) ? p.branchFilter.filter((b) => b !== name) : [...p.branchFilter, name],
    );
  const repoColor = (root: string) => gitGraphBridge()?.repoColor(root, p.roots) ?? null;
  const swatch = (root: string) => {
    const color = repoColor(root);
    return color ? <span className={styles.repoSwatch} style={{ background: color }} aria-hidden="true" /> : null;
  };
  const [repoAnchor, setRepoAnchor] = useState<HTMLElement | null>(null);
  const branchLabel = p.branchFilter.length
    ? p.branchFilter.length === 1
      ? p.branchFilter[0]!
      : tx`${p.branchFilter.length} branches`
    : tx("All branches");
  const graph = p.mode === "graph";
  const modeTab = (mode: GraphMode, label: ReactNode) => (
    <button
      type="button"
      role="tab"
      aria-selected={p.mode === mode}
      className={clsx(styles.paneTab, p.mode === mode && styles.paneTabActive)}
      onClick={() => p.onMode(mode)}
    >
      {label}
    </button>
  );
  return (
    <div className={styles.toolbar} role="toolbar" aria-label={tx("Git Graph")}>
      <span className={styles.modeSwitch} role="tablist" aria-label={tx("Git Graph View")}>
        {modeTab("graph", <T>Graph</T>)}
        {/* An abbreviation every locale keeps as is. */}
        {modeTab("pr", "PR")}
      </span>
      {p.roots.length > 1 && p.repo ? (
        <button
          type="button"
          className={styles.dropdown}
          onClick={(e) => setRepoAnchor(e.currentTarget)}
          aria-label={tx("Repository")}
          aria-haspopup="dialog"
        >
          {swatch(p.repo) ?? <Icon name="folder" size={14} />}
          <span>{repoName(p.repo)}</span>
          <Icon name="chevron-down" size={12} />
        </button>
      ) : null}
      {repoAnchor ? (
        <PickerPopup
          anchor={repoAnchor}
          items={p.roots.map((root) => ({
            value: root,
            label: repoName(root),
            icon: swatch(root) ?? <Icon name="folder" size={14} />,
            checked: root === p.repo,
          }))}
          onPick={p.onRepo}
          onClose={() => setRepoAnchor(null)}
          label="Repositories"
          placeholder="Search repositories"
          emptyLabel="No matching repositories"
        />
      ) : null}
      {graph ? (
        <>
          <button
            type="button"
            className={styles.dropdown}
            onClick={(e) => setBranchAnchor(e.currentTarget)}
            aria-label={tx("Branches")}
            aria-haspopup="dialog"
          >
            <Icon name="branch" size={14} />
            <span>{branchLabel}</span>
            <Icon name="chevron-down" size={12} />
          </button>
          {p.branchFilter.length ? (
            <IconButton icon="close" title="Show All Branches" onClick={() => p.onBranchFilter([])} />
          ) : null}
          <IconButton
            icon="web"
            title="Show Remote Branches"
            pressed={p.showRemotes}
            onClick={() => p.onShowRemotes(!p.showRemotes)}
          />
          {branchAnchor && BranchFilterPopup ? (
            <BranchFilterPopup
              anchor={branchAnchor}
              repo={p.repo ?? ""}
              branches={p.branches}
              selected={p.branchFilter}
              onSelect={(branch) => {
                toggleBranch(branch);
                setBranchAnchor(null);
              }}
              onSelectMany={p.onBranchFilter}
              onClose={() => setBranchAnchor(null)}
            />
          ) : null}
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
        </>
      ) : null}
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
