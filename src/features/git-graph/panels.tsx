/** The bottom pane's other tabs (reflog, statistics, file tree) and the bisect banner. */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
 * Loads `load()` for the selection `key`, waiting `SELECTION_DELAY` after the first load so a
 * selection that changes again sooner sends nothing. Until the new result lands, `value` stays the
 * previous selection's (null before any) and `current` is false: show it as loading, and don't act
 * on it. A failed load gives `fallback`, or keeps loading when there is none.
 */
export function useSelectionLoad<T>(
  key: string | null,
  load: () => Promise<T>,
  fallback?: T,
): { value: T | null; current: boolean; loadedKey: string | null } {
  const [state, setState] = useState<{ key: string; value: T } | null>(null);
  const first = useRef(true);
  useEffect(() => {
    if (key === null) return;
    let live = true;
    const timer = setTimeout(
      () =>
        load().then(
          (value) => live && setState({ key, value }),
          () => live && fallback !== undefined && setState({ key, value: fallback }),
        ),
      first.current ? 0 : SELECTION_DELAY,
    );
    first.current = false;
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
 * goes back to the top when `resetKey` changes (a new selection's rows landed).
 */
export function usePaneRows(count: number, resetKey: string | null) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowHeight = useListRowHeight();
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 10,
  });
  useEffect(() => virtualizer.measure(), [virtualizer, rowHeight]);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [resetKey]);
  return { scrollRef, rows: virtualizer.getVirtualItems(), height: virtualizer.getTotalSize() };
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
  const { scrollRef, rows, height } = usePaneRows(shown.length, loadedKey);
  if (!rev) return <EmptyState title="Select a commit" className={styles.empty} />;
  if (!entries) return <Spinner size={14} />;
  // Until the new revision's files land, the previous revision's stay dimmed and inert.
  const open = (e: GraphTreeEntry) => current && e.kind === "blob" && onOpen(e.path);
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
      >
        <div role="presentation" className={styles.virtualRows} style={{ height }}>
          {rows.map((v) => {
            const e = shown[v.index]!;
            return (
              <div
                key={e.path}
                role="listitem"
                aria-setsize={shown.length}
                aria-posinset={v.index + 1}
                tabIndex={0}
                className={clsx(styles.tableRow, styles.virtualRow)}
                style={{ transform: `translateY(${v.start}px)` }}
                onDoubleClick={() => open(e)}
                onKeyDown={(ev) => ev.key === "Enter" && open(e)}
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
