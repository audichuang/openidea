import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notify = vi.fn();
const call = vi.fn();
const copyText = vi.fn(async (_text: string) => undefined);
let activePath: string | null = null;

vi.mock("@/workbench/contributions", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/workbench/contributions")>();
  return {
    ...real,
    notifications: () => ({ notify: (n: unknown) => notify(n) }),
    editorService: () => ({ activePath: () => activePath }),
  };
});

vi.mock("@/ui/selectableText", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/ui/selectableText")>();
  return { ...real, copyText: (t: string) => copyText(t) };
});

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    call: (p: unknown) => call(p),
    commands: { ...real.commands, clipCopy: (source: unknown) => ({ source }) },
  };
});

import { executeAction } from "@/platform/actions";
import { menuGroupItems } from "@/workbench/contributions";
import { registerClipActions } from "../clip";

describe("ClipCode: Copy to Clipboard without an argument", () => {
  let unregister: () => void;
  beforeEach(() => {
    vi.clearAllMocks();
    activePath = null;
    call.mockResolvedValue({
      text: "x",
      mode: "files",
      files: 1,
      chars: 1,
      lines: 1,
      words: 1,
      tokens: 1,
      notify: false,
    });
    unregister = registerClipActions();
  });
  afterEach(() => unregister());

  it("copies the focused editor's file", async () => {
    activePath = "/p/a.txt";
    await executeAction("clip.copyFiles");
    expect(call).toHaveBeenCalledWith({ source: { kind: "files", paths: ["/p/a.txt"] } });
  });

  it("prefers the paths it was given", async () => {
    activePath = "/p/a.txt";
    await executeAction("clip.copyFiles", ["/p/b.txt"]);
    expect(call).toHaveBeenCalledWith({ source: { kind: "files", paths: ["/p/b.txt"] } });
  });

  it("says so when there is no file either", async () => {
    await executeAction("clip.copyFiles");
    expect(call).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ group: "clipcode", level: "info", title: "No files selected." }),
    );
  });
});

describe("ClipCode in the editor context menu", () => {
  let unregister: () => void;
  beforeEach(() => {
    unregister = registerClipActions();
  });
  afterEach(() => unregister());

  it("offers Copy to Clipboard for the current file and Paste and Restore Files", () => {
    const items = menuGroupItems("editor", { paths: ["/p/a.txt"] });
    expect(items).toEqual([
      { kind: "action", action: "clip.copyFiles", arg: ["/p/a.txt"] },
      { kind: "action", action: "clip.paste" },
      { kind: "separator" },
    ]);
  });

  it("offers nothing for a virtual document", () => {
    expect(menuGroupItems("editor", { paths: ["jar:file:///x.jar!/A.class"] })).toEqual([]);
  });
});
