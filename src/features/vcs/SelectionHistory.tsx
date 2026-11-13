/**
 * History for Selection editor tab (IDEA's Show History for Selection): the
 * commits that changed the selected lines (`git log -L`, renames followed),
 * newest first, each shown as the block before and after it. Unsaved or
 * uncommitted edits of the block come first as Local Changes.
 */
import { useEffect, useMemo, useState } from "react";
import type { BlockHistorySummary, BlockRevision, BlockRevisionSummary, RequestId } from "@/bindings";
import { call, commands, isCancelled, nextRequestId } from "@/platform/ipc";
import { useRemote } from "@/platform/remote";
import { List, Spinner, T } from "@/ui";
import type { EditorInput } from "@/workbench/contributions";
import { DiffEditor } from "./DiffEditor";
import { diffInput, type DiffSide } from "./diffInput";
import { baseName, formatTime } from "./model";
import { errorMessage } from "./ops";
import type { SelectionHistoryData } from "./selectionHistoryKind";
import layout from "./LocalHistory.module.css";
import styles from "./SelectionHistory.module.css";
import { tx } from "@/platform/i18n";

export type HistoryRow =
  | { kind: "local"; head: string; current: string }
  | { kind: "revision"; revision: BlockRevisionSummary; index: number };

const HEAD = "HEAD";
const DIFF_BATCH = 4;
const DIFF_CACHE_SIZE = DIFF_BATCH * 3;
const NO_ROWS: HistoryRow[] = [];

/** Lines `from..=to` of `text`, each ending with a line break (as Git prints a block). */
export function blockOf(text: string, [from, to]: readonly [number, number]): string {
  return text
    .split("\n")
    .slice(from, to + 1)
    .map((line) => `${line.replace(/\r$/, "")}\n`)
    .join("");
}

/** The rows of the list: Local Changes when the block differs from HEAD, then the commits. */
export function historyRows(history: BlockHistorySummary, current: string): HistoryRow[] {
  const rows: HistoryRow[] = history.revisions.map((revision, index) => ({ kind: "revision", revision, index }));
  const head = history.diffs[0]?.after;
  if (head !== undefined && head !== current) rows.unshift({ kind: "local", head, current });
  return rows;
}

function sides(row: HistoryRow, revision: BlockRevision | undefined): [DiffSide, DiffSide] | undefined {
  if (row.kind === "local")
    return [
      { type: "text", text: row.head, label: HEAD },
      { type: "text", text: row.current, label: tx("Local Changes") },
    ];
  if (!revision) return;
  return [
    { type: "text", text: revision.before, label: `${revision.shortId}^` },
    { type: "text", text: revision.after, label: revision.shortId },
  ];
}

function historyRequest<T>(
  run: (request: RequestId) => Promise<T>,
  onResult: (result: T) => void,
  onError: (error: string) => void,
) {
  const request = nextRequestId();
  let started = false;
  let done = false;
  let live = true;
  void Promise.resolve().then(async () => {
    if (!live) return;
    started = true;
    try {
      const result = await run(request);
      if (live) onResult(result);
    } catch (error) {
      if (live && !isCancelled(error)) onError(errorMessage(error));
    } finally {
      done = true;
    }
  });
  return () => {
    live = false;
    if (started && !done) void commands.cancelRequest(request);
  };
}

export function SelectionHistoryEditor({ input }: { input: EditorInput }) {
  const data = input.data as SelectionHistoryData;
  const [result, setResult] = useState<{
    data: SelectionHistoryData;
    history: BlockHistorySummary;
    legacy: Map<string, BlockRevision> | null;
  } | null>(null);
  const [failure, setFailure] = useState<{ data: SelectionHistoryData; error: string } | null>(null);
  const [active, setActive] = useState(0);
  const history = result?.data === data ? result.history : null;
  const error = failure?.data === data ? failure.error : null;

  useEffect(
    () =>
      historyRequest(
        async (request) => {
          const session = useRemote.getState().session;
          // Released servers only provide the original command with all diffs.
          if (session && !session.commands.includes("vcs_block_history_summary")) {
            const { headLines, revisions } = await call(
              commands.vcsBlockHistory(request, data.path, data.text, data.lines),
            );
            const history = { anchor: null, revisions, diffs: revisions.slice(0, 1) };
            return { history, legacy: headLines ? new Map(revisions.map((r) => [r.id, r])) : null };
          }
          return {
            history: await call(commands.vcsBlockHistorySummary(request, data.path, data.text, data.lines)),
            legacy: null,
          };
        },
        ({ history, legacy }) => {
          setActive(0);
          setResult({ data, history, legacy });
        },
        (error) => setFailure({ data, error }),
      ),
    [data],
  );

  const rows = useMemo(
    () => (history ? historyRows(history, blockOf(data.text, data.lines)) : NO_ROWS),
    [history, data],
  );
  const current = rows[Math.min(active, rows.length - 1)];
  const [diffs, setDiffs] = useState<{ history: BlockHistorySummary; revisions: Map<string, BlockRevision> } | null>(
    null,
  );
  const [diffError, setDiffError] = useState<{ history: BlockHistorySummary; row: HistoryRow; message: string } | null>(
    null,
  );
  const id = current?.kind === "revision" ? current.revision.id : null;
  const revision =
    id == null
      ? undefined
      : (history?.diffs.find((diff) => diff.id === id) ??
        result?.legacy?.get(id) ??
        (diffs?.history === history ? diffs?.revisions.get(id) : undefined));

  useEffect(() => {
    if (!history?.anchor || current?.kind !== "revision" || revision) return;
    const { anchor } = history;
    const index = current.index;
    const commits = history.revisions.slice(index, index + DIFF_BATCH).map((row) => row.id);
    return historyRequest(
      (request) => call(commands.vcsBlockHistoryRevisions(request, data.path, anchor, index, commits)),
      (batch) => {
        setDiffError(null);
        setDiffs((previous) => {
          const revisions = new Map(previous?.history === history ? previous.revisions : []);
          for (const diff of batch) revisions.set(diff.id, diff);
          while (revisions.size > DIFF_CACHE_SIZE) revisions.delete(revisions.keys().next().value!);
          return { history, revisions };
        });
      },
      (message) => setDiffError({ history, row: current, message }),
    );
  }, [history, current, revision, data.path]);

  const [from, to] = data.lines;

  let detail;
  if (!current)
    detail = (
      <div className={layout.message}>
        <T>Select a revision</T>
      </div>
    );
  else {
    const texts = sides(current, revision);
    if (texts) {
      const [left, right] = texts;
      detail = (
        <DiffEditor
          key={current.kind === "local" ? "local" : current.revision.id}
          input={diffInput({ path: data.path, left, right })}
        />
      );
    } else {
      detail = (
        <div className={layout.message}>
          {diffError?.history === history && diffError.row === current ? diffError.message : <Spinner size={14} />}
        </div>
      );
    }
  }

  return (
    <div className={layout.root}>
      <div className={layout.sidebar}>
        <div className={layout.header}>
          <span className={layout.title}>
            <T>History for Selection</T>
          </span>
          <span className={styles.range}>{`${baseName(data.path)}:${from + 1}-${to + 1}`}</span>
        </div>
        {error ? (
          <div className={layout.message}>{error}</div>
        ) : !history ? (
          <div className={layout.message}>
            <Spinner size={14} />
          </div>
        ) : (
          <List
            items={rows}
            getKey={(row) => (row.kind === "local" ? "local" : row.revision.id)}
            activeIndex={Math.min(active, rows.length - 1)}
            onActiveChange={setActive}
            onActivate={(_row, i) => setActive(i)}
            rowHeight={38}
            aria-label="Revisions"
            className={layout.list}
            empty={
              <span className={layout.message}>
                {history.anchor || result?.legacy
                  ? tx`No commits changed these lines`
                  : tx`These lines are not committed yet`}
              </span>
            }
            renderItem={(row) =>
              row.kind === "local" ? (
                <span className={layout.entry}>
                  <span className={styles.summary}>
                    <T>Local Changes</T>
                  </span>
                  <span className={styles.meta}>
                    <T>Not Committed Yet</T>
                  </span>
                </span>
              ) : (
                <span className={layout.entry}>
                  <span className={styles.summary}>{row.revision.summary}</span>
                  <span className={styles.meta}>
                    {`${row.revision.shortId} · ${row.revision.author} · ${formatTime(row.revision.timeMs)}`}
                  </span>
                </span>
              )
            }
          />
        )}
      </div>
      <div className={layout.diff}>{detail}</div>
    </div>
  );
}
