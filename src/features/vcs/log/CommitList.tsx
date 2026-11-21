import type { Commit } from "@/bindings";
import { setContext } from "@/platform/context";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { Scrollbar, Spinner, T, hideNativeScrollbar } from "@/ui";
import { useRowHeight } from "@/ui/density";
import { useGitLogChecks } from "@/workbench/contributions";
import { useVirtualizer } from "@tanstack/react-virtual";
import clsx from "clsx";
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import styles from "../GitLog.module.css";
import type { GraphCommit } from "../graph";
import { LogIdContext } from "../logContext";
import { loadLogDetails } from "../logDetails";
import { useLogOptions } from "../logOptions";
import { createLogGraphPresenter } from "../logPresentation";
import { survivingRowShift } from "../logScrollAnchor";
import { nextSpeedMatch } from "../logSearch";
import {
  PAGE,
  extendCommitSelection,
  goToChild,
  goToParent,
  goToRef,
  isMine,
  loadMore,
  loadNewer,
  selectCommit,
  toggleCommitSelection,
  useGitLog,
} from "../logStore";
import { formatTime } from "../model";
import { commitKey, commitRepo, graphCommit, type RepoCommit } from "../multiRoot";
import { currentRepo, currentRepoRoot, useVcs, type VcsState } from "../store";
import { ColumnHeaders } from "./ColumnHeaders";
import { CommitSignature } from "./CommitMessage";
import { CommitRow } from "./CommitRow";
import { ROW, SUBJECT_COLUMN, type LogColumn, type RowEvents } from "./shared";

const remoteNameSets = new WeakMap<readonly string[], ReadonlySet<string>>();

/** A commit's own remote names (multi-root logs) as one set per array, else the shared one. */
function rowRemoteNames(own: readonly string[] | undefined, shared: ReadonlySet<string>): ReadonlySet<string> {
  if (!own) return shared;
  let set = remoteNameSets.get(own);
  if (!set) remoteNameSets.set(own, (set = new Set(own)));
  return set;
}

/** Whether `next` is `previous` with commits appended (the same objects first). */
const grows = (previous: readonly RepoCommit[], next: readonly RepoCommit[]) =>
  previous.length <= next.length && previous.every((c, i) => c === next[i]);

/**
 * What the list reads from every loaded commit: the first row of each key, the head commits, the
 * repositories whose first loaded commit is not their newest, and what the heads reach (the
 * current-branch highlight). A page appended extends the previous one's, which then no longer
 * describes its own list.
 */
interface LoadedCommits {
  all: readonly RepoCommit[];
  /** The list this one extends. */
  grewFrom: readonly RepoCommit[] | null;
  heads: VcsState["heads"];
  headCommit: string | null;
  keys: Map<string, number>;
  headKeys: ReadonlySet<string>;
  repos: Set<string | null | undefined>;
  earlier: boolean;
  /** `reachableFrom(all.map(graphCommit), headKeys)`. */
  reach: Set<string>;
  /** Each key's last `onCurrentBranch`, which overrides `reach`. */
  flags: Map<string, boolean>;
}

function loadCommits(
  previous: LoadedCommits | null,
  all: readonly RepoCommit[],
  heads: VcsState["heads"],
  headCommit: string | null,
): LoadedCommits {
  const grew =
    previous && previous.heads === heads && previous.headCommit === headCommit && grows(previous.all, all)
      ? previous
      : null;
  const from = grew ? grew.all.length : 0;
  const headKeys = new Set(grew?.headKeys);
  const reach = grew?.reach ?? new Set<string>();
  const keys = grew?.keys ?? new Map<string, number>();
  // `reachableFrom` starts from every head: a head found again on a later row restarts it.
  for (let i = from; i < all.length; i++) {
    const c = all[i]!;
    const repo = commitRepo(c);
    if (!c.refs.includes("HEAD") && c.id !== (repo ? heads[repo]?.headCommit : headCommit)) continue;
    const key = commitKey(c);
    if (grew && keys.has(key)) return loadCommits(null, all, heads, headCommit);
    headKeys.add(key);
    reach.add(key);
  }
  const loaded: LoadedCommits = {
    all,
    grewFrom: grew?.all ?? null,
    heads,
    headCommit,
    keys,
    headKeys,
    repos: grew?.repos ?? new Set(),
    earlier: grew?.earlier ?? false,
    reach,
    flags: grew?.flags ?? new Map(),
  };
  for (let i = from; i < all.length; i++) {
    const c = all[i]!;
    const repo = commitRepo(c);
    const key = commitKey(c);
    if (!keys.has(key)) keys.set(key, i);
    if (!loaded.repos.has(repo)) {
      loaded.repos.add(repo);
      loaded.earlier ||= (c.logPosition ?? 0) > 0;
    }
    if (reach.has(key))
      for (const id of [...(c.graphParents ?? c.parents), ...(c.graphBoundaryParents ?? [])])
        reach.add(commitKey({ repo, id }));
    if (c.onCurrentBranch != null) loaded.flags.set(key, c.onCurrentBranch);
  }
  return loaded;
}

/** The first row of `graph` whose edge into a parent is `edge` (`${id}\0${parent}`). */
function edgeSource(graph: readonly GraphCommit[], rowsOf: (id: string) => readonly number[], edge: string) {
  let first: number | undefined;
  // Ids of multi-root logs contain `\0` as well: try every split.
  for (let at = edge.indexOf("\0"); at >= 0; at = edge.indexOf("\0", at + 1)) {
    const id = edge.slice(0, at);
    const parent = edge.slice(at + 1);
    for (const row of rowsOf(id))
      if ((first === undefined || row < first) && graph[row]!.parents.includes(parent)) first = row;
  }
  return first === undefined ? undefined : graph[first];
}

export function CommitList({ fileHistory = false }: { fileHistory?: boolean }) {
  const scope = useContext(LogIdContext);
  const shown = useGitLog((s) => s.shownLog);
  const active = !scope || scope === shown;
  const all = useGitLog((s) => s.commits);
  const selection = useGitLog((s) => s.selection);
  const fileHistoryTarget = useGitLog((s) => {
    const id = scope ?? s.shownLog;
    const tab = s.logTabs.find((t) => t.id === id);
    return tab?.kind === "history" ? tab.target : null;
  });
  const options = useLogOptions();
  const opts = useMemo(() => {
    if (!fileHistory || options.columnOrder.includes(SUBJECT_COLUMN.id)) return options;
    const extraColumns = options.columnOrder.filter((id) => id !== "author" && id !== "date");
    return { ...options, columnOrder: ["author", "date", SUBJECT_COLUMN.id, ...extraColumns] };
  }, [fileHistory, options]);
  const ChecksCell = useGitLogChecks((s) => s.cell);
  const bookmarks = useGitLog((s) => s.bookmarks);
  const fragments = useGitLog((s) => s.fragments);
  const { expanded: expandedFragments, collapsed: collapsedFragments, merges: expandedMerges } = fragments;
  const [hoverColor, setHoverColor] = useState<string | null>(null);
  const [boundaryTitles, setBoundaryTitles] = useState<ReadonlyMap<string, string>>(() => new Map());
  const boundaryRequests = useRef(new Set<string>());
  const [speedSearch, setSpeedSearch] = useState("");
  const speedGeneration = useRef(0);
  const speedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(speedTimer.current), []);
  useEffect(() => () => setContext("vcsLogRevisionFocus", false), []);
  const columns = useMemo(() => {
    const builtins: LogColumn[] = [
      ...(opts.showAuthor ? [{ id: "author", title: "Author", width: 130, render: (c: Commit) => c.author }] : []),
      ...(opts.showDate
        ? [
            {
              id: "date",
              title: "Date",
              // Fits a 12-hour date and time ("11/05/2026 02:30 PM", "Yesterday 09:07 AM").
              width: 140,
              render: (c: Commit) => formatTime(opts.commitTimestamp ? (c.commitTimeMs ?? c.timeMs) : c.timeMs),
            },
          ]
        : []),
      ...(opts.showHash ? [{ id: "hash", title: "Hash", width: 72, render: (c: Commit) => c.shortId }] : []),
      ...(opts.showSignature
        ? [{ id: "signature", title: "Signature", width: 100, render: (c: Commit) => <CommitSignature commit={c} /> }]
        : []),
      ...(opts.showGitHubChecks && ChecksCell
        ? [
            {
              id: "github-checks",
              title: "GitHub Commit Checks",
              width: 44,
              render: (c: Commit) => {
                const root = commitRepo(c) ?? currentRepoRoot();
                return root && !(c as RepoCommit).readOnly ? <ChecksCell root={root} revision={c.id} /> : null;
              },
            },
          ]
        : []),
    ];
    const order = [...new Set([...opts.columnOrder, ...builtins.map((c) => c.id)])];
    return builtins.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  }, [
    opts.showAuthor,
    opts.showDate,
    opts.showHash,
    opts.showSignature,
    opts.showGitHubChecks,
    opts.commitTimestamp,
    opts.columnOrder,
    ChecksCell,
  ]);
  const user = useGitLog((s) => s.user);
  const headCommit = useVcs((s) => s.branch?.headCommit ?? null);
  const branches = useVcs((s) => s.branches);
  const remoteNames = useMemo(() => new Set(branches.filter((b) => b.remote).map((b) => b.name)), [branches]);
  // Date, No Merges and First Parent are applied by the backend with parent rewriting,
  // so the graph stays connected under them.
  const heads = useVcs((s) => s.heads);
  const lastLoaded = useRef<LoadedCommits | null>(null);
  const loaded = useMemo(
    () => (lastLoaded.current = loadCommits(lastLoaded.current, all, heads, headCommit)),
    [all, heads, headCommit],
  );
  const { headKeys, earlier } = loaded;
  const keep = useMemo(
    () =>
      opts.collapseLinear || fragments.collapsed.size
        ? new Set([...headKeys, ...selection, ...Object.keys(bookmarks)])
        : null,
    [opts.collapseLinear, fragments.collapsed, headKeys, selection, bookmarks],
  );
  // Lays out only the rows a page appends; rows are resolved as they are drawn.
  const [presentGraph] = useState(createLogGraphPresenter);
  const presented = useMemo(
    () => presentGraph(all, opts, fragments, keep ?? new Set()),
    [presentGraph, all, opts, fragments, keep],
  );
  const { commits, row: graphRow, linear, collapsed, graph: displayedGraph } = presented;
  // The first row of each key in `commits`, and the list it grew from.
  const rowKeys = useMemo(
    () =>
      commits === all
        ? { keys: loaded.keys, grewFrom: loaded.grewFrom }
        : {
            keys: new Map([...commits.entries()].reverse().map(([i, c]) => [commitKey(c), i])),
            grewFrom: null,
          },
    [commits, all, loaded],
  );
  const { edges: highlighted, nodes: highlightedNodes } = useMemo(() => {
    const empty = { edges: new Set<string>(), nodes: new Set<string>() };
    if (!hoverColor) return empty;
    const nodeId = hoverColor.startsWith("node:") ? hoverColor.slice(5) : null;
    const merge = nodeId ?? linear?.fragments.get(hoverColor);
    const fragment = merge ? linear?.nodes.get(merge) : null;
    const nodes = new Set(fragment);
    const { rowsOf, childCount } = presented;
    if (!fragment) {
      const source = nodeId ? displayedGraph[rowsOf(nodeId)[0] ?? -1] : edgeSource(displayedGraph, rowsOf, hoverColor);
      const target = source?.parents.find((p) => nodeId || `${source.id}\0${p}` === hoverColor);
      if (source) nodes.add(source.id);
      for (let current = target; current && !nodes.has(current);) {
        nodes.add(current);
        // The last commit with that id, as a map from ids keeps it.
        const c = displayedGraph[rowsOf(current).at(-1) ?? -1];
        if (!c || c.parents.length !== 1 || childCount(current) !== 1 || c.refs?.length || headKeys.has(current)) break;
        current = c.parents[0];
      }
    }
    const edges = new Set<string>();
    for (const id of nodes)
      for (const row of rowsOf(id))
        for (const p of displayedGraph[row]!.parents) if (nodes.has(p)) edges.add(`${id}\0${p}`);
    return { nodes, edges };
  }, [hoverColor, linear, displayedGraph, presented, headKeys]);
  const filterBranches = useGitLog((s) => s.filters.branches);
  const currentBranch = useVcs((s) => s.branch?.head ?? null);
  // Nothing to tell apart when the log is filtered to the current branch.
  const onlyCurrent = filterBranches.length > 0 && filterBranches.every((b) => b === "HEAD" || b === currentBranch);
  // The heads' reach unless the backend said otherwise (a commit's own flag wins).
  const onBranch = useMemo(() => {
    if (!opts.highlightCurrentBranch || onlyCurrent) return null;
    const { flags, reach } = loaded;
    return { has: (key: string) => flags.get(key) ?? reach.has(key) };
  }, [loaded, opts.highlightCurrentBranch, onlyCurrent]);
  const loading = useGitLog((s) => s.loading);
  const done = useGitLog((s) => s.done);
  const error = useGitLog((s) => s.error);
  const selected = useGitLog((s) => s.selected);
  const selectedSet = useMemo(() => new Set(selection), [selection]);
  const revealTick = useGitLog((s) => s.revealTick);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Commit rows shrink in compact mode; the column header (the scroll margin) keeps ROW.
  const row = useRowHeight(ROW);
  const selectedIndex = selected ? (rowKeys.keys.get(selected) ?? -1) : -1;
  const lastRevealed = useRef(0);
  // Recycled rows can emit enter events without the pointer moving.
  const hoverPointer = useRef<{ x: number; y: number } | null>(null);
  const previousRows = useRef(commits);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    const previous = previousRows.current;
    previousRows.current = commits;
    if (!element || previous === commits || (revealTick !== lastRevealed.current && selectedIndex >= 0)) return;
    const top = Math.max(0, Math.floor((element.scrollTop - ROW) / row));
    // A page appended keeps every row where it was.
    if (rowKeys.grewFrom === previous && top < previous.length && rowKeys.keys.get(commitKey(previous[top]!)) === top)
      return;
    // Preserve the first surviving visible commit and its pixel offset.
    const shift = survivingRowShift(previous, commits, top);
    if (shift !== null) element.scrollTop += shift * row;
  }, [commits, rowKeys, revealTick, selectedIndex, row]);
  const finished = done;
  const virtualizer = useVirtualizer({
    count: commits.length + (finished ? 0 : 1),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => row,
    overscan: 8,
    scrollMargin: ROW,
  });
  useEffect(() => virtualizer.measure(), [virtualizer, row]);
  const items = virtualizer.getVirtualItems();
  const last = items[items.length - 1];

  // The next page is requested while a page of rows is still ahead, so scrolling
  // quickly doesn't reach the end before `git log` answers.
  useEffect(() => {
    if (!finished && !loading && last && last.index >= commits.length - PAGE) void loadMore(scope ?? undefined);
  }, [last, commits.length, finished, loading, active, scope]);

  useLayoutEffect(() => {
    if (revealTick === lastRevealed.current || selectedIndex < 0) return;
    lastRevealed.current = revealTick;
    virtualizer.scrollToIndex(selectedIndex, { align: "center" });
  }, [revealTick, selectedIndex, virtualizer]);

  const visible = useRef(commits);
  visible.current = commits;
  const pick = useCallback((id: string, e: ReactMouseEvent) => {
    if (e.button === 2) {
      if (!useGitLog.getState().selection.includes(id)) selectCommit(id);
    } else if (e.button !== 0) return;
    else if (e.shiftKey) extendCommitSelection(id, visible.current);
    else if (e.metaKey || e.ctrlKey) toggleCommitSelection(id);
    else selectCommit(id);
  }, []);
  // CommitRow is memoized: rows get handlers that stay the same across renders and
  // call this render's (assigned before rendering).
  const rowEvents = useRef<RowEvents | null>(null);
  const rowHandlers = useMemo<RowEvents>(
    () => ({
      onHover: (edge) => rowEvents.current?.onHover(edge),
      onFragment: (from, target, expand) => rowEvents.current?.onFragment(from, target, expand),
      onNavigate: (index, key) => rowEvents.current?.onNavigate(index, key),
    }),
    [],
  );
  // Called while a row renders its graph, so it changes with what it reads.
  const targetTitle = useCallback(
    (index: number, key?: string) => {
      const target = commits[index];
      return target
        ? `${target.shortId} ${target.summary} — ${target.author}`
        : (key && boundaryTitles.get(key)) ||
            `${tx("Commit is outside the loaded history")} · ${key?.split("\0").at(-1)?.slice(0, 8) ?? ""}`;
    },
    [commits, boundaryTitles],
  );

  const onKeyDown = (e: KeyboardEvent) => {
    if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key.length === 1 || e.key === "Backspace" || e.key === "Escape")) {
      const query = e.key === "Escape" ? "" : e.key === "Backspace" ? speedSearch.slice(0, -1) : speedSearch + e.key;
      setSpeedSearch(query);
      speedGeneration.current++;
      clearTimeout(speedTimer.current);
      speedTimer.current = setTimeout(() => setSpeedSearch(""), 1500);
      if (query) {
        const found = nextSpeedMatch(commits, query, opts, -1);
        if (found >= 0) {
          selectCommit(commitKey(commits[found]!), true);
          virtualizer.scrollToIndex(found, { align: "auto" });
        } else if (query.length >= 2) {
          const generation = ++speedGeneration.current;
          const roots = [...new Set(all.map(commitRepo))];
          void Promise.all(
            roots.map(async (repo) => {
              const [hit] = await call(
                commands.vcsLog(repo ?? currentRepo(), {
                  skip: 0,
                  limit: 1,
                  summaryOnly: true,
                  speedSearch: query,
                  searchFields: [...(opts.showAuthor ? ["author"] : []), ...(opts.showHash ? ["hash"] : [])],
                  branch: null,
                  path: null,
                  author: null,
                  text: null,
                }),
              );
              return hit ? { ...hit, repo } : null;
            }),
          )
            .then((hits) => {
              const hit = hits.find(Boolean);
              if (hit && speedGeneration.current === generation) void goToRef(hit.id, commitRepo(hit));
            })
            .catch(() => undefined);
        }
      }
      e.preventDefault();
      return;
    }
    if (speedSearch && (e.key === "F3" || e.key === "Enter")) {
      e.preventDefault();
      const found = nextSpeedMatch(commits, speedSearch, opts, selectedIndex, e.shiftKey ? -1 : 1);
      if (found >= 0) selectCommit(commitKey(commits[found]!), true);
      return;
    }
    const lead = selectedIndex >= 0 ? commits[selectedIndex] : undefined;
    if (lead && (e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (e.key === "ArrowLeft") goToChild(lead);
      else void goToParent(lead);
      return;
    }
    let next: number;
    if (e.key === "ArrowDown") next = Math.min(commits.length - 1, selectedIndex + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, selectedIndex - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = commits.length - 1;
    else if (e.key === "PageDown") next = Math.min(commits.length - 1, selectedIndex + 20);
    else if (e.key === "PageUp") next = Math.max(0, selectedIndex - 20);
    else return;
    e.preventDefault();
    const c = commits[next];
    if (c) {
      if (e.shiftKey) extendCommitSelection(commitKey(c), commits);
      else selectCommit(commitKey(c));
      // Fixed rows already in view do not need a scroll command or reconciliation.
      const offset = virtualizer.getOffsetForIndex(next);
      if (offset && offset[1] !== "auto" && offset[0] !== virtualizer.scrollOffset)
        virtualizer.scrollToIndex(next, { align: "auto" });
    }
  };

  if (error && !commits.length) return <div className={styles.message}>{error}</div>;

  const fragment = (from: string, target: string, expand: boolean) => {
    if (from === target && (expandedMerges.has("*") ? !expandedMerges.has(from) : expandedMerges.has(from))) {
      useGitLog.setState({
        fragments: {
          ...fragments,
          merges: expandedMerges.has("*")
            ? new Set([...expandedMerges, from])
            : new Set([...expandedMerges].filter((id) => id !== from)),
        },
      });
      return;
    }
    if (
      from === target &&
      linear &&
      all.find((c) => commitKey(c) === from)?.parents.length === 2 &&
      linear.graph.find((c) => c.id === from)?.parents.length === 1
    ) {
      useGitLog.setState({
        fragments: {
          ...fragments,
          merges: expandedMerges.has("*")
            ? new Set([...expandedMerges].filter((id) => id !== from))
            : new Set([...expandedMerges, from]),
        },
      });
      return;
    }
    if (from === target) {
      const shown = (linear?.graph ?? collapsed?.graph ?? all.map(graphCommit)).find((c) => c.id === from);
      target = shown?.parents[0] ?? target;
      expand = !!shown?.dashed?.[0];
    }
    const merge = linear?.fragments.get(`${from}\0${target}`);
    if (merge) {
      useGitLog.setState({
        fragments: {
          ...fragments,
          merges: expandedMerges.has("*")
            ? new Set([...expandedMerges].filter((id) => id !== merge))
            : new Set([...expandedMerges, merge]),
        },
      });
      return;
    }
    const graph = new Map(
      all.map((c) => {
        const g = graphCommit(c);
        return [g.id, g] as const;
      }),
    );
    const childCounts = new Map<string, number>();
    for (const c of graph.values())
      for (const parent of c.parents) childCounts.set(parent, (childCounts.get(parent) ?? 0) + 1);
    const hidden: string[] = [];
    for (const start of expand ? (graph.get(from)?.parents ?? []) : [target]) {
      const chain: string[] = [];
      let current: string | undefined = start;
      const seen = new Set<string>();
      while (current && !seen.has(current)) {
        seen.add(current);
        const node = graph.get(current);
        if (
          !node ||
          (expand && current === target) ||
          node.parents.length !== 1 ||
          childCounts.get(current) !== 1 ||
          node.refs.length ||
          headKeys.has(current)
        )
          break;
        chain.push(current);
        current = node.parents[0];
      }
      if (!expand || current === target) for (const id of chain) hidden.push(id);
    }
    if (expand) {
      useGitLog.setState({
        fragments: {
          ...fragments,
          expanded: new Set([...expandedFragments, ...hidden]),
          collapsed: new Set([...collapsedFragments].filter((id) => !hidden.includes(id))),
        },
      });
    } else {
      useGitLog.setState({
        fragments: {
          ...fragments,
          expanded: new Set([...expandedFragments].filter((id) => !hidden.includes(id))),
          collapsed: new Set([...collapsedFragments, ...hidden]),
        },
      });
    }
  };

  rowEvents.current = {
    onHover: (edge) => {
      if (
        edge === hoverColor ||
        (edge && (virtualizer.isScrolling || scrollRef.current?.hasAttribute("data-hover-paused")))
      )
        return;
      setHoverColor(edge);
      if (!edge) return;
      const source = edgeSource(displayedGraph, presented.rowsOf, edge);
      const target = source?.parents.find((p) => `${source.id}\0${p}` === edge);
      if (!source || !target || rowKeys.keys.has(target) || boundaryRequests.current.has(target)) return;
      const original = all[loaded.keys.get(source.id) ?? -1];
      if (!original) return;
      boundaryRequests.current.add(target);
      const split = target.lastIndexOf("\0"),
        id = target.slice(split + 1);
      void loadLogDetails({ ...original, id })
        .then((details) =>
          setBoundaryTitles((current) =>
            new Map(current).set(target, `${id.slice(0, 8)} ${details.message.split("\n")[0]}`),
          ),
        )
        .catch(() => undefined);
    },
    onFragment: fragment,
    onNavigate: (index, key) => {
      const target = commits[index];
      if (target) selectCommit(commitKey(target), true);
      else if (key) {
        const split = key.lastIndexOf("\0");
        void goToRef(key.slice(split + 1), split >= 0 ? key.slice(0, split) : currentRepo());
      }
    },
  };

  return (
    <div className={styles.listWrap}>
      {earlier && (
        <button type="button" disabled={loading} onClick={() => void loadNewer(scope ?? undefined)}>
          {tx("Load Newer Commits")}
        </button>
      )}
      {speedSearch && (
        <div role="status" className={styles.speedSearch}>
          {speedSearch}
        </div>
      )}
      {error && (
        <div role="alert" className={styles.message}>
          {error}
        </div>
      )}
      <Scrollbar target={scrollRef} contentHeight={virtualizer.getTotalSize()} />
      <div
        ref={scrollRef}
        className={clsx(styles.list, hideNativeScrollbar)}
        role="listbox"
        aria-label={tx("Commits")}
        aria-multiselectable
        aria-activedescendant={selectedIndex >= 0 ? `commit-${scope ?? "log"}-${selectedIndex}` : undefined}
        tabIndex={0}
        onFocusCapture={() => setContext("vcsLogRevisionFocus", !!active && !!fileHistoryTarget)}
        onBlurCapture={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setContext("vcsLogRevisionFocus", false);
        }}
        onScroll={(e) => {
          if (!e.currentTarget.hasAttribute("data-hover-paused")) e.currentTarget.dataset.hoverPaused = "";
          setHoverColor(null);
        }}
        onPointerMoveCapture={(e) => {
          const previous = hoverPointer.current;
          hoverPointer.current = { x: e.clientX, y: e.clientY };
          if (!virtualizer.isScrolling && (!previous || previous.x !== e.clientX || previous.y !== e.clientY))
            delete e.currentTarget.dataset.hoverPaused;
        }}
        onPointerLeave={(e) => {
          hoverPointer.current = { x: e.clientX, y: e.clientY };
        }}
        onKeyDown={onKeyDown}
        onCopy={(e) => {
          if (window.getSelection()?.toString()) return;
          const selected = commits.filter((c) => selectedSet.has(commitKey(c)));
          if (!selected.length) return;
          e.preventDefault();
          e.clipboardData.setData(
            "text/plain",
            selected
              .map((c) =>
                [
                  c.summary,
                  c.refs.join(" "),
                  ...(opts.showRepository ? [commitRepo(c) ?? ""] : []),
                  ...columns.map((column) => (typeof column.render(c) === "string" ? column.render(c) : "")),
                ].join("\t"),
              )
              .join("\n"),
          );
          e.clipboardData.setData(
            "application/x-openidea-vcs-commits",
            JSON.stringify({ version: 1, commits: selected.map((c) => ({ root: commitRepo(c), hash: c.id })) }),
          );
        }}
      >
        {opts.showColumnHeaders && <ColumnHeaders columns={columns} options={opts} />}
        {!commits.length && !loading && finished && (
          <div className={styles.message}>{headCommit ? tx("No commits match the filters") : tx("No commits yet")}</div>
        )}
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {items.map((v) => {
            const c = commits[v.index];
            if (!c)
              return (
                <div key="loading" className={styles.row} style={{ top: v.start - ROW, height: row }}>
                  <Spinner size={12} />{" "}
                  <span className={styles.muted}>
                    <T>Loading…</T>
                  </span>
                </div>
              );
            return (
              <CommitRow
                // Keyed by slot, not commit: a scrollbar drag that jumps past every mounted
                // row then updates the same DOM nodes instead of rebuilding them.
                key={v.index % items.length}
                id={`commit-${scope ?? "log"}-${v.index}`}
                commit={c}
                fileHistoryTarget={fileHistoryTarget}
                graph={graphRow(v.index)}
                top={v.start - ROW}
                height={row}
                selected={selectedSet.has(commitKey(c))}
                head={headKeys.has(commitKey(c))}
                mine={opts.highlightMine && isMine(c, user)}
                onBranch={!!onBranch?.has(commitKey(c))}
                opts={opts}
                remoteNames={rowRemoteNames((c as RepoCommit).remoteNames, remoteNames)}
                onPick={pick}
                hoverColor={hoverColor}
                highlighted={highlighted}
                highlightedNodes={highlightedNodes}
                onHover={rowHandlers.onHover}
                onFragment={rowHandlers.onFragment}
                onNavigate={rowHandlers.onNavigate}
                targetTitle={targetTitle}
                columns={columns}
                bookmarked={!!bookmarks[commitKey(c)]}
                interactive={!virtualizer.isScrolling}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
