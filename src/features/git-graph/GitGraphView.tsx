/** The Git Graph editor tab: toolbar, the graph of every branch with stashes and uncommitted changes, and the bottom pane. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { GraphBisectState, Remote } from "@/bindings";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { EmptyState, SplitGroup, SplitHandle, SplitPanel } from "@/ui";
import { gitGraphBridge } from "@/workbench/gitGraphBridge";
import { CommitList, type CommitListProps } from "./CommitList";
import { findMatches, useGraphData, useGraphExtras, useRepoState, type GraphFilters } from "./data";
import { BottomPane } from "./Details";
import { buildEntries, layoutInput, selectedEntries, type GraphEntry } from "./entries";
import { BisectBanner } from "./panels";
import { PrView } from "./PrView";
import { Toolbar } from "./Toolbar";
import { branchFilterOf, useGraphView, type GraphPanel } from "./viewState";
import styles from "./GitGraph.module.css";

/** Remotes and the bisect state of `repo`, refreshed with the vcs state. */
function useRepoExtras(repo: string | null, version: number) {
  const [value, setValue] = useState<{ repo: string | null; remotes: Remote[]; bisect: GraphBisectState | null }>({
    repo: null,
    remotes: [],
    bisect: null,
  });
  useEffect(() => {
    if (!repo) return;
    let live = true;
    void Promise.all([
      call(commands.vcsRemotes(repo)).catch((): Remote[] => []),
      call(commands.graphBisectState(repo)).catch(() => null),
    ]).then(([remotes, bisect]) => live && setValue({ repo, remotes, bisect }));
    return () => {
      live = false;
    };
  }, [repo, version]);
  const current = value.repo === repo ? value : { repo, remotes: [], bisect: null };
  return { ...current, setBisect: (bisect: GraphBisectState) => setValue({ ...current, bisect }) };
}

const NO_IDS: string[] = [];

/** The selected ids in `repo`: read here, not in the editor, so a selection re-renders only the list and the pane. */
const useSelection = (repo: string) => useGraphView((s) => (s.selection.repo === repo ? s.selection.ids : NO_IDS));

function GraphList(p: Omit<CommitListProps, "selected" | "onSelect">) {
  const selected = useSelection(p.repo);
  const { repo } = p;
  const onSelect = useCallback((ids: string[]) => useGraphView.setState({ selection: { repo, ids } }), [repo]);
  return <CommitList {...p} selected={selected} onSelect={onSelect} />;
}

function GraphBottomPane(p: {
  entries: GraphEntry[];
  repo: string;
  version: number;
  onJump: (id: string) => void;
  remoteBranches: ReadonlySet<string>;
}) {
  const selected = useSelection(p.repo);
  const panel = useGraphView((s) => s.panel);
  const treeRev = useGraphView((s) => s.treeRev[p.repo] ?? null);
  const { repo } = p;
  const onPanel = (panel: GraphPanel) =>
    useGraphView.setState((s) => ({
      panel,
      ...(panel === "tree" ? { treeRev: { ...s.treeRev, [repo]: null } } : {}),
    }));
  return (
    <BottomPane
      panel={panel}
      onPanel={onPanel}
      entries={selectedEntries(p.entries, selected)}
      repo={repo}
      version={p.version}
      treeRev={treeRev}
      onJump={p.onJump}
      remoteBranches={p.remoteBranches}
    />
  );
}

export function GitGraphEditor() {
  const repoState = useRepoState();
  // Everything but the selection and the bottom pane's state, which `GraphList` and `GraphBottomPane` read.
  const view = useGraphView(
    useShallow((s) => ({
      repo: s.repo,
      branchFilter: s.branchFilter,
      showRemotes: s.showRemotes,
      query: s.query,
      matchIndex: s.matchIndex,
      mode: s.mode,
    })),
  );
  const set = useGraphView.setState;
  const activeRepo =
    view.repo && repoState.roots.includes(view.repo) ? view.repo : (repoState.repo ?? repoState.roots[0] ?? null);
  const { showRemotes, query, matchIndex } = view;
  const branchFilter = branchFilterOf(view, activeRepo);
  const filters = useMemo<GraphFilters>(() => ({ branches: branchFilter, showRemotes }), [branchFilter, showRemotes]);
  const data = useGraphData(activeRepo, filters, repoState.version);
  const extras = useGraphExtras(activeRepo, repoState.version);
  const repoExtras = useRepoExtras(activeRepo, repoState.version);
  const [prReload, setPrReload] = useState(0);
  const head = activeRepo ? (repoState.heads[activeRepo] ?? null) : null;
  const entries = useMemo(
    () =>
      activeRepo
        ? buildEntries(data.commits, extras.stashes, extras.working, head?.headCommit ?? null, activeRepo)
        : [],
    [data.commits, extras, head?.headCommit, activeRepo],
  );
  const bridge = gitGraphBridge();
  // Keeps the last layout: a loaded page lays out and presents only the new rows.
  const present = useMemo(() => bridge?.presenter(), [bridge]);
  const rows = useMemo(() => present?.(layoutInput(entries)) ?? [], [present, entries]);
  const width = useMemo(() => rows.reduce((m, r) => Math.max(m, r.width), 1), [rows]);
  const searchable = useMemo(() => entries.map((e) => (e.kind === "working" ? null : e.commit)), [entries]);
  const matches = useMemo(() => findMatches(searchable, query), [searchable, query]);
  const remoteBranches = useMemo(
    () => new Set(data.branches.filter((b) => b.remote).map((b) => b.name)),
    [data.branches],
  );

  if (!bridge || !repoState.roots.length || !activeRepo)
    return <EmptyState title="No Git repository" className={styles.empty} />;

  const jumpTo = (id: string) => set({ selection: { repo: activeRepo, ids: [id] }, panel: "details" });
  const step = (dir: 1 | -1) => {
    if (!matches.length) return;
    const next = (matchIndex + dir + matches.length) % matches.length;
    const e = entries[matches[next]!];
    set({ matchIndex: next, ...(e ? { selection: { repo: activeRepo, ids: [e.id] } } : {}) });
  };

  return (
    <div className={styles.root}>
      <Toolbar
        mode={view.mode}
        onMode={(mode) => set({ mode })}
        roots={repoState.roots}
        repo={activeRepo}
        onRepo={(repo) => set({ repo })}
        branches={data.branches}
        branchFilter={branchFilter}
        onBranchFilter={(b) => set((s) => ({ branchFilter: { ...s.branchFilter, [activeRepo]: b } }))}
        showRemotes={showRemotes}
        onShowRemotes={(v) => set({ showRemotes: v })}
        query={query}
        onQuery={(q) => set({ query: q, matchIndex: 0 })}
        matchText={query ? (matches.length ? `${matchIndex + 1}/${matches.length}` : tx("No matches")) : ""}
        onStep={step}
        loading={view.mode === "graph" && data.loading}
        onRefresh={view.mode === "graph" ? data.reload : () => setPrReload((n) => n + 1)}
        operation={repoState.operations[activeRepo] ?? null}
      />
      {view.mode === "pr" ? (
        <PrView repo={activeRepo} current={head?.head ?? null} version={repoState.version} reload={prReload} />
      ) : (
        <>
          {data.error ? (
            <div className={styles.error} role="alert">
              {data.error}
            </div>
          ) : null}
          {repoExtras.bisect ? (
            <BisectBanner repo={activeRepo} state={repoExtras.bisect} onJump={jumpTo} onChange={repoExtras.setBisect} />
          ) : null}
          <SplitGroup orientation="vertical" id="git-graph" className={styles.split}>
            <SplitPanel id="graph" defaultSize="65%" minSize="20%">
              <GraphList
                entries={entries}
                rows={rows}
                width={width}
                done={data.done}
                loading={data.loading}
                loadMore={data.loadMore}
                head={head}
                branches={data.branches}
                remotes={repoExtras.remotes}
                remoteBranches={remoteBranches}
                matches={matches}
                current={matches[matchIndex] ?? -1}
                repo={activeRepo}
                bisect={repoExtras.bisect}
              />
            </SplitPanel>
            <SplitHandle />
            <SplitPanel id="details" defaultSize="35%" minSize="10%">
              <GraphBottomPane
                entries={entries}
                repo={activeRepo}
                version={repoState.version}
                onJump={jumpTo}
                remoteBranches={remoteBranches}
              />
            </SplitPanel>
          </SplitGroup>
        </>
      )}
    </div>
  );
}
