import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Commit, LogQuery } from "@/bindings";

const api = vi.hoisted(() => ({ log: vi.fn(), refs: vi.fn(), cancel: vi.fn(), choose: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsLog: (repo: string | null, query: LogQuery) => api.log(repo, query),
      vcsLogRefs: () => api.refs(),
      cancelRequest: (id: number) => api.cancel(id),
      vcsBranches: () => Promise.resolve({ status: "ok", data: [] }),
      vcsBranchInfo: () => Promise.resolve({ status: "ok", data: { upstream: null } }),
      vcsConfigGet: () => Promise.resolve({ status: "ok", data: null }),
      vcsOpenExternalLog: (repo: string) => Promise.resolve({ status: "ok", data: repo }),
    },
  };
});
const layouts = vi.hoisted(() => ({ count: 0 }));
vi.mock("../logPresentation", async (original) => {
  const real = await original<typeof import("../logPresentation")>();
  return {
    ...real,
    presentLogGraph: (...args: Parameters<typeof real.presentLogGraph>) => {
      layouts.count++;
      return real.presentLogGraph(...args);
    },
  };
});
vi.mock("../CommitChooser", () => ({ chooseLogCommit: (commits: Commit[]) => api.choose(commits) }));

import { commitKey } from "../multiRoot";
import { useVcs } from "../store";
import { DEFAULT_LOG_OPTIONS, useLogOptions } from "../logOptions";
import { emptyFilters, goToParent, PAGE, reloadLog, updateLogOptions, useGitLog } from "../logStore";

const c = (id: string, parents: string[] = [], refs: string[] = []): Commit => ({
  id,
  shortId: id,
  parents,
  refs,
  author: "A",
  email: "a@example.com",
  timeMs: 0,
  summary: id,
  message: id,
});
const ok = <T>(data: T) => ({ status: "ok" as const, data });

beforeEach(() => {
  api.log.mockReset().mockResolvedValue(ok([]));
  api.refs.mockReset().mockResolvedValue(ok({}));
  api.cancel.mockReset().mockResolvedValue(undefined);
  api.choose.mockReset().mockImplementation(async (commits: Commit[]) => commits[1]);
  useVcs.setState({ root: "/repo", repo: "/repo", roots: ["/repo"], branches: [] });
  useLogOptions.setState({ ...DEFAULT_LOG_OPTIONS });
  useGitLog.setState({
    shownLog: "log",
    tab: "log",
    logTabs: [],
    filters: emptyFilters(),
    commits: [],
    selection: [],
    selected: null,
    done: false,
    fragments: { expanded: new Set(), collapsed: new Set(), merges: new Set() },
    generation: useGitLog.getState().generation + 1,
  });
});

afterEach(async () => {
  api.log.mockResolvedValue(ok([]));
  await reloadLog();
});

describe("goToParent cost", () => {
  // A deep row's parent: finding it laid the whole graph out again for every loaded row.
  it("lays the graph out a bounded number of times however many rows are loaded", async () => {
    const n = 400;
    const commits = Array.from({ length: n }, (_, i) => c(`sha-${i}`, i + 1 < n ? [`sha-${i + 1}`] : []));
    useGitLog.setState({ commits, done: true });
    layouts.count = 0;
    await goToParent(commits[n - 2]!);
    expect(useGitLog.getState().selected).toBe(`sha-${n - 1}`);
    expect(layouts.count).toBeLessThan(10);
  });

  // With collapsed linear runs the visible parent moves as pages load: tip's parent is
  // "middle" until "middle" loads and folds away, then it is "base".
  it("re-reads the visible parents after each page", async () => {
    const history = [
      c("tip", ["middle"]),
      ...Array.from({ length: PAGE - 1 }, (_, i) => c(`pad-${i}`, i + 1 < PAGE - 1 ? [`pad-${i + 1}`] : [])),
      c("middle", ["base"]),
      c("base"),
    ];
    api.log.mockImplementation(async (_repo: string, q: LogQuery) => ok(history.slice(q.skip, q.skip + q.limit)));
    updateLogOptions({ collapseLinear: true });
    await reloadLog();
    expect(useGitLog.getState().commits).toHaveLength(PAGE);
    await goToParent(useGitLog.getState().commits[0]!);
    expect(api.log).toHaveBeenCalledTimes(2);
    expect(useGitLog.getState().selected).toBe(commitKey(useGitLog.getState().commits.at(-1)!));
  });
});
