/** The bottom pane's other tabs (reflog, statistics, file tree) and the bisect banner. */
import { useEffect, useState } from "react";
import clsx from "clsx";
import type { GraphAuthorStat, GraphBisectState, GraphReflogEntry, GraphTreeEntry } from "@/bindings";
import { formatTimestamp } from "@/platform/dateFormat";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { EmptyState, Icon, SearchField, Spinner, T } from "@/ui";
import { bisect } from "./menus";
import styles from "./GitGraph.module.css";

/** Loads `load()` whenever `key` changes; null while loading. */
function useLoaded<T>(key: string | null, load: () => Promise<T>): T | null {
  const [state, setState] = useState<{ key: string | null; value: T } | null>(null);
  useEffect(() => {
    if (key === null) return;
    let live = true;
    load()
      .then((value) => live && setState({ key, value }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // `load` is recreated each render; `key` names what it loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state && state.key === key ? state.value : null;
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
  const entries = useLoaded<GraphReflogEntry[]>(`${repo}\0${version}`, () =>
    call(commands.graphReflog(repo, "HEAD", 300)),
  );
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
  const stats = useLoaded<GraphAuthorStat[]>(`${repo}\0${version}`, () => call(commands.graphAuthorStats(repo)));
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
  const entries = useLoaded<GraphTreeEntry[]>(rev ? `${repo}\0${rev}` : null, () =>
    call(commands.graphTree(repo, rev!)),
  );
  if (!rev) return <EmptyState title="Select a commit" className={styles.empty} />;
  if (!entries) return <Spinner size={14} />;
  const q = filter.trim().toLowerCase();
  const shown = q ? entries.filter((e) => e.path.toLowerCase().includes(q)) : entries;
  return (
    <div className={styles.treePanel}>
      <div className={styles.treeBar}>
        <span className={styles.mono}>{rev.slice(0, 8)}</span>
        <span className={styles.dim}>{tx`${entries.length} files`}</span>
        <SearchField
          className={styles.search}
          value={filter}
          onChange={setFilter}
          aria-label={tx("Filter files")}
          placeholder={tx("Filter files")}
        />
      </div>
      <div className={styles.table} role="list" aria-label={tx("Files at Revision")}>
        {shown.map((e) => (
          <div
            key={e.path}
            role="listitem"
            tabIndex={0}
            className={styles.tableRow}
            onDoubleClick={() => e.kind === "blob" && onOpen(e.path)}
            onKeyDown={(ev) => ev.key === "Enter" && e.kind === "blob" && onOpen(e.path)}
            title={e.path}
          >
            <Icon name={e.kind === "commit" ? "folder-github" : "file"} size={14} />
            <span className={styles.grow}>{e.path}</span>
            <span className={styles.dim}>{e.size === null ? "" : `${e.size} B`}</span>
          </div>
        ))}
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
