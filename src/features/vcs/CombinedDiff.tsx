/**
 * The all-in-one diff tab (`combined-diff`): one block per file of a change, each a diff
 * as tall as its content under a sticky header, in one scrolling view. Only the blocks near
 * the viewport are mounted, so a change of thousands of files costs what a screenful does;
 * a header collapses its block or opens the file's own diff tab.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { defaultRangeExtractor, useVirtualizer, type Range, type Virtualizer } from "@tanstack/react-virtual";
import clsx from "clsx";
import { editorsFor } from "@/editor/api";
import { tx } from "@/platform/i18n";
import { relativeDir, useProject } from "@/platform/project";
import { Icon, IconButton, T, fileIconName } from "@/ui";
import { editorService, maybeEditorService, type EditorInput } from "@/workbench/contributions";
import { setAllInOneDiff, type CombinedDiffData } from "./allInOneDiff";
import { DiffEditor } from "./DiffEditor";
import { diffInput, diffKey, openDiff, sideFile, withChain, type DiffData } from "./diffInput";
import { loadDiffOptions, saveDiffOptions } from "./diffOptions";
import { KIND_COLOR, KIND_LABEL, baseName, fileCount } from "./model";
import styles from "./CombinedDiff.module.css";

type Kind = "added" | "deleted" | "modified";

/** What happened to the file: one side absent means added or deleted. */
export function blockKind(item: DiffData): Kind {
  const absent = (s: DiffData["left"]) => s.type === "text" && !!s.absent;
  return absent(item.left) ? "added" : absent(item.right) ? "deleted" : "modified";
}

/** Height of a block not measured yet: its header and a short diff. */
const ESTIMATE = 200;
/** Blocks mounted past each edge of the viewport. */
const OVERSCAN = 2;
/** Longest a block coming back into view keeps its last height while its diff reloads. */
const HOLD_MS = 1000;
/** Scroll speed (px per ms) from which blocks coming into view wait for the scrolling to settle. */
const FAST_PX_PER_MS = 4;
/** How long after the last fast scroll the waiting blocks start mounting their diffs. */
const SETTLE_MS = 100;
/** Scroll events closer than this to the last one measured count towards the next measurement. */
const MIN_SAMPLE_MS = 4;
/**
 * Frames drawn without a scroll event since the last one, from which the view sat still. A page
 * blocked by a long task draws none, however long it takes, while the scrolling goes on through it.
 */
const IDLE_FRAMES = 2;
/**
 * How long the first movement after the view sat still took: the browser reports scrolling once a
 * frame, so it (a scrollbar track click, a fling's first frame) took about a frame or two, not the
 * whole wait. One wheel notch (~120 px) stays below `FAST_PX_PER_MS`.
 */
const IDLE_SAMPLE_MS = 33;

/**
 * Paces the mounting of the blocks' diff editors. Building one (a CodeMirror merge view, laid
 * out at once) takes a good part of a frame, so a block that comes into view while the view
 * scrolls fast (a fling, a dragged scrollbar) shows its header over a placeholder of its height
 * and waits; once the scrolling settles, the waiting blocks mount one a frame, those in view first.
 */
class MountGate {
  /** Where the view was at `at`: the next scroll's speed is measured from there. */
  private top = 0;
  private at = 0;
  /** Frames drawn since the last scroll event, up to `IDLE_FRAMES`. */
  private stillFrames = IDLE_FRAMES;
  private fastUntil = 0;
  private frame = 0;
  private stillFrame = 0;
  private readonly waiting = new Set<{ index: number; grant: () => void }>();

  /** `inView`: the first and last index of the blocks in view. */
  constructor(private readonly inView: () => readonly [number, number]) {}

  /** Whether a block coming into view now waits to mount its diff. */
  deferring(): boolean {
    return performance.now() < this.fastUntil;
  }

  /** The view is at `top` without having scrolled there (it just opened). */
  seen(top: number) {
    this.top = top;
    this.at = performance.now();
    this.stillFrames = IDLE_FRAMES;
  }

  /** The user scrolled the view to `top`. */
  scrolled(top: number) {
    const now = performance.now();
    const elapsed = now - this.at;
    if (elapsed < MIN_SAMPLE_MS) return;
    // Scrolling on (long frames included), the view moved for the whole time since the last event.
    const span = this.stillFrames >= IDLE_FRAMES ? Math.min(elapsed, IDLE_SAMPLE_MS) : elapsed;
    if (Math.abs(top - this.top) / span > FAST_PX_PER_MS) this.fastUntil = now + SETTLE_MS;
    this.top = top;
    this.at = now;
    this.stillFrames = 0;
    if (!this.stillFrame) this.stillFrame = requestAnimationFrame(this.countStill);
  }

  /** The view moved itself by `by` px (to keep its content in place as a block above resized, to a file). */
  shifted(by: number) {
    // Not the user's movement: the speed keeps being measured from the same content.
    this.top += by;
  }

  /** The view is about to go to a file from `top` (Next File, reveal); its writes follow as `shifted`. */
  jumped(top: number) {
    this.seen(top);
    // Going to a file ends a fling: the blocks there mount right away.
    this.fastUntil = 0;
    this.schedule();
  }

  /** Calls `grant` on a later frame, once the scrolling has settled, unless the returned function cancels it first. */
  request(index: number, grant: () => void): () => void {
    const entry = { index, grant };
    this.waiting.add(entry);
    this.schedule();
    return () => this.waiting.delete(entry);
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.stillFrame);
    this.frame = this.stillFrame = 0;
  }

  /** Counts the frames drawn since the last scroll event (a frame's scroll events come before its frame callbacks). */
  private readonly countStill = (frameStart: number) => {
    this.stillFrame = 0;
    if (frameStart > this.at) this.stillFrames++;
    if (this.stillFrames < IDLE_FRAMES) this.stillFrame = requestAnimationFrame(this.countStill);
  };

  private schedule() {
    if (!this.frame && this.waiting.size) this.frame = requestAnimationFrame(this.tick);
  }

  private readonly tick = () => {
    this.frame = 0;
    if (!this.deferring()) {
      // The blocks in view from the top down, then the others nearest first.
      const [first, last] = this.inView();
      let next: { index: number; grant: () => void } | undefined;
      let best = Infinity;
      for (const entry of this.waiting) {
        const { index } = entry;
        const rank =
          index >= first && index <= last
            ? index - first
            : 1 + last - first + Math.min(Math.abs(index - first), Math.abs(index - last));
        if (rank < best) {
          best = rank;
          next = entry;
        }
      }
      if (next) {
        this.waiting.delete(next);
        next.grant();
      }
    }
    this.schedule();
  };
}

/** Whether a file of `item` has unsaved changes in a document open in a view (its diff panes, an editor). */
function hasUnsavedEdits(item: DiffData, dirtyDocs: ReadonlySet<number>): boolean {
  if (!dirtyDocs.size) return false;
  return [sideFile(item.left, item.path), sideFile(item.right, item.path)].some(
    (file) => !!file && editorsFor(file).some((e) => dirtyDocs.has(e.ctx.doc)),
  );
}

const Block = memo(function Block({
  item,
  itemKey,
  index,
  items,
  collapsed,
  onToggle,
  mode,
  heights,
  gate,
}: {
  item: DiffData;
  itemKey: string;
  index: number;
  items: readonly DiffData[];
  collapsed: boolean;
  onToggle: (key: string) => void;
  mode: "split" | "unified";
  /** Last height of each block's diff, by layout and diff entry, kept while blocks are unmounted. */
  heights: Map<string, number>;
  gate: MountGate;
}) {
  // A block mounted collapsed loads its diff once expanded.
  const [loaded, setLoaded] = useState(!collapsed);
  if (!collapsed && !loaded) setLoaded(true);
  // Whether its diff editor may mount: a block coming into view during a fast scroll waits for
  // the gate. Once mounted, the editor stays for as long as the block does.
  const [live, setLive] = useState(() => !gate.deferring());
  const waiting = loaded && !collapsed && !live;
  useEffect(() => (waiting ? gate.request(index, () => setLive(true)) : undefined), [waiting, gate, index]);
  const input: EditorInput = useMemo(() => diffInput({ ...item, mode }), [item, mode]);
  const kind = blockKind(item);
  const name = baseName(item.path);
  const root = useProject((s) => s.project?.root ?? "");
  const dir = relativeDir(root, item.path);

  // Back in view, the diff reloads: until it is as tall as before (or for `HOLD_MS`), the block
  // keeps its last height, so the blocks around it don't jump while the view scrolls.
  const bodyRef = useRef<HTMLDivElement>(null);
  const heightKey = `${mode}:${itemKey}`;
  const [hold, setHold] = useState(() => heights.get(heightKey) ?? 0);
  useEffect(() => {
    const content = bodyRef.current?.firstElementChild;
    if (!(content instanceof HTMLElement)) return;
    const timer = hold ? setTimeout(() => setHold(0), HOLD_MS) : undefined;
    const observer = new ResizeObserver(() => {
      const height = content.offsetHeight;
      // Collapsed (hidden), or still loading after coming back.
      if (!height || height < hold) return;
      if (hold) setHold(0);
      else heights.set(heightKey, height);
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [loaded, live, hold, heightKey, heights]);

  return (
    <section
      className={styles.block}
      data-combined-block={item.path}
      aria-label={name}
      // Waiting, a block never shown is as tall as the virtualizer estimates it (else its last height, below).
      style={waiting && !hold ? { minHeight: ESTIMATE } : undefined}
    >
      <div className={styles.header}>
        <IconButton
          icon={collapsed ? "chevron-right" : "chevron-down"}
          title={collapsed ? "Expand File" : "Collapse File"}
          size="small"
          aria-expanded={!collapsed}
          onClick={() => {
            // Expanding shows the diff at once, whatever the gate.
            if (collapsed) setLive(true);
            onToggle(itemKey);
          }}
        />
        <Icon name={fileIconName(name)} size={16} />
        <span className={styles.name} style={{ color: KIND_COLOR[kind] }} title={tx(KIND_LABEL[kind])}>
          {name}
        </span>
        {dir && (
          <span className={styles.dir} title={item.path}>
            {dir}
          </span>
        )}
        <span className={styles.grow} />
        <IconButton
          icon="diff"
          title="Open in Separate Tab"
          size="small"
          // The file's own diff, still knowing its siblings for Compare Next File.
          onClick={() => void editorService().openInput(diffInput(withChain(items, index)), { focus: true })}
        />
        {item.right.type === "worktree" && (
          <IconButton
            icon="edit"
            title="Jump to Source"
            size="small"
            onClick={() => void editorService().openFile(item.path, { focus: true })}
          />
        )}
      </div>
      {/* A collapsed block keeps its loaded diff, hidden: unmounting it would release the
          working-tree document and, with autosave off, drop its unsaved edits. */}
      {loaded && (
        <div ref={bodyRef} className={styles.body} hidden={collapsed} style={hold ? { minHeight: hold } : undefined}>
          {live && <DiffEditor input={input} fit />}
        </div>
      )}
    </section>
  );
});

export function CombinedDiffTab({ input }: { input: EditorInput }) {
  const data = input.data as CombinedDiffData;
  const items = data.items;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [mode, setMode] = useState(() => loadDiffOptions().mode);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [heights] = useState(() => new Map<string, number>());
  /** Blocks mounted as of the last commit. */
  const mountedRef = useRef<readonly number[]>([]);

  // Only the blocks around the viewport stay mounted. Blocks scrolled away are unmounted except
  // those with unsaved edits or holding the keyboard focus: unmounting a dirty block would
  // release its working-tree document (triggering an unexpected autosave or, with autosave off,
  // detaching the editor and dropping its undo history and unsaved view state), which is why
  // blocks were previously kept mounted once loaded.
  const pinnedIndexes = useCallback(
    (already: ReadonlySet<number>) => {
      const scroller = scrollRef.current;
      const active = document.activeElement;
      const focused =
        scroller && active && scroller.contains(active)
          ? Number(active.closest("[data-combined-block]")?.parentElement?.dataset.index ?? -1)
          : -1;
      const dirtyDocs = new Set(maybeEditorService()?.dirtyDocumentIds?.() ?? []);
      return mountedRef.current.filter(
        (i) => !already.has(i) && !!items[i] && (i === focused || hasUnsavedEdits(items[i], dirtyDocs)),
      );
    },
    [items],
  );
  const rangeExtractor = useCallback(
    (range: Range) => {
      const shown = defaultRangeExtractor(range);
      const kept = pinnedIndexes(new Set(shown));
      return kept.length ? [...shown, ...kept].sort((a, b) => a - b) : shown;
    },
    [pinnedIndexes],
  );
  const virtualizerRef = useRef<Virtualizer<HTMLDivElement, Element> | null>(null);
  const [gate] = useState(
    () =>
      new MountGate(() => {
        const v = virtualizerRef.current;
        const top = v?.scrollOffset ?? 0;
        const first = v?.getVirtualItemForOffset(top)?.index ?? 0;
        return [first, v?.getVirtualItemForOffset(top + (v.scrollRect?.height ?? 0))?.index ?? first];
      }),
  );
  // Before the virtualizer's own scroll listener (capture runs first on the target), so the
  // blocks its re-render brings into view see this scroll's speed.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => gate.scrolled(el.scrollTop);
    gate.seen(el.scrollTop);
    el.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll, { capture: true });
      gate.dispose();
    };
  }, [gate]);
  const scrollToFn = useCallback(
    (
      offset: number,
      options: { adjustments?: number; behavior?: ScrollBehavior },
      instance: { scrollElement: HTMLDivElement | null },
    ) => {
      const el = instance.scrollElement;
      if (!el) return;
      // ResizeObserver can run after a scrollTop write (e.g. inside rAF) and before the
      // browser dispatches its scroll event; `offset` is then stale, so apply size
      // adjustments relative to the live scrollTop instead of reverting pending movement.
      const base = options.adjustments ? el.scrollTop : offset;
      const top = base + (options.adjustments ?? 0);
      // Before the scroll event this write may dispatch, so the event isn't taken for the user's.
      // A write is never the user's: a size adjustment, its retry once the content has grown
      // enough to take it, or a move to a file `scrollToIndex` already told the gate about.
      gate.shifted(top - el.scrollTop);
      el.scrollTo({ top, behavior: options.behavior });
      // The browser clamps at either end: measure from where the view actually is.
      if (options.behavior !== "smooth") gate.shifted(el.scrollTop - top);
    },
    [gate],
  );
  // Built once per list: a block changing height has the virtualizer key every block after it,
  // and every toggle checks whether all files are collapsed.
  const keys = useMemo(() => items.map(diffKey), [items]);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: useCallback((i: number) => keys[i]!, [keys]),
    estimateSize: useCallback(() => ESTIMATE, []),
    overscan: OVERSCAN,
    rangeExtractor,
    scrollToFn,
  });
  virtualizerRef.current = virtualizer;

  /** Index of the block at the top of the view. */
  const current = () =>
    virtualizer.getVirtualItemForOffset((scrollRef.current?.scrollTop ?? 0) + 1)?.index ?? items.length - 1;
  const scrollToIndex = (index: number) => {
    if (index < 0 || index >= items.length) return;
    gate.jumped(scrollRef.current?.scrollTop ?? 0);
    virtualizer.scrollToIndex(index, { align: "start" });
  };
  const step = (dir: 1 | -1) => scrollToIndex(current() + dir);

  const virtualItems = virtualizer.getVirtualItems();
  // When the scroller collapses to height 0 (e.g. a maximized tool window sets `hidden`),
  // virtual-core's `calculateRange()` returns null and `getVirtualItems()` returns [] without
  // calling `rangeExtractor`. Keep pinned (dirty or focused) blocks mounted alongside the
  // virtual items so a zero-height viewport never unmounts an editor or drops unsaved edits.
  const pinned = pinnedIndexes(new Set(virtualItems.map((row) => row.index)));
  const rows = pinned.length
    ? [
        ...virtualItems,
        ...pinned.map((index) => virtualizer.measurementsCache[index] ?? { index, start: index * ESTIMATE }),
      ].sort((a, b) => a.index - b.index)
    : virtualItems;
  useLayoutEffect(() => {
    mountedRef.current = rows.map((row) => row.index);
  });

  // Open at the file the diff was asked for.
  useLayoutEffect(() => {
    const byKey = data.revealKey ? keys.indexOf(data.revealKey) : -1;
    const at = byKey >= 0 ? byKey : data.reveal ? items.findIndex((i) => i.path === data.reveal) : -1;
    if (at >= 0) scrollToIndex(at);
    // Once per tab: later revisits keep their scroll position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setViewer = (next: "split" | "unified") => {
    setMode(next);
    saveDiffOptions({ ...loadDiffOptions(), mode: next });
  };
  const toggle = useCallback(
    (key: string) =>
      setCollapsed((c) => {
        const s = new Set(c);
        if (s.has(key)) s.delete(key);
        else s.add(key);
        return s;
      }),
    [],
  );
  // All files can only be collapsed once as many keys are collapsed as there are files.
  const distinct = useMemo(() => new Set(keys).size, [keys]);
  const allCollapsed = useMemo(
    () => distinct > 0 && collapsed.size >= distinct && keys.every((k) => collapsed.has(k)),
    [keys, distinct, collapsed],
  );

  return (
    <div className={styles.root}>
      <div className={styles.toolbar} role="toolbar" aria-label={tx("Combined Changes Diff")}>
        <IconButton icon="arrow-up" title="Previous File" size="small" onClick={() => step(-1)} />
        <IconButton icon="arrow-down" title="Next File" size="small" onClick={() => step(1)} />
        <IconButton
          icon={allCollapsed ? "expand-all" : "collapse-all"}
          title={allCollapsed ? "Expand All Files" : "Collapse All Files"}
          size="small"
          onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(keys))}
        />
        <span className={styles.sep} />
        <IconButton
          icon="diff-side-by-side"
          title="Side-by-side Viewer"
          size="small"
          pressed={mode === "split"}
          onClick={() => setViewer("split")}
        />
        <IconButton
          icon="diff-unified"
          title="Unified Viewer"
          size="small"
          pressed={mode === "unified"}
          onClick={() => setViewer("unified")}
        />
        <span className={styles.count}>{fileCount(items.length)}</span>
        <span className={styles.grow} />
        <IconButton
          icon="editor-only"
          title="Show Files in Separate Diff Tabs"
          size="small"
          onClick={() => {
            // Back to one diff per file, at the file in view.
            setAllInOneDiff(false);
            const at = Math.max(0, current());
            void openDiff(withChain(items, at)).then(() => editorService().closeInput?.(input.key));
          }}
        />
      </div>
      <div ref={scrollRef} className={styles.scroll} data-combined-scroll>
        {items.length ? (
          <div className={styles.blocks} style={{ height: virtualizer.getTotalSize() }}>
            {rows.map((row) => {
              const item = items[row.index]!;
              const itemKey = keys[row.index]!;
              return (
                <div
                  // Keyed by diff identity (not layout mode): switching the layout keeps each block's diff and its documents.
                  key={itemKey}
                  ref={virtualizer.measureElement}
                  data-index={row.index}
                  className={styles.slot}
                  // `top`, not a transform: a sticky header inside a transformed box sticks off by the transform.
                  style={{ top: row.start }}
                >
                  <Block
                    item={item}
                    itemKey={itemKey}
                    index={row.index}
                    items={items}
                    collapsed={collapsed.has(itemKey)}
                    onToggle={toggle}
                    mode={mode}
                    heights={heights}
                    gate={gate}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          <div className={clsx(styles.placeholder, styles.empty)}>
            <T>No changes</T>
          </div>
        )}
      </div>
    </div>
  );
}
