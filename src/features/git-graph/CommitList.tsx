/** The graph's rows: commits, stashes and uncommitted changes, with selection, menus and drag and drop. */
import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import clsx from "clsx";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Branch, GraphBisectState, Remote } from "@/bindings";
import { formatTimestamp } from "@/platform/dateFormat";
import { tx, useI18n } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import {
  EmptyState,
  Icon,
  registerDropTarget,
  showContextMenu,
  Spinner,
  startPointerDrag,
  T,
  type MenuItem,
} from "@/ui";
import { gitGraphBridge, type GraphCommit, type GraphLaneRow, type GraphRefLabel } from "@/workbench/gitGraphBridge";
import { changeCount, type GraphEntry } from "./entries";
import { GraphCell, LANE } from "./GraphCell";
import {
  branchExtras,
  commitExtras,
  compareExtras,
  dropMenu,
  GRAPH_DRAG,
  tagExtras,
  workingMenu,
  type DragItem,
} from "./menus";
import styles from "./GitGraph.module.css";

export const ROW = 24;

export interface CommitListProps {
  entries: GraphEntry[];
  rows: GraphLaneRow[];
  width: number;
  done: boolean;
  loading: boolean;
  loadMore: () => void;
  selected: string[];
  onSelect: (ids: string[]) => void;
  head: { head: string | null; headCommit: string | null } | null;
  branches: Branch[];
  remotes: Remote[];
  remoteBranches: ReadonlySet<string>;
  matches: number[];
  current: number;
  repo: string;
  bisect: GraphBisectState | null;
}

const entryCommit = (e: GraphEntry | undefined): GraphCommit | null => (e && e.kind !== "working" ? e.commit : null);

/** What a row does on input; one stable object, so rows re-render only when their own state changes. */
interface RowActions {
  click(e: ReactMouseEvent, i: number): void;
  menu(e: ReactMouseEvent, i: number): void;
  drag(e: ReactPointerEvent<HTMLElement>, entry: GraphEntry): void;
  openRef(e: ReactMouseEvent, l: GraphRefLabel): void;
  /** Selects the row at an arrow's other end (scrolled into view with the selection). */
  navigate(targetRow: number): void;
}

/** Rows loaded, when one of `row`'s down arrows points past them: the row re-renders once they load. */
const pendingTarget = (row: GraphLaneRow | undefined, loaded: number) =>
  row?.down.some((s) => s.arrow && s.targetRow !== undefined && s.targetRow >= loaded) ? loaded : undefined;

export function CommitList(p: CommitListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [hoverColor, setHoverColor] = useState<number | null>(null);
  const [dropRow, setDropRow] = useState<string | null>(null);
  const anchor = useRef<number>(-1);
  const virtualizer = useVirtualizer({
    count: p.entries.length + (p.done ? 0 : 1),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 8,
  });
  const items = virtualizer.getVirtualItems();
  const last = items[items.length - 1];
  useEffect(() => {
    if (!p.done && !p.loading && last && last.index >= p.entries.length - 40) p.loadMore();
  }, [last?.index, p.entries.length, p.done, p.loading]);

  const indexOf = useMemo(() => new Map(p.entries.map((e, i) => [e.id, i])), [p.entries]);
  const selectedSet = useMemo(() => new Set(p.selected), [p.selected]);
  const matchSet = useMemo(() => new Set(p.matches), [p.matches]);
  useEffect(() => {
    const id = p.selected[p.selected.length - 1];
    const i = id ? indexOf.get(id) : undefined;
    if (i !== undefined) virtualizer.scrollToIndex(i, { align: "auto" });
  }, [p.selected, indexOf]);

  // Input handlers and drops read the latest props through this, so they never change identity.
  const latest = useRef({ p, selectedSet, indexOf });
  useLayoutEffect(() => {
    latest.current = { p, selectedSet, indexOf };
  });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Drops land on the row under the pointer.
    const rowAt = (x: number, y: number) => {
      const row = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-entry]");
      const id = row?.dataset.entry;
      return id ? (latest.current.p.entries.find((e) => e.id === id) ?? null) : null;
    };
    return registerDropTarget(el, {
      accepts: (type) => type === GRAPH_DRAG,
      over: (_d, x, y) => setDropRow(rowAt(x, y)?.id ?? null),
      leave: () => setDropRow(null),
      drop: (d, x, y) => {
        setDropRow(null);
        const target = rowAt(x, y);
        if (!target) return;
        const { repo, head } = latest.current.p;
        const items = dropMenu(JSON.parse(d.payload) as DragItem, target, repo, head);
        showContextMenu(
          { x, y },
          items.length ? items : [{ label: "Drop a branch or commit on the current branch's commit", disabled: true }],
        );
      },
    });
  }, []);

  const actions = useMemo<RowActions>(
    () => ({
      click: (e, i) => {
        const { p, selectedSet } = latest.current;
        const entry = p.entries[i]!;
        if (e.shiftKey && anchor.current >= 0) {
          const [a, b] = [Math.min(anchor.current, i), Math.max(anchor.current, i)];
          p.onSelect(p.entries.slice(a, b + 1).map((x) => x.id));
          return;
        }
        if (e.metaKey || e.ctrlKey) {
          anchor.current = i;
          p.onSelect(selectedSet.has(entry.id) ? p.selected.filter((x) => x !== entry.id) : [...p.selected, entry.id]);
          return;
        }
        anchor.current = i;
        p.onSelect([entry.id]);
      },
      menu: async (e, i) => {
        e.preventDefault();
        const { p, selectedSet, indexOf } = latest.current;
        const point = { x: e.clientX, y: e.clientY };
        const entry = p.entries[i]!;
        if (!selectedSet.has(entry.id)) {
          anchor.current = i;
          p.onSelect([entry.id]);
        }
        const bridge = gitGraphBridge();
        if (!bridge) return;
        let items: MenuItem[];
        if (entry.kind === "working") items = workingMenu(p.repo);
        else if (entry.kind === "stash") items = bridge.stashMenu(entry.stash.index, entry.stash.message, p.repo);
        else {
          const selection = selectedSet.has(entry.id)
            ? p.selected
                .map((id) => p.entries[indexOf.get(id) ?? -1])
                .filter((x): x is GraphEntry & { kind: "commit" } => x?.kind === "commit")
                .map((x) => x.commit)
            : [entry.commit];
          items = [
            ...(await bridge.commitMenu(entry.commit, selection)),
            ...commitExtras(entry.commit, selection, p.bisect),
          ];
        }
        if (items.length) showContextMenu(point, items);
      },
      drag: (e, entry) => {
        const c = entryCommit(entry);
        if (!c || entry.kind !== "commit" || (e.target as HTMLElement).closest("button")) return;
        startPointerDrag(e, e.currentTarget, {
          type: GRAPH_DRAG,
          payload: JSON.stringify({ kind: "commit", commit: c } satisfies DragItem),
        });
      },
      openRef: async (e, l) => {
        e.preventDefault();
        e.stopPropagation();
        if (l.kind === "head") return;
        const bridge = gitGraphBridge();
        if (!bridge) return;
        const { p } = latest.current;
        const currentBranch = p.head?.head ?? null;
        const point = { x: e.clientX, y: e.clientY };
        let items: MenuItem[];
        if (l.kind === "tag")
          items = [...(await bridge.tagMenu(l.name, p.repo)), ...tagExtras(l.name, p.repo, p.remotes)];
        else {
          const branch: Branch = p.branches.find((b) => b.name === l.name && b.remote === (l.kind === "remote")) ?? {
            name: l.name,
            remote: l.kind === "remote",
            current: l.name === currentBranch,
            upstream: null,
            ahead: 0,
            behind: 0,
            lastCommitMs: null,
          };
          items = [
            ...(await bridge.branchMenu(branch, p.repo)),
            ...branchExtras(branch, p.repo, [...p.remoteBranches]),
            ...compareExtras(branch, p.repo, currentBranch),
          ];
        }
        if (items.length) showContextMenu(point, items);
      },
      navigate: (targetRow) => {
        const { p } = latest.current;
        const entry = p.entries[targetRow];
        if (!entry) return;
        anchor.current = targetRow;
        p.onSelect([entry.id]);
        // The clicked arrow may scroll out and unmount: keep the keys on the list.
        scrollRef.current?.focus({ preventScroll: true });
      },
    }),
    [],
  );

  // At least three lanes wide so the "Graph" header fits.
  const graphWidth = Math.min(Math.max(p.width, 3), 40) * LANE + 4;

  const keyDown = (e: KeyboardEvent) => {
    if (!p.entries.length) return;
    const cur = indexOf.get(p.selected[p.selected.length - 1] ?? "") ?? -1;
    let next = cur;
    if (e.key === "ArrowDown") next = Math.min(p.entries.length - 1, cur + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, cur - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = p.entries.length - 1;
    else return;
    e.preventDefault();
    const entry = p.entries[next]!;
    if (e.shiftKey && anchor.current >= 0) {
      const [a, b] = [Math.min(anchor.current, next), Math.max(anchor.current, next)];
      p.onSelect(p.entries.slice(a, b + 1).map((x) => x.id));
    } else {
      anchor.current = next;
      p.onSelect([entry.id]);
    }
  };
  // The branch line under the pointer stays bright and every other line dims, showing where a branch runs.
  const hover = (e: ReactMouseEvent) => {
    const color = (e.target as HTMLElement).closest<HTMLElement>("[data-color]")?.dataset.color;
    setHoverColor(color === undefined ? null : Number(color));
  };

  if (!p.entries.length && !p.loading) return <EmptyState title="No commits" className={styles.empty} />;

  const currentBranch = p.head?.head ?? null;
  return (
    <div className={styles.list}>
      {hoverColor !== null ? (
        <style>{`[data-graph-list="${listId}"] [data-lane-color]:not([data-lane-color="${hoverColor}"]){opacity:0.25}`}</style>
      ) : null}
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
        className={styles.scroll}
        tabIndex={0}
        role="grid"
        aria-label={tx("Commits")}
        aria-multiselectable
        data-graph-list={listId}
        onKeyDown={keyDown}
      >
        <div
          style={{ height: virtualizer.getTotalSize(), position: "relative" }}
          onMouseOver={hover}
          onMouseLeave={() => setHoverColor(null)}
        >
          {items.map((v) => {
            const entry = p.entries[v.index];
            if (!entry)
              return (
                <div key="more" className={styles.row} style={{ transform: `translateY(${v.start}px)` }}>
                  <Spinner size={12} />
                </div>
              );
            return (
              <CommitRow
                key={entry.id}
                entry={entry}
                row={p.rows[v.index]}
                index={v.index}
                start={v.start}
                selected={selectedSet.has(entry.id)}
                match={matchSet.has(v.index)}
                currentMatch={v.index === p.current}
                dropTarget={dropRow === entry.id}
                head={entry.id === p.head?.headCommit}
                currentBranch={currentBranch}
                graphWidth={graphWidth}
                loaded={pendingTarget(p.rows[v.index], p.entries.length)}
                remoteBranches={p.remoteBranches}
                actions={actions}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

const CommitRow = memo(function CommitRow({
  entry,
  row,
  index,
  start,
  selected,
  match,
  currentMatch,
  dropTarget,
  head,
  currentBranch,
  graphWidth,
  loaded,
  remoteBranches,
  actions,
}: {
  entry: GraphEntry;
  row: GraphLaneRow | undefined;
  index: number;
  start: number;
  selected: boolean;
  match: boolean;
  currentMatch: boolean;
  dropTarget: boolean;
  head: boolean;
  currentBranch: string | null;
  graphWidth: number;
  loaded: number | undefined;
  remoteBranches: ReadonlySet<string>;
  actions: RowActions;
}) {
  const c = entryCommit(entry);
  return (
    <div
      role="row"
      data-entry={entry.id}
      data-color={row?.color}
      aria-selected={selected}
      className={clsx(
        styles.row,
        entry.kind !== "commit" && styles.pseudo,
        selected && styles.selected,
        match && styles.match,
        currentMatch && styles.currentMatch,
        dropTarget && styles.dropTarget,
      )}
      style={{ transform: `translateY(${start}px)` }}
      onClick={(e) => actions.click(e, index)}
      onContextMenu={(e) => void actions.menu(e, index)}
      onPointerDown={(e) => actions.drag(e, entry)}
    >
      <span className={styles.colGraph} style={{ width: graphWidth }}>
        {row ? (
          <GraphCell
            row={row}
            head={head}
            hollow={entry.kind !== "commit"}
            width={graphWidth}
            loaded={loaded}
            onNavigate={actions.navigate}
          />
        ) : null}
      </span>
      <span className={styles.colDescription}>
        {entry.kind === "working" ? (
          <span className={styles.subject}>
            <T>Uncommitted Changes</T> <span className={styles.dim}>{`(${changeCount(entry.state)})`}</span>
          </span>
        ) : (
          <>
            {entry.kind === "stash" ? (
              <span className={clsx(styles.ref, styles.refStash)}>
                <Icon name="history" size={12} />
                <span>{`stash@{${entry.stash.index}}`}</span>
              </span>
            ) : (
              <RefPills
                refs={entry.commit.refs}
                remoteBranches={remoteBranches}
                currentBranch={currentBranch}
                onOpen={actions.openRef}
              />
            )}
            <span className={clsx(styles.subject, entry.parents.length > 1 && styles.mergeSubject)} title={c?.message}>
              {c?.summary}
            </span>
          </>
        )}
      </span>
      <DateCell ms={c?.timeMs} />
      <span className={styles.colAuthor} title={c?.email}>
        {c?.author}
      </span>
      <span className={styles.colHash}>{entry.kind === "working" ? "*" : c?.shortId}</span>
    </div>
  );
});

// One timer for every date cell, so relative dates ("5 min ago") advance without re-rendering rows.
const minuteListeners = new Set<() => void>();
let minuteTimer: ReturnType<typeof setInterval> | undefined;
let minute = 0;
function subscribeMinute(listener: () => void) {
  minuteListeners.add(listener);
  minuteTimer ??= setInterval(() => {
    minute++;
    for (const l of minuteListeners) l();
  }, 60_000);
  return () => {
    minuteListeners.delete(listener);
    if (minuteListeners.size) return;
    clearInterval(minuteTimer);
    minuteTimer = undefined;
  };
}
const currentMinute = () => minute;

/**
 * The date column: also re-renders on its own when the date format settings, the language or the
 * minute change, which the memoised row does not see. Not memoised itself, so it renders with its row.
 */
function DateCell({ ms }: { ms: number | null | undefined }) {
  useSyncExternalStore(subscribeMinute, currentMinute);
  useProject((s) => s.settings?.general?.dateFormat);
  useI18n((s) => s.texts);
  return <span className={styles.colDate}>{ms ? formatTimestamp(ms) : ""}</span>;
}

const REF_CLASS: Record<GraphRefLabel["kind"], string | undefined> = {
  head: styles.refHead,
  local: styles.refLocal,
  remote: styles.refRemote,
  tag: styles.refTag,
};

export const refClass = (kind: GraphRefLabel["kind"]) => REF_CLASS[kind];

const RefPills = memo(function RefPills(p: {
  refs: string[];
  remoteBranches: ReadonlySet<string>;
  currentBranch: string | null;
  onOpen: (e: ReactMouseEvent, l: GraphRefLabel) => void;
}) {
  const bridge = gitGraphBridge();
  if (!bridge || !p.refs.length) return null;
  const labels = bridge.refLabels(p.refs, p.remoteBranches);
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
          onClick={(e) => p.onOpen(e, l)}
          onContextMenu={(e) => p.onOpen(e, l)}
          onPointerDown={(e) => {
            e.stopPropagation();
            if (l.kind !== "head")
              startPointerDrag(e, e.currentTarget, {
                type: GRAPH_DRAG,
                payload: JSON.stringify({ kind: "ref", ref: l } satisfies DragItem),
              });
          }}
        >
          <Icon name={l.kind === "tag" ? "tag" : l.kind === "head" ? "current-branch" : "branch"} size={12} />
          <span>{l.name}</span>
        </button>
      ))}
    </span>
  );
});
