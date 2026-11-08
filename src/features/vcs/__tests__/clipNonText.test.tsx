import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ClipCopyResult, ClipCopySource, ClipNonTextSummary, ClipPasteFile, ClipPastePreview } from "@/bindings";
import { commands } from "@/platform/ipc";

const notify = vi.fn();
const copied = vi.fn(async (_text: string) => {});
const call = vi.fn();
const ask = vi.fn();

vi.mock("@/workbench/contributions", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/workbench/contributions")>();
  return { ...real, notifications: () => ({ notify: (n: unknown) => notify(n) }) };
});
vi.mock("@/ui/selectableText", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/ui/selectableText")>();
  return { ...real, copyText: (t: string) => copied(t) };
});
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    call: (p: unknown) => call(p),
    commands: { ...real.commands, clipCopy: (source: unknown, nonText: string) => ({ source, nonText }) },
  };
});
vi.mock("../clipNonText", async (importOriginal) => {
  const real = await importOriginal<typeof import("../clipNonText")>();
  return { ...real, askNonText: (s: ClipNonTextSummary) => ask(s) };
});

import { copyClip, PastePreviewDialog } from "../clip";
import { ClipPastePane } from "../ClipPastePane";
import { NonTextDialog, formatBytes, pasteNonTextLabel, replayFileNote } from "../clipNonText";

const summary = (over: Partial<ClipNonTextSummary> = {}): ClipNonTextSummary => ({
  count: 0,
  totalBytes: 0,
  estimatedIncludeBytes: 0,
  files: [],
  overLimitCount: 0,
  exceedsPayloadCap: false,
  ...over,
});

const result = (text: string, nonText: ClipNonTextSummary, extra: Partial<ClipCopyResult> = {}): ClipCopyResult => ({
  text,
  mode: "files",
  files: 1,
  commits: 0,
  chars: text.length,
  lines: 1,
  words: 1,
  tokens: 1,
  skipped: 0,
  skippedSize: 0,
  skippedUnreadable: 0,
  truncated: false,
  fileLimit: 30,
  notify: true,
  nonText,
  nonTextCopied: 0,
  skippedUnreadablePaths: [],
  ...extra,
});

const found = summary({
  count: 2,
  totalBytes: 5000,
  estimatedIncludeBytes: 9000,
  files: [{ path: "img/a.png", size: 4000 }],
});
const source: ClipCopySource = { kind: "files", paths: ["/p/a.txt"] };

describe("copyClip non-text decision", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not ask when there are no non-text files", async () => {
    call.mockResolvedValueOnce(result("TEXT", summary()));
    await expect(copyClip(source)).resolves.toBe(true);
    expect(ask).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledTimes(1);
    expect(copied).toHaveBeenCalledWith("TEXT");
  });

  it("Exclude writes the first payload without a second call", async () => {
    call.mockResolvedValueOnce(result("EXCLUDED", found));
    ask.mockResolvedValueOnce("exclude");
    await expect(copyClip(source)).resolves.toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]![0]).toMatchObject({ nonText: "exclude" });
    expect(copied).toHaveBeenCalledWith("EXCLUDED");
  });

  it("Include copies again with Include and writes that payload", async () => {
    call.mockResolvedValueOnce(result("EXCLUDED", found));
    call.mockResolvedValueOnce(result("INCLUDED", found, { nonTextCopied: 2 }));
    ask.mockResolvedValueOnce("include");
    await expect(copyClip(source)).resolves.toBe(true);
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1]![0]).toMatchObject({ nonText: "include" });
    expect(copied).toHaveBeenCalledWith("INCLUDED");
    expect(notify.mock.calls[0]![0].title).toContain("2 non-text files copied as Base64");
  });

  it("Cancel writes nothing", async () => {
    call.mockResolvedValueOnce(result("EXCLUDED", found));
    ask.mockResolvedValueOnce("cancel");
    await expect(copyClip(source)).resolves.toBe(false);
    expect(call).toHaveBeenCalledTimes(1);
    expect(copied).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("lists up to 3 unreadable paths in the notice", async () => {
    call.mockResolvedValueOnce(
      result("T", summary(), { skippedUnreadable: 4, skippedUnreadablePaths: ["a", "b", "c", "d"] }),
    );
    await copyClip(source);
    const n = notify.mock.calls[0]![0];
    expect(n.body).toContain("Unreadable: a, b, c");
    expect(n.body).toContain("and 1 more");
    expect(n.body).not.toContain("d,");
  });
});

describe("NonTextDialog", () => {
  it("shows counts, sizes, the first ten paths and the rest", () => {
    const files = Array.from({ length: 12 }, (_, i) => ({ path: `img/${i}.png`, size: 2048 }));
    render(
      <NonTextDialog
        summary={summary({ count: 14, totalBytes: 28672, estimatedIncludeBytes: 40000, files, overLimitCount: 3 })}
        onChoose={() => {}}
      />,
    );
    expect(screen.getByText("14 non-text files, raw 28 KB")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(10);
    expect(screen.getByText("and 4 more")).toBeTruthy();
    expect(screen.getByText("3 non-text files are over the size limit and will not be copied.")).toBeTruthy();
  });

  it("reports the button pressed", () => {
    const onChoose = vi.fn();
    render(<NonTextDialog summary={found} onChoose={onChoose} />);
    fireEvent.click(screen.getByRole("button", { name: "Include" }));
    fireEvent.click(screen.getByRole("button", { name: "Exclude" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onChoose.mock.calls.map((c) => c[0])).toEqual(["include", "exclude", "cancel"]);
  });

  it("disables Include over the payload cap", () => {
    const onChoose = vi.fn();
    render(<NonTextDialog summary={summary({ ...found, exceedsPayloadCap: true })} onChoose={onChoose} />);
    const include = screen.getByRole("button", { name: "Include" }) as HTMLButtonElement;
    expect(include.disabled).toBe(true);
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(include);
    expect(onChoose).not.toHaveBeenCalled();
  });
});

describe("paste preview rows", () => {
  const nt = (action: string, identical: boolean, size = 4128): ClipPasteFile => ({
    index: 0,
    path: "img/logo.png",
    target: "/p/img/logo.png",
    action,
    reason: null,
    nonText: { size, identical },
  });

  it("labels non-text rows with size and identical or different", () => {
    expect(formatBytes(4128)).toBe("4.0 KB");
    expect(pasteNonTextLabel(nt("create", false))).toBe("Non-text file · 4.0 KB");
    expect(pasteNonTextLabel(nt("overwrite", false))).toBe("Non-text file · 4.0 KB · Different");
    expect(pasteNonTextLabel(nt("overwrite", true))).toBe("Non-text file · 4.0 KB · Identical");
    expect(pasteNonTextLabel({ ...nt("create", false), nonText: null })).toBeNull();
  });

  it("describes replay rows as non-text files, not binary", () => {
    const f = { path: "a.png", oldPath: null, change: "ADDED", action: "WRITE", overwrites: false };
    expect(replayFileNote({ ...f, reason: "BINARY", nonTextSize: 2048 })).toBe("Non-text file · 2.0 KB");
    expect(replayFileNote({ ...f, reason: "CORRUPT_NON_TEXT", nonTextSize: null })).toBe("Corrupt non-text file");
    expect(replayFileNote({ ...f, reason: null, nonTextSize: null })).toBeNull();
  });

  describe("pane and dialog", () => {
    beforeEach(() => {
      vi.stubGlobal("__TAURI_INTERNALS__", {});
      vi.spyOn(commands, "clipPastePreviewFile");
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    it("the pane shows the label and reads no content", () => {
      render(<ClipPastePane previewId={1} file={nt("overwrite", true)} />);
      expect(screen.getByText("Non-text file · 4.0 KB · Identical")).toBeTruthy();
      expect(commands.clipPastePreviewFile).not.toHaveBeenCalled();
    });

    it("the tree row carries the label", () => {
      const preview: ClipPastePreview = {
        id: 1,
        mode: "files",
        destination: "/p",
        files: [nt("create", false)],
        commits: [],
        suggestion: null,
        adjusted: false,
      };
      render(<PastePreviewDialog text="" target={{ dest: "/p", repo: null }} initial={preview} onClose={() => {}} />);
      expect(screen.getAllByText("Non-text file · 4.0 KB").length).toBeGreaterThan(0);
      expect(commands.clipPastePreviewFile).not.toHaveBeenCalled();
    });
  });
});
