/** The graph's rows: commits, stashes and uncommitted changes, with selection, menus and drag and drop. */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import clsx from "clsx";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Branch, GraphBisectState, Remote } from "@/bindings";
import { formatTimestamp } from "@/platform/dateFormat";
import { tx } from "@/platform/i18n";
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
import { branchExtras, commitExtras, dropMenu, GRAPH_DRAG, tagExtras, workingMenu, type DragItem } from "./menus";
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

export function CommitList(p: CommitListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [hoverColor, setHoverColor] = useState<number | null>(null);
  const [dropRow, setDropRow] = useState<string | null>(null);
  const anchor = useRef<number>(-1);
  const virtualizer = useVirtualizer({
    count: p.entries.length + (p.done ? 0 : 1),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 20,
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

  // Drops land on the row under the pointer.
  const entriesRef = useRef(p.entries);
  const dropContext = useRef({ repo: p.repo, head: p.head });
  useEffect(() => {
    entriesRef.current = p.entries;
    dropContext.current = { repo: p.repo, head: p.head };
  });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const rowAt = (x: number, y: number) => {
      const row = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-entry]");
      const id = row?.dataset.entry;
      return id ? (entriesRef.current.find((e) => e.id === id) ?? null) : null;
    };
    return registerDropTarget(el, {
      accepts: (type) => type === GRAPH_DRAG,
      over: (_d, x, y) => setDropRow(rowAt(x, y)?.id ?? null),
      leave: () => setDropRow(null),
      drop: (d, x, y) => {
        setDropRow(null);
        const target = rowAt(x, y);
        if (!target) return;
        const { repo, head } = dropContext.current;
        const items = dropMenu(JSON.parse(d.payload) as DragItem, target, repo, head);
        showContextMenu(
          { x, y },
          items.length ? items : [{ label: "Drop a branch or commit on the current branch's commit", disabled: true }],
        );
      },
    });
  }, []);

  // At least three lanes wide so the "Graph" header fits.
  const graphWidth = Math.min(Math.max(p.width, 3), 40) * LANE + 4;

  const click = (e: ReactMouseEvent, i: number) => {
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
  };
  const menu = async (e: ReactMouseEvent, i: number) => {
    e.preventDefault();
    const point = { x: e.clientX, y: e.clientY };
    const entry = p.entries[i]!;
    if (!selectedSet.has(entry.id)) {
      anchor.current = i;
      p.onSelect([entry.id]);
    }
    const bridge = gitGraphBridge();
    if (!bridge) return;
    let items: MenuItem[];
    if (entry.kind === "working") items = workingMenu();
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
  };
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
  const dragCommit = (e: ReactPointerEvent<HTMLElement>, entry: GraphEntry) => {
    const c = entryCommit(entry);
    if (!c || entry.kind !== "commit" || (e.target as HTMLElement).closest("button")) return;
    startPointerDrag(e, e.currentTarget, {
      type: GRAPH_DRAG,
      payload: JSON.stringify({ kind: "commit", commit: c } satisfies DragItem),
    });
  };

  if (!p.entries.length && !p.loading) return <EmptyState title="No commits" className={styles.empty} />;

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
        className={styles.scroll}
        tabIndex={0}
        role="grid"
        aria-label={tx("Commits")}
        aria-multiselectable
        onKeyDown={keyDown}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {items.map((v) => {
            const entry = p.entries[v.index];
            if (!entry)
              return (
                <div key="more" className={styles.row} style={{ transform: `translateY(${v.start}px)` }}>
                  <Spinner size={12} />
                </div>
              );
            const row = p.rows[v.index];
            const c = entryCommit(entry);
            return (
              <div
                key={entry.id}
                role="row"
                data-entry={entry.id}
                aria-selected={selectedSet.has(entry.id)}
                className={clsx(
                  styles.row,
                  entry.kind !== "commit" && styles.pseudo,
                  selectedSet.has(entry.id) && styles.selected,
                  matchSet.has(v.index) && styles.match,
                  v.index === p.current && styles.currentMatch,
                  dropRow === entry.id && styles.dropTarget,
                )}
                style={{ transform: `translateY(${v.start}px)` }}
                onClick={(e) => click(e, v.index)}
                onContextMenu={(e) => void menu(e, v.index)}
                onPointerDown={(e) => dragCommit(e, entry)}
                onMouseEnter={() => setHoverColor(row ? row.color : null)}
                onMouseLeave={() => setHoverColor(null)}
              >
                <span className={styles.colGraph} style={{ width: graphWidth }}>
                  {row ? (
                    <GraphCell
                      row={row}
                      head={entry.id === p.head?.headCommit}
                      hollow={entry.kind !== "commit"}
                      width={graphWidth}
                      highlight={hoverColor}
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
                          repo={p.repo}
                          branches={p.branches}
                          remotes={p.remotes}
                          remoteBranches={p.remoteBranches}
                          currentBranch={p.head?.head ?? null}
                        />
                      )}
                      <span
                        className={clsx(styles.subject, entry.parents.length > 1 && styles.mergeSubject)}
                        title={c?.message}
                      >
                        {c?.summary}
                      </span>
                    </>
                  )}
                </span>
                <span className={styles.colDate}>{c?.timeMs ? formatTimestamp(c.timeMs) : ""}</span>
                <span className={styles.colAuthor} title={c?.email}>
                  {c?.author}
                </span>
                <span className={styles.colHash}>{entry.kind === "working" ? "*" : c?.shortId}</span>
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

export const refClass = (kind: GraphRefLabel["kind"]) => REF_CLASS[kind];

function RefPills(p: {
  refs: string[];
  repo: string;
  branches: Branch[];
  remotes: Remote[];
  remoteBranches: ReadonlySet<string>;
  currentBranch: string | null;
}) {
  const bridge = gitGraphBridge();
  if (!bridge || !p.refs.length) return null;
  const labels = bridge.refLabels(p.refs, p.remoteBranches);
  const open = async (e: ReactMouseEvent, l: GraphRefLabel) => {
    e.preventDefault();
    e.stopPropagation();
    if (l.kind === "head") return;
    const point = { x: e.clientX, y: e.clientY };
    let items: MenuItem[];
    if (l.kind === "tag") items = [...(await bridge.tagMenu(l.name, p.repo)), ...tagExtras(l.name, p.repo, p.remotes)];
    else {
      const branch: Branch = p.branches.find((b) => b.name === l.name && b.remote === (l.kind === "remote")) ?? {
        name: l.name,
        remote: l.kind === "remote",
        current: l.name === p.currentBranch,
        upstream: null,
        ahead: 0,
        behind: 0,
        lastCommitMs: null,
      };
      items = [...(await bridge.branchMenu(branch, p.repo)), ...branchExtras(branch, p.repo, [...p.remoteBranches])];
    }
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
}
