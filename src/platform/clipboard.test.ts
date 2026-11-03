import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "./ipc";
import { pasteClipboardFiles, readClipboardText, readPlainText, writeClipboardText } from "./clipboard";

beforeEach(() => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  // The webview reads the text, as on Windows; `readPlainText` covers the native read.
  vi.spyOn(commands, "clipboardText").mockResolvedValue({ status: "ok", data: null });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function transfer(text: string, files = true): DataTransfer {
  return { getData: () => text, files: [], types: files ? ["Files"] : ["text/plain"] } as unknown as DataTransfer;
}

const cases = [
  { name: "text present", text: "plain text", paths: ["/stale"], expected: "plain text", calls: 0 },
  {
    name: "files plus list",
    text: "",
    paths: ["/a b", "/中文", "C:\\folder"],
    expected: "/a b\n/中文\nC:\\folder",
    calls: 1,
  },
  { name: "files without list", text: "", paths: [], expected: "", calls: 1 },
  { name: "backend error", text: "", paths: null, expected: "", calls: 1 },
];

describe("clipboard text", () => {
  it.each(cases)("$name", async ({ text, paths, expected, calls }) => {
    const list = vi.spyOn(commands, "clipboardFileList");
    if (paths) list.mockResolvedValue({ status: "ok", data: paths });
    else list.mockRejectedValue(new Error("busy"));
    expect(await readClipboardText(transfer(text))).toBe(expected);
    expect(list).toHaveBeenCalledTimes(calls);
    list.mockClear();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: async () => text } });
    expect(await readClipboardText()).toBe(expected);
    expect(list).toHaveBeenCalledTimes(calls);
  });

  it("does not consult files for an empty text-only event or a browser", async () => {
    const list = vi.spyOn(commands, "clipboardFileList");
    expect(await readClipboardText(transfer("", false))).toBe("");
    vi.unstubAllGlobals();
    expect(await readClipboardText(transfer(""))).toBe("");
    expect(list).not.toHaveBeenCalled();
  });

  it("does not intercept text, already handled images, or an absent transfer", () => {
    const paste = vi.fn();
    for (const data of [transfer("text"), null]) {
      const event = new Event("paste", { cancelable: true }) as ClipboardEvent;
      Object.defineProperty(event, "clipboardData", { value: data });
      expect(pasteClipboardFiles(event, paste)).toBe(false);
    }
    const event = new Event("paste", { cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, "clipboardData", { value: transfer("") });
    event.preventDefault();
    expect(pasteClipboardFiles(event, paste)).toBe(false);
    expect(paste).not.toHaveBeenCalled();
  });
});

describe("clipboard writes", () => {
  it.each(["com.acme.A#run", "/p/src/A.java:5", "中文\n😀", ""])(
    "writes %j natively without browser activation",
    async (text) => {
      const native = vi.spyOn(commands, "clipboardWriteText").mockResolvedValue({ status: "ok", data: null });
      const browser = vi
        .fn()
        .mockRejectedValue(
          new DOMException(
            "The request is not allowed by the user agent or the platform in the current context",
            "NotAllowedError",
          ),
        );
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: browser } });
      await Promise.resolve();
      await writeClipboardText(text);
      expect(native).toHaveBeenCalledExactlyOnceWith(text);
      expect(browser).not.toHaveBeenCalled();
    },
  );

  it("reports native errors instead of claiming success", async () => {
    vi.spyOn(commands, "clipboardWriteText").mockResolvedValue({
      status: "error",
      error: { kind: "internal", message: "busy", data: null },
    });
    await expect(writeClipboardText("text")).rejects.toThrow("busy");
  });

  it("uses the browser clipboard outside Tauri", async () => {
    vi.unstubAllGlobals();
    const native = vi.spyOn(commands, "clipboardWriteText");
    const browser = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: browser } });
    await writeClipboardText("web preview");
    expect(browser).toHaveBeenCalledExactlyOnceWith("web preview");
    expect(native).not.toHaveBeenCalled();
  });
});

describe("plain text", () => {
  const webview = (text: string) => {
    const readText = vi.fn(async () => text);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText } });
    return readText;
  };

  it("reads natively in the app, without asking the webview", async () => {
    vi.spyOn(commands, "clipboardText").mockResolvedValue({ status: "ok", data: "// file: a.ts\na\n" });
    const readText = webview("webview");
    expect(await readPlainText()).toBe("// file: a.ts\na\n");
    expect(await readClipboardText()).toBe("// file: a.ts\na\n");
    expect(readText).not.toHaveBeenCalled();
  });

  it("falls through to the file list when the native read hides a file's name", async () => {
    vi.spyOn(commands, "clipboardText").mockResolvedValue({ status: "ok", data: "" });
    vi.spyOn(commands, "clipboardFileList").mockResolvedValue({ status: "ok", data: ["/p/a b.txt"] });
    const readText = webview("a b.txt");
    expect(await readClipboardText()).toBe("/p/a b.txt");
    expect(readText).not.toHaveBeenCalled();
  });

  it("uses the webview where the backend cannot read text, or outside the app", async () => {
    webview("webview");
    expect(await readPlainText()).toBe("webview");
    vi.unstubAllGlobals();
    const native = vi.spyOn(commands, "clipboardText");
    native.mockClear();
    expect(await readPlainText()).toBe("webview");
    expect(native).not.toHaveBeenCalled();
  });
});
