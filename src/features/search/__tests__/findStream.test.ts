import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileMatches, SearchQuery, SearchSummary } from "@/platform/ipc";
import { FindSession, type FindDeps, type FindState } from "../find/session";

const query: SearchQuery = {
  pattern: "needle",
  isRegex: false,
  caseSensitive: false,
  wholeWord: false,
  include: [],
  exclude: [],
  scope: { kind: "project" },
  maxMatches: 0,
};

const file = (i: number, hits = 1): FileMatches => ({
  path: `/p/src/m${i % 13}/F${i}.kt`,
  relPath: `src/m${i % 13}/F${i}.kt`,
  matches: Array.from({ length: hits }, (_, line) => ({ line, text: "  needle", ranges: [[2, 8]], textOffset: 0 })),
});

const summary = (files: number, matches = files): SearchSummary => ({
  files,
  matches,
  limitHit: false,
  cancelled: false,
  elapsedMs: 1,
});

interface Running {
  onFile: (f: FileMatches) => void;
  finish: (s: SearchSummary | null) => void;
  fail: (e: unknown) => void;
}

function setup() {
  const running: Running[] = [];
  let next = 0;
  const deps: FindDeps = {
    validate: async () => {},
    start: (_id, _q, onFile) =>
      new Promise<SearchSummary | null>((finish, fail) => {
        running.push({ onFile, finish, fail });
      }),
    cancel: vi.fn(),
    nextRequestId: () => ++next,
  };
  const states: FindState[] = [];
  const session = new FindSession(deps, (s) => states.push(s));
  return { session, deps, running, states, last: () => states[states.length - 1]! };
}

/** Lets validation resolve and the search start. */
const started = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"],
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("FindSession streaming", () => {
  // Each Tauri channel message arrives in its own task, so per-file work multiplies by N:
  // a backend second worth of files must not publish (and copy) once per file.
  it.each([1_000, 4_000, 10_000])("publishes per frame, not per file, for %i files", async (n) => {
    const { session, running, states, last } = setup();
    void session.search(query);
    await started();
    const before = states.length;
    const run = running[0]!;
    // The backend's ~1 s of results: one channel message (macrotask) per file.
    for (let i = 0; i < n; i++) setTimeout(() => run.onFile(file(i)), Math.floor((i * 1000) / n));
    const t0 = performance.now();
    await vi.advanceTimersByTimeAsync(1000);
    run.finish(summary(n));
    await vi.advanceTimersByTimeAsync(0);
    const ms = performance.now() - t0;
    const published = states.slice(before);
    const copied = published.reduce((sum, s) => sum + s.files.length, 0);
    console.info(`${n} files: ${published.length} publishes, ${copied} file entries copied, ${ms.toFixed(0)} ms`);
    // About one publish per 16 ms frame plus the leading and final ones.
    expect(published.length).toBeLessThanOrEqual(1000 / 16 + 5);
    expect(copied).toBeLessThanOrEqual((1000 / 16 + 5) * n);
    expect(last().status).toBe("done");
    expect(last().files).toHaveLength(n);
    expect(last().matchCount).toBe(n);
    expect(last().files.map((f) => f.relPath)).toEqual(Array.from({ length: n }, (_, i) => file(i).relPath));
  });

  it("publishes the first file at once and the rest by the next frame", async () => {
    const { session, running, last } = setup();
    void session.search(query);
    await started();
    running[0]!.onFile(file(0));
    await Promise.resolve();
    expect(last().files).toHaveLength(1);
    expect(last().stale).toBe(false);
    running[0]!.onFile(file(1));
    running[0]!.onFile(file(2));
    await Promise.resolve();
    expect(last().files).toHaveLength(1);
    await vi.advanceTimersToNextFrame();
    expect(last().files.map((f) => f.relPath)).toEqual([0, 1, 2].map((i) => file(i).relPath));
  });

  it("falls back to a timer when animation frames stall (hidden window)", async () => {
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const { session, running, last } = setup();
    void session.search(query);
    await started();
    running[0]!.onFile(file(0));
    running[0]!.onFile(file(1));
    await Promise.resolve();
    running[0]!.onFile(file(2));
    await vi.advanceTimersByTimeAsync(20);
    expect(last().files).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(last().files).toHaveLength(3);
  });

  it("current includes files not yet published", async () => {
    const { session, running, last } = setup();
    void session.search(query);
    await started();
    running[0]!.onFile(file(0));
    await Promise.resolve();
    running[0]!.onFile(file(1));
    expect(session.current.files).toHaveLength(2);
    expect(session.current.matchCount).toBe(2);
    expect(last().files).toHaveLength(1);
    await vi.advanceTimersToNextFrame();
    expect(last().files).toBe(session.current.files);
  });

  it.each([
    ["done", (r: Running) => r.finish(summary(3)), "done"],
    ["backend cancellation", (r: Running) => r.fail({ kind: "cancelled", message: "cancelled" }), "done"],
    ["error", (r: Running) => r.fail({ kind: "io", message: "disk on fire" }), "error"],
  ] as const)("%s publishes every file, pending ones included", async (_name, end, status) => {
    const { session, running, states, last } = setup();
    void session.search(query);
    await started();
    running[0]!.onFile(file(0));
    await Promise.resolve();
    running[0]!.onFile(file(1));
    running[0]!.onFile(file(2));
    end(running[0]!);
    await vi.advanceTimersByTimeAsync(0);
    expect(last().status).toBe(status);
    expect(last().files).toHaveLength(3);
    expect(last().matchCount).toBe(3);
    const count = states.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(states).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancel() keeps pending files and stops the batch", async () => {
    const { session, running, states, last } = setup();
    void session.search(query);
    await started();
    running[0]!.onFile(file(0));
    await Promise.resolve();
    running[0]!.onFile(file(1));
    session.cancel();
    expect(last()).toMatchObject({ status: "done", matchCount: 2 });
    expect(last().files).toHaveLength(2);
    const count = states.length;
    running[0]!.onFile(file(2));
    await vi.advanceTimersByTimeAsync(500);
    expect(states).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("invalidate() keeps pending files as stale rows", async () => {
    const { session, running, states, last } = setup();
    void session.search(query);
    await started();
    running[0]!.onFile(file(0));
    await Promise.resolve();
    running[0]!.onFile(file(1));
    session.invalidate();
    expect(last()).toMatchObject({ stale: true, matchCount: 0 });
    expect(last().files).toHaveLength(2);
    const count = states.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(states).toHaveLength(count);
  });

  it("a new search drops the superseded batch and its late events", async () => {
    const { session, running, last } = setup();
    void session.search(query);
    await started();
    running[0]!.onFile(file(0));
    await Promise.resolve();
    running[0]!.onFile(file(1));
    void session.search({ ...query, pattern: "other" });
    expect(last()).toMatchObject({ status: "validating", stale: true });
    // Retained (stale) rows include what had already streamed in.
    expect(last().files).toHaveLength(2);
    await started();
    running[0]!.onFile(file(2));
    running[1]!.onFile(file(10));
    await vi.advanceTimersByTimeAsync(100);
    expect(last().files.map((f) => f.relPath)).toEqual([file(10).relPath]);
    expect(last().query?.pattern).toBe("other");
  });

  it("dispose() clears the scheduled publish", async () => {
    const { session, running, states } = setup();
    void session.search(query);
    await started();
    running[0]!.onFile(file(0));
    await Promise.resolve();
    running[0]!.onFile(file(1));
    session.dispose();
    const count = states.length;
    running[0]!.onFile(file(2));
    await vi.advanceTimersByTimeAsync(500);
    expect(states).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("streams one file with 10,000 matches", async () => {
    const { session, running, last } = setup();
    void session.search(query);
    await started();
    running[0]!.onFile(file(0, 10_000));
    running[0]!.finish(summary(1, 10_000));
    await vi.advanceTimersByTimeAsync(0);
    expect(last()).toMatchObject({ status: "done", matchCount: 10_000 });
    expect(last().files[0]!.matches).toHaveLength(10_000);
  });
});
