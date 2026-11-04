/** The Git Graph editor tab: toolbar, the commit graph of every branch, and the selected commit's details. */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import clsx from "clsx";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Branch, ChangedFile } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { formatTimestamp } from "@/platform/dateFormat";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import {
  EmptyState,
  Icon,
  IconButton,
  SearchField,
  showContextMenu,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Spinner,
  T,
  type MenuItem,
} from "@/ui";
import { gitGraphBridge, type GraphCommit, type GraphLaneRow, type GraphRefLabel } from "@/workbench/gitGraphBridge";
import { findMatches, useGraphData, useRepoState, type GraphFilters } from "./data";
import { GraphCell, LANE } from "./GraphCell";
import styles from "./GitGraph.module.css";
import { useGraphView } from "./viewState";

export const ROW = 24;

export function GitGraphEditor() {
  const repoState = useRepoState();
  const view = useGraphView();
  const set = useGraphView.setState;
  const activeRepo =
    view.repo && repoState.roots.includes(view.repo) ? view.repo : (repoState.repo ?? repoState.roots[0] ?? null);
  const setRepo = (repo: string) => set({ repo });
  const { branchFilter, showRemotes, query, matchIndex } = view;
  const setBranchFilter = (branchFilter: string[]) => set({ branchFilter });
  const setShowRemotes = (showRemotes: boolean) => set({ showRemotes });
  const filters = useMemo<GraphFilters>(() => ({ branches: branchFilter, showRemotes }), [branchFilter, showRemotes]);
  const data = useGraphData(activeRepo, filters, repoState.version);
  const selected = view.selection.repo === activeRepo ? view.selection.ids : [];
  const setSelected = (ids: string[]) => set({ selection: { repo: activeRepo, ids } });
  const matches = useMemo(() => findMatches(data.commits, query), [data.commits, query]);
  const setMatchIndex = (matchIndex: number) => set({ matchIndex });
  const setQuery = (q: string) => set({ query: q, matchIndex: 0 });
  const head = activeRepo ? (repoState.heads[activeRepo] ?? null) : null;
  const remoteBranches = useMemo(
    () => new Set(data.branches.filter((b) => b.remote).map((b) => b.name)),
    [data.branches],
  );

  if (!gitGraphBridge() || !repoState.roots.length)
    return <EmptyState title="No Git repository" className={styles.empty} />;

  const selectedCommits = selected
    .map((id) => data.commits.find((c) => c.id === id))
    .filter((c): c is GraphCommit => !!c);
  const jumpTo = (id: string) => setSelected([id]);
  const step = (dir: 1 | -1) => {
    if (!matches.length) return;
    const next = (matchIndex + dir + matches.length) % matches.length;
    setMatchIndex(next);
    const c = data.commits[matches[next]!];
    if (c) jumpTo(c.id);
  };

  return (
    <div className={styles.root}>
      <Toolbar
        roots={repoState.roots}
        repo={activeRepo}
        onRepo={setRepo}
        branches={data.branches}
        branchFilter={branchFilter}
        onBranchFilter={setBranchFilter}
        showRemotes={showRemotes}
        onShowRemotes={setShowRemotes}
        query={query}
        onQuery={setQuery}
        matchText={query ? (matches.length ? `${matchIndex + 1}/${matches.length}` : tx("No matches")) : ""}
        onStep={step}
        loading={data.loading}
        onRefresh={data.reload}
        operation={activeRepo ? (repoState.operations[activeRepo] ?? null) : null}
      />
      {data.error ? (
        <div className={styles.error} role="alert">
          {data.error}
        </div>
      ) : null}
      <SplitGroup orientation="vertical" id="git-graph" className={styles.split}>
        <SplitPanel id="graph" defaultSize="65%" minSize="20%">
          <CommitList
            commits={data.commits}
            rows={data.rows}
            width={data.width}
            done={data.done}
            loading={data.loading}
            loadMore={data.loadMore}
            selected={selected}
            onSelect={setSelected}
            headCommit={head?.headCommit ?? null}
            currentBranch={head?.head ?? null}
            branches={data.branches}
            remoteBranches={remoteBranches}
            matches={matches}
            current={matches[matchIndex] ?? -1}
            repo={activeRepo}
          />
        </SplitPanel>
        <SplitHandle />
        <SplitPanel id="details" defaultSize="35%" minSize="10%">
          <Details commits={selectedCommits} onJump={jumpTo} remoteBranches={remoteBranches} />
        </SplitPanel>
      </SplitGroup>
    </div>
  );
}

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

function Toolbar(p: ToolbarProps) {
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
      {p.operation ? <OperationBar operation={p.operation} /> : null}
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

interface CommitListProps {
  commits: GraphCommit[];
  rows: GraphLaneRow[];
  width: number;
  done: boolean;
  loading: boolean;
  loadMore: () => void;
  selected: string[];
  onSelect: (ids: string[]) => void;
  headCommit: string | null;
  currentBranch: string | null;
  branches: Branch[];
  remoteBranches: ReadonlySet<string>;
  matches: number[];
  current: number;
  repo: string | null;
}

function CommitList(p: CommitListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [hoverColor, setHoverColor] = useState<number | null>(null);
  const anchor = useRef<number>(-1);
  const virtualizer = useVirtualizer({
    count: p.commits.length + (p.done ? 0 : 1),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 20,
  });
  const items = virtualizer.getVirtualItems();
  const last = items[items.length - 1];
  useEffect(() => {
    if (!p.done && !p.loading && last && last.index >= p.commits.length - 40) p.loadMore();
  }, [last?.index, p.commits.length, p.done, p.loading]);

  const indexOf = useMemo(() => new Map(p.commits.map((c, i) => [c.id, i])), [p.commits]);
  const selectedSet = useMemo(() => new Set(p.selected), [p.selected]);
  const matchSet = useMemo(() => new Set(p.matches), [p.matches]);
  useEffect(() => {
    const id = p.selected[p.selected.length - 1];
    const i = id ? indexOf.get(id) : undefined;
    if (i !== undefined) virtualizer.scrollToIndex(i, { align: "auto" });
  }, [p.selected, indexOf]);

  const graphWidth = Math.min(Math.max(p.width, 1), 40) * LANE + 4;

  const click = (e: ReactMouseEvent, i: number) => {
    const c = p.commits[i]!;
    if (e.shiftKey && anchor.current >= 0) {
      const [a, b] = [Math.min(anchor.current, i), Math.max(anchor.current, i)];
      p.onSelect(p.commits.slice(a, b + 1).map((x) => x.id));
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      anchor.current = i;
      p.onSelect(selectedSet.has(c.id) ? p.selected.filter((x) => x !== c.id) : [...p.selected, c.id]);
      return;
    }
    anchor.current = i;
    p.onSelect([c.id]);
  };
  const menu = async (e: ReactMouseEvent, i: number) => {
    e.preventDefault();
    const point = { x: e.clientX, y: e.clientY };
    const c = p.commits[i]!;
    let selection = p.selected.map((id) => p.commits[indexOf.get(id) ?? -1]).filter((x): x is GraphCommit => !!x);
    if (!selectedSet.has(c.id)) {
      anchor.current = i;
      p.onSelect([c.id]);
      selection = [c];
    }
    const items = await gitGraphBridge()?.commitMenu(c, selection);
    if (items?.length) showContextMenu(point, items);
  };
  const keyDown = (e: KeyboardEvent) => {
    if (!p.commits.length) return;
    const cur = indexOf.get(p.selected[p.selected.length - 1] ?? "") ?? -1;
    let next = cur;
    if (e.key === "ArrowDown") next = Math.min(p.commits.length - 1, cur + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, cur - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = p.commits.length - 1;
    else return;
    e.preventDefault();
    const c = p.commits[next]!;
    if (e.shiftKey && anchor.current >= 0) {
      const [a, b] = [Math.min(anchor.current, next), Math.max(anchor.current, next)];
      p.onSelect(p.commits.slice(a, b + 1).map((x) => x.id));
    } else {
      anchor.current = next;
      p.onSelect([c.id]);
    }
  };

  if (!p.commits.length && !p.loading) return <EmptyState title="No commits" className={styles.empty} />;

  return (
    <div className={styles.list}>
      <div className={styles.header} role="row">
        <span className={styles.colGraph} style={{ width: graphWidth }} role="columnheader">
          <T>Graph</T>
        </span>
        <span className={styles.colDescription} role="columnheader">
          <T>Description</T>
        </span>
        <span className={styles.colDate} role="columnheader">
          <T>Date</T>
        </span>
        <span className={styles.colAuthor} role="columnheader">
          <T>Author</T>
        </span>
        <span className={styles.colHash} role="columnheader">
          <T>Commit</T>
        </span>
      </div>
      <div
        ref={scrollRef}
        className={clsx(styles.scroll, hoverColor !== null && styles.hovering)}
        tabIndex={0}
        role="grid"
        aria-label={tx("Commits")}
        aria-multiselectable
        onKeyDown={keyDown}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {items.map((v) => {
            const c = p.commits[v.index];
            if (!c)
              return (
                <div key="more" className={styles.row} style={{ transform: `translateY(${v.start}px)` }}>
                  <Spinner size={12} />
                </div>
              );
            const row = p.rows[v.index];
            const isHead = c.id === p.headCommit;
            return (
              <div
                key={c.id}
                role="row"
                aria-selected={selectedSet.has(c.id)}
                className={clsx(
                  styles.row,
                  selectedSet.has(c.id) && styles.selected,
                  matchSet.has(v.index) && styles.match,
                  v.index === p.current && styles.currentMatch,
                  row && hoverColor === row.color && styles.onRail,
                )}
                style={{ transform: `translateY(${v.start}px)` }}
                onClick={(e) => click(e, v.index)}
                onContextMenu={(e) => void menu(e, v.index)}
                onMouseEnter={() => setHoverColor(row ? row.color : null)}
                onMouseLeave={() => setHoverColor(null)}
              >
                <span className={styles.colGraph} style={{ width: graphWidth }}>
                  {row ? <GraphCell row={row} head={isHead} width={graphWidth} highlight={hoverColor} /> : null}
                </span>
                <span className={styles.colDescription}>
                  <RefPills
                    refs={c.refs}
                    repo={p.repo}
                    branches={p.branches}
                    remoteBranches={p.remoteBranches}
                    currentBranch={p.currentBranch}
                  />
                  <span className={clsx(styles.subject, c.parents.length > 1 && styles.mergeSubject)}>{c.summary}</span>
                </span>
                <span className={styles.colDate}>{c.timeMs ? formatTimestamp(c.timeMs) : ""}</span>
                <span className={styles.colAuthor} title={c.email}>
                  {c.author}
                </span>
                <span className={styles.colHash}>{c.shortId}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const REF_CLASS: Record<GraphRefLabel["kind"], string | undefined> = {
  head: styles.refHead,
  local: styles.refLocal,
  remote: styles.refRemote,
  tag: styles.refTag,
};

function RefPills(p: {
  refs: string[];
  repo: string | null;
  branches: Branch[];
  remoteBranches: ReadonlySet<string>;
  currentBranch: string | null;
}) {
  const bridge = gitGraphBridge();
  if (!bridge || !p.refs.length) return null;
  const labels = bridge.refLabels(p.refs, p.remoteBranches);
  const open = async (e: ReactMouseEvent, l: GraphRefLabel) => {
    e.preventDefault();
    e.stopPropagation();
    if (!p.repo || l.kind === "head") return;
    const point = { x: e.clientX, y: e.clientY };
    const items =
      l.kind === "tag"
        ? await bridge.tagMenu(l.name, p.repo)
        : await bridge.branchMenu(
            p.branches.find((b) => b.name === l.name && b.remote === (l.kind === "remote")) ?? {
              name: l.name,
              remote: l.kind === "remote",
              current: l.name === p.currentBranch,
              upstream: null,
              ahead: 0,
              behind: 0,
              lastCommitMs: null,
            },
            p.repo,
          );
    if (items.length) showContextMenu(point, items);
  };
  return (
    <span className={styles.refs}>
      {labels.map((l) => (
        <button
          key={`${l.kind}:${l.name}`}
          type="button"
          className={clsx(
            styles.ref,
            REF_CLASS[l.kind],
            l.kind === "local" && l.name === p.currentBranch && styles.refCurrent,
          )}
          title={l.name}
          onClick={(e) => void open(e, l)}
          onContextMenu={(e) => void open(e, l)}
        >
          <Icon name={l.kind === "tag" ? "tag" : l.kind === "head" ? "current-branch" : "branch"} size={12} />
          <span>{l.name}</span>
        </button>
      ))}
    </span>
  );
}

const KIND_LETTER: Record<string, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typeChanged: "T",
};

function Details({
  commits,
  onJump,
  remoteBranches,
}: {
  commits: GraphCommit[];
  onJump: (id: string) => void;
  remoteBranches: ReadonlySet<string>;
}) {
  const one = commits.length === 1 ? commits[0]! : null;
  const commitKey = one ? `${one.repo}\0${one.id}` : null;
  const [loadedFiles, setLoadedFiles] = useState<{ key: string; files: ChangedFile[] } | null>(null);
  const [activeFile, setActiveFile] = useState<{ key: string | null; index: number }>({ key: null, index: -1 });
  const files = loadedFiles && loadedFiles.key === commitKey ? loadedFiles.files : null;
  const active = activeFile.key === commitKey ? activeFile.index : -1;
  const setActive = (index: number) => setActiveFile({ key: commitKey, index });
  const repo = one?.repo;
  const id = one?.id;
  useEffect(() => {
    if (!repo || !id) return;
    let live = true;
    const key = `${repo}\0${id}`;
    call(commands.vcsCommitFiles(repo, id))
      .then((f) => live && setLoadedFiles({ key, files: f }))
      .catch(() => live && setLoadedFiles({ key, files: [] }));
    return () => {
      live = false;
    };
  }, [repo, id]);

  if (!commits.length) return <EmptyState title="Select a commit" className={styles.empty} />;
  if (!one)
    return (
      <EmptyState title={tx`${commits.length} commits selected`} className={styles.empty}>
        <T>Right-click for cherry-pick, squash, compare and more.</T>
      </EmptyState>
    );

  const bridge = gitGraphBridge();
  const body = one.message.slice(one.summary.length).trim();
  const fileMenu = async (e: ReactMouseEvent, i: number) => {
    e.preventDefault();
    const point = { x: e.clientX, y: e.clientY };
    setActive(i);
    const items = await bridge?.filesMenu(one, [files![i]!]);
    if (items?.length) showContextMenu(point, items);
  };
  return (
    <div className={styles.details}>
      <div className={styles.meta}>
        <div className={styles.metaSubject}>{one.summary}</div>
        {bridge && one.refs.length ? (
          <div className={styles.metaRefs}>
            {bridge.refLabels(one.refs, remoteBranches).map((l) => (
              <span key={`${l.kind}:${l.name}`} className={clsx(styles.ref, REF_CLASS[l.kind])}>
                {l.name}
              </span>
            ))}
          </div>
        ) : null}
        {body ? <pre className={styles.metaBody}>{body}</pre> : null}
        <dl className={styles.metaGrid}>
          <dt>
            <T>Commit</T>
          </dt>
          <dd>
            <span className={styles.mono}>{one.id}</span>
            <IconButton
              icon="copy"
              size="small"
              title="Copy Revision Number"
              action="vcs.log.copyRevision"
              actionArg={one}
            />
          </dd>
          <dt>
            <T>Parents</T>
          </dt>
          <dd>
            {one.parents.map((id) => (
              <button key={id} type="button" className={styles.link} onClick={() => onJump(id)}>
                {id.slice(0, 8)}
              </button>
            ))}
          </dd>
          <dt>
            <T>Author</T>
          </dt>
          <dd>
            {one.author} &lt;{one.email}&gt;
          </dd>
          <dt>
            <T>Date</T>
          </dt>
          <dd>{one.timeMs ? new Date(one.timeMs).toLocaleString() : ""}</dd>
          {one.commitTimeMs && one.commitTimeMs !== one.timeMs ? (
            <>
              <dt>
                <T>Committed</T>
              </dt>
              <dd>{new Date(one.commitTimeMs).toLocaleString()}</dd>
            </>
          ) : null}
        </dl>
      </div>
      <div className={styles.files} role="list" aria-label={tx("Changed Files")}>
        {files === null ? (
          <Spinner size={14} />
        ) : (
          files.map((f, i) => (
            <div
              key={f.path}
              role="listitem"
              tabIndex={0}
              className={clsx(styles.file, i === active && styles.selected)}
              onClick={() => {
                setActive(i);
                void bridge?.openDiff(one, files, i, true);
              }}
              onDoubleClick={() => void bridge?.openDiff(one, files, i)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void bridge?.openDiff(one, files, i);
              }}
              onContextMenu={(e) => void fileMenu(e, i)}
              title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
            >
              <span className={clsx(styles.kind, styles[`kind_${f.kind}`])}>{KIND_LETTER[f.kind] ?? "?"}</span>
              <span className={styles.fileName}>{f.path.split("/").pop()}</span>
              <span className={styles.fileDir}>
                {f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ""}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
