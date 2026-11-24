/**
 * The fork's Interactively Rebase from Here dialog, as before the rebase onto v0.1.51: rows are
 * virtualized (thousands of commits stay responsive) and the plan keeps the fork's autosquash
 * order. Upstream's RebasePlanDialog replaced it in l0ng-ai/openidea#5174; `forkRebaseDialog`
 * chooses between them.
 */
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import type { RebaseAction } from "@/bindings";
import { Dialog, IconButton, Select, SplitGroup, SplitHandle, SplitPanel, T } from "@/ui";
import { initialRows, planIsNoop, planProblem, type RebaseRange, type RebaseRow } from "./rebasePlan";
import styles from "./common.module.css";
import { tx } from "@/platform/i18n";

const short = (id: string) => id.slice(0, 8);

/** `rows` with the row at `index` moved one place up (-1) or down (1). */
function moveRow(rows: readonly RebaseRow[], index: number, delta: -1 | 1): RebaseRow[] {
  const to = index + delta;
  if (index < 0 || index >= rows.length || to < 0 || to >= rows.length) return [...rows];
  const out = [...rows];
  [out[index], out[to]] = [out[to]!, out[index]!];
  return out;
}

const ACTIONS: Array<{ value: RebaseAction; label: string }> = [
  { value: "pick", label: "Pick" },
  { value: "reword", label: "Reword" },
  { value: "edit", label: "Stop to Edit" },
  { value: "squash", label: "Squash" },
  { value: "fixup", label: "Fixup" },
  { value: "drop", label: "Drop" },
];

// Rows show the subject over the short hash (49 px in Chromium); measureElement corrects the estimate after mount.
const REBASE_ROW_HEIGHT = 49;
const REBASE_OVERSCAN = 6;
const REBASE_INITIAL_RECT = { width: 470, height: 420 };
const estimateRebaseRow = () => REBASE_ROW_HEIGHT;

function rowIndexIn(list: HTMLDivElement | null, el: Element | null, count: number): number {
  const row = el && list?.contains(el) ? el.closest<HTMLElement>("[data-index]") : null;
  if (!row) return -1;
  const idx = Number(row.dataset.index);
  return Number.isInteger(idx) && idx >= 0 && idx < count ? idx : -1;
}

const RebaseRowItem = memo(function RebaseRowItem({
  row,
  index,
  total,
  start,
  selected,
  measureRef,
  onSelect,
  onAction,
  onRowFocus,
  onRowBlur,
}: {
  row: RebaseRow;
  index: number;
  total: number;
  start: number;
  selected: boolean;
  measureRef: (node: HTMLDivElement | null) => void;
  onSelect: (commitId: string) => void;
  onAction: (index: number, commitId: string, action: RebaseAction) => void;
  onRowFocus: (commitId: string, index: number) => void;
  onRowBlur: (commitId: string) => void;
}) {
  return (
    <div
      ref={measureRef}
      data-index={index}
      className={styles.rebaseRow}
      role="listitem"
      aria-posinset={index + 1}
      aria-setsize={total}
      data-selected={selected || undefined}
      style={{ transform: `translateY(${start}px)` }}
      onFocus={() => onRowFocus(row.commit.id, index)}
      onBlur={(e) => {
        // Tab into a neighbor row blurs this one first; the neighbor's focus moves the pin. Clearing it here would
        // re-render with focus on body and unmount the row the browser is about to focus.
        if (!e.currentTarget.parentElement?.contains(e.relatedTarget)) onRowBlur(row.commit.id);
      }}
    >
      <button
        type="button"
        className={styles.rebaseCommit}
        aria-current={selected || undefined}
        onClick={() => onSelect(row.commit.id)}
        title={row.commit.summary}
      >
        <span className={styles.rebaseSubject} data-dropped={row.action === "drop" || undefined}>
          {row.commit.summary}
        </span>
        <span className={styles.commitHash}>{row.commit.shortId}</span>
      </button>
      <Select<RebaseAction>
        value={row.action}
        options={ACTIONS}
        aria-label={tx`Action for ${short(row.commit.id)}`}
        className={styles.rebaseAction}
        onChange={(action) => onAction(index, row.commit.id, action)}
      />
    </div>
  );
});

export function ForkInteractiveRebaseDialog({
  range,
  onClose,
  onStart,
}: {
  range: RebaseRange & { repo: string | null };
  onClose: () => void;
  /** Runs the plan; the dialog closes with it. */
  onStart: (rows: RebaseRow[]) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<RebaseRow[]>(() => initialRows(range.commits));
  const [selectedId, setSelectedId] = useState(() => rows[0]?.commit.id);
  const pageRef = useRef<HTMLDivElement>(null);
  const [stacked, setStacked] = useState(false);
  useLayoutEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    const measure = () => setStacked(page.clientWidth < 640);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(page);
    return () => observer.disconnect();
  }, []);

  const rowCount = rows.length;
  const selectedIndex = rows.findIndex((r) => r.commit.id === selectedId);
  const selected = rows[selectedIndex];
  const problem = useMemo(() => planProblem(rows), [rows]);
  const noop = useMemo(() => planIsNoop(rows, range.commits), [rows, range.commits]);
  // The virtualizer rebuilds its whole measurement cache whenever getItemKey changes identity, so keep its
  // callbacks stable and replace getItemKey only when rows are reordered (the index -> key mapping changes).
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const [order, setOrder] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const getItemKey = useCallback((index: number) => rowsRef.current[index]!.commit.id, [order]);
  const getScrollElement = useCallback(() => listRef.current, []);
  const [activeCommitId, setActiveCommitId] = useState<string | null>(null);
  const onRowBlur = useCallback((id: string) => setActiveCommitId((prev) => (prev === id ? null : prev)), []);
  const pinnedIndex = useMemo(
    () => (activeCommitId ? rows.findIndex((r) => r.commit.id === activeCommitId) : -1),
    [activeCommitId, rows],
  );
  // Keep the row holding focus or an open Select popup mounted across scrolls so focus never drops to
  // document.body (where Enter submits the dialog) and active controls keep DOM/caret/IME state.
  const rangeExtractor = useCallback(
    (r: Range) => {
      const visible = defaultRangeExtractor(r);
      const start = visible[0];
      const end = visible[visible.length - 1];
      const list = listRef.current;
      // A Select popup that unmounts while focused fires no blur, so trust the pin only while focus is in the list.
      const focusInList = !!list?.contains(document.activeElement);
      const focusIdx = focusInList && pinnedIndex >= 0 && pinnedIndex < r.count ? pinnedIndex : -1;
      const activeIdx = rowIndexIn(list, document.activeElement, r.count);
      // Native Tab/Shift+Tab walk the DOM, so the rows next to the focused one stay mounted to be its neighbors
      // instead of the far-away rendered window; focus() then scrolls the new row into view.
      const candidates = [
        focusIdx,
        activeIdx,
        ...[focusIdx, activeIdx].flatMap((i) => (i < 0 ? [] : [i - 1, i + 1])).filter((i) => i >= 0 && i < r.count),
        rowIndexIn(list, list?.querySelector('[aria-expanded="true"]') ?? null, r.count),
      ];
      let merged: number[] | null = null;
      for (const idx of candidates) {
        if (idx < 0) continue;
        if (start !== undefined && end !== undefined && idx >= start && idx <= end) continue;
        if (!merged) merged = [...visible];
        if (!merged.includes(idx)) merged.push(idx);
      }
      return merged ? merged.sort((a, b) => a - b) : visible;
    },
    [pinnedIndex],
  );
  // Rows sit below the scroller's top padding, which the virtualizer's offsets leave out, so an end-aligned row
  // needs that much end padding to land with its bottom inside the viewport.
  const padTopRef = useRef(0);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement,
    getItemKey,
    estimateSize: estimateRebaseRow,
    rangeExtractor,
    overscan: REBASE_OVERSCAN,
    initialRect: REBASE_INITIAL_RECT,
    scrollPaddingEnd: padTopRef.current,
  });
  const scrollRowIntoView = useCallback(
    (index: number) => {
      const list = listRef.current;
      const pad = (list && Number.parseFloat(getComputedStyle(list).paddingTop)) || 0;
      padTopRef.current = pad;
      virtualizer.options.scrollPaddingEnd = pad;
      virtualizer.scrollToIndex(index, { align: "auto" });
    },
    [virtualizer],
  );
  // Tab after a wheel scroll focuses a row outside the viewport; bring it into view instead of relying on the
  // engine to scroll a transform-positioned row.
  const onRowFocus = useCallback(
    (id: string, index: number) => {
      setActiveCommitId(id);
      const visible = virtualizer.range;
      if (visible && (index < visible.startIndex || index > visible.endIndex)) scrollRowIntoView(index);
    },
    [virtualizer, scrollRowIntoView],
  );
  const update = useCallback(
    (i: number, patch: Partial<RebaseRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r))),
    [],
  );
  const onSelect = useCallback((id: string) => setSelectedId(id), []);
  const onAction = useCallback(
    (i: number, id: string, action: RebaseAction) => {
      setSelectedId(id);
      update(i, { action });
    },
    [update],
  );
  const move = (delta: -1 | 1) => {
    const to = selectedIndex + delta;
    if (selectedIndex < 0 || to < 0 || to >= rowCount) return;
    setRows((rs) => moveRow(rs, selectedIndex, delta));
    setOrder((n) => n + 1);
    scrollRowIntoView(to);
  };
  const start = () => {
    if (problem || noop) return;
    onStart(rows);
  };
  return (
    <Dialog
      open
      title={rebaseTitle(range.commits.length, range.base && short(range.base))}
      onClose={onClose}
      width={960}
      minWidth={360}
      minHeight={360}
      resizable="both"
      className={styles.rebaseDialog}
      buttons={[
        { label: "Start Rebasing", role: "default", disabled: !!problem || noop, onClick: start },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.rebasePage} ref={pageRef}>
        <SplitGroup id="rebase-panes" className={styles.rebaseSplit} orientation={stacked ? "vertical" : "horizontal"}>
          <SplitPanel id="rebase-plan" defaultSize="50%" minSize="30%">
            <div className={styles.rebaseToolbar}>
              <IconButton
                icon="arrow-up"
                size="small"
                title="Move Up"
                disabled={selectedIndex <= 0}
                onClick={() => move(-1)}
              />
              <IconButton
                icon="arrow-down"
                size="small"
                title="Move Down"
                disabled={selectedIndex < 0 || selectedIndex === rowCount - 1}
                onClick={() => move(1)}
              />
              <span className={styles.hint}>
                <T>Commits are applied from top to bottom.</T>
              </span>
            </div>
            <div ref={listRef} className={styles.rebaseList} role="list" aria-label={tx("Commits to rebase")}>
              <div
                className={styles.rebaseListInner}
                role="presentation"
                style={{ height: virtualizer.getTotalSize() }}
              >
                {virtualizer.getVirtualItems().map((v) => {
                  const r = rows[v.index]!;
                  return (
                    <RebaseRowItem
                      key={r.commit.id}
                      row={r}
                      index={v.index}
                      total={rowCount}
                      start={v.start}
                      selected={r.commit.id === selectedId}
                      measureRef={virtualizer.measureElement}
                      onSelect={onSelect}
                      onAction={onAction}
                      onRowFocus={onRowFocus}
                      onRowBlur={onRowBlur}
                    />
                  );
                })}
              </div>
            </div>
          </SplitPanel>
          <SplitHandle aria-label={tx("Resize rebase panes")} />
          <SplitPanel id="rebase-details" defaultSize="50%" minSize="30%">
            {selected && (
              <section className={styles.rebaseDetails} aria-label={tx("Commit details")}>
                <div className={styles.rebaseMetadata}>
                  <span className={styles.commitHash}>{selected.commit.shortId}</span>
                  <span>{selected.commit.author}</span>
                </div>
                {selected.action === "reword" ? (
                  <textarea
                    key={selected.commit.id}
                    className={`${styles.textarea} ${styles.rebaseMessage}`}
                    aria-label={tx`New message for ${short(selected.commit.id)}`}
                    rows={5}
                    value={selected.message}
                    onChange={(e) => update(selectedIndex, { message: e.target.value })}
                  />
                ) : (
                  <div className={styles.rebasePreview}>
                    {selected.commit.message.trimEnd() || selected.commit.summary}
                  </div>
                )}
              </section>
            )}
          </SplitPanel>
        </SplitGroup>
        {problem && (
          <div className={styles.error} role="alert">
            {tx(problem)}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function rebaseTitle(n: number, onto: string | null): string {
  if (onto) return n === 1 ? tx`Rebasing ${n} commit onto ${onto}` : tx`Rebasing ${n} commits onto ${onto}`;
  return n === 1 ? tx`Rebasing ${n} commit from the root` : tx`Rebasing ${n} commits from the root`;
}
