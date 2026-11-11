/** Annotate (git blame) gutter left of the line numbers. */
import { writeClipboardText } from "@/platform/clipboard";
import { Compartment, Prec, RangeSet, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, type PluginValue, type ViewUpdate } from "@codemirror/view";
import type { BlameLine } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { call, commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { onWorkflowSettingsChange, workflowSettings, type AnnotateColors } from "@/platform/workflowSettings";
import { showContextMenu } from "@/ui";
import { notifications } from "@/workbench/contributions";
import { closeBlamePopup, scheduleCloseBlamePopup, scheduleOpenBlamePopup } from "./BlamePopup";
import { formatDate } from "./model";
import { useVcs } from "./store";

const ZERO = /^0+$/;

export function isUncommitted(line: Pick<BlameLine, "commit">): boolean {
  return ZERO.test(line.commit);
}

export function shortAuthor(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? "";
  return first.length > 12 ? `${first.slice(0, 11)}…` : first;
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

class BlameMarker extends GutterMarker {
  override readonly elementClass: string;
  constructor(
    readonly line: BlameLine,
    readonly rank: number,
    readonly color?: number,
  ) {
    super();
    // On the gutter element, so the lines of one commit form a solid block.
    this.elementClass = color === undefined ? "" : `cm-vcs-blame-colored cm-vcs-blame-c${color}`;
  }
  eq(o: BlameMarker) {
    return o.line.commit === this.line.commit && o.rank === this.rank && o.color === this.color;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-vcs-blame-line";
    const l = this.line;
    if (isUncommitted(l)) {
      el.textContent = "";
      el.title = "Not committed yet";
      return el;
    }
    const author = document.createElement("span");
    author.className = "cm-vcs-blame-author";
    author.textContent = shortAuthor(l.author);
    const date = document.createElement("span");
    date.className = "cm-vcs-blame-date";
    date.textContent = formatDate(l.timeMs);
    el.append(date, author);
    if (this.color !== undefined) {
      const bg = annotateColor(this.color);
      el.style.setProperty("--blame-bg", bg);
      el.style.backgroundColor = bg;
    } else {
      // Without a background, age fades the text instead.
      const pct = Math.round(25 + this.rank * 75);
      el.style.color = `color-mix(in srgb, var(--fg-secondary) ${pct}%, var(--fg-gutter))`;
    }
    el.dataset.commit = l.commit;
    return el;
  }
}

const spacer = new BlameMarker({ commit: "f", author: "Mmmmmmmm", timeMs: Date.UTC(2020, 11, 28), summary: "" }, 1);

const setBlame = StateEffect.define<BlameLine[]>();

interface BlameState {
  lines: BlameLine[];
  markers: RangeSet<GutterMarker>;
}

function build(lines: readonly BlameLine[], doc: Text): RangeSet<GutterMarker> {
  const ranks = ageRanks(lines);
  const colors = annotateColorIndexes(lines, workflowSettings().vcs.git.annotateColors);
  const out = [];
  const n = Math.min(lines.length, doc.lines);
  for (let i = 0; i < n; i++) {
    const line = lines[i]!;
    out.push(new BlameMarker(line, ranks[i]!, colors.get(line.commit)).range(doc.line(i + 1).from));
  }
  return RangeSet.of(out);
}

const blameField = StateField.define<BlameState>({
  create: () => ({ lines: [], markers: RangeSet.empty }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setBlame)) return { lines: e.value, markers: build(e.value, tr.state.doc) };
    return tr.docChanged ? { ...value, markers: value.markers.map(tr.changes) } : value;
  },
});

/** Re-blames after edits and whenever HEAD moves (commit, Undo Commit, update, checkout). */
class BlameRefresher implements PluginValue {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private destroyed = false;
  private readonly offHead: () => void;
  constructor(
    private readonly view: EditorView,
    private readonly path: string,
  ) {
    this.offHead = useVcs.subscribe((s, p) => {
      if (s.branch?.headCommit !== p.branch?.headCommit) this.schedule(100);
    });
  }
  update(u: ViewUpdate) {
    if (u.docChanged) this.schedule(800);
  }
  private schedule(delay: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void call(commands.vcsBlame(this.path, null, null))
        .then((lines) => {
          if (!this.destroyed && this.view.state.field(blameField, false))
            this.view.dispatch({ effects: setBlame.of(lines) });
        })
        .catch(() => undefined);
    }, delay);
  }
  destroy() {
    this.destroyed = true;
    this.offHead();
    clearTimeout(this.timer);
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
  ".cm-vcs-blame": { cursor: "pointer", borderRight: "1px solid var(--border)" },
  ".cm-vcs-blame .cm-gutterElement": { padding: "0", display: "flex", alignItems: "stretch" },
  ...colorClasses,
  ".cm-vcs-blame .cm-vcs-blame-colored .cm-vcs-blame-line": { color: "var(--fg-emphasis)" },
  ".cm-vcs-blame-line": {
    flex: "1",
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    padding: "0 8px 0 6px",
    color: "var(--fg-secondary)",
    fontFamily: "var(--font-ui)",
    fontSize: "var(--fs-small)",
    whiteSpace: "nowrap",
  },
  ".cm-vcs-blame-date": { minWidth: "10ch", fontVariantNumeric: "tabular-nums" },
  ".cm-vcs-blame-author": { minWidth: "9ch" },
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

function blameExtension(lines: BlameLine[], path: string, live: boolean): Extension {
  return [
    blameField.init((state) => ({ lines, markers: build(lines, state.doc) })),
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
            event.preventDefault();
            showContextMenu(event as MouseEvent, [
              ...(l && !isUncommitted(l)
                ? [
                    {
                      label: "Show Commit in Git Log",
                      icon: "commit",
                      run: () => void executeAction("vcs.showCommit", l.commit),
                    },
                    {
                      label: "Copy Revision Number",
                      icon: "copy",
                      run: () => void writeClipboardText(l.commit),
                    },
                    { kind: "separator" as const },
                  ]
                : []),
              {
                label: "Colors",
                submenu: COLOR_MODES.map(({ mode, label }) => ({
                  label,
                  checked: workflowSettings().vcs.git.annotateColors === mode,
                  run: () => void setColorMode(mode).catch(() => undefined),
                })),
              },
              { kind: "separator" as const },
              { label: "Close Annotations", run: () => setAnnotations(view, null, path, false) },
            ]);
            return true;
          },
        },
      }),
    ),
    ViewPlugin.define((view) => new BlameInteraction(view)),
    // Static content (a merge pane's side) is not re-blamed on edits / HEAD moves.
    ...(live ? [ViewPlugin.define((view) => new BlameRefresher(view, path))] : []),
    ViewPlugin.define(colorModeListener),
    blameTheme,
  ];
}

export function annotationsShown(view: EditorView): boolean {
  return !!view.state.field(blameField, false);
}

function setAnnotations(view: EditorView, lines: BlameLine[] | null, path: string, live: boolean) {
  if (!lines) closeBlamePopup(view);
  view.dispatch({ effects: blameCompartment.reconfigure(lines ? blameExtension(lines, path, live) : []) });
}

/** Toggles annotations in `view`; `text` blames that content instead of the file on
 * disk, `revision` the history it is blamed on (default HEAD). */
export async function toggleAnnotations(view: EditorView, path: string, text?: string, revision?: string) {
  if (annotationsShown(view)) {
    setAnnotations(view, null, path, false);
    return;
  }
  try {
    const lines = await call(commands.vcsBlame(path, text ?? null, revision ?? null));
    setAnnotations(view, lines, path, text === undefined);
  } catch (e) {
    notifications().notify({
      group: "vcs",
      level: "error",
      title: "Cannot annotate",
      body: e instanceof Error ? e.message : String(e),
    });
  }
}
