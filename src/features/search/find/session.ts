/**
 * Find in Files request lifecycle:
 *
 *   idle ──search(q)──▶ validating ──ok──▶ searching ──done──▶ done
 *                           │                  │
 *                        invalid            error
 *
 * A new `search()` supersedes whatever is running: the previous backend
 * request is cancelled and its late events are dropped. Results stream in
 * per file: the first is published at once, later ones at most once per
 * animation frame. Lifecycle changes (done, cancel, error, a new search)
 * publish at once, with every file found so far.
 */
import type { FileMatches, RequestId, SearchQuery, SearchSummary } from "@/platform/ipc";
import { preserveCase } from "@/platform/search";

export type FindStatus = "idle" | "validating" | "invalid" | "searching" | "done" | "error";

export interface FindState {
  status: FindStatus;
  query: SearchQuery | null;
  /** Retained rows belong to a superseded search. */
  stale: boolean;
  files: readonly FileMatches[];
  matchCount: number;
  summary: SearchSummary | null;
  /** Validation or search error message. */
  error: string | null;
}

export interface FindDeps {
  validate(q: SearchQuery): Promise<void>;
  start(request: RequestId, q: SearchQuery, onFile: (f: FileMatches) => void): Promise<SearchSummary | null>;
  cancel(request: RequestId): void;
  nextRequestId(): RequestId;
}

export const countFileMatches = (file: FileMatches): number =>
  file.matches.reduce((count, line) => count + line.ranges.length, 0);

export const IDLE: FindState = {
  status: "idle",
  query: null,
  stale: false,
  files: [],
  matchCount: 0,
  summary: null,
  error: null,
};

function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

function isCancelledError(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { kind?: unknown }).kind === "cancelled";
}

/** Longest a streamed batch waits when animation frames stall (hidden or background window). */
const FRAME_FALLBACK_MS = 50;

/** Files of the running search, appended per event and copied once per publish. */
interface Stream {
  files: FileMatches[];
  matchCount: number;
  /** How many of `files` the current state holds. */
  synced: number;
}

export class FindSession {
  private seq = 0;
  private request: RequestId | null = null;
  private state: FindState = IDLE;
  private stream: Stream | null = null;
  /** Pending publish: the leading microtask, then one per animation frame while files keep coming. */
  private scheduled: { frame: number; timer: ReturnType<typeof setTimeout> } | "microtask" | null = null;
  private published: FindState | null = null;
  private disposed = false;

  constructor(
    private readonly deps: FindDeps,
    private readonly onChange: (s: FindState) => void,
  ) {}

  /** The latest state, including streamed files not published yet. */
  get current(): FindState {
    this.sync();
    return this.state;
  }

  /** Invalidates immediately, before a debounced search starts, keeping the layout steady. */
  invalidate() {
    this.seq++;
    this.endStream();
    this.cancelRunning();
    this.update({ ...this.state, stale: true, matchCount: 0, summary: null, error: null });
  }

  /** Starts (or restarts) a search; missing query or pattern resets to idle. */
  async search(query: SearchQuery | null): Promise<void> {
    const seq = ++this.seq;
    this.disposed = false;
    this.endStream();
    this.cancelRunning();
    if (!query?.pattern) {
      this.update({ ...IDLE });
      return;
    }
    this.update({ ...this.state, status: "validating", query, stale: true, matchCount: 0, summary: null, error: null });
    try {
      await this.deps.validate(query);
    } catch (e) {
      if (seq !== this.seq) return;
      this.update({ ...IDLE, status: "invalid", query, error: errorMessage(e) });
      return;
    }
    if (seq !== this.seq || this.disposed) return;

    const request = this.deps.nextRequestId();
    this.request = request;
    const stream: Stream = { files: [], matchCount: 0, synced: 0 };
    this.stream = stream;
    this.update({ ...this.state, status: "searching" });
    try {
      const summary = await this.deps.start(request, query, (f) => {
        if (seq !== this.seq) return;
        stream.files.push(f);
        stream.matchCount += countFileMatches(f);
        this.schedule();
      });
      if (seq !== this.seq) return;
      this.request = null;
      this.endStream();
      this.update({ ...this.finalState(stream), status: "done", summary });
    } catch (e) {
      if (seq !== this.seq) return;
      this.request = null;
      this.endStream();
      if (isCancelledError(e)) this.update({ ...this.finalState(stream), status: "done" });
      else this.update({ ...this.finalState(stream), status: "error", error: errorMessage(e) });
    }
  }

  /** Stops the running search, keeping results found so far. */
  cancel() {
    this.seq++;
    this.endStream();
    if (this.cancelRunning() && this.state.status === "searching") this.update({ ...this.state, status: "done" });
  }

  /** Cancels and stops publishing; a later `search()` revives the session. */
  dispose() {
    this.cancel();
    this.disposed = true;
  }

  private cancelRunning(): boolean {
    if (this.request === null) return false;
    this.deps.cancel(this.request);
    this.request = null;
    return true;
  }

  private finalState(stream: Stream): FindState {
    return { ...this.state, stale: false, files: [...stream.files], matchCount: stream.matchCount };
  }

  /** Brings the state up to date with the streamed files (without publishing). */
  private sync() {
    const stream = this.stream;
    if (!stream || stream.synced === stream.files.length) return;
    stream.synced = stream.files.length;
    this.state = { ...this.state, stale: false, files: stream.files.slice(), matchCount: stream.matchCount };
  }

  /** Folds the stream's last files into the state and stops its scheduled publish. */
  private endStream() {
    this.sync();
    this.stream = null;
    this.unschedule();
  }

  /**
   * Channel messages arrive one task each, so a microtask alone merges nothing:
   * the first file publishes at once, later ones at most once per frame.
   */
  private schedule() {
    if (this.scheduled) return;
    this.scheduled = "microtask";
    queueMicrotask(() => {
      if (this.scheduled !== "microtask") return;
      this.publishStream();
      this.scheduleFrame();
    });
  }

  private scheduleFrame() {
    const tick = () => {
      this.unschedule();
      // Nothing new since the last publish: the next file publishes at once again.
      if (this.publishStream()) this.scheduleFrame();
    };
    this.scheduled = {
      frame: typeof requestAnimationFrame === "function" ? requestAnimationFrame(tick) : 0,
      timer: setTimeout(tick, FRAME_FALLBACK_MS),
    };
  }

  private unschedule() {
    const s = this.scheduled;
    this.scheduled = null;
    if (!s || s === "microtask") return;
    if (s.frame) cancelAnimationFrame(s.frame);
    clearTimeout(s.timer);
  }

  private publishStream(): boolean {
    this.sync();
    if (this.disposed || this.state === this.published) return false;
    this.published = this.state;
    this.onChange(this.state);
    return true;
  }

  /** Publishes a lifecycle change at once, superseding any scheduled stream publish. */
  private update(next: FindState) {
    this.unschedule();
    this.state = next;
    if (this.disposed) return;
    this.published = next;
    this.onChange(next);
  }
}

/** Flat result rows (one per matching line) as shown by the popup. */
export interface MatchRow {
  key: string;
  path: string;
  relPath: string;
  line: number;
  /** Preview text (leading whitespace trimmed). */
  text: string;
  /** Column of `text` in the real line. */
  textCol: number;
  /** Highlight ranges within `text`. */
  ranges: Array<[number, number]>;
  /** First match column in the real line. */
  col: number;
  endCol: number;
  /** Raw matched substrings (for replace previews). */
  matched: string[];
  /** Start of every match on the line (identifies the usages to replace). */
  starts: Array<{ line: number; col: number }>;
}

export function matchRows(files: readonly FileMatches[]): MatchRow[] {
  const rows: MatchRow[] = [];
  for (const f of files) {
    for (const m of f.matches) {
      const lead = m.text.length - m.text.trimStart().length;
      const text = m.text.slice(lead).trimEnd();
      const ranges = m.ranges
        .map(([s, e]) => [Math.max(0, s - lead), Math.min(text.length, e - lead)] as [number, number])
        .filter(([s, e]) => e > s);
      const first = m.ranges[0] ?? [0, 0];
      rows.push({
        key: `${f.path}:${m.line}`,
        path: f.path,
        relPath: f.relPath,
        line: m.line,
        text,
        textCol: lead + m.textOffset,
        ranges,
        col: first[0] + m.textOffset,
        endCol: first[1] + m.textOffset,
        matched: m.ranges.map(([s, e]) => m.text.slice(s, e)),
        starts: m.ranges.map(([s]) => ({ line: m.line, col: s + m.textOffset })),
      });
    }
  }
  return rows;
}

/**
 * Preview of what Replace produces for one match. Regex replacements accept
 * the backend's (Rust `regex`) `$1` / `${1}` / `${name}` syntax.
 */
export function previewReplacement(
  matched: string,
  query: Pick<SearchQuery, "pattern" | "isRegex" | "caseSensitive">,
  replacement: string,
  preserve = false,
): string {
  const out = (() => {
    if (!query.isRegex) return replacement;
    try {
      const js = replacement.replace(/\$\{(\d+)\}/g, "$$$1").replace(/\$\{([A-Za-z_]\w*)\}/g, "$$<$1>");
      const re = new RegExp(query.pattern, query.caseSensitive ? "u" : "iu");
      return matched.replace(re, js);
    } catch {
      return replacement;
    }
  })();
  return preserve ? preserveCase(matched, out) : out;
}

/** Ranges → highlight indices (for `HighlightedText`). */
export function rangesToIndices(ranges: ReadonlyArray<readonly [number, number]>): number[] {
  const out: number[] = [];
  for (const [s, e] of ranges) for (let i = s; i < e; i++) out.push(i);
  return [...new Set(out)].sort((a, b) => a - b);
}
