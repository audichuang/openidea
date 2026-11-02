import { beforeEach, describe, expect, it, vi } from "vitest";

// A dirty open file with autoSave on: disk content versions stand in for the freshness hash.
const doc = { dirty: true, disk: "old", buffer: "edited" };
const snapshots: string[] = [];
const events: string[] = [];

const saveAll = vi.fn(async () => {
  events.push("saveAll");
  doc.disk = doc.buffer;
  doc.dirty = false;
});
const readClipboardText = vi.fn(async () => "payload");
const openDialog = vi.fn(() => {
  events.push("openDialog");
  // Focus moves into the dialog: CodeMirror blurs and the controller autosaves a dirty buffer only.
  if (doc.dirty) {
    doc.disk = doc.buffer;
    doc.dirty = false;
  }
});

vi.mock("@/workbench/contributions", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/workbench/contributions")>();
  return {
    ...real,
    notifications: () => ({ notify: vi.fn() }),
    maybeEditorService: () => ({ saveAll }),
  };
});

vi.mock("@/platform/clipboard", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/clipboard")>();
  return { ...real, readClipboardText: () => readClipboardText() };
});

vi.mock("../dialogs", async (importOriginal) => {
  const real = await importOriginal<typeof import("../dialogs")>();
  return { ...real, openDialog: () => openDialog() };
});

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    call: (p: unknown) => p,
    commands: {
      ...real.commands,
      clipPastePreview: async () => {
        events.push("preview");
        snapshots.push(doc.disk);
        return { files: [], commits: [], mode: "files" };
      },
    },
  };
});

import { pasteClip } from "../clip";

describe("Paste and Restore over a dirty open file", () => {
  beforeEach(() => {
    doc.dirty = true;
    doc.disk = "old";
    snapshots.length = 0;
    events.length = 0;
    vi.clearAllMocks();
  });

  it("saves dirty documents before the preview snapshots the target, so Restore revalidates", async () => {
    await pasteClip({ dest: "/p", repo: null });
    expect(events).toEqual(["saveAll", "preview", "openDialog"]);
    // The blur autosave after the dialog opens found a clean buffer and wrote nothing.
    expect(doc.disk).toBe(snapshots[0]);
  });
});
