/**
 * Build tool window (IDEA's Build view): the build → file → message tree on
 * the left, the raw console of the build on the right. Selecting a message
 * shows its full text on the right instead; Enter / double-click / F4 opens
 * its source (as IDEA: selection shows, navigation jumps).
 */
import { copySelectionOnKeyDown } from "@/ui/selectableText";
import { hasPrimaryModifier, registerKeyClaim } from "@/platform/keymap";
import { setContext } from "@/platform/context";
import { ConsoleFindBar } from "@/ui/ConsoleFindBar";
import { DEFAULT_FIND_OPTIONS, findInLines, type FindOptions, type FindResult } from "@/ui/consoleFind";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import clsx from "clsx";
import { useVirtualizer } from "@tanstack/react-virtual";
import { basename, relativeDir, useProject } from "@/platform/project";
import { fontsLoaded, monoStack } from "@/platform/fonts";
import {
  EmptyState,
  Icon,
  IconButton,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Spinner,
  Tree,
  fileIconName,
  type TreeHandle,
  type TreeRowState,
  T,
} from "@/ui";
import type { BuildMessage, Severity } from "@/platform/ipc";
import {
  ROOT_KEY,
  fileChildren,
  findNode,
  finishSummary,
  formatDuration,
  rootChildren,
  rootNode,
  type BuildNode,
  type BuildStatus,
  type ConsoleLine,
} from "./model";
import {
  findOutputLinks,
  horizontalColumnWindow,
  measureMonoCharWidth,
  revealScrollLeft,
  sliceRangesInWindow,
  visibleCharWindow,
  type OutputLink,
  type TextWindow,
} from "@/features/run/links";
import { openTarget, openUrl } from "@/features/run/navigate";
import { segmentLine, type SegmentMark } from "@/features/run/segments";
import { navigateToMessage, rerunBuild, selectBuildNode, useBuildRun } from "./store";
import styles from "./Build.module.css";
import { WidestColumns } from "@/platform/consoleColumns";
import { useConsoleFont, type ConsoleFont } from "@/platform/consoleFont";
import { tx } from "@/platform/i18n";

const SEVERITY_ICON: Record<Severity, string> = { error: "error", warning: "warning", info: "info", hint: "info" };

function firstLocated(n: BuildNode): BuildMessage | undefined {
  if (n.kind === "message") return n.message;
  if (n.kind === "file") return n.messages[0];
  return undefined;
}

function StatusIcon({ status }: { status: BuildStatus }) {
  if (status === "running") return <Spinner size={14} label="Building" />;
  const name = status === "success" ? "success" : status === "failed" ? "error" : "warning";
  return <Icon name={name} size={14} className={styles[`status-${status}`]} />;
}

function rootDetail(status: BuildStatus, errors: number, warnings: number): string {
  if (status === "running") return "running…";
  if (status === "cancelled") return "cancelled";
  if (status === "success") return tx("Finished");
  const summary = finishSummary({ success: false, errors, warnings, durationMs: null });
  return summary.replace(/^Build failed:?\s*/, "") || "failed";
}

export function BuildHeaderActions() {
  const running = useBuildRun((s) => s.status === "running");
  return (
    <>
      <IconButton icon="rerun" size="small" title="Rebuild Last" onClick={() => void rerunBuild()} disabled={running} />
      <IconButton icon="stop" size="small" action="build.stop" disabled={!running} />
    </>
  );
}

function BuildTree() {
  const { title, status, messages, durationMs, selected } = useBuildRun();
  const root = useProject((s) => s.project?.root ?? "");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const tree = useRef<TreeHandle>(null);
  const selection = useMemo(() => new Set(selected ? [selected] : []), [selected]);
  const roots = useMemo(() => (status ? [rootNode(title, status, messages)] : []), [title, status, messages]);
  const children = useMemo(() => rootChildren(messages), [messages]);
  const expanded = useMemo(() => {
    const keys = new Set<string>([ROOT_KEY]);
    for (const c of children) if (c.kind === "file") keys.add(c.key);
    for (const k of collapsed) keys.delete(k);
    return keys;
  }, [children, collapsed]);

  // A selection made by the store (the first error of a failed build) expands
  // its file, then is scrolled into view.
  const [shown, setShown] = useState(selected);
  if (shown !== selected) {
    setShown(selected);
    const file = selected?.split("\u0000")[0];
    if (file && file !== selected && collapsed.has(file)) {
      const next = new Set(collapsed);
      next.delete(file);
      setCollapsed(next);
    }
  }
  useEffect(() => {
    if (selected && tree.current?.leadKey() !== selected) tree.current?.reveal(selected);
  }, [selected, expanded]);

  const navigate = (n: BuildNode) => {
    const m = firstLocated(n);
    if (m) navigateToMessage(m, true);
  };

  const getChildren = useCallback(
    (n: BuildNode): BuildNode[] | undefined =>
      n.kind === "root" ? children : n.kind === "file" ? fileChildren(n) : undefined,
    [children],
  );

  const renderNode = (n: BuildNode, state: TreeRowState) => {
    if (n.kind === "root") {
      const detail = rootDetail(n.status, n.errors, n.warnings);
      const elapsed = n.status !== "running" && durationMs != null ? formatDuration(durationMs) : null;
      return (
        <span className={styles.row} title={[n.title, detail, elapsed].filter(Boolean).join(" ")}>
          <StatusIcon status={n.status} />
          <span className={styles.strong}>{n.title}</span>
          <span className={clsx(styles.muted, styles.rootDetail)}>{detail}</span>
          {elapsed && <span className={clsx(styles.muted, styles.duration)}>{elapsed}</span>}
        </span>
      );
    }
    if (n.kind === "file") {
      const directory = relativeDir(root, n.path);
      const errors = n.messages.filter((m) => m.severity === "error").length;
      const warnings = n.messages.filter((m) => m.severity === "warning").length;
      const counts = [
        errors && `${errors} error${errors === 1 ? "" : "s"}`,
        warnings && `${warnings} warning${warnings === 1 ? "" : "s"}`,
      ]
        .filter(Boolean)
        .join(", ");
      return (
        <span className={styles.row} title={n.path}>
          <Icon name={fileIconName(basename(n.path), n.path)} size={16} className={styles.fileIcon} />
          <span className={styles.fileLabel}>
            <span
              className={clsx(
                styles.strong,
                styles.fileName,
                errors > 0 && styles.fileError,
                state.selected && styles.selected,
              )}
            >
              {basename(n.path)}
            </span>
            {directory && <span className={clsx(styles.muted, styles.directory)}>{directory}</span>}
          </span>
          {counts && <span className={styles.muted}>{counts}</span>}
        </span>
      );
    }
    const m = n.message;
    const start = m.range?.start;
    return (
      <span className={styles.row} title={m.text}>
        <Icon name={SEVERITY_ICON[m.severity]} size={14} className={styles[`sev-${m.severity}`]} />
        <span className={styles.message}>{m.text.split("\n")[0]}</span>
        {start && (
          <span className={styles.position}>
            :{start.line + 1}:{start.col + 1}
          </span>
        )}
      </span>
    );
  };

  return (
    <div
      className={styles.treeHost}
      onKeyDown={(e) => {
        if (e.key !== "F4" || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !selected) return;
        const n = findNode(messages, selected);
        if (!n) return;
        e.preventDefault();
        e.stopPropagation();
        navigate(n);
      }}
    >
      <Tree<BuildNode>
        handleRef={tree}
        aria-label="Build"
        roots={roots}
        getKey={(n) => n.key}
        getLabel={(n) => (n.kind === "root" ? n.title : n.kind === "file" ? basename(n.path) : n.message.text)}
        getChildren={getChildren}
        isExpandable={(n) => n.kind !== "message"}
        expanded={expanded}
        onExpandedChange={(_next, node, isOpen) =>
          setCollapsed((prev) => {
            const s = new Set(prev);
            if (isOpen) s.delete(node.key);
            else s.add(node.key);
            return s;
          })
        }
        renderNode={renderNode}
        selected={selection}
        onActivate={navigate}
        onSelectionChange={(_sel, lead) => selectBuildNode(lead?.key ?? null)}
        multiSelect={false}
        empty={<EmptyState title="No build output" />}
      />
    </div>
  );
}

/** Matches `.line { padding: 0 12px }` in `Build.module.css`. */
const BUILD_PADDING_LEFT_PX = 12;

/**
 * One console line: file locations and URLs (compiler diagnostics, stack
 * frames) are links, resolved against the directory of the step that printed
 * the line (Maven reactor modules run in their own directory), then the
 * project root and a name search as in the run console.
 */
const isCurrentMark = (m: SegmentMark) => !!m.current;

const ConsoleLineText = memo(function ConsoleLineText({
  line,
  root,
  marks,
  colStart,
  colEnd,
}: {
  line: ConsoleLine;
  root: string;
  /** Find matches on this line. */
  marks?: readonly SegmentMark[];
  colStart?: number;
  colEnd?: number;
}) {
  const rawLinks = useMemo(() => (line.kind === "system" ? [] : findOutputLinks(line.text)), [line.text, line.kind]);
  const windowed = colStart !== undefined && colEnd !== undefined && (colStart > 0 || line.text.length > colEnd);
  const win = windowed ? visibleCharWindow(line.text, colStart, colEnd) : null;
  const links = useMemo(
    () => (win ? sliceRangesInWindow(rawLinks, win.start, win.end) : rawLinks),
    [rawLinks, win?.start, win?.end], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const visibleMarks = marks && win ? sliceRangesInWindow(marks, win.start, win.end, isCurrentMark) : marks;
  const activate = (e: MouseEvent, link: OutputLink) => {
    e.preventDefault();
    if (window.getSelection()?.toString()) return;
    if (link.kind === "url") void openUrl(link.url);
    else void openTarget(link.target, line.cwd ?? root);
  };
  if (!links.length && !visibleMarks?.length) return <>{line.text}</>;
  const out: ReactNode[] = [];
  segmentLine([{ text: line.text }], links, visibleMarks).forEach((seg, i) => {
    const marked = seg.mark
      ? {
          className: clsx(styles.match, seg.current && styles.matchCurrent),
          "data-find-match": "",
          "data-find-current": seg.current ? "" : undefined,
        }
      : null;
    if (seg.link) {
      const link = seg.link;
      out.push(
        <a
          key={i}
          href={link.kind === "url" ? link.url : undefined}
          {...marked}
          className={clsx(styles.link, marked?.className)}
          onClick={(e) => activate(e, link)}
          role="link"
          tabIndex={-1}
        >
          {seg.text}
        </a>,
      );
    } else if (marked) {
      out.push(
        <mark key={i} {...marked}>
          {seg.text}
        </mark>,
      );
    } else {
      out.push(seg.text);
    }
  });
  return <>{out}</>;
});

/** The Build console holding focus, for `build.findInOutput`. */
let focusedConsole: { openFind(): void } | null = null;

/** Opens the find bar of the focused Build console (`build.findInOutput`). */
export function openBuildFind() {
  focusedConsole?.openFind();
}

const EMPTY_FIND: FindResult = { matches: [], overflow: false, invalid: false };

function BuildConsole({ font }: { font: ConsoleFont }) {
  const { rowHeight } = font;
  const root = useProject((s) => s.project?.root ?? "/");
  const lines = useBuildRun((s) => s.lines);
  const ref = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const charWidthRef = useRef<number | null | undefined>(undefined);
  const [colWindow, setColWindow] = useState<TextWindow | null>(null);
  const syncHorizontalWindow = (el: HTMLDivElement | null) => {
    if (!el) {
      setColWindow(null);
      return;
    }
    if (charWidthRef.current === undefined && el.clientWidth > 0) {
      charWidthRef.current = measureMonoCharWidth(el);
    }
    const next = horizontalColumnWindow(el.scrollLeft, el.clientWidth, font.size, {
      charWidthPx: charWidthRef.current,
      paddingLeftPx: BUILD_PADDING_LEFT_PX,
    });
    setColWindow((prev) => (prev?.start === next?.start && prev?.end === next?.end ? prev : next));
  };
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let active = true;
    charWidthRef.current = el.clientWidth > 0 ? measureMonoCharWidth(el) : undefined;
    syncHorizontalWindow(el);
    const fontStack = font.family.replaceAll("var(--font-mono)", monoStack());
    void fontsLoaded(fontStack, font.size).then(() => {
      if (!active) return;
      charWidthRef.current = el.clientWidth > 0 ? measureMonoCharWidth(el) : undefined;
      syncHorizontalWindow(el);
    });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => syncHorizontalWindow(el)) : null;
    ro?.observe(el);
    return () => {
      active = false;
      ro?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the console font's metrics govern the window width
  }, [font.family, font.size, font.weight]);
  const [widest] = useState(() => new WidestColumns());
  const columns = useMemo(() => widest.measure(lines), [widest, lines]);
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => ref.current,
    estimateSize: () => rowHeight,
    overscan: 20,
  });
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [rowHeight, virtualizer]);
  useEffect(() => {
    if (stick.current && lines.length) virtualizer.scrollToIndex(lines.length - 1, { align: "end" });
  }, [lines.length, rowHeight, virtualizer]);

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
  const allText = () => lines.map((l) => l.text).join("\n");
  // Edit › Select All (the native menu role on macOS, execCommand elsewhere) asks the body with
  // `selectstart` before selecting the whole window; with the output focused, select the output instead.
  useEffect(() => {
    const onSelectStart = (e: Event) => {
      const el = ref.current;
      if (e.target !== document.body || !el || !el.contains(document.activeElement)) return;
      e.preventDefault();
      const inner = innerRef.current;
      if (inner) window.getSelection()?.selectAllChildren(inner);
    };
    document.addEventListener("selectstart", onSelectStart, true);
    return () => document.removeEventListener("selectstart", onSelectStart, true);
  }, []);

  // Find (⌘F, `build.findInOutput`): searches every line, not just the mounted rows.
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [findOptions, setFindOptions] = useState<FindOptions>(DEFAULT_FIND_OPTIONS);
  const [active, setActive] = useState(0);
  const findInput = useRef<HTMLInputElement>(null);
  /** Line the next search starts from (the top of the viewport when the query changed). */
  const findAnchor = useRef(0);
  const scrolledMatch = useRef<string | null>(null);
  const found = useMemo(
    () =>
      findOpen && query
        ? findInLines(
            lines.map((l, i) => ({ id: i, text: l.text })),
            query,
            findOptions,
          )
        : EMPTY_FIND,
    [findOpen, query, findOptions, lines],
  );
  const activeIndex = found.matches.length ? Math.min(Math.max(active, 0), found.matches.length - 1) : -1;
  const current = activeIndex >= 0 ? found.matches[activeIndex] : undefined;
  const marksByLine = useMemo(() => {
    const byLine = new Map<number, SegmentMark[]>();
    found.matches.forEach((m, i) => {
      const mark: SegmentMark = { start: m.start, end: m.end, current: i === activeIndex };
      const marks = byLine.get(m.line);
      if (marks) marks.push(mark);
      else byLine.set(m.line, [mark]);
    });
    return byLine;
  }, [found, activeIndex]);
  const topLine = () => {
    const offset = ref.current?.scrollTop ?? 0;
    const items = virtualizer.getVirtualItems();
    // The virtualizer also renders overscan rows above the viewport.
    return (items.find((item) => item.start + item.size > offset) ?? items[0])?.index ?? 0;
  };
  const openFind = () => {
    findAnchor.current = topLine();
    scrolledMatch.current = null;
    setFindOpen(true);
    findInput.current?.focus();
    findInput.current?.select();
  };
  const closeFind = () => {
    scrolledMatch.current = null;
    setFindOpen(false);
    ref.current?.focus();
  };
  const goToMatch = (direction: 1 | -1) => {
    const total = found.matches.length;
    if (total) setActive((activeIndex + direction + total) % total);
  };
  const handle = useRef({ openFind });
  handle.current.openFind = openFind;
  useEffect(() => {
    const own = handle.current;
    return () => {
      if (focusedConsole !== own) return;
      focusedConsole = null;
      setContext("buildConsoleFocus", false);
    };
  }, []);
  useEffect(() => {
    if (!findOpen) return;
    findInput.current?.focus();
    findInput.current?.select();
    // The bar owns Escape / Enter / F3 / ⌘G while it is focused; keep the IDE keymap out.
    return registerKeyClaim((e) => !!(e.target as Element | null)?.closest?.("[data-console-find]"));
  }, [findOpen]);
  // A new query (or option) starts from the viewport, not from the top of the output.
  useEffect(() => {
    if (!findOpen) return;
    const next = found.matches.findIndex((m) => m.line >= findAnchor.current);
    setActive(next >= 0 ? next : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- new output keeps the current match
  }, [findOpen, query, findOptions]);
  // Bring the current match into view, horizontally too on a long line.
  useEffect(() => {
    if (!findOpen || !current) return;
    const key = `${current.line}:${current.start}`;
    if (scrolledMatch.current === key) return;
    scrolledMatch.current = key;
    stick.current = false;
    virtualizer.scrollToIndex(current.line, { align: "center" });
    const el = ref.current;
    const text = lines[current.line]?.text;
    if (!el || text === undefined) return;
    if (charWidthRef.current === undefined && el.clientWidth > 0) charWidthRef.current = measureMonoCharWidth(el);
    const left = revealScrollLeft(text, current.start, current.end, el, font.size, {
      charWidthPx: charWidthRef.current,
      paddingLeftPx: BUILD_PADDING_LEFT_PX,
    });
    if (left === null) return;
    el.scrollLeft = left;
    syncHorizontalWindow(el);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the viewport and font are read when the match changes
  }, [findOpen, current, virtualizer]);

  return (
    <div className={styles.consoleWrap}>
      {findOpen && (
        <ConsoleFindBar
          label="Find in build output"
          query={query}
          onChange={(value) => {
            findAnchor.current = topLine();
            setQuery(value);
          }}
          options={findOptions}
          onOptionsChange={(next) => {
            findAnchor.current = topLine();
            setFindOptions(next);
          }}
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
        ref={ref}
        className={styles.console}
        tabIndex={0}
        role="log"
        onFocus={() => {
          focusedConsole = handle.current;
          setContext("buildConsoleFocus", true);
        }}
        onBlur={() => {
          if (focusedConsole !== handle.current) return;
          focusedConsole = null;
          setContext("buildConsoleFocus", false);
        }}
        onKeyDown={(e) => {
          if (hasPrimaryModifier(e) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "a") {
            e.preventDefault();
            selectAll();
            return;
          }
          copySelectionOnKeyDown(e, (selection) => (allSelected() ? allText() : selection.toString()));
        }}
        onCopy={(e) => {
          // Native copy (Edit menu, macOS) would take only the mounted rows.
          if (!allSelected()) return;
          e.preventDefault();
          e.clipboardData.setData("text/plain", allText());
        }}
        aria-label={tx("Build output")}
        onScroll={(e) => {
          const el = e.currentTarget;
          syncHorizontalWindow(el);
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < rowHeight * 2;
        }}
      >
        <div
          ref={innerRef}
          className={styles.consoleInner}
          style={{ height: virtualizer.getTotalSize(), minWidth: `calc(${columns}ch + 24px)` }}
        >
          {virtualizer.getVirtualItems().map((v) => {
            const line = lines[v.index]!;
            return (
              <div
                key={v.key}
                className={clsx(styles.line, styles[line.kind])}
                style={{ transform: `translateY(${v.start}px)` }}
              >
                <ConsoleLineText
                  line={line}
                  root={root}
                  marks={marksByLine.get(v.index)}
                  colStart={colWindow?.start}
                  colEnd={colWindow?.end}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Full text and location of the selected message (IDEA shows the node's own console). */
function MessageDetail({ message }: { message: BuildMessage }) {
  const root = useProject((s) => s.project?.root ?? "");
  const start = message.range?.start;
  const location = message.path
    ? `${relativeDir(root, message.path) ? `${relativeDir(root, message.path)}/` : ""}${basename(message.path)}${
        start ? `:${start.line + 1}:${start.col + 1}` : ""
      }`
    : null;
  return (
    <div
      className={styles.detail}
      tabIndex={0}
      onKeyDown={copySelectionOnKeyDown}
      role="document"
      aria-label={tx("Build message")}
    >
      {location && (
        <button type="button" className={styles.detailLocation} onClick={() => navigateToMessage(message, true)}>
          {location}
        </button>
      )}
      <div className={clsx(styles.detailText, message.severity === "error" && styles.err)}>{message.text}</div>
    </div>
  );
}

function BuildOutput({ font }: { font: ConsoleFont }) {
  const selected = useBuildRun((s) => s.selected);
  const messages = useBuildRun((s) => s.messages);
  const node = useMemo(() => (selected ? findNode(messages, selected) : undefined), [selected, messages]);
  return node?.kind === "message" ? <MessageDetail message={node.message} /> : <BuildConsole font={font} />;
}

export function BuildView() {
  const hasBuild = useBuildRun((s) => s.status !== null);
  const font = useConsoleFont();
  if (!hasBuild) {
    return (
      <div className={styles.view}>
        <EmptyState title="No build output">
          <T>Build the project to see compiler messages here</T>
        </EmptyState>
      </div>
    );
  }
  return (
    <div className={styles.view}>
      <SplitGroup
        orientation="horizontal"
        className={styles.split}
        id="build-view-split"
        storageKey="openidea.build.split"
      >
        <SplitPanel id="build-tree" defaultSize="33%" minSize="120px" className={styles.pane}>
          <BuildTree />
        </SplitPanel>
        <SplitHandle />
        <SplitPanel
          id="build-console"
          minSize="120px"
          className={styles.pane}
          style={{
            fontFamily: font.family,
            fontSize: font.size,
            fontWeight: font.weight,
            lineHeight: `${font.rowHeight}px`,
          }}
        >
          <BuildOutput font={font} />
        </SplitPanel>
      </SplitGroup>
    </div>
  );
}
