import { writeClipboardText } from "@/platform/clipboard";
import { copySelectionOnKeyDown } from "@/ui/selectableText";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import clsx from "clsx";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useWorkflowSettings } from "@/platform/workflowSettings";
import { useConsoleFont } from "@/platform/consoleFont";
import { Icon, showContextMenu } from "@/ui";
import { spanStyle, type Span } from "@/ui/ansi";
import { logLineColor } from "@/ui/logColors";
import { compileConsoleRules, matchConsoleRules, styleSpans, type ConsoleRuleMatch } from "@/ui/consoleRules";
import { useConsoleRules } from "@/workbench/contributions";
import type { ConsoleLine, ConsoleModel } from "./console";
import {
  findOutputLinks,
  horizontalColumnWindow,
  measureMonoCharWidth,
  sliceRangesInWindow,
  visibleCharWindow,
  type OutputLink,
  type TextWindow,
} from "./links";
import { debugConsoleUrl, openTarget, openUrl } from "./navigate";
import { segmentLine, type SegmentMark } from "./segments";
import styles from "./Run.module.css";
import { useConsoleSelection } from "./useConsoleSelection";
import { hostBinding, formatBinding, hasPrimaryModifier, registerKeyClaim } from "@/platform/keymap";
import { WidestColumns } from "@/platform/consoleColumns";
import { tx } from "@/platform/i18n";
import { executeAction } from "@/platform/actions";
import { ConsoleFindBar } from "@/ui/ConsoleFindBar";
import {
  DEFAULT_FIND_OPTIONS,
  MAX_MATCHES,
  findInLines,
  type ConsoleMatch,
  type FindOptions,
  type FindResult,
} from "@/ui/consoleFind";

const MARK_COLOR = "var(--bg-search-match)";
const CURRENT_MARK_COLOR = "var(--bg-search-match-current)";
const EMPTY_FIND: FindResult = { matches: [], overflow: false, invalid: false };
const EMPTY_ROW_MAP = new Map<number, number>();
const isCurrentMark = (m: SegmentMark) => !!m.current;
/** Matches `.line { padding: 0 12px }` in `Run.module.css`. */
const LINE_PADDING_LEFT_PX = 12;

function sameMarks(a: readonly SegmentMark[] | undefined, b: readonly SegmentMark[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.start !== y.start || x.end !== y.end || !!x.current !== !!y.current) return false;
  }
  return true;
}

const Line = memo(
  function Line({
    line,
    marks,
    rules,
    cwd,
    colStart,
    colEnd,
  }: {
    line: ConsoleLine;
    marks?: readonly SegmentMark[];
    rules?: ConsoleRuleMatch;
    text: string;
    spans: readonly Span[];
    cwd: string;
    colStart?: number;
    colEnd?: number;
  }) {
    // Not memoised: the open (last) line mutates in place; `memo` below snapshots text/spans to catch \r overwrites.
    const spans = rules ? styleSpans(line.spans, rules) : line.spans;
    const rawLinks = line.kind === "system" ? [] : findOutputLinks(line.text);
    let links: readonly OutputLink[] = rawLinks;
    let visibleMarks: readonly SegmentMark[] | undefined = marks;
    if (colStart !== undefined && colEnd !== undefined && (colStart > 0 || line.text.length > colEnd)) {
      const win = visibleCharWindow(line.text, colStart, colEnd);
      links = sliceRangesInWindow(rawLinks, win.start, win.end);
      if (marks) visibleMarks = sliceRangesInWindow(marks, win.start, win.end, isCurrentMark);
    }
    const segments = segmentLine(spans, links, visibleMarks);
    const activate = (e: MouseEvent, link: OutputLink) => {
      e.preventDefault();
      if (window.getSelection()?.toString()) return;
      if (link.kind !== "url") void openTarget(link.target, cwd);
      else if (!debugConsoleUrl(e, link.url)) void openUrl(link.url);
    };
    // A blank line is an empty row: its height comes from CSS, never from a character in the text.
    if (segments.length === 0) return null;
    return (
      <>
        {segments.map((seg, i) => {
          // A match keeps the span's colours but takes the search background (as IDEA does).
          const style = seg.mark
            ? {
                ...spanStyle(seg.style),
                backgroundColor: seg.current ? CURRENT_MARK_COLOR : MARK_COLOR,
                color: "var(--fg-search-match)",
              }
            : spanStyle(seg.style);
          const marked = seg.mark ? { "data-find-match": "", "data-find-current": seg.current ? "" : undefined } : {};
          return seg.link ? (
            <a
              key={i}
              href={seg.link.kind === "url" ? seg.link.url : undefined}
              className={styles.link}
              style={style}
              onClick={(e) => activate(e, seg.link!)}
              role="link"
              tabIndex={-1}
              {...marked}
            >
              {seg.text}
            </a>
          ) : seg.mark ? (
            <mark key={i} className={styles.match} style={style} {...marked}>
              {seg.text}
            </mark>
          ) : (
            <span key={i} style={style}>
              {seg.text}
            </span>
          );
        })}
      </>
    );
  },
  (a, b) =>
    a.line === b.line &&
    a.text === b.text &&
    a.spans === b.spans &&
    a.cwd === b.cwd &&
    a.rules === b.rules &&
    a.colStart === b.colStart &&
    a.colEnd === b.colEnd &&
    sameMarks(a.marks, b.marks),
);

/** A run of folded lines (Settings › Console › Fold lines that contain). */
export interface Fold {
  start: number;
  count: number;
  /** Id of the first folded line (stable across trimming). */
  id: number;
  expanded: boolean;
}

/**
 * A visible console row: one line (carrying the fold of the lines after it, IDEA attaches
 * the `<N internal lines>` placeholder to the previous line), or a fold with no line before it.
 */
export type DisplayRow = { kind: "line"; index: number; fold?: Fold } | { kind: "fold"; fold: Fold };

const foldMatchCache = new WeakMap<readonly string[], WeakMap<ConsoleLine, { text: string; matched: boolean }>>();

function lineMatchesFold(line: ConsoleLine, patterns: readonly string[]): boolean {
  if (line.kind === "system" || patterns.length === 0) return false;
  let perPattern = foldMatchCache.get(patterns);
  if (!perPattern) {
    perPattern = new WeakMap();
    foldMatchCache.set(patterns, perPattern);
  }
  const cached = perPattern.get(line);
  if (cached && cached.text === line.text) return cached.matched;
  const matched = patterns.some((p) => line.text.includes(p));
  perPattern.set(line, { text: line.text, matched });
  return matched;
}

/**
 * IDEA's Fold Lines Like This: the selection when it stays on one line, else the clicked line;
 * trimmed, and `null` when that leaves nothing to fold on.
 */
export function foldLineText(selection: string, line: string | null): string | null {
  const text = (selection || (line ?? "")).trim();
  return text && !/[\r\n]/.test(text) ? text : null;
}

/**
 * Folds runs of consecutive output lines (one or more) that contain one of
 * `patterns`; runs whose first line id is in `expanded` stay open.
 */
export function foldRows(
  lines: readonly ConsoleLine[],
  patterns: readonly string[],
  expanded: ReadonlySet<number>,
): DisplayRow[] {
  const rows: DisplayRow[] = [];
  if (patterns.length === 0) {
    for (let i = 0; i < lines.length; i++) rows.push({ kind: "line", index: i });
    return rows;
  }
  for (let i = 0; i < lines.length;) {
    if (lineMatchesFold(lines[i]!, patterns)) {
      let j = i + 1;
      while (j < lines.length && lineMatchesFold(lines[j]!, patterns)) j++;
      const fold: Fold = { start: i, count: j - i, id: lines[i]!.id, expanded: expanded.has(lines[i]!.id) };
      const prev = rows[rows.length - 1];
      if (prev?.kind === "line") prev.fold = fold;
      else if (!fold.expanded) rows.push({ kind: "fold", fold });
      if (fold.expanded) for (; i < j; i++) rows.push({ kind: "line", index: i });
      i = j;
      continue;
    }
    rows.push({ kind: "line", index: i });
    i++;
  }
  return rows;
}

/** Typed console input (IDEA: type into the console, Enter sends the line). */
export interface ConsoleInput {
  /** Typed, not yet sent. */
  pending: string;
  onChange(pending: string): void;
  /** Sends one line (without the newline). */
  onSubmit(line: string): void;
  /** Closes stdin (EOF). */
  onEof(): void;
}

export interface ConsoleViewProps {
  model: ConsoleModel;
  version: number;
  softWrap: boolean;
  follow: boolean;
  onFollowChange: (follow: boolean) => void;
  /** Directory relative paths in the output resolve against. */
  cwd: string;
  onClear?: () => void;
  /** Set while the process accepts input. */
  input?: ConsoleInput;
  /** Controlled find bar (the Run toolbar button); without it ⌘F opens it locally. */
  findOpen?: boolean;
  onFindOpenChange?: (open: boolean) => void;
  "aria-label"?: string;
}

export function ConsoleView({
  model,
  version,
  softWrap,
  follow,
  onFollowChange,
  cwd,
  onClear,
  input,
  findOpen: controlledFindOpen,
  onFindOpenChange,
  ...aria
}: ConsoleViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const lines = model.lines;
  const patterns = useWorkflowSettings((s) => s.console.foldPatterns);
  const logColors = useWorkflowSettings((s) => s.console.logColors);
  const consoleRules = compileConsoleRules(useConsoleRules((s) => s.providers));
  // The Run console uses Tools › Terminal › Font (which can follow Editor › Font),
  // so the font and fallback configured there apply to process output too.
  const consoleFont = useConsoleFont();
  const { rowHeight } = consoleFont;
  /** A row's box: at its virtual offset, and never shorter than one line — a blank line has no text. */
  const rowStyle = (start: number) => ({
    transform: `translateY(${start}px)`,
    height: softWrap ? undefined : rowHeight,
    minHeight: rowHeight,
  });
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const [internalFindOpen, setInternalFindOpen] = useState(false);
  const findOpen = controlledFindOpen ?? internalFindOpen;
  const setFindOpen = (open: boolean) => {
    onFindOpenChange?.(open);
    if (controlledFindOpen === undefined) setInternalFindOpen(open);
  };
  const [query, setQuery] = useState("");
  const [findOptions, setFindOptions] = useState<FindOptions>(DEFAULT_FIND_OPTIONS);
  const [active, setActive] = useState(0);
  const findInput = useRef<HTMLInputElement>(null);
  /** Line the next search starts from (the top of the viewport when the query changed). */
  const findAnchor = useRef(0);
  const scrolledMatch = useRef<string | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` marks in-place appends to `lines`
  const folded = useMemo(() => foldRows(lines, patterns, expanded), [lines, version, patterns, expanded]);
  // Pending input continues the open line (a prompt), or starts a row of its own.
  const lastRow = folded[folded.length - 1];
  const inputInline =
    !!input && !!model.openLine && lastRow?.kind === "line" && !lastRow.fold && lines[lastRow.index] === model.openLine;
  const inputRow = !!input && !inputInline;
  const [widest] = useState(() => new WidestColumns());
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` marks in-place appends to `lines`
  const columns = useMemo(() => widest.measure(lines), [widest, lines, version]);
  const rows = folded;
  const count = rows.length + (inputRow ? 1 : 0);
  const toggleFold = (id: number) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const programmatic = useRef(false);
  const charWidthRef = useRef<number | null | undefined>(undefined);
  const [colWindow, setColWindow] = useState<TextWindow | null>(null);
  const syncHorizontalWindow = (el: HTMLDivElement | null) => {
    if (softWrap || !el) {
      setColWindow(null);
      return;
    }
    if (charWidthRef.current === undefined && el.clientWidth > 0) {
      charWidthRef.current = measureMonoCharWidth(el);
    }
    const next = horizontalColumnWindow(el.scrollLeft, el.clientWidth, consoleFont.size, {
      charWidthPx: charWidthRef.current,
      paddingLeftPx: LINE_PADDING_LEFT_PX,
    });
    setColWindow((prev) => (prev?.start === next?.start && prev?.end === next?.end ? prev : next));
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (softWrap || !el) {
      charWidthRef.current = undefined;
      setColWindow(null);
      return;
    }
    let active = true;
    charWidthRef.current = el.clientWidth > 0 ? measureMonoCharWidth(el) : undefined;
    syncHorizontalWindow(el);
    const fonts = el.ownerDocument?.fonts;
    if (fonts?.ready) {
      void fonts.ready.then(() => {
        if (!active) return;
        charWidthRef.current = el.clientWidth > 0 ? measureMonoCharWidth(el) : undefined;
        syncHorizontalWindow(el);
      });
    }
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => syncHorizontalWindow(el)) : null;
    ro?.observe(el);
    return () => {
      active = false;
      ro?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- consoleFont metrics and softWrap govern window width
  }, [softWrap, consoleFont.family, consoleFont.size, consoleFont.weight]);

  const { rangeExtractor, selecting } = useConsoleSelection(scrollRef, () => onFollowChange(false));
  const virtualizer = useVirtualizer({
    rangeExtractor,
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 15,
    getItemKey: (i) => {
      const r = rows[i];
      if (!r) return "input";
      return r.kind === "fold" ? `f${r.fold.id}` : (lines[r.index]?.id ?? i);
    },
  });

  // Soft wrap changes row heights; re-measure everything.
  useEffect(() => {
    virtualizer.measure();
  }, [softWrap, rowHeight, virtualizer]);

  useLayoutEffect(() => {
    if (!follow || count === 0) return;
    programmatic.current = true;
    virtualizer.scrollToIndex(count - 1, { align: "end" });
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => (programmatic.current = false));
  }, [version, count, follow, virtualizer]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    if (!softWrap) syncHorizontalWindow(el);
    if (programmatic.current) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < rowHeight;
    if (atBottom && selecting) return;
    if (atBottom !== follow) onFollowChange(atBottom);
  };

  // Find (⌘F): search the whole buffer, not just the rendered rows, caching completed lines across flushes.
  const findCache = useRef<{
    model: ConsoleModel;
    lines: readonly ConsoleLine[];
    query: string;
    options: FindOptions;
    invalid: boolean;
    byId: Map<number, { text: string; spans: Array<{ start: number; end: number }> }>;
  } | null>(null);
  const found = useMemo((): FindResult => {
    if (!findOpen || !query) {
      findCache.current = null;
      return EMPTY_FIND;
    }
    let cache = findCache.current;
    if (
      !cache ||
      cache.model !== model ||
      cache.lines !== lines ||
      cache.query !== query ||
      cache.options.caseSensitive !== findOptions.caseSensitive ||
      cache.options.wholeWord !== findOptions.wholeWord ||
      cache.options.regex !== findOptions.regex
    ) {
      const probe = findInLines([], query, findOptions, 1);
      cache = { model, lines, query, options: findOptions, invalid: probe.invalid, byId: new Map() };
      findCache.current = cache;
    }
    if (cache.invalid) return { matches: [], overflow: false, invalid: true };
    const firstId = lines[0]?.id ?? 0;
    if (cache.byId.size > lines.length + 512) {
      for (const id of cache.byId.keys()) {
        if (id < firstId) cache.byId.delete(id);
      }
    }
    const matches: ConsoleMatch[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const hit = cache.byId.get(line.id);
      if (hit && hit.text === line.text) {
        for (const s of hit.spans) {
          if (matches.length >= MAX_MATCHES) return { matches, overflow: true, invalid: false };
          matches.push({ line: i, lineId: line.id, start: s.start, end: s.end });
        }
        continue;
      }
      const remaining = MAX_MATCHES - matches.length;
      const res = findInLines([line], query, findOptions, remaining);
      if (res.invalid) {
        cache.invalid = true;
        return { matches: [], overflow: false, invalid: true };
      }
      if (!res.overflow) {
        cache.byId.set(line.id, {
          text: line.text,
          spans: res.matches.map((m) => ({ start: m.start, end: m.end })),
        });
      } else {
        cache.byId.delete(line.id);
      }
      for (const m of res.matches) matches.push({ line: i, lineId: line.id, start: m.start, end: m.end });
      if (res.overflow) return { matches, overflow: true, invalid: false };
    }
    return { matches, overflow: false, invalid: false };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` marks in-place appends to `lines`
  }, [findOpen, model, lines, version, query, findOptions]);
  const activeIndex = found.matches.length ? Math.min(Math.max(active, 0), found.matches.length - 1) : -1;
  const activeMatch = activeIndex >= 0 ? found.matches[activeIndex] : undefined;
  const marksByLine = useMemo(() => {
    const byLine = new Map<number, SegmentMark[]>();
    found.matches.forEach((match, i) => {
      const mark: SegmentMark = { start: match.start, end: match.end, current: i === activeIndex };
      const marks = byLine.get(match.line);
      if (marks) marks.push(mark);
      else byLine.set(match.line, [mark]);
    });
    return byLine;
  }, [found, activeIndex]);
  const rowOfLine = useMemo(() => {
    if (!findOpen) return EMPTY_ROW_MAP;
    const rowsByLine = new Map<number, number>();
    rows.forEach((row, i) => {
      if (row.kind === "line") rowsByLine.set(row.index, i);
    });
    return rowsByLine;
  }, [findOpen, rows]);

  /** The line at the top of the viewport: typing searches from there, as IDEA does. */
  const topLine = () => {
    const offset = scrollRef.current?.scrollTop ?? 0;
    const items = virtualizer.getVirtualItems();
    // The virtualizer also renders overscan rows above the viewport.
    const first = items.find((item) => item.start + item.size > offset) ?? items[0];
    const row = first ? rows[first.index] : undefined;
    if (!row) return 0;
    return row.kind === "line" ? row.index : row.fold.start;
  };
  const selectedText = () => {
    const el = scrollRef.current;
    const selection = window.getSelection();
    if (!el || !selection || !selection.anchorNode || !el.contains(selection.anchorNode)) return "";
    const text = selection.toString();
    return text && !text.includes("\n") ? text.trim() : "";
  };
  const openFind = () => {
    findAnchor.current = topLine();
    // Opening with selected output searches for it (a single line, like the terminal).
    if (!findOpen) {
      const selection = selectedText();
      if (selection) setQuery(selection);
    }
    scrolledMatch.current = null;
    setFindOpen(true);
    onFollowChange(false);
    findInput.current?.focus();
    findInput.current?.select();
  };
  const closeFind = () => {
    scrolledMatch.current = null;
    setFindOpen(false);
    scrollRef.current?.focus();
  };
  const changeQuery = (value: string) => {
    findAnchor.current = topLine();
    setQuery(value);
  };
  const changeOptions = (next: FindOptions) => {
    findAnchor.current = topLine();
    setFindOptions(next);
  };
  const goToMatch = (direction: 1 | -1) => {
    const total = found.matches.length;
    if (!total) return;
    setActive((current) => {
      const from = current >= 0 && current < total ? current : activeIndex;
      return (from + direction + total) % total;
    });
  };

  const findWasOpen = useRef(false);
  useEffect(() => {
    if (findOpen) {
      findWasOpen.current = true;
      findInput.current?.focus();
      findInput.current?.select();
    } else if (findWasOpen.current) {
      // Closed from the toolbar rather than the bar: put the caret back in the console.
      findWasOpen.current = false;
      scrollRef.current?.focus();
    }
  }, [findOpen]);

  // The bar owns Escape / Enter / F3 / ⌘G while it is focused; keep the IDE keymap out.
  useEffect(() => {
    if (!findOpen) return;
    return registerKeyClaim((e) => !!(e.target as Element | null)?.closest?.("[data-console-find]"));
  }, [findOpen]);

  // A new query (or option) starts from the viewport, not from the top of the output.
  useEffect(() => {
    if (!findOpen) return;
    const next = found.matches.findIndex((match) => match.line >= findAnchor.current);
    setActive(next >= 0 ? next : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- new output keeps the current match
  }, [findOpen, query, findOptions]);

  // Bring the current match into view; expand a collapsed fold that hides it.
  useEffect(() => {
    if (!findOpen || !activeMatch) return;
    const key = `${activeMatch.lineId}:${activeMatch.start}`;
    if (scrolledMatch.current === key) return;
    const rowIndex = rowOfLine.get(activeMatch.line);
    if (rowIndex === undefined) {
      for (const row of rows) {
        const fold = row.fold;
        if (fold && activeMatch.line >= fold.start && activeMatch.line < fold.start + fold.count) {
          setExpanded((s) => {
            const next = new Set(s);
            next.add(fold.id);
            return next;
          });
          break;
        }
      }
      return;
    }
    virtualizer.scrollToIndex(rowIndex, { align: "center" });
    scrolledMatch.current = key;
  }, [findOpen, activeMatch, rowOfLine, rows, virtualizer]);

  /** Rows are virtualized, so "everything" is a selection of the container, not of the mounted rows. */
  const selectAll = () => {
    const inner = innerRef.current;
    if (inner) window.getSelection()?.selectAllChildren(inner);
  };
  const allSelected = () => {
    const inner = innerRef.current;
    const s = window.getSelection();
    return (
      !!inner &&
      !!s &&
      !s.isCollapsed &&
      s.anchorNode === inner &&
      s.focusNode === inner &&
      s.anchorOffset === 0 &&
      s.focusOffset === inner.childNodes.length
    );
  };
  /** The selected text; after Select All the whole buffer, including rows that are not mounted. */
  const selectedOutput = () => (allSelected() ? model.text() : (window.getSelection()?.toString() ?? ""));

  /** The output line a context menu opened on; folds and the input row have none. */
  const lineAt = (target: EventTarget) => {
    const index = (target as Element).closest?.("[data-index]")?.getAttribute("data-index");
    const row = index == null ? undefined : rows[Number(index)];
    const line = row?.kind === "line" ? lines[row.index] : undefined;
    return line && line.kind !== "system" ? line.text : null;
  };

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    const selection = selectedOutput();
    const foldText = foldLineText(selection, lineAt(e.target));
    showContextMenu(e, [
      {
        label: "Copy",
        icon: "copy",
        shortcut: formatBinding(hostBinding("Meta+C")),
        disabled: !selection,
        run: () => void writeClipboardText(selection).catch(() => undefined),
      },
      { label: "Select All", shortcut: formatBinding(hostBinding("Meta+A")), run: selectAll },
      { label: "Copy All", run: () => void writeClipboardText(model.text()).catch(() => undefined) },
      {
        label: "Find…",
        icon: "search",
        shortcut: formatBinding(hostBinding("Meta+F")),
        run: openFind,
      },
      { kind: "separator" },
      {
        label: "Fold Lines Like This",
        disabled: !foldText,
        // Opens Settings › Console with the text added to the fold patterns, for OK / Cancel there.
        run: () => void executeAction("file.settings", `build.console#${foldText}`),
      },
      { label: "Clear All", icon: "trash", disabled: !onClear, run: () => onClear?.() },
      ...(input
        ? [{ kind: "separator" } as const, { label: "Send EOF", shortcut: "⌃D", run: () => input.onEof() }]
        : []),
    ]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (hasPrimaryModifier(e) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      openFind();
      return;
    }
    if (hasPrimaryModifier(e) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "a") {
      e.preventDefault();
      selectAll();
      return;
    }
    if (copySelectionOnKeyDown(e, selectedOutput)) return;
    if (!input) return;
    if (e.key === "d" && e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      input.onEof();
    } else if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      input.onSubmit(input.pending);
      input.onChange("");
    } else if (e.key === "Backspace" && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      input.onChange(e.altKey ? input.pending.replace(/\S*\s*$/, "") : [...input.pending].slice(0, -1).join(""));
    } else if (e.key.length === 1 && [...e.key].length === 1 && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      input.onChange(input.pending + e.key);
    }
  };

  const onPaste = (e: ClipboardEvent) => {
    if (!input) return;
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    const parts = (input.pending + text).replace(/\r\n?/g, "\n").split("\n");
    const rest = parts.pop() ?? "";
    for (const line of parts) input.onSubmit(line);
    input.onChange(rest);
  };

  const pendingInput = input && (
    <span className={styles.userInput}>
      {input.pending}
      <span className={styles.inputCaret} aria-hidden />
    </span>
  );
  const foldButton = (fold: Fold, attached: boolean) =>
    fold.expanded ? (
      <button
        type="button"
        className={styles.foldToggle}
        title={tx("Collapse folded lines")}
        aria-label={tx("Collapse folded lines")}
        onClick={() => toggleFold(fold.id)}
      >
        <Icon name="chevron-up" size={10} />
      </button>
    ) : (
      <button
        type="button"
        className={styles.fold}
        title={tx("Expand folded lines")}
        onClick={() => toggleFold(fold.id)}
      >
        {`${attached ? " " : ""}${fold.count === 1 ? tx`<${fold.count} internal line>` : tx`<${fold.count} internal lines>`}`}
      </button>
    );

  const items = virtualizer.getVirtualItems();
  return (
    <div className={styles.consoleWrap}>
      {/* A console whose find bar is not driven by a toolbar (a stack-trace tab, say) still
          needs a visible way in: the same Find the Run toolbar offers, over the output. */}
      {controlledFindOpen === undefined && !findOpen && (
        <button
          type="button"
          className={styles.consoleFindOpen}
          title="Find…"
          aria-label="Find in console"
          onClick={() => setFindOpen(true)}
        >
          <Icon name="search" size={14} />
        </button>
      )}
      {findOpen && (
        <ConsoleFindBar
          query={query}
          onChange={changeQuery}
          options={findOptions}
          onOptionsChange={changeOptions}
          count={found.matches.length}
          active={activeIndex}
          overflow={found.overflow}
          invalid={found.invalid}
          inputRef={findInput}
          onNext={() => goToMatch(1)}
          onPrevious={() => goToMatch(-1)}
          onClose={closeFind}
        />
      )}
      <div
        ref={scrollRef}
        className={clsx(styles.console, softWrap && styles.wrap)}
        style={{
          fontFamily: consoleFont.family,
          fontSize: `${consoleFont.size}px`,
          fontWeight: consoleFont.weight,
          ["--fw-code-bold" as string]: String(consoleFont.boldWeight),
          lineHeight: `${rowHeight}px`,
        }}
        role="log"
        aria-live="off"
        aria-label={aria["aria-label"] ?? "Console"}
        tabIndex={0}
        onScroll={onScroll}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
        onCopy={(e) => {
          // Native copy (menu, macOS) would take only the mounted rows.
          if (!allSelected()) return;
          e.preventDefault();
          e.clipboardData.setData("text/plain", model.text());
        }}
        onPaste={onPaste}
        data-autofocus=""
      >
        <div
          ref={innerRef}
          className={styles.consoleInner}
          style={{
            height: virtualizer.getTotalSize(),
            // Rows are mounted only near the viewport; the widest line sets the scroll width.
            minWidth: softWrap ? undefined : `calc(${columns}ch + 24px)`,
          }}
        >
          {items.map((item) => {
            const row = rows[item.index];
            if (!row) {
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={softWrap ? virtualizer.measureElement : undefined}
                  className={styles.line}
                  style={rowStyle(item.start)}
                >
                  {pendingInput}
                </div>
              );
            }
            if (row.kind === "fold") {
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={softWrap ? virtualizer.measureElement : undefined}
                  className={styles.line}
                  style={rowStyle(item.start)}
                >
                  {foldButton(row.fold, false)}
                </div>
              );
            }
            const line = lines[row.index];
            if (!line) return null;
            // A plugin's whole-line rule replaces the level colour. The level colour is the
            // inherited fallback; spans with their own ANSI colour win (rule styles replace those).
            const ruled = matchConsoleRules(line.text, line.kind, consoleRules);
            const color = ruled?.line ? ruled.line.fg : logLineColor(line.text, line.kind, logColors);
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={softWrap ? virtualizer.measureElement : undefined}
                className={clsx(styles.line, styles[line.kind])}
                style={{ ...rowStyle(item.start), color, background: ruled?.line?.bg }}
              >
                <Line
                  line={line}
                  marks={marksByLine.get(row.index)}
                  rules={ruled}
                  text={line.text}
                  spans={line.spans}
                  cwd={cwd}
                  colStart={colWindow?.start}
                  colEnd={colWindow?.end}
                />
                {row.fold && foldButton(row.fold, true)}
                {inputInline && item.index === rows.length - 1 && pendingInput}
                {"\n"}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
