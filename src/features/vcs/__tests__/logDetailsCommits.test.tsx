import type { Commit } from "@/bindings";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ commits: [] as Commit[] }));
const shown = vi.hoisted(() => ({ sizes: [] as number[] }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  const ok = <T,>(data: T) => Promise.resolve({ status: "ok" as const, data });
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsLog: (_repo: string, query: { skip: number; limit: number | null }) =>
        ok(api.commits.slice(query.skip, query.limit ? query.skip + query.limit : undefined)),
      vcsLogRefs: () => ok({}),
      vcsBranches: () => ok([]),
      vcsTags: () => ok([]),
      vcsBranchInfo: () => ok({ upstream: null }),
      vcsConfigGet: () => ok(null),
    },
  };
});
vi.mock("../log/CommitDetails", () => ({
  CommitDetails: ({ commits }: { commits: Commit[] }) => {
    shown.sizes.push(commits.length);
    return null;
  },
}));

import { LogView } from "../GitLog";
import { DEFAULT_LOG_OPTIONS, useLogOptions } from "../logOptions";
import { emptyFilters, useGitLog } from "../logStore";
import { useVcs } from "../store";

const commit = (i: number): Commit => ({
  id: `c${i}`,
  shortId: `c${i}`,
  parents: [`c${i + 1}`],
  refs: i ? [] : ["HEAD -> main"],
  author: "Author",
  email: "a@example.com",
  committer: "Author",
  committerEmail: "a@example.com",
  summary: `c${i}`,
  message: `c${i}`,
  messageTruncated: false,
  timeMs: 0,
  commitTimeMs: 0,
});

beforeEach(() => {
  api.commits = Array.from({ length: 600 }, (_, i) => commit(i));
  shown.sizes = [];
  useVcs.setState({
    root: "/repo",
    repo: "/repo",
    roots: ["/repo"],
    available: true,
    branchesLoaded: true,
    branches: [],
    branch: { head: "main", headCommit: "c0", upstream: null, ahead: 0, behind: 0, operation: null },
  });
  useGitLog.setState({
    shownLog: "log",
    tab: "log",
    logTabs: [],
    commits: [],
    filters: emptyFilters(),
    selection: [],
    selected: null,
    done: false,
    branchScope: "/repo",
    generation: useGitLog.getState().generation + 1,
  });
  useLogOptions.setState({ ...DEFAULT_LOG_OPTIONS, showBranches: false, showDetails: true });
});

describe("Git Log commit details", () => {
  // React's development build compares a component's old and new props on every render: a prop
  // holding every loaded commit made a Refresh of 50,000 commits stop the window for 0.3 s.
  it("are given the selected commits, not every loaded commit", async () => {
    render(<LogView />);
    await screen.findByRole("listbox", { name: "Commits" });
    await waitFor(() => expect(useGitLog.getState().commits.length).toBeGreaterThanOrEqual(300));
    useGitLog.setState({ selection: ["/repo\0c3"], selected: "/repo\0c3" });
    await waitFor(() => expect(shown.sizes.at(-1)).toBe(1));
    expect(Math.max(...shown.sizes)).toBeLessThanOrEqual(1);
  });
});
