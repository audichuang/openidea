/**
 * Continue / Abort with an explicit repository (the Git Graph's): the selection may change
 * while the status refreshes, and the command must still run in the repository asked for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const [APP, LIB] = ["/work/app", "/work/lib"];
/** Root → the operation the backend reports it stopped in. */
let operations: Record<string, string | null> = {};
let rootsGate: Promise<void> | null = null;
/** Roots with a conflicted file. */
let conflicted: string[] = [];
const vcsOperation = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ status: "ok", data: null }));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage: (line: string) => void = () => {};
  },
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsBranchInfo: async (repo: string | null) => ({
        status: "ok",
        data: {
          head: "main",
          headCommit: "a",
          upstream: null,
          ahead: 0,
          behind: 0,
          operation: operations[repo ?? APP] ?? null,
        },
      }),
      vcsRoots: async () => {
        await rootsGate;
        return {
          status: "ok",
          data: [APP, LIB].map((root) => ({
            root,
            operation: operations[root] ?? null,
            head: "main",
            headCommit: "a",
          })),
        };
      },
      vcsStatus: async () => ({
        status: "ok",
        data: conflicted.map((root) => ({
          path: `${root}/c.ts`,
          relPath: "c.ts",
          staged: null,
          unstaged: "conflicted",
          renamedFrom: null,
        })),
      }),
      vcsOperation: (...args: unknown[]) => vcsOperation(...args),
      cancelRequest: async () => ({ status: "ok", data: null }),
    },
  };
});

import { registerActions } from "@/platform/actions";
import { provideNotificationService } from "@/workbench/contributions";
import { controlOperation, stoppedActions } from "../operations";
import { refreshNow, useVcs } from "../store";

const vcs = useVcs.getState();
let notes: string[] = [];
/** Title → the links of that notification. */
let links: Record<string, string[]> = {};

beforeEach(async () => {
  notes = [];
  links = {};
  conflicted = [];
  provideNotificationService({
    notify: (n) => {
      notes.push(String(n.title));
      links[String(n.title)] = (n.actions ?? []).map((a) => a.label);
    },
    expire: () => {},
  });
  operations = { [APP]: "rebase", [LIB]: "rebase" };
  useVcs.setState({ available: true, root: APP, roots: [APP, LIB], repo: APP });
  await refreshNow();
});

afterEach(async () => {
  rootsGate = null;
  // The refresh a finished operation leaves running.
  await refreshNow();
  useVcs.setState(vcs);
  vcsOperation.mockClear();
});

describe("controlOperation with an explicit repository", () => {
  it("aborts in that repository when the selection changes while the status refreshes", async () => {
    let open = () => {};
    rootsGate = new Promise<void>((resolve) => (open = resolve));
    const done = controlOperation("abort", "rebase", APP);
    useVcs.setState({ repo: LIB });
    open();
    await done;
    expect(vcsOperation).toHaveBeenCalledTimes(1);
    expect(vcsOperation.mock.calls[0]![0]).toBe(APP);
    expect(vcsOperation.mock.calls[0]![2]).toEqual({ op: "abort" });
  });

  it("reads that repository's operation, not the selected one's", async () => {
    operations = { [APP]: null, [LIB]: "rebase" };
    useVcs.setState({ repo: LIB });
    await controlOperation("abort", "rebase", APP);
    expect(vcsOperation).not.toHaveBeenCalled();
    expect(notes).toContain("No rebase in progress");
  });

  it("keeps the failure balloon's Stage and Retry and Abort links on that repository", async () => {
    useVcs.setState({ repo: LIB });
    const links = stoppedActions(
      "rebase",
      "There are unstaged changes in tracked files preventing rebase from continuing",
      APP,
    );
    const idle = () => vi.waitFor(() => expect(useVcs.getState().remoteBusy).toBeNull());
    links.find((l) => l.label === "Stage and Retry")!.run();
    await vi.waitFor(() => expect(vcsOperation).toHaveBeenCalledTimes(1));
    expect(vcsOperation.mock.calls[0]![0]).toBe(APP);
    expect(vcsOperation.mock.calls[0]![2]).toEqual({ op: "stageAndContinue" });
    await idle();
    links.find((l) => l.label === "Abort")!.run();
    await vi.waitFor(() => expect(vcsOperation).toHaveBeenCalledTimes(2));
    expect(vcsOperation.mock.calls[1]![0]).toBe(APP);
    expect(vcsOperation.mock.calls[1]![2]).toEqual({ op: "abort" });
    await idle();
  });

  describe("when git refuses to continue", () => {
    const UNSTAGED = "There are unstaged changes in tracked files preventing rebase from continuing";
    const resolveConflicts = vi.fn();
    let off = () => {};

    beforeEach(() => {
      resolveConflicts.mockClear();
      off = registerActions([{ id: "vcs.resolveConflicts", title: "Resolve Conflicts", run: resolveConflicts }]);
    });
    afterEach(() => off());

    it("reports that repository's failure though another one has conflicts", async () => {
      conflicted = [LIB];
      vcsOperation.mockResolvedValueOnce({ status: "error", error: { kind: "other", message: UNSTAGED } });
      await controlOperation("continue", "rebase", APP);
      expect(vcsOperation.mock.calls[0]![0]).toBe(APP);
      expect(links["Continue Rebase failed"]).toEqual(["Stage and Retry", "Show Files", "Abort"]);
      expect(resolveConflicts).not.toHaveBeenCalled();
    });

    it("opens the conflicts instead when they are that repository's", async () => {
      // None before the command (Continue would stop there), its own once it stopped again.
      vcsOperation.mockImplementationOnce(async () => {
        conflicted = [APP];
        return { status: "error", error: { kind: "other", message: "could not apply" } };
      });
      await controlOperation("continue", "rebase", APP);
      expect(resolveConflicts).toHaveBeenCalled();
      expect(notes).not.toContain("Continue Rebase failed");
    });
  });

  it("acts on the selected repository without one", async () => {
    useVcs.setState({ repo: LIB });
    await controlOperation("abort", "rebase");
    expect(vcsOperation.mock.calls[0]![0]).toBe(LIB);
  });
});
