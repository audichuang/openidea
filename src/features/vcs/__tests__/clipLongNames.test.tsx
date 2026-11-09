import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ClipNonTextSummary, ClipPasteFile, ClipPastePreview, ClipReplayFile } from "@/bindings";

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, call: vi.fn(), commands: { ...real.commands, clipPastePreviewFile: vi.fn() } };
});

import { PastePreviewDialog } from "../clip";
import { ClipPastePane } from "../ClipPastePane";
import { NonTextDialog, replayFileNote, skipReasonText, visibleName } from "../clipNonText";
import { PathText } from "../PathText";
import { splitDir, splitFirstSegment } from "../fitText";
import { readFileSync } from "node:fs";

const names = [
  "name-alpha-0123456789-0123456789-0123456789-0123456789-first.png",
  "name-alpha-0123456789-0123456789-0123456789-0123456789-second.png",
  "name-alpha-0123456789-0123456789-0123456789-0123456789-third!.png",
];

describe("long names keep their end visible", () => {
  it("splits a path into folders and name", () => {
    expect(splitDir("a/b/c.png")).toEqual(["a/b/", "c.png"]);
    expect(splitDir("c.png")).toEqual(["", "c.png"]);
  });

  it("the pane title shows the file name's end next to its folders", () => {
    const path = `d11long/a-really-long-folder-name-that-fills-the-line/${names[1]}`;
    const file: ClipPasteFile = {
      index: 0,
      path,
      target: `/p/${path}`,
      action: "skip",
      reason: "NON_UTF8_TARGET",
      nonText: null,
    };
    const { container } = render(<ClipPastePane previewId={1} file={file} />);
    const title = container.querySelector("[title]")!;
    expect(title.getAttribute("title")).toBe(`/p/${path}`);
    expect(title.textContent).toBe(path);
    // The full text is what the box asks its width for; the shown text is fitted to that width.
    expect(title.getAttribute("data-full")).toBe(path);
    expect(screen.getByText("Skipped: Existing file is not UTF-8; not overwritten")).toBeTruthy();
  });

  it("tree rows and the dialog list show each long name as a fitted box", () => {
    const files: ClipPasteFile[] = names.map((n, i) => ({
      index: i,
      path: `static/${n}`,
      target: null,
      action: "create",
      reason: null,
      nonText: { size: 4096, identical: false },
    }));
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
    const fulls = [...document.querySelectorAll("[class*=nodeName] [data-full]")].map((e) =>
      e.getAttribute("data-full"),
    );
    expect(fulls.filter((f) => f!.startsWith("name-"))).toEqual(names);

    const summary: ClipNonTextSummary = {
      count: 3,
      totalBytes: 3,
      estimatedIncludeBytes: 10,
      files: names.map((n) => ({ path: `static/${n}`, size: 1 })),
      overLimitCount: 0,
      unreadOverLimitCount: 0,
      unreadLimitBytes: 1,
      exceedsPayloadCap: false,
      limitLeftOut: 10,
      limitLeftOutAtLeast: false,
      headerCannotBeEscaped: false,
    };
    const dialog = render(<NonTextDialog summary={summary} onChoose={() => {}} />);
    expect(dialog.getAllByText("Files left out by the file limit: 10")).toHaveLength(1);
    const dialogFulls = [...document.querySelectorAll("li [data-full]")].map((e) => e.getAttribute("data-full"));
    expect(new Set(dialogFulls).size).toBe(3);
    dialog.unmount();
    render(<PathText path="x/y.png" />);
  });
});

describe("reasons read as text, never as codes", () => {
  it("maps every code a preview can carry", () => {
    const codes = [
      "BINARY",
      "NON_UTF8",
      "NON_UTF8_PATH",
      "UNSUPPORTED_TYPE",
      "UNREADABLE",
      "NOT_COPIED",
      "UNSAFE_PATH",
      "NON_UTF8_TARGET",
      "CORRUPT_NON_TEXT",
      "ALREADY_ABSENT",
      "UNRESOLVED_PATH",
      "AMBIGUOUS_PATH",
      "PLACEHOLDER_BODY",
      "TARGET_NOT_FILE",
      "TARGET_COLLISION",
    ];
    for (const code of codes) expect(skipReasonText(code), code).not.toMatch(/^[A-Z_]+$/);
    expect(skipReasonText("NON_UTF8_TARGET")).toBe("Existing file is not UTF-8; not overwritten");
    expect(skipReasonText("BINARY")).toBe("Non-text file, not copied");
    expect(skipReasonText("TARGET_COLLISION")).toBe("Another entry maps to the same file; not applied");
  });

  it("a replayed row shows the reason text", () => {
    const f: ClipReplayFile = {
      path: "a.png",
      oldPath: null,
      change: "MODIFIED",
      action: "SKIP",
      overwrites: false,
      reason: "BINARY",
      nonTextSize: null,
    };
    expect(replayFileNote(f)).toBe("Non-text file, not copied");
    expect(replayFileNote({ ...f, reason: "NON_UTF8_TARGET" })).toBe("Existing file is not UTF-8; not overwritten");
  });

  it("shows control characters in a name", () => {
    expect(visibleName("tab\tname.txt")).toBe("tab\\tname.txt");
    expect(visibleName("back\\slash.txt")).toBe("back\\slash.txt");
  });
});

const css = readFileSync("src/features/vcs/clip.module.css", "utf8");

/** The declarations of one rule in the module's source (class names are unmangled there). */
function rule(selector: string): string {
  const m = new RegExp(`(?:^|\\n)${selector.replace(/[.[\]="]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css);
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[1]!;
}

describe("the file name has layout priority over folders, notes and badges", () => {
  const dir = `d3/${"a-really-long-folder-segment/".repeat(5)}`;
  const name = "pppp-sssssssssssssssssssssss-final.png";

  it("splits the folders into first segment and the rest", () => {
    expect(splitFirstSegment("d3/a/b/")).toEqual(["d3/", "a/b/"]);
    expect(splitFirstSegment("d3/")).toEqual(["d3/", ""]);
    expect(splitFirstSegment("")).toEqual(["", ""]);
    const { container } = render(<PathText path={`${dir}${name}`} />);
    expect(container.querySelector("[title]")!.textContent).toBe(`${dir}${name}`);
  });

  it("the box asks for the full text's width and shows a string cut in JS, not by CSS", () => {
    expect(rule(".fit")).toMatch(/overflow:\s*hidden/);
    expect(rule(".fit")).toMatch(/min-width:\s*0/);
    expect(rule(".fit::after")).toMatch(/content:\s*attr\(data-full\)/);
    expect(rule(".fit::after")).toMatch(/height:\s*0/);
    // CSS eliding is what drew half a letter or left a gap before the next text.
    expect(rule(".fit")).not.toMatch(/text-overflow/);
    expect(css).not.toMatch(/nameHead|nameTail/);
  });

  it("a badge and a note show whole or not at all in a preview row", () => {
    // The row wraps and clips its second line: an item that does not fit moves there whole, so none is ever
    // squeezed (no clipped word, partial number or sliver of padding). The name part is the first item and
    // the only one that shrinks; the badge comes before the note, so the note drops first.
    expect(rule(".nodeRow")).toMatch(/flex-wrap:\s*wrap/);
    expect(rule(".nodeRow")).toMatch(/overflow:\s*hidden/);
    expect(rule(".nodeMain")).toMatch(/min-width:\s*0/);
    for (const part of [".nodeRow > .badge", ".nodeNote"]) {
      expect(rule(part)).toMatch(/flex:\s*none/);
      expect(rule(part)).toMatch(/white-space:\s*nowrap/);
      expect(rule(part)).not.toMatch(/overflow/);
    }
    // No floor above the head and tail: the name may not keep a fixed width that clips its end.
    expect(rule(".nodeName")).toMatch(/min-width:\s*0/);
  });
});
