import { afterEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  docAutosave: vi.fn(),
  docSave: vi.fn(),
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...actual, commands: { ...actual.commands, docAutosave: ipc.docAutosave, docSave: ipc.docSave } };
});

import { ipcBackend } from "./backend";
import { useRemote } from "@/platform/remote";
import type { RemoteSession } from "@/platform/ipc";

afterEach(() => {
  useRemote.setState({ session: null });
  vi.clearAllMocks();
});

describe("ipcBackend.autosave", () => {
  it("saves as before on a remote server without doc_autosave, asking it only once", async () => {
    useRemote.setState({ session: { root: "/srv/app" } as unknown as RemoteSession });
    ipc.docAutosave.mockResolvedValue({
      status: "error",
      error: { kind: "protocol", message: "command doc_autosave is not available remotely" },
    });
    ipc.docSave.mockResolvedValue({ status: "ok", data: null });
    await expect(ipcBackend.autosave!(1)).resolves.toBe(true);
    await expect(ipcBackend.autosave!(1)).resolves.toBe(true);
    expect(ipc.docAutosave).toHaveBeenCalledTimes(1);
    expect(ipc.docSave).toHaveBeenCalledTimes(2);
  });

  it("keeps the guarded answer of a server that has it", async () => {
    ipc.docAutosave.mockResolvedValue({ status: "ok", data: false });
    await expect(ipcBackend.autosave!(1)).resolves.toBe(false);
    expect(ipc.docSave).not.toHaveBeenCalled();
  });
});
