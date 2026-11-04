/** The Git Graph editor tab: toolbar, the graph of every branch with stashes and uncommitted changes, and the bottom pane. */
import { useEffect, useMemo, useState } from "react";
import type { GraphBisectState, Remote } from "@/bindings";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { EmptyState, SplitGroup, SplitHandle, SplitPanel } from "@/ui";
import { gitGraphBridge } from "@/workbench/gitGraphBridge";
import { CommitList } from "./CommitList";
import { findMatches, useGraphData, useGraphExtras, useRepoState, type GraphFilters } from "./data";
import { BottomPane } from "./Details";
import { buildEntries, layoutInput } from "./entries";
import { BisectBanner } from "./panels";
import { Toolbar } from "./Toolbar";
import { useGraphView } from "./viewState";
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

export function GitGraphEditor() {
  const repoState = useRepoState();
  const view = useGraphView();
  const set = useGraphView.setState;
  const activeRepo =
    view.repo && repoState.roots.includes(view.repo) ? view.repo : (repoState.repo ?? repoState.roots[0] ?? null);
  const { branchFilter, showRemotes, query, matchIndex } = view;
  const filters = useMemo<GraphFilters>(() => ({ branches: branchFilter, showRemotes }), [branchFilter, showRemotes]);
  const data = useGraphData(activeRepo, filters, repoState.version);
  const extras = useGraphExtras(activeRepo, repoState.version);
  const repoExtras = useRepoExtras(activeRepo, repoState.version);
  const head = activeRepo ? (repoState.heads[activeRepo] ?? null) : null;
  const entries = useMemo(
    () =>
      activeRepo
        ? buildEntries(data.commits, extras.stashes, extras.working, head?.headCommit ?? null, activeRepo)
        : [],
    [data.commits, extras, head?.headCommit, activeRepo],
  );
  const rows = useMemo(() => gitGraphBridge()?.layout(layoutInput(entries)).rows ?? [], [entries]);
  const width = rows.reduce((m, r) => Math.max(m, r.width), 1);
  const searchable = useMemo(() => entries.map((e) => (e.kind === "working" ? null : e.commit)), [entries]);
  const matches = useMemo(() => findMatches(searchable, query), [searchable, query]);
  const remoteBranches = useMemo(
    () => new Set(data.branches.filter((b) => b.remote).map((b) => b.name)),
    [data.branches],
  );

  if (!gitGraphBridge() || !repoState.roots.length || !activeRepo)
    return <EmptyState title="No Git repository" className={styles.empty} />;

  const selected = view.selection.repo === activeRepo ? view.selection.ids : [];
  const setSelected = (ids: string[]) => set({ selection: { repo: activeRepo, ids } });
  const selectedEntries = selected
    .map((id) => entries.find((e) => e.id === id))
    .filter((e): e is (typeof entries)[number] => !!e);
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
        roots={repoState.roots}
        repo={activeRepo}
        onRepo={(repo) => set({ repo })}
        branches={data.branches}
        branchFilter={branchFilter}
        onBranchFilter={(b) => set({ branchFilter: b })}
        showRemotes={showRemotes}
        onShowRemotes={(v) => set({ showRemotes: v })}
        query={query}
        onQuery={(q) => set({ query: q, matchIndex: 0 })}
        matchText={query ? (matches.length ? `${matchIndex + 1}/${matches.length}` : tx("No matches")) : ""}
        onStep={step}
        loading={data.loading}
        onRefresh={data.reload}
        operation={repoState.operations[activeRepo] ?? null}
      />
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
          <CommitList
            entries={entries}
            rows={rows}
            width={width}
            done={data.done}
            loading={data.loading}
            loadMore={data.loadMore}
            selected={selected}
            onSelect={setSelected}
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
          <BottomPane
            panel={view.panel}
            onPanel={(panel) => set({ panel, ...(panel === "tree" ? { treeRev: null } : {}) })}
            entries={selectedEntries}
            repo={activeRepo}
            version={repoState.version}
            treeRev={view.treeRev}
            onJump={jumpTo}
            remoteBranches={remoteBranches}
          />
        </SplitPanel>
      </SplitGroup>
    </div>
  );
}
