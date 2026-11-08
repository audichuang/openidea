import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notify = vi.fn();
const call = vi.fn();
const copyText = vi.fn(async (_text: string) => undefined);
const readClipboardText = vi.fn(async () => "");
let activePath: string | null = null;
let openPaths: string[] = [];

vi.mock("@/workbench/contributions", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/workbench/contributions")>();
  return {
    ...real,
    notifications: () => ({ notify: (n: unknown) => notify(n) }),
    editorService: () => ({ activePath: () => activePath, openPaths: () => openPaths }),
  };
});

vi.mock("@/ui/selectableText", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/ui/selectableText")>();
  return { ...real, copyText: (t: string) => copyText(t) };
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
    commands: {
      ...real.commands,
      clipCopy: (source: unknown) => ({ source }),
      clipPastePreview: (...preview: unknown[]) => ({ preview }),
    },
  };
});

import { executeAction } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { menuGroupItems } from "@/workbench/contributions";
import { copyClip, registerClipActions } from "../clip";
import { useVcs } from "../store";

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
      nonText: { count: 0, files: [], overLimitCount: 0, exceedsPayloadCap: false },
      skippedUnreadablePaths: [],
      skippedUnportablePaths: [],
      skippedSymlinkDirPaths: [],
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

describe("ClipCode: Paste and Restore Files destination", () => {
  let unregister: () => void;
  beforeEach(() => {
    vi.clearAllMocks();
    readClipboardText.mockResolvedValue("// file: repo/src/a.ts\na\n");
    call.mockResolvedValue(null);
    useProject.setState({ project: { name: "m", root: "/m", trusted: true, isGit: false, settings: {} } as never });
    useVcs.setState({ root: "/m/repo", roots: ["/m/repo", "/m/other"], repo: "/m/other" });
    unregister = registerClipActions();
  });
  afterEach(() => {
    unregister();
    useProject.setState({ project: null });
    useVcs.setState({ root: null, roots: [], repo: null });
  });

  it("restores files under the project root and replays commits into the selected repository", async () => {
    await executeAction("clip.paste");
    await vi.waitFor(() =>
      expect(call).toHaveBeenCalledWith({
        preview: ["// file: repo/src/a.ts\na\n", "/m", "/m/other", false, ["/m/repo", "/m/other"]],
      }),
    );
  });

  it("ignores the folder it was invoked on (the Project view passes none, older callers did)", async () => {
    await executeAction("clip.paste", ["/m/repo/src"]);
    await vi.waitFor(() => expect(call).toHaveBeenCalled());
    expect(call).toHaveBeenCalledWith({ preview: expect.arrayContaining(["/m", "/m/other"]) });
    expect(call).not.toHaveBeenCalledWith({ preview: expect.arrayContaining(["/m/repo/src"]) });
  });
});

describe("ClipCode: Copy to Clipboard from a non-filesystem editor", () => {
  let unregister: () => void;
  beforeEach(() => {
    vi.clearAllMocks();
    call.mockResolvedValue({
      text: "x",
      mode: "files",
      files: 1,
      chars: 1,
      lines: 1,
      words: 1,
      tokens: 1,
      notify: false,
      nonText: { count: 0, files: [], overLimitCount: 0, exceedsPayloadCap: false },
      skippedUnreadablePaths: [],
      skippedUnportablePaths: [],
      skippedSymlinkDirPaths: [],
    });
    unregister = registerClipActions();
  });
  afterEach(() => unregister());

  it("says no files selected instead of copying a virtual document path", async () => {
    activePath = "jdt://contents/rt.jar/java.lang/String.class";
    await executeAction("clip.copyFiles");
    expect(call).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ group: "clipcode", level: "info", title: "No files selected." }),
    );
  });

  it("copies only filesystem paths among the open tabs", async () => {
    openPaths = ["/p/a.txt", "jdt://contents/String.class"];
    await executeAction("clip.copyOpenTabs");
    expect(call).toHaveBeenCalledWith({ source: { kind: "files", paths: ["/p/a.txt"] } });
    openPaths = [];
  });
});

describe("ClipCode: Copy to Clipboard with unreadable entries", () => {
  beforeEach(() => vi.clearAllMocks());

  it("counts and names the unreadable paths in the notice", async () => {
    call.mockResolvedValue({
      text: "x",
      mode: "files",
      files: 1,
      chars: 1,
      lines: 1,
      words: 1,
      tokens: 1,
      notify: true,
      skippedUnreadable: 3,
      nonText: { count: 0, files: [], overLimitCount: 0, exceedsPayloadCap: false },
      skippedUnreadablePaths: ["mix/dangling", "mix/locked.txt", "mix/locked_dir"],
      skippedUnportablePaths: [],
      skippedSymlinkDirPaths: [],
    });
    await expect(copyClip({ kind: "files", paths: ["/p/mix"] })).resolves.toBe(true);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining("Skipped (non-text file or unreadable): 3."),
        body: expect.stringContaining("Unreadable: mix/dangling, mix/locked.txt, mix/locked_dir"),
      }),
    );
  });
});
