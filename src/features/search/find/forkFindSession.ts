/**
 * Fork: the Find session of the fork's Find views (`forkFind.upstream` off). Streamed files are
 * appended per event and copied once per publish: the first file publishes at once, later ones
 * at most once per animation frame, and `isStreamExtension` is O(1) between its snapshots (the
 * fork's incremental tree relies on it). Upstream's `FindSession` (l0ng-ai/openidea#5239)
 * copies the whole result per file; it stays behind the flag.
 */
import type { FileMatches, RequestId, SearchQuery } from "@/platform/ipc";
import { IDLE, countFileMatches, type FindDeps, type FindState } from "./session";

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

const streamOrigins = new WeakMap<readonly FileMatches[], Stream>();

function snapshotStream(stream: Stream): FileMatches[] {
  const copy = stream.files.slice();
  streamOrigins.set(copy, stream);
  return copy;
}

/**
 * True when `files` starts with the exact same elements as `prefix`.
 * O(1) when both snapshots came from the same `FindSession` stream.
 */
export function isStreamExtension(files: readonly FileMatches[], prefix: readonly FileMatches[]): boolean {
  if (prefix.length > files.length) return false;
  const origin = streamOrigins.get(files);
  if (origin !== undefined && origin === streamOrigins.get(prefix)) return true;
  for (let i = 0; i < prefix.length; i++) if (files[i] !== prefix[i]) return false;
  return true;
}

export class ForkFindSession {
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
    return { ...this.state, stale: false, files: snapshotStream(stream), matchCount: stream.matchCount };
  }

  /** Brings the state up to date with the streamed files (without publishing). */
  private sync() {
    const stream = this.stream;
    if (!stream || stream.synced === stream.files.length) return;
    stream.synced = stream.files.length;
    this.state = { ...this.state, stale: false, files: snapshotStream(stream), matchCount: stream.matchCount };
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
