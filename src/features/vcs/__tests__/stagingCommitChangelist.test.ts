import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, call: vi.fn() };
});

import { executeAction } from "@/platform/actions";
import { clearContext, setContext } from "@/platform/context";
import { useProject } from "@/platform/project";
import { useChangelists } from "../changelists";
import { commitChangelist, commitFiles } from "../changelistsUi";
import { useCommit } from "../commitStore";
import { registerHistoryActions } from "../historyActions";
import { trackStagingContext } from "../staging";
import { useVcs } from "../store";

const A = { path: "/p/a.ts", relPath: "a.ts", staged: "modified", unstaged: null, renamedFrom: null } as const;
const B = { path: "/p/b.ts", relPath: "b.ts", staged: "modified", unstaged: null, renamedFrom: null } as const;

function setStaging(on: boolean) {
  useProject.setState({ settings: { vcs: { git: { stagingArea: on }, commit: { nonModal: true } } } } as never);
}

let unregister: () => void = () => {};

beforeEach(() => {
  localStorage.clear();
  useVcs.setState({ available: true, root: "/p", repo: "/p", roots: ["/p"], status: [A, B] } as never);
  useCommit.setState({ selection: [], checks: new Map(), focusTick: 0 });
  useChangelists.setState({
    state: {
      lists: [
        { id: "default", name: "Changes", comment: "" },
        { id: "other", name: "Other", comment: "" },
      ],
      active: "default",
      files: { "a.ts": "default", "b.ts": "other" },
    },
  });
  setContext("vcsAvailable", true);
  unregister = registerHistoryActions();
});

afterEach(() => {
  unregister();
  setStaging(false);
  clearContext("vcsAvailable");
  clearContext("vcsStagingArea");
});

describe("narrowing a commit with the staging area", () => {
  // A commit takes the whole index, so inclusion checks would only pretend to narrow it.
  it("Commit Changelist… is unavailable and leaves the inclusion alone", async () => {
    setStaging(true);
    setContext("vcsStagingArea", true);
    expect(await executeAction("vcs.changelist.commit", "default")).toBe(false);
    expect(useCommit.getState().checks.size).toBe(0);
    expect(useCommit.getState().focusTick).toBe(0);
  });

  it("follows the staging area setting through the vcsStagingArea context key", async () => {
    const untrack = trackStagingContext();
    try {
      setStaging(true);
      expect(await executeAction("vcs.changelist.commit", "default")).toBe(false);
      setStaging(false);
      expect(await executeAction("vcs.changelist.commit", "default")).toBe(true);
    } finally {
      untrack();
    }
  });

  it("a stale Commit Changelist… call does not narrow the commit", () => {
    setStaging(true);
    expect(commitChangelist("default")).toBe(false);
    expect(useCommit.getState().checks.size).toBe(0);
  });

  it("a stale Commit File… call does not narrow the commit", () => {
    setStaging(true);
    expect(commitFiles(["/p/a.ts"])).toBe(false);
    expect(useCommit.getState().checks.size).toBe(0);
  });

  it("without the staging area Commit Changelist… still includes exactly that list", async () => {
    expect(await executeAction("vcs.changelist.commit", "default")).toBe(true);
    expect(Object.fromEntries(useCommit.getState().checks)).toEqual({ "/p/a.ts": "all", "/p/b.ts": "none" });
  });
});
