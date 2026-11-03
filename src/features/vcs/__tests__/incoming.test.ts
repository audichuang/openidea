import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "@/bindings";
import { useProject } from "@/platform/project";
import { FIRST_DELAY, INCOMING_INTERVAL, fetchPlan, installIncomingCheck } from "../incoming";
import { useVcs } from "../store";

const h = vi.hoisted(() => ({
  fetch: vi.fn<(repo: string | null) => Promise<unknown>>(),
  notify: vi.fn(),
  refresh: vi.fn(() => Promise.resolve()),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (m: unknown) => void = () => undefined;
  },
}));
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    call: (p: Promise<unknown>) => p,
    commands: { ...real.commands, vcsRemote: (repo: string | null) => h.fetch(repo) },
  };
});
vi.mock("@/workbench/contributions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/workbench/contributions")>()),
  notifications: () => ({ notify: h.notify }),
}));
vi.mock("../store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../store")>()),
  refreshNow: h.refresh,
  loadBranches: () => Promise.resolve([]),
}));

const git = (g: Record<string, unknown>) =>
  useProject.setState({ settings: { vcs: { git: g } } as unknown as Settings });

describe("fetchPlan", () => {
  it("auto fetch runs on its own interval and ignores the incoming check's failure / mode", () => {
    expect(fetchPlan({ autoFetch: true, autoFetchMinutes: 30, incomingCheck: "never" }, true)).toEqual({
      interval: 30 * 60_000,
      auto: true,
    });
  });

  it("falls back to the incoming check: 15 minutes, stopped by never or a failed auto", () => {
    const off = { autoFetch: false, autoFetchMinutes: 30 };
    expect(fetchPlan({ ...off, incomingCheck: "auto" }, false)).toEqual({ interval: INCOMING_INTERVAL, auto: false });
    expect(fetchPlan({ ...off, incomingCheck: "auto" }, true)).toBeNull();
    expect(fetchPlan({ ...off, incomingCheck: "always" }, true)).toEqual({ interval: INCOMING_INTERVAL, auto: false });
    expect(fetchPlan({ ...off, incomingCheck: "never" }, false)).toBeNull();
  });
});

describe("installIncomingCheck", () => {
  let dispose: () => void = () => undefined;
  beforeEach(() => {
    vi.useFakeTimers();
    h.fetch.mockReset().mockResolvedValue(null);
    h.notify.mockReset();
    h.refresh.mockClear();
    useVcs.setState({ available: true, root: "/p", roots: ["/p/a", "/p/b"], repo: "/p/a", remoteBusy: null });
  });
  afterEach(() => {
    dispose();
    vi.useRealTimers();
  });

  it("fetches every repository on the configured interval and refreshes afterwards", async () => {
    git({ autoFetch: true, autoFetchMinutes: 30, incomingCheck: "never" });
    dispose = installIncomingCheck();
    await vi.advanceTimersByTimeAsync(FIRST_DELAY);
    expect(h.fetch.mock.calls.map((c) => c[0])).toEqual(["/p/a", "/p/b"]);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30 * 60_000 - 1);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetch).toHaveBeenCalledTimes(4);
  });

  it("warns once per streak of failures and keeps fetching", async () => {
    git({ autoFetch: true, autoFetchMinutes: 5, incomingCheck: "auto" });
    useVcs.setState({ roots: ["/p"], repo: "/p" });
    h.fetch.mockRejectedValue(new Error("offline"));
    dispose = installIncomingCheck();
    await vi.advanceTimersByTimeAsync(FIRST_DELAY + 2 * 5 * 60_000);
    expect(h.fetch).toHaveBeenCalledTimes(3);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0]![0]).toMatchObject({ level: "warning", title: "Automatic fetch failed" });
    // A success ends the streak; the next failure warns again.
    h.fetch.mockResolvedValueOnce(null);
    await vi.advanceTimersByTimeAsync(2 * 5 * 60_000);
    expect(h.notify).toHaveBeenCalledTimes(2);
  });

  it("skips a round while another remote operation runs", async () => {
    git({ autoFetch: true, autoFetchMinutes: 10, incomingCheck: "never" });
    useVcs.setState({ remoteBusy: "Pushing" });
    dispose = installIncomingCheck();
    await vi.advanceTimersByTimeAsync(FIRST_DELAY);
    expect(h.fetch).not.toHaveBeenCalled();
    useVcs.setState({ remoteBusy: null });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("does nothing with auto fetch off and the incoming check set to never", async () => {
    git({ autoFetch: false, incomingCheck: "never" });
    dispose = installIncomingCheck();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(h.fetch).not.toHaveBeenCalled();
  });
});
