import { readFileSync } from "node:fs";
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

import { copyClip, PastePreviewDialog, reportPaste } from "../clip";
import { ClipPastePane } from "../ClipPastePane";
import {
  NonTextDialog,
  formatBytes,
  isUnchanged,
  pasteNonTextLabel,
  pasteRowNote,
  errorLineText,
  pasteRowTitle,
  replayFileNote,
  resolveNonText,
} from "../clipNonText";

const summary = (over: Partial<ClipNonTextSummary> = {}): ClipNonTextSummary => ({
  count: 0,
  totalBytes: 0,
  estimatedIncludeBytes: 0,
  files: [],
  overLimitCount: 0,
  unreadOverLimitCount: 0,
  unreadLimitBytes: 2097152,
  exceedsPayloadCap: false,
  limitLeftOut: 0,
  limitLeftOutAtLeast: false,
  headerCannotBeEscaped: false,
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
  skippedUnportable: 0,
  skippedUnportablePaths: [],
  skippedSymlinkDirs: 0,
  skippedSymlinkDirPaths: [],
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
    expect(notify.mock.calls[0]![0].title).toContain("Non-text files copied as Base64: 2");
  });

  it("after Include the notice says Unreadable, after Exclude it keeps the old wording", async () => {
    call.mockResolvedValueOnce(result("EXCLUDED", found, { skippedUnreadable: 2 }));
    call.mockResolvedValueOnce(result("INCLUDED", found, { nonTextCopied: 2, skippedUnreadable: 2 }));
    ask.mockResolvedValueOnce("include");
    await copyClip(source);
    expect(notify.mock.calls[0]![0].title).toContain("Unreadable: 2.");
    expect(notify.mock.calls[0]![0].title).not.toContain("non-text file or unreadable");

    notify.mockClear();
    call.mockResolvedValueOnce(result("EXCLUDED", found, { skippedUnreadable: 2 }));
    ask.mockResolvedValueOnce("exclude");
    await copyClip(source);
    expect(notify.mock.calls[0]![0].title).toContain("Skipped (non-text file or unreadable): 2.");
  });

  it("names unportable file names and symlinked folders apart from unreadable ones", async () => {
    call.mockResolvedValueOnce(
      result("TEXT", summary(), {
        skipped: 4,
        skippedUnportable: 3,
        skippedUnportablePaths: ["odd/back\\slash.txt", "odd/tab\tname.txt"],
        skippedSymlinkDirs: 1,
        skippedSymlinkDirPaths: ["odd/linkdir"],
      }),
    );
    await copyClip(source);
    const n = notify.mock.calls[0]![0];
    expect(n.title).toContain("Name not portable: 3.");
    expect(n.title).toContain("Symlinked folder not followed: 1.");
    expect(n.title).not.toContain("Unreadable");
    expect(n.body).toContain("Name not portable: odd/back\\slash.txt, odd/tab\\tname.txt");
    expect(n.body).toContain("Symlinked folder: odd/linkdir");
  });

  it("reports how many files the file limit left out", async () => {
    call.mockResolvedValueOnce(result("TEXT", summary({ limitLeftOut: 5 }), { truncated: true }));
    await copyClip(source);
    expect(notify.mock.calls[0]![0].title).toContain("File limit 30 reached, files left out: 5.");
  });

  it("asks when the Include result has non-text files after the limit", async () => {
    call.mockResolvedValueOnce(result("TEXT", summary({ ...found, limitLeftOut: 10 }), { truncated: true }));
    ask.mockResolvedValueOnce("exclude");
    await copyClip(source);
    expect(ask).toHaveBeenCalledOnce();
    // The count describes Include, so an Exclude result does not quote it.
    expect(notify.mock.calls[0]![0].title).toContain("File limit 30 reached.");
  });

  it("Exclude with only a size placeholder left is Nothing to copy", async () => {
    call.mockResolvedValueOnce(result("PLACEHOLDER", found, { files: 0 }));
    ask.mockResolvedValueOnce("exclude");
    await expect(copyClip(source)).resolves.toBe(false);
    expect(copied).not.toHaveBeenCalled();
    expect(notify.mock.calls[0]![0].title).toBe("Nothing to copy");
    expect(notify.mock.calls[0]![0].body).toBeUndefined();
  });

  it("a selection of only a symlinked folder is a Nothing to copy notice naming the folder", async () => {
    call.mockResolvedValueOnce(
      result("", summary(), { files: 0, skipped: 1, skippedSymlinkDirs: 1, skippedSymlinkDirPaths: ["d14/linkdir"] }),
    );
    await expect(copyClip(source)).resolves.toBe(false);
    const n = notify.mock.calls[0]![0];
    expect(n.title).toBe("Nothing to copy");
    expect(n.body).toContain("Symlinked folder: d14/linkdir");
    expect(JSON.stringify(n)).not.toMatch(/IpcError|symlinked folder not followed/);
  });

  it("names a commit the replay did not create in user text", () => {
    reportPaste(
      {
        created: 0,
        overwritten: 0,
        deleted: 0,
        skipped: 0,
        commits: ["abc"],
        errors: [],
        notCreated: [{ number: 1, subject: "rewrite legacy", reason: "NON_UTF8_TARGET" }],
        unchanged: 0,
        corruptNonText: [],
      },
      true,
    );
    const n = notify.mock.calls[0]![0];
    expect(n.level).toBe("warning");
    expect(n.body).toBe("Commit 1 (rewrite legacy) not created: Existing file is not UTF-8; not overwritten");
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
    expect(screen.getByText("Non-text files: 14, raw 28 KB")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(10);
    expect(screen.getByText("and 4 more")).toBeTruthy();
    expect(screen.getByText("Non-text files over the size limit (not copied): 3")).toBeTruthy();
  });

  it("pads its summary lines and mentions unread files over both limits", () => {
    const { container } = render(
      <NonTextDialog summary={summary({ ...found, unreadOverLimitCount: 2 })} onChoose={() => {}} />,
    );
    expect(screen.getByText("Not read, over 2.0 MB (copied as size placeholders): 2")).toBeTruthy();
    const body = screen.getByText("Non-text files: 2, raw 4.9 KB").parentElement!;
    expect(body.className).toMatch(/nonText/);
    expect(container.ownerDocument.body.contains(body)).toBe(true);
    // CSS modules are not applied in jsdom: the body rule itself must pad it.
    const css = readFileSync(`${process.cwd()}/src/features/vcs/clip.module.css`, "utf8");
    expect(/\.nonText \{[^}]*padding: 0 var\(--space-2\)/.test(css)).toBe(true);
    render(<NonTextDialog summary={found} onChoose={() => {}} />);
    expect(screen.getAllByText(/Not read, over/)).toHaveLength(1);
  });

  it("focuses Exclude when Include is unavailable, Include otherwise", () => {
    const { unmount } = render(
      <NonTextDialog summary={summary({ ...found, exceedsPayloadCap: true })} onChoose={() => {}} />,
    );
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Exclude" }));
    unmount();
    render(<NonTextDialog summary={found} onChoose={() => {}} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Include" }));
  });

  it("keeps the size on one line and the file name from shrinking (CSS)", () => {
    const css = readFileSync(`${process.cwd()}/src/features/vcs/clip.module.css`, "utf8");
    expect(/\.nonTextRow > \.note \{[^}]*flex: none;[^}]*white-space: nowrap/.test(css)).toBe(true);
    // The name has priority: a note, then a badge, wraps to the clipped second line whole instead of
    // shrinking; a long name keeps its end. The layout rules are asserted in clipLongNames.test.tsx.
    expect(/\.nodeName \{[^}]*flex: 0 1 auto;[^}]*min-width: 0/.test(css)).toBe(true);
    expect(/\.nodeNote \{[^}]*flex: none;[^}]*white-space: nowrap/.test(css)).toBe(true);
    expect(/\.nameTail \{[^}]*flex: none/.test(css)).toBe(true);
    expect(/\.badge\[data-action="corrupt"\] \{[^}]*var\(--danger\)/.test(css)).toBe(true);
  });

  it("reports the button pressed", () => {
    const onChoose = vi.fn();
    render(<NonTextDialog summary={found} onChoose={onChoose} />);
    fireEvent.click(screen.getByRole("button", { name: "Include" }));
    fireEvent.click(screen.getByRole("button", { name: "Exclude" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onChoose.mock.calls.map((c) => c[0])).toEqual(["include", "exclude", "cancel"]);
  });

  it("over the cap says more than 50 MB next to the raw total, never an estimate below it (case 26)", () => {
    const MB = 1024 * 1024;
    render(
      <NonTextDialog
        summary={summary({
          ...found,
          totalBytes: 54 * MB,
          estimatedIncludeBytes: 50 * MB + 1,
          exceedsPayloadCap: true,
        })}
        onChoose={() => {}}
      />,
    );
    expect(screen.getByText(/raw 54 MB/)).toBeTruthy();
    expect(screen.getByText("Payload with them: more than 50 MB")).toBeTruthy();
    expect(screen.queryByText(/about/)).toBeNull();
  });

  it("disables Include, with the reason, when the header format cannot be escaped (case 25)", async () => {
    const onChoose = vi.fn();
    render(<NonTextDialog summary={summary({ ...found, headerCannotBeEscaped: true })} onChoose={onChoose} />);
    const include = screen.getByRole("button", { name: "Include" }) as HTMLButtonElement;
    expect(include.disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toMatch(/header format/i);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Exclude" }));
    fireEvent.click(include);
    expect(onChoose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Exclude" }));
    expect(onChoose).toHaveBeenCalledWith("exclude");
    // A stale Include answer still yields the Exclude result.
    const first = result("x", summary({ ...found, headerCannotBeEscaped: true }));
    const again = vi.fn();
    expect(await resolveNonText(first, async () => "include", again)).toBe(first);
    expect(again).not.toHaveBeenCalled();
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

describe("write error lines", () => {
  it("shows user text with the path kept, never the OS message", () => {
    expect(errorLineText("ro/new.png: Folder is not writable")).toBe("ro/new.png: Folder is not writable");
    expect(errorLineText("a: b/c.png: The disk is full")).toBe("a: b/c.png: The disk is full");
    expect(errorLineText("other: text")).toBe("other: text");
  });

  it("translates the reason in zh and keeps the path", async () => {
    const { setLocale } = await import("@/platform/i18n");
    await setLocale("zh");
    try {
      expect(errorLineText("ro/new.png: Folder is not writable")).toBe("ro/new.png: 文件夹不可写");
    } finally {
      await setLocale("en");
    }
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

  it("tree rows show the size only, with the full wording as the tooltip", () => {
    expect(pasteRowNote(nt("overwrite", true))).toBe("4.0 KB");
    expect(pasteRowTitle(nt("overwrite", true))).toBe("Non-text file · 4.0 KB · Identical");
    const corrupt: ClipPasteFile = { ...nt("skip", false), nonText: null, reason: "CORRUPT_NON_TEXT" };
    expect(pasteRowNote(corrupt)).toBeNull();
    expect(pasteRowTitle(corrupt)).toBe("Corrupt non-text file");
    expect(pasteRowNote({ ...corrupt, reason: "BINARY" })).toBeNull();
    expect(isUnchanged(nt("overwrite", true))).toBe(true);
    expect(isUnchanged(nt("overwrite", false))).toBe(false);
  });

  it("describes replay rows as non-text files, not binary", () => {
    const f = { path: "a.png", oldPath: null, change: "ADDED", action: "WRITE", overwrites: false };
    expect(replayFileNote({ ...f, reason: "BINARY", nonTextSize: 2048 })).toBe("Non-text file · 2.0 KB");
    expect(replayFileNote({ ...f, reason: "CORRUPT_NON_TEXT", nonTextSize: null })).toBeNull();
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

    it("identical targets are Unchanged, checked, and not counted as overwrites", () => {
      const files: ClipPasteFile[] = [
        { ...nt("overwrite", true), index: 0, path: "same.png" },
        { ...nt("overwrite", false), index: 1, path: "diff.png" },
        { ...nt("overwrite", false), index: 2, path: "diff2.png" },
      ];
      const preview: ClipPastePreview = {
        id: 1,
        mode: "files",
        destination: "/p",
        files,
        commits: [],
        suggestion: null,
        adjusted: false,
      };
      render(<PastePreviewDialog text="" target={{ dest: "/p", repo: null }} initial={preview} onClose={() => {}} />);
      expect(screen.getByText("Unchanged")).toBeTruthy();
      expect(screen.getAllByText("Overwrite")).toHaveLength(2);
      expect(screen.getByRole("checkbox", { name: "Overwrite all 2 existing files" })).toBeTruthy();
      expect(screen.getByRole("checkbox", { name: "Restore same.png" }).getAttribute("aria-checked")).toBe("true");
      expect(screen.getByRole("checkbox", { name: "Restore diff.png" }).getAttribute("aria-checked")).toBe("false");
    });

    it("a corrupt non-text entry says so in the tree and the pane", () => {
      const corrupt: ClipPasteFile = {
        index: 0,
        path: "bad.png",
        target: null,
        action: "skip",
        reason: "CORRUPT_NON_TEXT",
        nonText: null,
      };
      const preview: ClipPastePreview = {
        id: 1,
        mode: "files",
        destination: "/p",
        files: [corrupt],
        commits: [],
        suggestion: null,
        adjusted: false,
      };
      render(<PastePreviewDialog text="" target={{ dest: "/p", repo: null }} initial={preview} onClose={() => {}} />);
      // The pane keeps the full reason; the tree row shows a badge, never an inline note that could collapse.
      expect(screen.getAllByText("Corrupt non-text file")).toHaveLength(1);
      const badge = screen.getByText("Corrupt");
      expect(badge.getAttribute("title")).toBe("Corrupt non-text file");
      expect(screen.queryByText("Skip")).toBeNull();
    });

    it("a long corrupt name keeps the full path and reason in its tooltip", () => {
      const path = "photos/holiday-photo-beach-2026.png";
      const corrupt: ClipPasteFile = {
        index: 0,
        path,
        target: null,
        action: "skip",
        reason: "CORRUPT_NON_TEXT",
        nonText: null,
      };
      const preview: ClipPastePreview = {
        id: 1,
        mode: "files",
        destination: "/p",
        files: [corrupt],
        commits: [],
        suggestion: null,
        adjusted: false,
      };
      render(<PastePreviewDialog text="" target={{ dest: "/p", repo: null }} initial={preview} onClose={() => {}} />);
      const name = [...document.querySelectorAll("[class*=nodeName]")].find((e) =>
        e.getAttribute("title")?.includes("Corrupt"),
      )!;
      expect(name.textContent).toBe("holiday-photo-beach-2026.png");
      expect(name.getAttribute("title")).toBe(`${path}\nCorrupt non-text file`);
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
      expect(screen.getAllByText("4.0 KB").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Non-text file · 4.0 KB").length).toBeGreaterThan(0);
      expect(commands.clipPastePreviewFile).not.toHaveBeenCalled();
    });
  });
});
