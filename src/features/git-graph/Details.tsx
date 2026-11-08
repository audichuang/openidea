/** The bottom pane: the selected row's details and the File Tree, Reflog and Statistics tabs. */
import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import clsx from "clsx";
import type { ChangedFile } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { formatClock, formatDay } from "@/platform/dateFormat";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { EmptyState, IconButton, showContextMenu, Spinner, T } from "@/ui";
import { gitGraphBridge, type GraphCommit } from "@/workbench/gitGraphBridge";
import { refClass } from "./CommitList";
import { changeCount, type GraphEntry } from "./entries";
import { ReflogPanel, StatsPanel, TreePanel } from "./panels";
import type { GraphPanel } from "./viewState";
import styles from "./GitGraph.module.css";

/** Day and time in the user's date format (Settings › Appearance › Date Formats). */
const fullDate = (ms: number) => `${formatDay(new Date(ms))} ${formatClock(new Date(ms))}`;

const PANELS: Array<{ id: GraphPanel; label: string }> = [
  { id: "details", label: "Details" },
  { id: "tree", label: "File Tree" },
  { id: "reflog", label: "Reflog" },
  { id: "stats", label: "Statistics" },
];

export function BottomPane(p: {
  panel: GraphPanel;
  onPanel: (panel: GraphPanel) => void;
  entries: GraphEntry[];
  repo: string;
  version: number;
  treeRev: string | null;
  onJump: (id: string) => void;
  remoteBranches: ReadonlySet<string>;
}) {
  const one = p.entries.length === 1 ? p.entries[0]! : null;
  const selectedRev = one && one.kind !== "working" ? one.id : null;
  return (
    <div className={styles.bottom}>
      <div className={styles.paneTabs} role="tablist" aria-label={tx("Git Graph Panels")}>
        {PANELS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={p.panel === t.id}
            className={clsx(styles.paneTab, p.panel === t.id && styles.paneTabActive)}
            onClick={() => p.onPanel(t.id)}
          >
            <T>{t.label}</T>
          </button>
        ))}
      </div>
      <div className={styles.paneBody}>
        {p.panel === "details" ? (
          one?.kind === "working" ? (
            <WorkingDetails entry={one} />
          ) : (
            <CommitDetails
              commits={p.entries.flatMap((e) => (e.kind === "working" ? [] : [e.commit]))}
              stash={one?.kind === "stash" ? one.stash.index : null}
              onJump={p.onJump}
              remoteBranches={p.remoteBranches}
            />
          )
        ) : p.panel === "tree" ? (
          <TreePanel
            repo={p.repo}
            rev={p.treeRev ?? selectedRev}
            onOpen={(path) => {
              const rev = p.treeRev ?? selectedRev;
              if (rev) void gitGraphBridge()?.openRevisionFile(p.repo, rev, path);
            }}
          />
        ) : p.panel === "reflog" ? (
          <ReflogPanel repo={p.repo} version={p.version} onJump={p.onJump} />
        ) : (
          <StatsPanel repo={p.repo} version={p.version} />
        )}
      </div>
    </div>
  );
}

function WorkingDetails({ entry }: { entry: GraphEntry & { kind: "working" } }) {
  const s = entry.state;
  return (
    <div className={styles.meta}>
      <div className={styles.metaSubject}>
        <T>Uncommitted Changes</T> {`(${changeCount(s)})`}
      </div>
      <dl className={styles.metaGrid}>
        <dt>
          <T>Staged</T>
        </dt>
        <dd>{s.staged}</dd>
        <dt>
          <T>Unstaged</T>
        </dt>
        <dd>{s.unstaged}</dd>
        <dt>
          <T>Untracked</T>
        </dt>
        <dd>{s.untracked}</dd>
        <dt>
          <T>Conflicted</T>
        </dt>
        <dd>{s.conflicted}</dd>
      </dl>
      <div className={styles.buttons}>
        <button type="button" className={styles.opButton} onClick={() => void executeAction("vcs.commit")}>
          <T>Commit…</T>
        </button>
        <button type="button" className={styles.opButton} onClick={() => void executeAction("vcs.stash")}>
          <T>Stash Changes…</T>
        </button>
        <button type="button" className={styles.opButton} onClick={() => void executeAction("vcs.rollback")}>
          <T>Rollback…</T>
        </button>
      </div>
    </div>
  );
}

export const KIND_LETTER: Record<string, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typeChanged: "T",
};

export function CommitDetails({
  commits,
  stash,
  onJump,
  remoteBranches,
}: {
  commits: GraphCommit[];
  /** The selected row is `stash@{stash}`. */
  stash: number | null;
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
              <span key={`${l.kind}:${l.name}`} className={clsx(styles.ref, refClass(l.kind))}>
                {l.name}
              </span>
            ))}
          </div>
        ) : null}
        {body ? <pre className={styles.metaBody}>{body}</pre> : null}
        {stash !== null && bridge ? (
          <div className={styles.buttons}>
            <span className={clsx(styles.ref, styles.refStash)}>{`stash@{${stash}}`}</span>
            {bridge.stashMenu(stash, one.summary, one.repo).flatMap((item) =>
              item.kind === "separator" || item.kind === "header" || item.kind === "action"
                ? []
                : [
                    <button key={item.label} type="button" className={styles.opButton} onClick={item.run}>
                      <T>{item.label}</T>
                    </button>,
                  ],
            )}
          </div>
        ) : null}
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
          {one.author ? (
            <>
              <dt>
                <T>Author</T>
              </dt>
              <dd>
                {one.author} &lt;{one.email}&gt;
              </dd>
            </>
          ) : null}
          <dt>
            <T>Date</T>
          </dt>
          <dd>{one.timeMs ? fullDate(one.timeMs) : ""}</dd>
          {one.commitTimeMs && one.commitTimeMs !== one.timeMs ? (
            <>
              <dt>
                <T>Committed</T>
              </dt>
              <dd>{fullDate(one.commitTimeMs)}</dd>
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
