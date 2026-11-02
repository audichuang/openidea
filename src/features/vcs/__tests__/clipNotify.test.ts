import { beforeEach, describe, expect, it, vi } from "vitest";

const notify = vi.fn();
const call = vi.fn();
const readClipboardText = vi.fn(async () => "");

vi.mock("@/workbench/contributions", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/workbench/contributions")>();
  return { ...real, notifications: () => ({ notify: (n: unknown) => notify(n) }) };
});

vi.mock("@/platform/clipboard", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/clipboard")>();
  return { ...real, readClipboardText: () => readClipboardText() };
});

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    call: (p: unknown) => call(p),
    commands: { ...real.commands, clipCopy: (source: unknown) => ({ source }) },
  };
});

import { copyClip, pasteClip } from "../clip";

describe("ClipCode notifications use their own group", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readClipboardText.mockResolvedValue("");
  });

  it("reports an empty clipboard under the clipcode group, not vcs", async () => {
    await pasteClip();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ group: "clipcode", title: "The clipboard is empty" }),
    );
  });

  it("reports a failed ClipCode copy under the clipcode group", async () => {
    call.mockRejectedValue(new Error("boom"));
    await expect(copyClip({ kind: "files", paths: ["/p/a.txt"] })).resolves.toBe(false);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ group: "clipcode", level: "warning", title: "ClipCode copy failed" }),
    );
    expect(notify.mock.calls.every(([n]) => (n as { group: string }).group === "clipcode")).toBe(true);
  });
});
