/**
 * Virtualized tree with lazy children, multi-selection, IDEA keyboard model
 * (↑↓←→, Enter / F4 / ⌘↓, Home/End, PageUp/PageDown, Shift-extend) and speed
 * search: typing while the tree is focused highlights matches and jumps to them
 * (↑/↓ cycle matches, Home/End first / last match, Esc clears; ←/→, Enter and
 * PageUp/PageDown close it and act as usual); `speedSearchMode="filter"` hides
 * rows that neither match nor contain a match.
 */
import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import clsx from "clsx";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Icon, type IconName } from "./icons";
import { HighlightedText } from "./HighlightedText";
import { Spinner } from "./Feedback";
import { IconButton } from "./Button";
import { fuzzyMatch } from "./match";
import { acquirePopup } from "./popupState";
import styles from "./Tree.module.css";
import { T } from "./T";
import { setContext } from "@/platform/context";
import { registerKeyClaim } from "@/platform/keymap";
import { useGivenTx } from "@/platform/i18n";
import { useTreeReorder, type TreeReorder } from "./treeReorder";
import { startPointerDrag, type DragData } from "./pointerDrag";
import { useTreeDirectoryContext } from "./treeDirectoryContext";
import { useIconRowHeight } from "./iconAppearance";

const DEFAULT_ROW_HEIGHT = 24;
export type { TreeReorder } from "./treeReorder";

export interface TreeRowState {
  depth: number;
  expanded: boolean;
  expandable: boolean;
  selected: boolean;
  /** Keyboard lead row. */
  lead: boolean;
  /** Speed search match indices into the label, if matching. */
  matches: number[] | null;
}

/** Where Next / Previous Occurrence landed: the selected node and its 1-based position among all occurrences. */
export interface TreeOccurrence {
  key: string;
  node: unknown;
  index: number;
  total: number;
}

/** A visible row of a `TreeModel`, with its place among its siblings (`aria-posinset` / `aria-setsize`). */
export interface TreeModelRow<T> {
  node: T;
  key: string;
  depth: number;
  parentKey: string | null;
  expandable: boolean;
  expanded: boolean;
  posInSet: number;
  setSize: number;
}

/**
 * The visible rows of a tree that the caller indexes itself, for results that stream in: `Tree`
 * reads the rows in view and the lead row instead of walking every node on each update.
 * Expansion is the model's: `setExpanded` is called instead of `onExpandedChange`.
 */
export interface TreeModel<T> {
  rowCount: number;
  rowAt(index: number): TreeModelRow<T> | undefined;
  indexOfKey(key: string): number;
  /** Every visible row in order; only used by speed search, Select All and dragging. */
  forEachRow(visit: (row: TreeModelRow<T>) => void): void;
  setExpanded(node: T, open: boolean): void;
  /** `findOccurrence` over the loaded nodes (collapsed ones included). */
  findOccurrence(
    lead: string | null,
    dir: 1 | -1,
    options: { skipSubtree?: boolean; isOccurrence?: (node: T) => boolean },
  ): { node: T; ancestors: T[]; index: number; total: number } | null;
}

export interface TreeHandle {
  focus(): void;
  /** Selects `key` (must be visible, i.e. ancestors expanded) and scrolls to it; false when no row has `key`. */
  reveal(key: string): boolean;
  clearSelection(): void;
  leadKey(): string | null;
  /** Selects the next (1) / previous (-1) row, for a filter field that keeps the focus (Settings search). */
  moveSelection(dir: 1 | -1): void;
  /**
   * Next / Previous Occurrence: selects the next (1) / previous (-1) node that
   * `isOccurrence` accepts (default: leaves) after the lead, in tree order over
   * the loaded nodes, expanding its collapsed ancestors. `null` when there is none.
   * `skipSubtree`: forward, ignore the lead's descendants (after excluding a group).
   */
  selectOccurrence(dir: 1 | -1, options?: { skipSubtree?: boolean }): TreeOccurrence | null;
}

export interface TreeProps<T> {
  roots?: readonly T[];
  /** Replaces `roots`, `expanded` and `onExpandedChange` with an index maintained by the caller. */
  model?: TreeModel<T>;
  getKey: (node: T) => string;
  getLabel: (node: T) => string;
  /** Loaded children; `undefined` for unloaded (or leaf) nodes. */
  getChildren: (node: T) => readonly T[] | undefined;
  isExpandable: (node: T) => boolean;
  /** Called when an expandable node with unloaded children is expanded. */
  loadChildren?: (node: T) => void | Promise<void>;
  /** Custom row content (after the chevron). Defaults to icon + highlighted label + `getDetail`. */
  renderNode?: (node: T, state: TreeRowState) => ReactNode;
  getIcon?: (node: T, expanded: boolean) => IconName | (string & {}) | undefined;
  /** Muted trailing detail (e.g. a path next to the project root); may include styled content. */
  getDetail?: (node: T) => ReactNode;
  /** Label colour, e.g. VCS status. */
  getColor?: (node: T) => string | undefined;
  /** Colour square between the icon and the label, e.g. a repository's colour. */
  getSwatch?: (node: T) => string | null | undefined;
  /** Filesystem directory for actions on the focused selection; groups return null. */
  getDirectory?: (node: T) => string | null | undefined;

  expanded?: ReadonlySet<string>;
  defaultExpanded?: Iterable<string>;
  onExpandedChange?: (expanded: Set<string>, node: T, isExpanded: boolean) => void;

  selected?: ReadonlySet<string>;
  defaultSelected?: Iterable<string>;
  onSelectionChange?: (selected: Set<string>, lead: T | null) => void;
  multiSelect?: boolean;

  /** Enter / double-click on a leaf (or on nodes `activateExpandable` accepts). */
  onActivate?: (node: T, e: KeyboardEvent | MouseEvent) => void;
  activateExpandable?: boolean | ((node: T) => boolean);
  /**
   * Jump to Source (F4 / ⌘↓) on the lead row. Without it the key activates like Enter; trees
   * whose activation opens a diff pass this to open the file itself.
   */
  onJumpToSource?: (node: T, selection: ReadonlySet<string>) => void;
  /** Nodes Next / Previous Occurrence stops at (`TreeHandle.selectOccurrence`); default: leaves. */
  isOccurrence?: (node: T) => boolean;
  onContextMenu?: (node: T | null, selection: Set<string>, e: MouseEvent) => void;

  speedSearch?: boolean;
  speedSearchMode?: "highlight" | "filter";
  /**
   * Speed search shows as a field over the bar right above the tree (a tool window's toolbar)
   * instead of a popup over its first rows, with a toggle to show only the matches.
   */
  speedSearchField?: boolean;
  rowHeight?: number;
  indent?: number;
  className?: string;
  rowClassName?: (node: T) => string | undefined;
  /** CSS colour the row background is tinted with (File Colors). */
  rowTint?: (node: T) => string | undefined;
  "aria-label"?: string;
  handleRef?: Ref<TreeHandle>;
  /** Context key set while the tree itself has keyboard focus. */
  focusContext?: string;
  empty?: ReactNode;
  /** Rows wider than the pane scroll horizontally instead of clipping. */
  horizontalScroll?: boolean;
  /** Optional display reordering between siblings; the caller owns the order. */
  reorder?: TreeReorder<T>;
  /** Rows can be dragged to other components: what dragging `nodes` (the pressed row, or the
   *  selection containing it) carries, or null when they can't be dragged. */
  getDragData?: (nodes: T[]) => DragData | null;
}

/** Remember intrinsic widths by identity, including rows outside the virtual window. */
function useContentWidth<T>(
  scroller: RefObject<HTMLDivElement | null>,
  rows: readonly Row<T>[],
  enabled: boolean,
): number {
  const [width, setWidth] = useState(0);
  const latestRows = useRef(rows);
  const schedule = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const element = scroller.current;
    if (!element) return;
    const cache = new Map<string, number>();
    const observed = new Set<HTMLElement>();
    let measuredRows: readonly Row<T>[] | null = null;
    let maximum = 0;
    let frame = 0;
    const measure = () => {
      frame = 0;
      // Hidden tool windows have no layout. Keep their estimates until shown;
      // the observer remains attached so showing the window resumes measurement.
      if (element.clientWidth === 0) return;
      const rows = latestRows.current;
      const mounted = [...element.querySelectorAll<HTMLElement>("[data-row]")];
      let recompute = false;
      if (measuredRows !== rows) {
        const keys = new Set(rows.map((row) => row.key));
        for (const [key, value] of cache) {
          if (!keys.has(key)) {
            cache.delete(key);
            if (value === maximum) recompute = true;
          }
        }
        measuredRows = rows;
      }
      // Measure max-content, not the viewport's min-width floor. Batch writes and
      // restore before paint so selection backgrounds still fill the viewport.
      const minimums = mounted.map((row) => row.style.minWidth);
      for (const row of mounted) row.style.minWidth = "0";
      const widths = mounted.map((row) => row.offsetWidth);
      mounted.forEach((row, index) => {
        row.style.minWidth = minimums[index]!;
        const key = rows[Number(row.dataset.row)]?.key;
        if (key === undefined) return;
        const value = widths[index]!;
        if (cache.get(key) === maximum && value < maximum) recompute = true;
        cache.set(key, value);
        maximum = Math.max(maximum, value);
      });
      // Ordinary scrolling only touches mounted rows. Scan cached widths only
      // when the previous maximum was removed or actually became narrower.
      if (recompute) {
        maximum = 0;
        for (const value of cache.values()) maximum = Math.max(maximum, value);
      }
      // Reconcile and measure together: never publish an intermediate shrink.
      setWidth(maximum);
      // Rows resize without a render when fonts or zoom change.
      const current = new Set(mounted);
      for (const row of observed) if (!current.has(row)) observer.unobserve(row);
      for (const row of mounted) if (!observed.has(row)) observer.observe(row);
      observed.clear();
      for (const row of mounted) observed.add(row);
    };
    // Measuring forces layout: coalesce renders and resizes into one pass per
    // frame instead of measuring inside every commit.
    const request = () => {
      frame ||= requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(request);
    observer.observe(element);
    schedule.current = request;
    request();
    return () => {
      schedule.current = null;
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [enabled, scroller]);
  // Rows or the virtual window may have changed; keep `rows` in step with the DOM.
  useLayoutEffect(() => {
    latestRows.current = rows;
    schedule.current?.();
  });
  // Offscreen widths are estimates after label/font/indent changes; mounting
  // measures them afresh, including decreases for the same key.
  return width;
}

interface Row<T> {
  node: T;
  key: string;
  depth: number;
  parent: number;
  parentKey: string | null;
  expandable: boolean;
  expanded: boolean;
  loading?: boolean;
}

const NO_ROOTS: readonly never[] = [];
const NO_ROWS: readonly Row<never>[] = [];

/** What the tree reads of a row, whether it flattened `roots` or got the row from a model. */
type VisibleRow<T> = Omit<Row<T>, "parent"> & Partial<Pick<TreeModelRow<T>, "posInSet" | "setSize">>;

function useControllableSet(value: ReadonlySet<string> | undefined, initial: Iterable<string> | undefined) {
  const [inner, setInner] = useState<ReadonlySet<string>>(() => new Set(initial ?? []));
  return [value ?? inner, setInner, value !== undefined] as const;
}

export function Tree<T>(props: TreeProps<T>) {
  const given = useGivenTx();
  const {
    roots = NO_ROOTS,
    model,
    getKey,
    getLabel,
    getChildren,
    isExpandable,
    loadChildren,
    renderNode,
    getIcon,
    getDetail,
    getColor,
    getSwatch,
    multiSelect = true,
    onActivate,
    onJumpToSource,
    activateExpandable = false,
    onContextMenu,
    speedSearch = true,
    speedSearchMode = "highlight",
    speedSearchField = false,
    rowHeight: fixedRowHeight,
    indent = 20,
    className,
    rowClassName,
    rowTint,
    handleRef,
    empty,
  } = props;

  const [expanded, setExpandedInner, expandedControlled] = useControllableSet(props.expanded, props.defaultExpanded);
  const [selected, setSelectedInner, selectedControlled] = useControllableSet(props.selected, props.defaultSelected);
  const [lead, setLead] = useState<string | null>(() => [...selected][0] ?? null);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [onlyMatches, setOnlyMatches] = useState(false);
  const filterMatches = speedSearchMode === "filter" || (speedSearchField && onlyMatches);
  const scrollRef = useRef<HTMLDivElement>(null);
  const baseId = useId();

  const allRows = useMemo((): readonly Row<T>[] => {
    if (model) return NO_ROWS;
    const rows: Row<T>[] = [];
    const walk = (nodes: readonly T[], depth: number, parent: number, parentKey: string | null) => {
      for (const node of nodes) {
        const key = getKey(node);
        const expandable = isExpandable(node);
        const isOpen = expandable && expanded.has(key);
        const index = rows.length;
        rows.push({ node, key, depth, parent, parentKey, expandable, expanded: isOpen });
        if (isOpen) {
          const children = getChildren(node);
          if (children) walk(children, depth + 1, index, key);
          else
            rows.push({
              node,
              key: `${key}\u0000loading`,
              depth: depth + 1,
              parent: index,
              parentKey: key,
              expandable: false,
              expanded: false,
              loading: true,
            });
        }
      }
    };
    walk(roots, 0, -1, null);
    return rows;
  }, [model, roots, expanded, getKey, isExpandable, getChildren]);

  const matchMap = useMemo(() => {
    const m = new Map<string, number[]>();
    if (!query) return m;
    const check = (r: VisibleRow<T>) => {
      if (r.loading) return;
      const hit = fuzzyMatch(getLabel(r.node), query);
      if (hit) m.set(r.key, hit);
    };
    if (model) model.forEachRow(check);
    else allRows.forEach(check);
    return m;
  }, [model, allRows, query, getLabel]);

  // The rows to show when they are not the model's own: speed search filtering, or `roots` flattened.
  const shown = useMemo((): readonly VisibleRow<T>[] | null => {
    if (!query || !filterMatches) return model ? null : allRows;
    if (model) {
      const kept: VisibleRow<T>[] = [];
      const keptKeys = new Set<string>();
      const ancestors: VisibleRow<T>[] = [];
      model.forEachRow((r) => {
        ancestors.length = r.depth + 1;
        ancestors[r.depth] = r;
        if (!matchMap.has(r.key)) return;
        for (const a of ancestors) {
          if (keptKeys.has(a.key)) continue;
          keptKeys.add(a.key);
          kept.push(a);
        }
      });
      return kept;
    }
    const keep = new Set<number>();
    allRows.forEach((r, i) => {
      if (!matchMap.has(r.key)) return;
      for (let j = i; j >= 0 && !keep.has(j); j = allRows[j]!.parent) keep.add(j);
    });
    return allRows.filter((_, i) => keep.has(i));
  }, [model, allRows, matchMap, query, filterMatches]);

  const rowCount = shown ? shown.length : model!.rowCount;
  const rowAt = useCallback(
    (i: number): VisibleRow<T> | undefined => (shown ? shown[i] : model!.rowAt(i)),
    [shown, model],
  );
  const emptyState = !rowCount && !!empty && !query;
  /** Every visible row, for what needs them all (Select All, dragging the selection). */
  const visibleRows = (): readonly VisibleRow<T>[] => {
    if (shown) return shown;
    const all: VisibleRow<T>[] = [];
    model!.forEachRow((r) => all.push(r));
    return all;
  };
  // `horizontalScroll` and `reorder` look at every row, so they materialise a model's rows.
  const effectRows = useMemo((): readonly Row<T>[] => {
    if (!props.horizontalScroll && !props.reorder) return NO_ROWS;
    if (shown) return shown as readonly Row<T>[];
    const all: Row<T>[] = [];
    model!.forEachRow((r) => all.push({ ...r, parent: -1 }));
    return all;
  }, [shown, model, props.horizontalScroll, props.reorder]);
  const contentWidth = useContentWidth(scrollRef, effectRows, !!props.horizontalScroll);
  const reordering = useTreeReorder(scrollRef, effectRows, emptyState ? undefined : props.reorder);
  // aria-posinset / aria-setsize among visible siblings (rows are virtualised); a model knows its own.
  const positions = useMemo(() => (shown ? siblingPositions(shown) : null), [shown]);
  const indexOfKey = useMemo(() => (shown ? new Map(shown.map((r, i) => [r.key, i])) : null), [shown]);
  const keyIndex = useCallback(
    (key: string) => (indexOfKey ? (indexOfKey.get(key) ?? -1) : model!.indexOfKey(key)),
    [indexOfKey, model],
  );
  const leadIndex = lead != null ? keyIndex(lead) : -1;

  const themedRowHeight = useIconRowHeight();
  const rowHeight = fixedRowHeight ?? themedRowHeight ?? DEFAULT_ROW_HEIGHT;
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
    // Rows have one height, so a model's index is a key as good as any (and costs no lookup per row).
    getItemKey: (i) => (shown ? shown[i]!.key : i),
  });
  useEffect(() => virtualizer.measure(), [virtualizer, rowHeight]);

  // Keep the keyboard lead in view when the lead changes — not when its index
  // shifts because expanding or collapsing elsewhere inserted rows above it:
  // following the index would yank the viewport from the folder the user just
  // opened back to the selection.
  const pendingScrollToLead = useRef<string | null>(null);
  useEffect(() => {
    pendingScrollToLead.current = lead;
  }, [lead]);
  // A preselected lead may arrive before its row is loaded. Retry until it
  // appears, then stop following index changes for that selection.
  useEffect(() => {
    const key = pendingScrollToLead.current;
    if (key == null) return;
    const i = keyIndex(key);
    if (i < 0) return;
    virtualizer.scrollToIndex(i, { align: "auto" });
    pendingScrollToLead.current = null;
  }, [lead, keyIndex, virtualizer]);

  // Speed search owns Escape while active, and ⌫ with any modifier: the query is edited like a
  // text field instead of the view's shortcuts running (⌘⌫ is Drop… in the Database view).
  useEffect(() => {
    if (!query) return;
    const release = acquirePopup();
    const unclaim = registerKeyClaim(
      (e) => e.key === "Backspace" && e.target instanceof Node && !!scrollRef.current?.contains(e.target),
    );
    return () => {
      release();
      unclaim();
    };
  }, [query]);

  const setExpanded = (row: VisibleRow<T>, open: boolean) => {
    if (!row.expandable || row.expanded === open) return;
    if (model) {
      model.setExpanded(row.node, open);
      if (open && getChildren(row.node) === undefined) void loadChildren?.(row.node);
      return;
    }
    const next = new Set(expanded);
    if (open) next.add(row.key);
    else {
      // Collapsing a node also collapses everything expanded below it, so expanding it again
      // shows only its direct children.
      next.delete(row.key);
      const stack = [...(getChildren(row.node) ?? [])];
      while (next.size && stack.length) {
        const n = stack.pop()!;
        if (next.delete(getKey(n)) || isExpandable(n)) stack.push(...(getChildren(n) ?? []));
      }
    }
    if (!expandedControlled) setExpandedInner(next);
    props.onExpandedChange?.(next, row.node, open);
    if (open && getChildren(row.node) === undefined) void loadChildren?.(row.node);
  };

  const commitSelection = useCallback(
    (next: Set<string>, leadKey: string | null) => {
      if (!selectedControlled) setSelectedInner(next);
      setLead(leadKey);
      const leadRow = leadKey != null ? rowAt(keyIndex(leadKey)) : undefined;
      props.onSelectionChange?.(next, leadRow?.node ?? null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rowAt, keyIndex, selectedControlled, props.onSelectionChange],
  );

  const selectIndex = (i: number, mode: "single" | "toggle" | "range" = "single") => {
    const row = rowAt(i);
    if (!row || row.loading) return;
    if (mode === "single" || !multiSelect) {
      setAnchor(row.key);
      commitSelection(new Set([row.key]), row.key);
    } else if (mode === "toggle") {
      const next = new Set(selected);
      if (next.has(row.key)) next.delete(row.key);
      else next.add(row.key);
      setAnchor(row.key);
      commitSelection(next, row.key);
    } else {
      const a = anchor != null ? (keyIndex(anchor) >= 0 ? keyIndex(anchor) : i) : leadIndex >= 0 ? leadIndex : i;
      setAnchor(rowAt(a)!.key);
      const [s, e] = a < i ? [a, i] : [i, a];
      const next = new Set<string>();
      for (let j = s; j <= e; j++) {
        const r = rowAt(j)!;
        if (!r.loading) next.add(r.key);
      }
      commitSelection(next, row.key);
    }
  };

  useImperativeHandle(handleRef, () => ({
    focus: () => scrollRef.current?.focus(),
    reveal: (key: string) => {
      const i = keyIndex(key);
      if (i < 0) return false;
      setAnchor(key);
      commitSelection(new Set([key]), key);
      virtualizer.scrollToIndex(i, { align: "center" });
      return true;
    },
    clearSelection: () => {
      setAnchor(null);
      commitSelection(new Set(), null);
    },
    leadKey: () => lead,
    moveSelection: (dir: 1 | -1) => {
      const key = lead != null && selected.has(lead) ? lead : ([...selected][0] ?? null);
      const from = key != null ? keyIndex(key) : -1;
      const i = from < 0 ? step(-1, 1) : step(from, dir);
      if (i < 0 || i === from || !rowAt(i)) return;
      selectIndex(i);
      virtualizer.scrollToIndex(i);
    },
    selectOccurrence: (dir: 1 | -1, options?: { skipSubtree?: boolean }) => {
      if (model) {
        const found = model.findOccurrence(lead, dir, { ...options, isOccurrence: props.isOccurrence });
        if (!found) return null;
        for (const a of found.ancestors) model.setExpanded(a, true);
        const key = getKey(found.node);
        const sel = new Set([key]);
        setAnchor(key);
        if (!selectedControlled) setSelectedInner(sel);
        setLead(key);
        props.onSelectionChange?.(sel, found.node);
        return { key, node: found.node, index: found.index, total: found.total };
      }
      const found = findOccurrence(
        roots,
        lead,
        dir,
        { getKey, getChildren, isExpandable, isOccurrence: props.isOccurrence },
        options?.skipSubtree,
      );
      if (!found) return null;
      const missing = found.ancestors.filter((a) => !expanded.has(getKey(a)));
      if (missing.length) {
        const next = new Set(expanded);
        for (const a of missing) {
          next.add(getKey(a));
          props.onExpandedChange?.(new Set(next), a, true);
        }
        if (!expandedControlled) setExpandedInner(next);
      }
      const key = getKey(found.node);
      const sel = new Set([key]);
      setAnchor(key);
      if (!selectedControlled) setSelectedInner(sel);
      setLead(key);
      props.onSelectionChange?.(sel, found.node);
      return { key, node: found.node, index: found.index, total: found.total };
    },
  }));

  const findMatch = (from: number, dir: 1 | -1, inclusive: boolean, q = query, wrap = true): number => {
    if (!q) return -1;
    const n = rowCount;
    const test = (i: number) => {
      const r = rowAt(i)!;
      return !r.loading && fuzzyMatch(getLabel(r.node), q) !== null;
    };
    const start = from < 0 ? (dir === 1 ? 0 : n - 1) : from;
    for (let step = inclusive ? 0 : 1; step < n + (inclusive ? 0 : 1); step++) {
      const raw = start + dir * step;
      if (!wrap && (raw < 0 || raw >= n)) return -1;
      const i = ((raw % n) + n) % n;
      if (test(i)) return i;
    }
    return -1;
  };

  const activate = (row: VisibleRow<T>, e: KeyboardEvent | MouseEvent) => {
    if (row.loading) return;
    const activates = typeof activateExpandable === "function" ? activateExpandable(row.node) : activateExpandable;
    if (row.expandable && !activates) setExpanded(row, !row.expanded);
    else onActivate?.(row.node, e);
  };

  const step = (i: number, dir: 1 | -1) => {
    for (let j = i + dir; j >= 0 && j < rowCount; j += dir) if (!rowAt(j)!.loading) return j;
    return i;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const row = leadIndex >= 0 ? rowAt(leadIndex) : undefined;
    const pageSize = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 300) / rowHeight) - 1);
    const typed =
      speedSearch && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && !(e.key === " " && !query);
    if (typed) {
      const q = query + e.key;
      setQuery(q);
      const hit = findMatch(leadIndex, 1, true, q);
      if (hit >= 0) selectIndex(hit);
      e.preventDefault();
      return;
    }
    const range = e.shiftKey && multiSelect;
    // Jump to Source (F4 / ⌘↓): the tree's own handler, else it activates like Enter.
    if (e.key === "F4" || (e.key === "ArrowDown" && e.metaKey && !e.shiftKey && !e.altKey)) {
      if (!row) return;
      setQuery("");
      if (onJumpToSource) {
        if (!row.loading) onJumpToSource(row.node, selected);
      } else activate(row, e);
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    switch (e.key) {
      case "Escape":
        if (!query) return;
        setQuery("");
        break;
      case "Backspace":
        if (!query) return;
        // ⌘⌫ erases the query, ⌥⌫ / Ctrl+⌫ its last word, as in a text field.
        setQuery(e.metaKey ? "" : e.altKey || e.ctrlKey ? query.replace(/\w*\W*$/, "") : query.slice(0, -1));
        break;
      case "ArrowDown":
      case "ArrowUp": {
        const dir = e.key === "ArrowDown" ? 1 : -1;
        if (query) {
          const hit = findMatch(leadIndex, dir, false);
          if (hit >= 0) selectIndex(hit);
        } else if (leadIndex < 0) {
          selectIndex(step(-1, 1));
        } else {
          selectIndex(step(leadIndex, dir), range ? "range" : "single");
        }
        break;
      }
      case "ArrowRight":
        setQuery("");
        if (!row) return;
        if (row.expandable && !row.expanded) setExpanded(row, true);
        else if (row.expanded && rowAt(leadIndex + 1)?.parentKey === row.key && !rowAt(leadIndex + 1)!.loading)
          selectIndex(leadIndex + 1);
        break;
      case "ArrowLeft":
        setQuery("");
        if (!row) return;
        if (row.expanded) setExpanded(row, false);
        else if (row.parentKey != null) {
          const pi = keyIndex(row.parentKey);
          if (pi >= 0) selectIndex(pi);
        }
        break;
      case "Home":
      case "End": {
        const first = e.key === "Home";
        if (query) {
          const hit = findMatch(-1, first ? 1 : -1, true, query, false);
          if (hit >= 0) selectIndex(hit);
        } else selectIndex(first ? step(-1, 1) : step(rowCount, -1), range ? "range" : "single");
        break;
      }
      case "PageDown":
        setQuery("");
        selectIndex(Math.min(rowCount - 1, Math.max(0, leadIndex) + pageSize), range ? "range" : "single");
        break;
      case "PageUp":
        setQuery("");
        selectIndex(Math.max(0, leadIndex - pageSize), range ? "range" : "single");
        break;
      case "Enter":
        if (!row) return;
        setQuery("");
        activate(row, e);
        break;
      case "a":
      case "A":
        if (!(e.metaKey || e.ctrlKey) || !multiSelect) return;
        commitSelection(
          new Set(
            visibleRows()
              .filter((r) => !r.loading)
              .map((r) => r.key),
          ),
          lead,
        );
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const onRowMouseDown = (e: MouseEvent, i: number) => {
    if (e.button === 2) {
      if (!selected.has(rowAt(i)!.key)) selectIndex(i);
      return;
    }
    if (e.button !== 0) return;
    // The second press of a double-click starts the browser's word selection,
    // which in a virtualized tree spills onto the rows an expanding folder just
    // inserted and highlights neighbouring labels. Prevent it: rows are
    // controls, not text (the shared List does the same via `user-select`), the
    // first press already selected, and the dblclick below still fires, so
    // activation keeps working. Rows can host editors (inline rename), so this
    // is scoped to repeated clicks instead of unselecting all row content.
    if (e.detail >= 2) {
      e.preventDefault();
      return;
    }
    setQuery("");
    if (e.shiftKey) selectIndex(i, "range");
    else if (e.metaKey || e.ctrlKey) selectIndex(i, "toggle");
    else selectIndex(i);
  };

  const leadRow = leadIndex >= 0 ? rowAt(leadIndex) : undefined;
  useTreeDirectoryContext(
    scrollRef,
    leadRow && !leadRow.loading && selected.has(leadRow.key) ? props.getDirectory?.(leadRow.node) : undefined,
    !!props.getDirectory && !emptyState,
  );
  const noMatch = !!query && matchMap.size === 0;

  const { focusContext } = props;
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!focusContext || !element) return;
    let focused = false;
    const focus = () => {
      focused = true;
      setContext(focusContext, true);
    };
    const blur = () => {
      if (!focused) return;
      focused = false;
      setContext(focusContext, false);
    };
    element.addEventListener("focus", focus);
    element.addEventListener("blur", blur);
    if (element.ownerDocument.activeElement === element) focus();
    return () => {
      element.removeEventListener("focus", focus);
      element.removeEventListener("blur", blur);
      // Removing a focused tree can skip blur, leaving its shortcuts active.
      blur();
    };
  }, [emptyState, focusContext]);

  if (emptyState) return <div className={clsx(styles.tree, styles.emptyWrap, className)}>{empty}</div>;

  return (
    <div className={clsx(styles.wrap, className)}>
      <div
        ref={scrollRef}
        role="tree"
        aria-label={given(props["aria-label"])}
        aria-multiselectable={multiSelect || undefined}
        aria-activedescendant={
          leadRow && !leadRow.loading && virtualizer.getVirtualItems().some((v) => v.index === leadIndex)
            ? `${baseId}-${leadIndex}`
            : undefined
        }
        tabIndex={0}
        className={styles.tree}
        onKeyDown={onKeyDown}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setQuery("");
        }}
        onContextMenu={
          onContextMenu
            ? (e) => {
                e.preventDefault();
                const rowEl = (e.target as HTMLElement).closest<HTMLElement>("[data-row]");
                const i = rowEl ? Number(rowEl.dataset.row) : -1;
                const row = i >= 0 ? rowAt(i) : undefined;
                const sel =
                  row && selected.has(row.key) ? new Set(selected) : row ? new Set([row.key]) : new Set<string>();
                onContextMenu(row && !row.loading ? row.node : null, sel, e);
              }
            : undefined
        }
      >
        <div className={styles.sizer} style={{ height: virtualizer.getTotalSize() }}>
          {props.horizontalScroll && (
            <div aria-hidden data-content-width className={styles.contentWidth} style={{ width: contentWidth }} />
          )}
          {virtualizer.getVirtualItems().map((v) => {
            const row = rowAt(v.index)!;
            // Settings › Appearance › "Use smaller indents in trees" sets `--tree-indent`
            // on the root; reading it here applies the setting to every tree at once,
            // instantly, and keeps chevrons and level alignment consistent with it.
            const pad = (extra = 0) => `calc(${4 + extra}px + ${row.depth} * var(--tree-indent, ${indent}px))`;
            const style = { transform: `translateY(${v.start}px)`, height: v.size, paddingLeft: pad() };
            if (row.loading) {
              return (
                <div
                  key={row.key}
                  className={clsx(styles.row, styles.loading)}
                  style={{ ...style, paddingLeft: pad(20) }}
                  role="presentation"
                >
                  <Spinner size={12} /> <T>Loading…</T>
                </div>
              );
            }
            const isSelected = selected.has(row.key);
            const prevRow = isSelected ? rowAt(v.index - 1) : undefined;
            const nextRow = isSelected ? rowAt(v.index + 1) : undefined;
            const joinPrev = isSelected && !!prevRow && !prevRow.loading && selected.has(prevRow.key);
            const joinNext = isSelected && !!nextRow && !nextRow.loading && selected.has(nextRow.key);
            const isLead = v.index === leadIndex;
            const matches = matchMap.get(row.key) ?? null;
            const state: TreeRowState = {
              depth: row.depth,
              expanded: row.expanded,
              expandable: row.expandable,
              selected: isSelected,
              lead: isLead,
              matches,
            };
            const icon = getIcon?.(row.node, row.expanded);
            const detail = getDetail?.(row.node);
            const color = getColor?.(row.node);
            const tint = rowTint?.(row.node);
            const swatch = getSwatch?.(row.node);
            return (
              <div
                key={row.key}
                id={`${baseId}-${v.index}`}
                data-row={v.index}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-posinset={positions ? positions[v.index]![0] : row.posInSet}
                aria-setsize={positions ? positions[v.index]![1] : row.setSize}
                aria-expanded={row.expandable ? row.expanded : undefined}
                aria-selected={isSelected}
                className={clsx(
                  styles.row,
                  props.horizontalScroll && styles.wideRow,
                  rowClassName?.(row.node),
                  tint && styles.tinted,
                  isSelected && styles.selected,
                  joinPrev && styles.joinPrev,
                  joinNext && styles.joinNext,
                  isLead && styles.lead,
                  reordering.drop?.key === row.key && styles[reordering.drop.position],
                )}
                style={tint ? ({ ...style, "--row-tint": tint } as CSSProperties) : style}
                onPointerDown={
                  props.reorder
                    ? (e) => reordering.start(e, row)
                    : props.getDragData
                      ? (e) => {
                          const nodes = selected.has(row.key)
                            ? visibleRows()
                                .filter((r) => selected.has(r.key))
                                .map((r) => r.node)
                            : [row.node];
                          const data = props.getDragData!(nodes);
                          if (data) startPointerDrag(e, e.currentTarget, data, { always: true });
                        }
                      : undefined
                }
                onMouseDown={(e) => onRowMouseDown(e, v.index)}
                onDoubleClick={(e) => {
                  if (!props.reorder || !reordering.suppressActivation.current) activate(row, e);
                }}
              >
                <span
                  className={styles.chevron}
                  data-tree-toggle
                  onMouseDown={(e) => {
                    if (!row.expandable || e.button !== 0) return;
                    e.stopPropagation();
                    setExpanded(row, !row.expanded);
                    if (!row.expanded) return;
                    if (leadRow && isDescendant((k) => rowAt(keyIndex(k))?.parentKey ?? null, leadRow.key, row.key))
                      selectIndex(v.index);
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  {row.expandable && <Icon name={row.expanded ? "chevron-down" : "chevron-right"} size={16} />}
                </span>
                {renderNode ? (
                  renderNode(row.node, state)
                ) : (
                  <>
                    {icon && <Icon name={icon} size={16} className={styles.icon} />}
                    {swatch && <span className={styles.swatch} style={{ background: swatch }} aria-hidden="true" />}
                    <HighlightedText
                      className={styles.label}
                      style={color ? { color } : undefined}
                      text={getLabel(row.node)}
                      indices={matches}
                      tone="accent"
                    />
                    {detail != null && detail !== false && detail !== "" && (
                      <span className={styles.detail}>{detail}</span>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {query &&
        (speedSearchField ? (
          // Typing stays in the tree: a press here must not take its focus, which would end the search.
          <div
            className={clsx(styles.speedSearch, styles.speedField, noMatch && styles.noMatch)}
            onMouseDown={(e) => e.preventDefault()}
          >
            <Icon name="search" size={14} />
            <span className={styles.speedQuery} role="status" aria-live="polite">
              {query}
            </span>
            <span className={styles.caret} aria-hidden="true" />
            <IconButton
              icon="filter"
              size="small"
              className={styles.onlyMatches}
              title="Show Only Matches"
              pressed={onlyMatches}
              onClick={() => setOnlyMatches(!onlyMatches)}
            />
          </div>
        ) : (
          <div className={clsx(styles.speedSearch, noMatch && styles.noMatch)} role="status" aria-live="polite">
            <Icon name="search" size={12} />
            <span className={styles.speedQuery}>{query}</span>
          </div>
        ))}
    </div>
  );
}

function isDescendant(parentKeyOf: (key: string) => string | null, key: string, ancestor: string): boolean {
  for (let k = parentKeyOf(key); k != null; k = parentKeyOf(k)) if (k === ancestor) return true;
  return false;
}

/** `[posInSet, setSize]` (1-based) of every row among the rows sharing its parent. */
export function siblingPositions(
  rows: ReadonlyArray<{ parentKey: string | null; loading?: boolean }>,
): Array<[number, number]> {
  const counts = new Map<string | null, number>();
  const out: Array<[number, number]> = rows.map((r) => {
    const n = (counts.get(r.parentKey) ?? 0) + 1;
    counts.set(r.parentKey, n);
    return [n, 0];
  });
  rows.forEach((r, i) => (out[i]![1] = counts.get(r.parentKey)!));
  return out;
}

/** The occurrence after (`dir` 1) / before (-1) `lead` in tree order over loaded nodes, with its ancestors. */
export function findOccurrence<T>(
  roots: readonly T[],
  lead: string | null,
  dir: 1 | -1,
  model: {
    getKey: (node: T) => string;
    getChildren: (node: T) => readonly T[] | undefined;
    isExpandable: (node: T) => boolean;
    isOccurrence?: (node: T) => boolean;
  },
  skipSubtree = false,
): { node: T; ancestors: T[]; index: number; total: number } | null {
  const occurrences: Array<{ node: T; ancestors: T[]; at: number }> = [];
  let leadAt = -1;
  let leadEnd = -1;
  let at = 0;
  const walk = (nodes: readonly T[], ancestors: T[]) => {
    for (const node of nodes) {
      const here = at++;
      const isLead = model.getKey(node) === lead;
      if (isLead) leadAt = here;
      const expandable = model.isExpandable(node);
      if (model.isOccurrence ? model.isOccurrence(node) : !expandable) occurrences.push({ node, ancestors, at: here });
      const children = expandable ? model.getChildren(node) : undefined;
      if (children?.length) walk(children, [...ancestors, node]);
      if (isLead) leadEnd = at - 1;
    }
  };
  walk(roots, []);
  const after = skipSubtree ? leadEnd : leadAt;
  let i: number;
  if (leadAt < 0) i = dir === 1 ? 0 : occurrences.length - 1;
  else if (dir === 1) i = occurrences.findIndex((o) => o.at > after);
  else i = occurrences.findLastIndex((o) => o.at < leadAt);
  const hit = occurrences[i];
  return hit ? { node: hit.node, ancestors: hit.ancestors, index: i + 1, total: occurrences.length } : null;
}
