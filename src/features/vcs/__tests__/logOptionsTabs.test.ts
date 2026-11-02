import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Commit, LogQuery } from "@/bindings";
const log = vi.hoisted(() => vi.fn());
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsLog: (repo: string | null, query: LogQuery) => log(repo, query),
      vcsBranchInfo: () => Promise.resolve({ status: "ok", data: { upstream: null } }),
      vcsConfigGet: () => Promise.resolve({ status: "ok", data: null }),
    },
  };
});
import { emptyFilters, openLogTab, selectGitTab, updateLogOptions, useGitLog } from "../logStore";
import { DEFAULT_LOG_OPTIONS, setLogOptions } from "../logOptions";
import { useVcs } from "../store";

const commit = (id: string, parents: string[] = []): Commit => ({
  id,
  shortId: id,
  parents,
  refs: [],
  author: "a",
  email: "a@test",
  summary: id,
  message: id,
  timeMs: 0,
});

beforeEach(() => {
  setLogOptions({ ...DEFAULT_LOG_OPTIONS });
  useVcs.setState({ root: "/project", roots: ["/project"], repo: "/project" });
  useGitLog.setState({
    filters: emptyFilters(),
    commits: [],
    done: false,
    selection: [],
    selected: null,
    shownLog: "log",
    tab: "log",
    logTabs: [],
    generation: useGitLog.getState().generation + 1,
  });
  log.mockReset().mockResolvedValue({ status: "ok", data: [] });
});

describe("Log options across log tabs", () => {
  it("reloads a parked tab on return when a query option changed while it was parked", async () => {
    // Tab A (the history tab) loaded while No Merges was on.
    const tabA = openLogTab("history", "/project/a.ts");
    log.mockResolvedValue({ status: "ok", data: [commit("a1", ["a0"])] });
    updateLogOptions({ noMerges: true });
    await vi.waitFor(() => expect(useGitLog.getState().commits.map((c) => c.id)).toEqual(["a1"]));
    await vi.waitFor(() => expect(useGitLog.getState().loading).toBe(false));

    // Park A on the main Log, turn No Merges off there.
    selectGitTab("log");
    await vi.waitFor(() => expect(useGitLog.getState().loading).toBe(false));
    log.mockResolvedValue({ status: "ok", data: [commit("a1", ["a2"]), commit("a2")] });
    updateLogOptions({ noMerges: false });
    await vi.waitFor(() => expect(useGitLog.getState().loading).toBe(false));

    // Back to A: its stale rewritten-parent commits must not be reused.
    selectGitTab(tabA);
    await vi.waitFor(() => expect(useGitLog.getState().commits.map((c) => c.id)).toEqual(["a1", "a2"]));
    expect(useGitLog.getState().commits[0]!.parents).toEqual(["a2"]);
  });
});
