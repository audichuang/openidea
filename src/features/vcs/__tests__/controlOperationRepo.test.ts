/**
 * Continue / Abort with an explicit repository (the Git Graph's): the selection may change
 * while the status refreshes, and the command must still run in the repository asked for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const [APP, LIB] = ["/work/app", "/work/lib"];
/** Root → the operation the backend reports it stopped in. */
let operations: Record<string, string | null> = {};
let rootsGate: Promise<void> | null = null;
const vcsOperation = vi.fn(async (..._args: unknown[]) => ({ status: "ok", data: null }));

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
      vcsStatus: async () => ({ status: "ok", data: [] }),
      vcsOperation: (...args: unknown[]) => vcsOperation(...args),
      cancelRequest: async () => ({ status: "ok", data: null }),
    },
  };
});

import { provideNotificationService } from "@/workbench/contributions";
import { controlOperation } from "../operations";
import { refreshNow, useVcs } from "../store";

const vcs = useVcs.getState();
let notes: string[] = [];

beforeEach(async () => {
  notes = [];
  provideNotificationService({ notify: (n) => void notes.push(String(n.title)), expire: () => {} });
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

  it("acts on the selected repository without one", async () => {
    useVcs.setState({ repo: LIB });
    await controlOperation("abort", "rebase");
    expect(vcsOperation.mock.calls[0]![0]).toBe(LIB);
  });
});
