/** The bottom pane's other tabs (reflog, statistics, file tree) and the bisect banner. */
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import clsx from "clsx";
import type { GraphAuthorStat, GraphBisectState, GraphReflogEntry, GraphTreeEntry } from "@/bindings";
import { formatTimestamp } from "@/platform/dateFormat";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { EmptyState, Icon, SearchField, Spinner, T } from "@/ui";
import { bisect } from "./menus";
import styles from "./GitGraph.module.css";

/**
 * Loads `load()` whenever `key` changes, and again on each `refresh`; null until `key`'s first
 * result. A refresh keeps showing the last result while it loads, and keeps the same object when
 * it brought nothing new: every vcs refresh (any file save) reloads.
 */
function useLoaded<T>(key: string | null, load: () => Promise<T>, refresh = 0): T | null {
  const [state, setState] = useState<{ key: string | null; value: T } | null>(null);
  useEffect(() => {
    if (key === null) return;
    let live = true;
    load()
      .then(
        (value) =>
          live &&
          setState((prev) =>
            prev?.key === key && JSON.stringify(prev.value) === JSON.stringify(value) ? prev : { key, value },
          ),
      )
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // `load` is recreated each render; `key` names what it loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refresh]);
  return state && state.key === key ? state.value : null;
}

/** How long a selection must stay before its files load, so arrow-key repeat sends one request. */
export const SELECTION_DELAY = 100;

/**
 * Loads `load()` for the selection `key`: at once when the selection was idle, else after
 * `SELECTION_DELAY`, so a selection that keeps changing (arrow-key repeat) sends only its last. Until the new result lands, `value` stays the
 * previous selection's (null before any) and `current` is false: show it as loading, and don't act
 * on it. A failed load gives `fallback`, or keeps loading when there is none.
 */
export function useSelectionLoad<T>(
  key: string | null,
  load: () => Promise<T>,
  fallback?: T,
): { value: T | null; current: boolean; loadedKey: string | null } {
  const [state, setState] = useState<{ key: string; value: T } | null>(null);
  const lastChange = useRef(Number.NEGATIVE_INFINITY);
  useEffect(() => {
    if (key === null) return;
    let live = true;
    const now = performance.now();
    const rapid = now - lastChange.current < SELECTION_DELAY;
    lastChange.current = now;
    const timer = setTimeout(
      () =>
        load().then(
          (value) => live && setState({ key, value }),
          () => live && fallback !== undefined && setState({ key, value: fallback }),
        ),
      rapid ? SELECTION_DELAY : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `load` and `fallback` are recreated each render; `key` names what they load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { value: state?.value ?? null, current: state !== null && state.key === key, loadedKey: state?.key ?? null };
}

/** `--h-list-row`, the pane lists' row height: smaller in compact mode. */
function useListRowHeight(): number {
  const [height, setHeight] = useState(24);
  useLayoutEffect(() => {
    const root = document.documentElement;
    const read = () => {
      const h = parseFloat(getComputedStyle(root).getPropertyValue("--h-list-row"));
      if (h > 0) setHeight(h);
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ["data-compact"] });
    return () => observer.disconnect();
  }, []);
  return height;
}

/**
 * Virtualises a pane list of `count` fixed-height rows. Put `scrollRef` on the scrolling list; it
 * goes back to the top when `resetKey` changes (a new selection's rows landed). Rows outside the
 * window unmount, so the list itself takes keyboard focus (as `CommitList` does) and
 * `scrollToIndex` reveals the row the keys moved to.
 */
export function usePaneRows(count: number, resetKey: string | null) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowHeight = useListRowHeight();
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 10,
    // The lists' 4px top padding (`.files`, `.table`) sits above the rows: reveal a row's bottom edge with it.
    scrollPaddingEnd: 4,
  });
  useEffect(() => virtualizer.measure(), [virtualizer, rowHeight]);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [resetKey]);
  return {
    scrollRef,
    rows: virtualizer.getVirtualItems(),
    height: virtualizer.getTotalSize(),
    scrollToIndex: (index: number) => virtualizer.scrollToIndex(index, { align: "auto" }),
  };
}

/** The active row after a key in a pane list of `count` rows, or null when the key does not move it. */
export function paneListMove(key: string, count: number, active: number): number | null {
  if (!count) return null;
  if (key === "ArrowDown") return Math.min(count - 1, active + 1);
  if (key === "ArrowUp") return Math.max(0, active - 1);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

/**
 * Pointer bookkeeping for a pane list that owns keyboard focus. Spread `handlers` on the list;
 * `version` names the rows shown, null while they are stale.
 * - `doubleClickFresh`: whether a double-click began on the rows shown now. A new selection's rows
 *   replace the previous ones under the pointer; keying the rows by selection keeps a click pressed
 *   on the old ones off the new, but the dblclick goes to wherever its second press lands.
 * - `onKeyboardFocus` runs when the list takes focus from Tab rather than a press, so it can give
 *   the list an active row (each row used to be its own tab stop, and Enter opened it).
 */
export function usePaneListPointer(version: string | null, onKeyboardFocus: () => void) {
  const firstPress = useRef<string | null>(null);
  const pressing = useRef(false);
  return {
    handlers: {
      onMouseDownCapture: (e: ReactMouseEvent) => {
        pressing.current = true;
        if (e.detail <= 1) firstPress.current = version;
      },
      onFocus: () => {
        if (!pressing.current) onKeyboardFocus();
        pressing.current = false;
      },
      onBlur: () => {
        pressing.current = false;
      },
    },
    doubleClickFresh: () => version !== null && firstPress.current === version,
  };
}

export function ReflogPanel({
  repo,
  version,
  onJump,
}: {
  repo: string;
  version: number;
  onJump: (id: string) => void;
}) {
  const entries = useLoaded<GraphReflogEntry[]>(repo, () => call(commands.graphReflog(repo, "HEAD", 300)), version);
  if (!entries) return <Spinner size={14} />;
  if (!entries.length) return <EmptyState title="No reflog entries" className={styles.empty} />;
  return (
    <div className={styles.table} role="list" aria-label={tx("Reflog")}>
      {entries.map((e) => (
        <div
          key={e.selector}
          role="listitem"
          tabIndex={0}
          className={styles.tableRow}
          onClick={() => onJump(e.id)}
          onKeyDown={(ev) => ev.key === "Enter" && onJump(e.id)}
        >
          <span className={styles.mono}>{e.selector}</span>
          <span className={styles.link}>{e.id.slice(0, 8)}</span>
          <span className={styles.grow}>{e.action}</span>
          <span className={styles.dim}>{e.timeMs ? formatTimestamp(e.timeMs) : ""}</span>
        </div>
      ))}
    </div>
  );
}

export function StatsPanel({ repo, version }: { repo: string; version: number }) {
  const stats = useLoaded<GraphAuthorStat[]>(repo, () => call(commands.graphAuthorStats(repo)), version);
  if (!stats) return <Spinner size={14} />;
  if (!stats.length) return <EmptyState title="No commits" className={styles.empty} />;
  const total = stats.reduce((n, s) => n + s.commits, 0);
  const max = Math.max(...stats.map((s) => s.commits));
  return (
    <div className={styles.table} role="list" aria-label={tx("Statistics")}>
      <div className={styles.tableHeader}>{tx`Commits: ${total}, authors: ${stats.length}`}</div>
      {stats.map((s) => (
        <div key={`${s.name}\0${s.email}`} role="listitem" className={styles.tableRow}>
          <span className={styles.statName} title={s.email}>
            {s.name}
          </span>
          <span className={styles.statBar}>
            <span className={styles.statFill} style={{ width: `${(s.commits / max) * 100}%` }} />
          </span>
          <span className={styles.statCount}>{s.commits}</span>
          <span className={styles.dim}>{`${Math.round((s.commits / total) * 100)}%`}</span>
        </div>
      ))}
    </div>
  );
}

export function TreePanel({ repo, rev, onOpen }: { repo: string; rev: string | null; onOpen: (path: string) => void }) {
  const [filter, setFilter] = useState("");
  const key = rev ? `${repo}\0${rev}` : null;
  const {
    value: entries,
    current,
    loadedKey,
  } = useSelectionLoad<GraphTreeEntry[]>(key, () => call(commands.graphTree(repo, rev!)));
  const q = filter.trim().toLowerCase();
  const shown = !entries ? [] : q ? entries.filter((e) => e.path.toLowerCase().includes(q)) : entries;
  const { scrollRef, rows, height, scrollToIndex } = usePaneRows(shown.length, loadedKey);
  // The active row belongs to the rows shown: a new revision or filter starts it over.
  const listKey = `${loadedKey}\0${q}`;
  const [activeRow, setActiveRow] = useState<{ key: string; index: number }>({ key: "", index: -1 });
  const active = activeRow.key === listKey ? activeRow.index : -1;
  const pointer = usePaneListPointer(current ? loadedKey : null, () => {
    if (current && active < 0 && shown.length) setActiveRow({ key: listKey, index: 0 });
  });
  if (!rev) return <EmptyState title="Select a commit" className={styles.empty} />;
  if (!entries) return <Spinner size={14} />;
  // Until the new revision's files land, the previous revision's stay dimmed and inert.
  const open = (e: GraphTreeEntry | undefined) => current && e?.kind === "blob" && onOpen(e.path);
  return (
    <div className={styles.treePanel}>
      <div className={styles.treeBar}>
        <span className={styles.mono}>{rev.slice(0, 8)}</span>
        {current ? <span className={styles.dim}>{tx`${entries.length} files`}</span> : <Spinner size={12} />}
        <SearchField
          className={styles.search}
          value={filter}
          onChange={setFilter}
          aria-label={tx("Filter files")}
          placeholder={tx("Filter files")}
        />
      </div>
      <div
        ref={scrollRef}
        className={styles.table}
        role="list"
        aria-label={tx("Files at Revision")}
        aria-busy={!current || undefined}
        tabIndex={0}
        {...pointer.handlers}
        onKeyDown={(ev) => {
          if (!current) return;
          if (ev.key === "Enter") {
            if (active >= 0) open(shown[active]);
            return;
          }
          const next = paneListMove(ev.key, shown.length, active);
          if (next === null) return;
          ev.preventDefault();
          setActiveRow({ key: listKey, index: next });
          scrollToIndex(next);
        }}
      >
        {/* Keyed by revision so its rows are new nodes: a press on the old ones can't click these. */}
        <div key={loadedKey} role="presentation" className={styles.virtualRows} style={{ height }} inert={!current}>
          {rows.map((v) => {
            const e = shown[v.index]!;
            return (
              <div
                key={e.path}
                role="listitem"
                aria-setsize={shown.length}
                aria-posinset={v.index + 1}
                className={clsx(styles.tableRow, styles.virtualRow, v.index === active && styles.selected)}
                style={{ transform: `translateY(${v.start}px)` }}
                onClick={() => current && setActiveRow({ key: listKey, index: v.index })}
                onDoubleClick={() => pointer.doubleClickFresh() && open(e)}
                title={e.path}
              >
                <Icon name={e.kind === "commit" ? "folder-github" : "file"} size={14} />
                <span className={styles.grow}>{e.path}</span>
                <span className={styles.dim}>{e.size === null ? "" : `${e.size} B`}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** While a bisect runs: the commit under test and the verdict buttons, then the culprit. */
export function BisectBanner({
  repo,
  state,
  onJump,
  onChange,
}: {
  repo: string;
  state: GraphBisectState;
  onJump: (id: string) => void;
  onChange: (s: GraphBisectState) => void;
}) {
  const run = async (op: Parameters<typeof bisect>[1]) => {
    const next = await bisect(repo, op);
    if (next) onChange(next);
  };
  if (!state.active && !state.culprit) return null;
  const current = state.current;
  return (
    <div className={clsx(styles.banner, state.culprit && styles.bannerDone)} role="status">
      <Icon name="search" size={14} />
      {state.culprit ? (
        <span>
          <T>First bad commit:</T>{" "}
          <button type="button" className={styles.link} onClick={() => onJump(state.culprit!)}>
            {state.culprit.slice(0, 8)}
          </button>
        </span>
      ) : (
        <span>
          <T>Bisecting. Testing</T>{" "}
          {current ? (
            <button type="button" className={styles.link} onClick={() => onJump(current)}>
              {current.slice(0, 8)}
            </button>
          ) : null}
        </span>
      )}
      <span className={styles.spacer} />
      {state.active && current && !state.culprit ? (
        <>
          <button type="button" className={styles.opButton} onClick={() => void run({ op: "good", rev: current })}>
            <T>Good</T>
          </button>
          <button type="button" className={styles.opButton} onClick={() => void run({ op: "bad", rev: current })}>
            <T>Bad</T>
          </button>
          <button type="button" className={styles.opButton} onClick={() => void run({ op: "skip", rev: current })}>
            <T>Skip</T>
          </button>
        </>
      ) : null}
      {state.active ? (
        <button type="button" className={styles.opButton} onClick={() => void run({ op: "reset" })}>
          <T>End Bisect</T>
        </button>
      ) : null}
    </div>
  );
}
