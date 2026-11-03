/** Annotate (git blame) gutter left of the line numbers. */
import { writeClipboardText } from "@/platform/clipboard";
import { Compartment, Prec, RangeSet, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, type PluginValue, type ViewUpdate } from "@codemirror/view";
import { create } from "zustand";
import type { BlameLine } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { onWorkflowSettingsChange, workflowSettings, type AnnotateColors } from "@/platform/workflowSettings";
import { showContextMenu, type MenuItem } from "@/ui";
import { notifications } from "@/workbench/contributions";
import { closeBlamePopup, scheduleCloseBlamePopup, scheduleOpenBlamePopup } from "./BlamePopup";
import { formatDate } from "./model";
import { saveVcsSetting } from "./settingsUi";
import { useVcs } from "./store";

const ZERO = /^0+$/;

export function isUncommitted(line: Pick<BlameLine, "commit">): boolean {
  return ZERO.test(line.commit);
}

/** 0 (oldest) … 1 (newest) per line, for age colouring. */
export function ageRanks(lines: readonly Pick<BlameLine, "timeMs" | "commit">[]): number[] {
  const times = lines.filter((l) => !isUncommitted(l) && l.timeMs).map((l) => l.timeMs!);
  if (!times.length) return lines.map(() => 1);
  const min = Math.min(...times);
  const max = Math.max(...times);
  return lines.map((l) => (isUncommitted(l) || !l.timeMs ? 1 : max === min ? 1 : (l.timeMs - min) / (max - min)));
}

/** IDEA's AnnotationsSettings: 5 anchor colours with 4 interpolated between each pair. */
const ANCHORS = 5;
const BETWEEN = 4;
export const ANNOTATE_PALETTE_SIZE = (ANCHORS - 1) * (BETWEEN + 1) + 1;

/** IDEA's author palette: the ordered palette read with a stride, so neighbouring authors differ. */
export function authorPalette(size = ANNOTATE_PALETTE_SIZE, step = BETWEEN): number[] {
  const out: number[] = [];
  for (let i = 0; i < step; i++) for (let k = i; k < size; k += step) out.push(k);
  return out;
}

/**
 * Palette index (0 … `size` - 1) per commit, as IDEA's annotation gutter colours it:
 * `order` spreads the commits, newest first, over the palette; `author` gives each
 * author (alphabetically) its own colour. `none`, or a single commit / author: no
 * colours. Uncommitted lines are never coloured.
 */
export function annotateColorIndexes(
  lines: readonly Pick<BlameLine, "commit" | "author" | "timeMs">[],
  mode: AnnotateColors,
  size = ANNOTATE_PALETTE_SIZE,
): Map<string, number> {
  const out = new Map<string, number>();
  if (mode === "none") return out;
  const commits = new Map<string, Pick<BlameLine, "author" | "timeMs">>();
  for (const l of lines) if (!isUncommitted(l) && !commits.has(l.commit)) commits.set(l.commit, l);
  if (mode === "order") {
    if (commits.size < 2) return out;
    const ordered = [...commits].sort(([a, x], [b, y]) => (y.timeMs ?? 0) - (x.timeMs ?? 0) || a.localeCompare(b));
    ordered.forEach(([commit], i) => out.set(commit, Math.floor((size * i) / ordered.length)));
    return out;
  }
  const authors = [...new Set([...commits.values()].map((c) => c.author))].sort();
  if (authors.length < 2) return out;
  const palette = authorPalette(size);
  const byAuthor = new Map(authors.map((a, i) => [a, palette[i % palette.length]!]));
  for (const [commit, c] of commits) out.set(commit, byAuthor.get(c.author)!);
  return out;
}

/** Background of palette entry `index`: its anchor (`--vcs-annotate-N`) or a mix of the two around it. */
export function annotateColor(index: number): string {
  const anchor = Math.min(Math.floor(index / (BETWEEN + 1)), ANCHORS - 1);
  const step = index - anchor * (BETWEEN + 1);
  const from = `var(--vcs-annotate-${anchor + 1})`;
  if (step === 0) return from;
  const pct = Math.round(100 - (step * 100) / (BETWEEN + 1));
  return `color-mix(in oklab, ${from} ${pct}%, var(--vcs-annotate-${anchor + 2}))`;
}

const colorClasses = Object.fromEntries(
  Array.from({ length: ANNOTATE_PALETTE_SIZE }, (_, i) => [
    `.cm-vcs-blame .cm-gutterElement.cm-vcs-blame-c${i}`,
    { backgroundColor: annotateColor(i) },
  ]),
);

const COLUMNS = ["date", "author", "revision"] as const;
const GUTTER_ORDER = ["revision", "date", "author"] as const;
type AnnotateColumn = (typeof COLUMNS)[number];
type AnnotateColumns = Record<AnnotateColumn, boolean>;
type BlameLabels = Record<AnnotateColumn, string>;

class BlameMarker extends GutterMarker {
  override readonly elementClass: string;
  constructor(
    readonly line: BlameLine,
    readonly labels: BlameLabels | undefined,
    readonly rank: number,
    readonly color?: number,
  ) {
    super();
    // On the gutter element, so the lines of one commit form a solid block.
    this.elementClass = color === undefined ? "" : `cm-vcs-blame-colored cm-vcs-blame-c${color}`;
  }
  eq(o: BlameMarker) {
    return (
      o.line.commit === this.line.commit &&
      o.rank === this.rank &&
      o.color === this.color &&
      COLUMNS.every((column) => o.labels?.[column] === this.labels?.[column])
    );
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-vcs-blame-line";
    if (!this.labels) {
      el.title = "Not committed yet";
      return el;
    }
    for (const column of GUTTER_ORDER) {
      const cell = document.createElement("span");
      cell.className = `cm-vcs-blame-${column}`;
      cell.textContent = this.labels[column];
      el.append(cell);
    }
    if (this.color !== undefined) el.style.setProperty("--blame-bg", annotateColor(this.color));
    // Without a background, age fades the text instead.
    else {
      const pct = Math.round(25 + this.rank * 75);
      el.style.color = `color-mix(in srgb, var(--fg-secondary) ${pct}%, var(--fg-gutter))`;
    }
    el.dataset.commit = this.line.commit;
    return el;
  }
}

const spacer = new BlameMarker(
  { commit: "ffffffff", author: "", timeMs: 0, summary: "" },
  { date: "", author: "", revision: "" },
  1,
);

/** The columns the gutter shows (IDEA's annotate Options); kept across sessions. */
const COLUMNS_KEY = "openidea.vcs.annotateColumns";
const DEFAULT_COLUMNS: AnnotateColumns = { date: true, author: true, revision: false };

export function readAnnotateColumns(): AnnotateColumns {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(COLUMNS_KEY) ?? "null");
    const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const out = { ...DEFAULT_COLUMNS };
    for (const k of COLUMNS) if (typeof o[k] === "boolean") out[k] = o[k];
    return COLUMNS.some((k) => out[k]) ? out : { ...DEFAULT_COLUMNS };
  } catch {
    return { ...DEFAULT_COLUMNS };
  }
}

export const useAnnotateColumns = create<AnnotateColumns>(() => readAnnotateColumns());

// Other windows (project, diff) annotate too.
if (typeof window !== "undefined")
  window.addEventListener("storage", (e) => {
    if (e.key === COLUMNS_KEY) useAnnotateColumns.setState(readAnnotateColumns());
  });

/** Shows or hides a column in every annotated editor; the last shown column stays. */
function setAnnotateColumn(column: AnnotateColumn, shown: boolean) {
  const next = { ...useAnnotateColumns.getState(), [column]: shown };
  if (!COLUMNS.some((k) => next[k])) return;
  useAnnotateColumns.setState(next);
  try {
    localStorage.setItem(COLUMNS_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

/** Hides the columns turned off in Options, here and in editors annotated before the change. */
const annotateColumns = ViewPlugin.define(
  (view) => {
    view.requestMeasure(measureBlameColumns);
    return {
      update(update: ViewUpdate) {
        if (update.startState.field(blameField, false)?.labels !== update.state.field(blameField).labels)
          view.requestMeasure(measureBlameColumns);
      },
      destroy: useAnnotateColumns.subscribe(() => view.dispatch({})),
    };
  },
  {
    provide: () =>
      EditorView.editorAttributes.of(() => {
        const c = useAnnotateColumns.getState();
        const hidden = COLUMNS.filter((k) => !c[k]);
        return hidden.length ? { class: hidden.map((k) => `cm-vcs-blame-hide-${k}`).join(" ") } : null;
      }),
  },
);

const COLUMN_LABELS: Record<AnnotateColumn, string> = { date: "Date", author: "Author", revision: "Revision" };

function optionsMenu(): MenuItem {
  const c = useAnnotateColumns.getState();
  const shown = COLUMNS.filter((k) => c[k]).length;
  const { ignoreWhitespace, movement } = workflowSettings().vcs.git.annotate;
  return {
    label: "Options",
    submenu: [
      ...COLUMNS.map((k) => ({
        label: COLUMN_LABELS[k],
        checked: c[k],
        disabled: c[k] && shown === 1,
        run: () => setAnnotateColumn(k, !c[k]),
      })),
      { kind: "separator" },
      {
        label: "Ignore Whitespaces",
        checked: ignoreWhitespace,
        run: () => saveVcsSetting("vcs.git.annotate.ignoreWhitespace", !ignoreWhitespace, "global"),
      },
      {
        label: "Detect Movements Within File",
        checked: movement !== "none",
        run: () => saveVcsSetting("vcs.git.annotate.movement", movement === "none" ? "withinFile" : "none", "global"),
      },
      {
        label: "Detect Movements Across Files",
        checked: movement === "acrossFiles",
        run: () =>
          saveVcsSetting(
            "vcs.git.annotate.movement",
            movement === "acrossFiles" ? "withinFile" : "acrossFiles",
            "global",
          ),
      },
    ],
  };
}

const setBlame = StateEffect.define<BlameLine[]>();

interface BlameState {
  lines: BlameLine[];
  markers: RangeSet<GutterMarker>;
  labels: Map<string, BlameLabels>;
}

function build(lines: BlameLine[], doc: Text): BlameState {
  const ranks = ageRanks(lines);
  const colors = annotateColorIndexes(lines, workflowSettings().vcs.git.annotateColors);
  const labels = new Map<string, BlameLabels>();
  const out = [];
  const n = Math.min(lines.length, doc.lines);
  for (let i = 0; i < n; i++) {
    const line = lines[i]!;
    let label = labels.get(line.commit);
    if (!label && !isUncommitted(line)) {
      label = { date: formatDate(line.timeMs), author: line.author.trim(), revision: line.commit.slice(0, 8) };
      labels.set(line.commit, label);
    }
    out.push(new BlameMarker(line, label, ranks[i]!, colors.get(line.commit)).range(doc.line(i + 1).from));
  }
  return { lines, markers: RangeSet.of(out), labels };
}

const blameField = StateField.define<BlameState>({
  create: () => ({ lines: [], markers: RangeSet.empty, labels: new Map() }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setBlame)) return build(e.value, tr.state.doc);
    return tr.docChanged ? { ...value, markers: value.markers.map(tr.changes) } : value;
  },
});

type BlameWidthMeasurement = { gutter: HTMLElement; widths: Record<AnnotateColumn, number> };

/** Use the full file's annotation widths so scrolling does not move the code sideways. */
const measureBlameColumns = {
  read(view: EditorView): BlameWidthMeasurement | null {
    const gutter = view.dom.querySelector<HTMLElement>(".cm-vcs-blame");
    const labels = view.state.field(blameField, false)?.labels;
    if (!gutter || !labels?.size || typeof CanvasRenderingContext2D === "undefined") return null;
    const context = view.dom.ownerDocument.createElement("canvas").getContext("2d");
    if (!context) return null;
    const style = getComputedStyle(gutter);
    context.font = `${style.fontSize} ${style.fontFamily}`;
    const widths = { date: 0, author: 0, revision: 0 };
    for (const column of COLUMNS) {
      for (const label of new Set(Array.from(labels.values(), (entry) => entry[column]))) {
        widths[column] = Math.max(widths[column], context.measureText(label).width);
      }
    }
    return { gutter, widths };
  },
  write(result: BlameWidthMeasurement | null) {
    if (!result) return;
    const { gutter, widths } = result;
    for (const column of COLUMNS)
      gutter.style.setProperty(`--blame-${column}-width`, `${Math.ceil(widths[column]) + 2}px`);
  },
};

interface BlameSource {
  path: string;
  text?: string;
  revision?: string;
}

class BlameRefresher implements PluginValue {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private readonly off: (() => void)[];
  private readonly live: boolean;

  constructor(
    private readonly view: EditorView,
    private readonly source: BlameSource,
  ) {
    this.live = source.text === undefined && source.revision === undefined;
    this.off = [
      onWorkflowSettingsChange(
        (s) => s.vcs.git.annotate,
        () => this.schedule(0),
      ),
    ];
    if (this.live) {
      this.off.push(
        useVcs.subscribe((s, p) => {
          if (s.branch?.headCommit !== p.branch?.headCommit) this.schedule(100);
        }),
      );
    }
  }

  update(u: ViewUpdate) {
    if (this.live && u.docChanged) this.schedule(800);
  }

  schedule(delay: number) {
    clearTimeout(this.timer);
    const generation = ++this.generation;
    this.timer = setTimeout(() => void this.refresh(generation), delay);
  }

  private async refresh(generation: number) {
    const { path, text, revision } = this.source;
    const lines = await call(commands.vcsBlame(path, text ?? null, revision ?? null)).catch(() => null);
    if (!lines || generation !== this.generation || !annotationsShown(this.view)) return;
    closeBlamePopup(this.view);
    this.view.dispatch({ effects: setBlame.of(lines) });
  }

  destroy() {
    ++this.generation;
    clearTimeout(this.timer);
    for (const off of this.off) off();
  }
}

/** Repaints when the colour mode changes (gutter menu › Colors, or another window). */
function colorModeListener(view: EditorView): PluginValue {
  const off = onWorkflowSettingsChange(
    (w) => w.vcs.git.annotateColors,
    () => {
      const st = view.state.field(blameField, false);
      if (st) view.dispatch({ effects: setBlame.of(st.lines) });
    },
  );
  return { destroy: off };
}

const COLOR_MODES: { mode: AnnotateColors; label: string }[] = [
  { mode: "order", label: "Order" },
  { mode: "author", label: "Author" },
  { mode: "none", label: "Hide" },
];

async function setColorMode(mode: AnnotateColors) {
  useProject.setState({
    settings: await call(commands.settingsSet("global", "vcs.git.annotateColors", JSON.stringify(mode))),
  });
}

const blameTheme = EditorView.baseTheme({
  ".cm-vcs-blame": {
    cursor: "pointer",
    borderRight: "1px solid var(--border)",
    fontFamily: "var(--font-ui)",
    fontSize: "var(--fs-ui)",
  },
  ".cm-vcs-blame .cm-gutterElement": { padding: "0", display: "flex", alignItems: "stretch" },
  ...colorClasses,
  ".cm-vcs-blame .cm-vcs-blame-colored .cm-vcs-blame-line": { color: "var(--fg-emphasis)" },
  ".cm-vcs-blame-line": {
    flex: "1",
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--space-1)",
    padding: "0 var(--space-2) 0 var(--space-1)",
    color: "var(--fg-secondary)",
    whiteSpace: "nowrap",
  },
  ".cm-vcs-blame-line > span": { flex: "none", overflow: "hidden", textOverflow: "ellipsis" },
  ".cm-vcs-blame-date": { width: "min(var(--blame-date-width, 9ch), 14em)" },
  ".cm-vcs-blame-author": { width: "min(var(--blame-author-width, 12ch), 18em)" },
  ".cm-vcs-blame-revision": { width: "var(--blame-revision-width, 9ch)" },
  "&.cm-vcs-blame-hide-date .cm-vcs-blame-date, &.cm-vcs-blame-hide-author .cm-vcs-blame-author, &.cm-vcs-blame-hide-revision .cm-vcs-blame-revision":
    { display: "none" },
  ".cm-vcs-blame .cm-gutterElement:hover .cm-vcs-blame-line, .cm-vcs-blame .cm-gutterElement.cm-vcs-blame-same-commit .cm-vcs-blame-line":
    {
      color: "var(--fg-strong)",
      backgroundColor: "color-mix(in srgb, var(--fg-strong) 10%, var(--blame-bg, var(--bg-tree-hover)))",
    },
});

export const blameCompartment = new Compartment();

/** Placeholder included in every editor so annotations can be toggled. */
export function blameSlot(): Extension {
  return blameCompartment.of([]);
}

function lineAt(view: EditorView, from: number): BlameLine | undefined {
  const st = view.state.field(blameField, false);
  if (!st) return undefined;
  let found: BlameLine | undefined;
  st.markers.between(from, from, (f, _t, m) => {
    if (f === from) found = (m as BlameMarker).line;
  });
  return found;
}

function highlightSameCommit(view: EditorView, commit: string | null) {
  for (const el of view.dom.querySelectorAll<HTMLElement>(".cm-vcs-blame .cm-gutterElement")) {
    const line = el.querySelector<HTMLElement>(".cm-vcs-blame-line");
    el.classList.toggle("cm-vcs-blame-same-commit", !!commit && line?.dataset.commit === commit);
  }
}

class BlameInteraction implements PluginValue {
  private readonly onScroll = () => {
    highlightSameCommit(this.view, null);
    closeBlamePopup(this.view);
  };
  private readonly onLeave = (e: MouseEvent) => {
    const gutterEl = this.view.dom.querySelector(".cm-vcs-blame");
    if (gutterEl && e.relatedTarget instanceof Node && gutterEl.contains(e.relatedTarget)) return;
    highlightSameCommit(this.view, null);
    scheduleCloseBlamePopup();
  };
  constructor(private readonly view: EditorView) {
    this.view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
    this.view.dom.addEventListener("mouseout", this.onLeave);
  }
  update(u: ViewUpdate) {
    if (u.docChanged) {
      highlightSameCommit(this.view, null);
      closeBlamePopup(this.view);
    }
  }
  destroy() {
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    this.view.dom.removeEventListener("mouseout", this.onLeave);
    highlightSameCommit(this.view, null);
    closeBlamePopup(this.view);
  }
}

function blameExtension(lines: BlameLine[], source: BlameSource): Extension {
  const { path } = source;
  const refresher = ViewPlugin.define((view) => new BlameRefresher(view, source));
  return [
    blameField.init((state) => build(lines, state.doc)),
    Prec.high(
      gutter({
        class: "cm-vcs-blame",
        markers: (v) => v.state.field(blameField).markers,
        initialSpacer: () => spacer,
        domEventHandlers: {
          mouseover(view, block, event) {
            const l = lineAt(view, block.from);
            const anchor = (event.target as HTMLElement | null)?.closest?.<HTMLElement>(".cm-gutterElement");
            if (!l || isUncommitted(l) || !anchor) {
              highlightSameCommit(view, null);
              scheduleCloseBlamePopup();
              return false;
            }
            highlightSameCommit(view, l.commit);
            scheduleOpenBlamePopup({ view, anchor, line: l, path });
            return false;
          },
          click(view, block) {
            closeBlamePopup(view);
            const l = lineAt(view, block.from);
            if (l && !isUncommitted(l)) void executeAction("vcs.showCommit", l.commit);
            return true;
          },
          contextmenu(view, block, event) {
            closeBlamePopup(view);
            const l = lineAt(view, block.from);
            const origin = l?.originPath ?? path;
            event.preventDefault();
            showContextMenu(event as MouseEvent, [
              { label: "Close Annotations", run: () => setAnnotations(view, null, source) },
              ...(l && !isUncommitted(l)
                ? [
                    {
                      label: "Show Diff",
                      icon: "diff",
                      run: () => void import("./annotateRevision").then((m) => m.showRevisionDiff(origin, l.commit)),
                    },
                    {
                      label: "Copy Revision Number",
                      icon: "copy",
                      run: () => void writeClipboardText(l.commit),
                    },
                    { kind: "separator" as const },
                    {
                      label: tx("Annotate at Revision…"),
                      icon: "clock",
                      run: () => void import("./FileRevisionChooser").then((m) => m.annotateFileRevision(path)),
                    },
                    {
                      label: tx("Annotate Previous Revision"),
                      icon: "history",
                      // Loads the history and diff viewer code only when it is used.
                      run: () =>
                        void import("./annotateRevision").then((m) => m.annotatePreviousRevision(origin, l.commit)),
                    },
                    {
                      label: "Show Commit in Git Log",
                      icon: "commit",
                      run: () => void executeAction("vcs.showCommit", l.commit),
                    },
                    {
                      label: "Ignore This Commit",
                      icon: "hide",
                      run: () => void ignoreCommit(path, l.commit, () => view.plugin(refresher)?.schedule(0)),
                    },
                  ]
                : []),
              optionsMenu(),
              {
                label: "Colors",
                submenu: COLOR_MODES.map(({ mode, label }) => ({
                  label,
                  checked: workflowSettings().vcs.git.annotateColors === mode,
                  run: () => void setColorMode(mode).catch(() => undefined),
                })),
              },
            ]);
            return true;
          },
        },
      }),
    ),
    ViewPlugin.define((view) => new BlameInteraction(view)),
    annotateColumns,
    refresher,
    ViewPlugin.define(colorModeListener),
    blameTheme,
  ];
}

export function annotationsShown(view: EditorView): boolean {
  return !!view.state.field(blameField, false);
}

function setAnnotations(view: EditorView, lines: BlameLine[] | null, source: BlameSource) {
  if (!lines) closeBlamePopup(view);
  view.dispatch({ effects: blameCompartment.reconfigure(lines ? blameExtension(lines, source) : []) });
}

/**
 * Appends `commit` to the repository's ignore list so annotate skips it, then re-blames
 * the gutter.
 */
async function ignoreCommit(path: string, commit: string, refresh: () => void) {
  try {
    await call(commands.vcsIgnoreBlameRevision(path, commit));
    refresh();
  } catch (e) {
    notifications().notify({
      group: "vcs",
      level: "error",
      title: "Cannot ignore the commit",
      body: e instanceof Error ? e.message : String(e),
    });
  }
}

/** Toggles annotations in `view`; `text` blames that content instead of the file on
 * disk, `revision` the history it is blamed on (default HEAD). */
export async function toggleAnnotations(view: EditorView, path: string, text?: string, revision?: string) {
  if (annotationsShown(view)) {
    setAnnotations(view, null, { path });
    return;
  }
  try {
    const lines = await call(commands.vcsBlame(path, text ?? null, revision ?? null));
    // A file Git has no commit of (unversioned, ignored, added) would get an empty column.
    if (revision === undefined && lines.every(isUncommitted)) {
      notifications().notify({
        group: "vcs",
        level: "info",
        title: "Nothing to annotate",
        body: "The file has no committed history in Git.",
      });
      return;
    }
    setAnnotations(view, lines, { path, text, revision });
  } catch (e) {
    notifications().notify({
      group: "vcs",
      level: "error",
      title: "Cannot annotate",
      body: e instanceof Error ? e.message : String(e),
    });
  }
}
