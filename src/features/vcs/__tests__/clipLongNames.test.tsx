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
import { PathText, splitDir, splitFirstSegment, splitTail } from "../PathText";
import { readFileSync } from "node:fs";

const names = [
  "name-alpha-0123456789-0123456789-0123456789-0123456789-first.png",
  "name-alpha-0123456789-0123456789-0123456789-0123456789-second.png",
  "name-alpha-0123456789-0123456789-0123456789-0123456789-third!.png",
];

describe("long names keep their end visible", () => {
  it("splits a long name into an eliding head and a whole tail", () => {
    const ends = names.map((n) => splitTail(n)[1]);
    expect(new Set(ends).size).toBe(3);
    for (const n of names) {
      const [head, tail] = splitTail(n);
      expect(head + tail).toBe(n);
      expect(tail.length).toBe(14);
    }
    // A short name is not split.
    expect(splitTail("logo.png")).toEqual(["logo.png", ""]);
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
    const tail = container.querySelector("[class*=nameTail]")!;
    expect(tail.textContent!.endsWith("-second.png")).toBe(true);
    expect(tail.textContent!.length).toBeLessThanOrEqual(14);
    expect(screen.getByText("Skipped: Existing file is not UTF-8; not overwritten")).toBeTruthy();
  });

  it("tree rows and the dialog list show each long name as head and tail", () => {
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
    const tails = [...document.querySelectorAll("[class*=nodeName] [class*=nameTail]")].map((e) => e.textContent);
    expect(new Set(tails).size).toBe(3);

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
    const dialogTails = [...document.querySelectorAll("li [class*=nameTail]")].map((e) => e.textContent);
    expect(new Set(dialogTails).size).toBe(3);
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
const shrink = (selector: string) => Number(/flex:\s*0\s+(\d+)\s+auto/.exec(rule(selector))?.[1]);

describe("the file name has layout priority over folders, notes and badges", () => {
  const dir = `d3/${"a-really-long-folder-segment/".repeat(5)}`;
  const name = "pppp-sssssssssssssssssssssss-final.png";

  it("splits a path into first segment, the rest of the folders and the name", () => {
    expect(splitFirstSegment("d3/a/b/")).toEqual(["d3/", "a/b/"]);
    expect(splitFirstSegment("d3/")).toEqual(["d3/", ""]);
    expect(splitFirstSegment("")).toEqual(["", ""]);
    const { container } = render(<PathText path={`${dir}${name}`} />);
    expect(container.querySelector("[class*=pathDirFirst]")!.textContent).toBe("d3/");
    expect(container.querySelector("[class*=pathDirRest]")!.textContent).toBe(dir.slice(3));
    // The whole name, extension included, is in the name part.
    expect(container.querySelector("[class*=pathName]")!.textContent).toBe(name);
    expect(container.querySelector("[title]")!.textContent).toBe(`${dir}${name}`);
  });

  it("elides a name longer than 20 characters in the middle and keeps a short one whole", () => {
    const long = "alpha-readable-name-28chars.png";
    expect(splitTail(long)).toEqual([long.slice(0, -14), long.slice(-14)]);
    expect(splitTail("12345678901234567890")).toEqual(["12345678901234567890", ""]);
    expect(splitTail("alpha.png")).toEqual(["alpha.png", ""]);
  });

  it("the folder part shrinks first, down to its first segment and an ellipsis", () => {
    expect(rule(".pathDirFirst")).toMatch(/flex:\s*none/);
    expect(rule(".pathDirRest")).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule(".pathDirRest")).toMatch(/min-width:\s*1em/);
    // Flex shrinks in proportion to factor x size: a factor this much larger leaves the name every
    // character until the folder part is at its minimum.
    expect(shrink(".pathDirRest")).toBeGreaterThanOrEqual(shrink(".pathName") * 1_000_000);
    expect(rule(".pathName")).toMatch(/min-width:\s*0/);
    expect(rule(".nameTail")).toMatch(/flex:\s*none/);
  });

  it("a note and then a badge shrink before the name in a preview row", () => {
    expect(shrink(".nodeNote")).toBeGreaterThan(shrink(".nodeRow > .badge"));
    expect(shrink(".nodeRow > .badge")).toBeGreaterThanOrEqual(shrink(".nodeName") * 1_000_000);
    expect(rule(".nodeRow > .badge")).toMatch(/min-width:\s*0/);
    // No floor above the head and tail: the name may not keep a fixed width that clips its end.
    expect(rule(".nodeName")).toMatch(/min-width:\s*0/);
  });
});
