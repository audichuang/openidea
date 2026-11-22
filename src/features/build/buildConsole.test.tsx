import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { usePlatform } from "@/platform/platformInfo";
import { getAction, isActionEnabled, registerActions } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { bindingsFor, installKeyboardDispatcher, useKeymap } from "@/platform/keymap";
import { activate } from "./index";
import { BuildView } from "./BuildView";
import { applyBuildEvent, useBuildRun } from "./store";
import type { ConsoleLine } from "./model";

/** Like a real viewport scrolled to the end: only the last 30 rows are mounted. */
const MOUNTED = 30;
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 20,
    getVirtualItems: () =>
      Array.from({ length: Math.min(count, MOUNTED) }, (_, i) => {
        const index = count - Math.min(count, MOUNTED) + i;
        return { index, start: index * 20, size: 20, key: index };
      }),
    scrollToIndex: () => {},
    measureElement: () => {},
    measure: () => {},
  }),
}));

const clipboard = vi.hoisted(() => ({ writeText: vi.fn(async (_text: string) => {}) }));

const LINES: ConsoleLine[] = Array.from({ length: 2_500 }, (_, i) => ({
  kind: "out",
  text: `t3row${String(i).padStart(5, "0")} ${"x".repeat(20)}`,
}));
const ALL = LINES.map((l) => l.text).join("\n");

beforeEach(() => {
  usePlatform.setState({ os: "macos" });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
  clipboard.writeText.mockClear();
  useBuildRun.setState({ status: "success", lines: LINES, dropped: 0, messages: [], selected: null });
});
afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
});

function setup() {
  render(<BuildView />);
  const log = screen.getByRole("log", { name: "Build output" });
  log.focus();
  return log;
}

describe("Build output Select All + Copy (#452)", () => {
  it("copies every line after ⌘A / ⌘C, not only the mounted rows", () => {
    const log = setup();
    expect(log.firstElementChild!.children).toHaveLength(MOUNTED);
    fireEvent.keyDown(log, { key: "a", code: "KeyA", metaKey: true });
    fireEvent.keyDown(log, { key: "c", code: "KeyC", metaKey: true });
    expect(clipboard.writeText).toHaveBeenCalledWith(ALL);
  });

  it("keeps Edit › Select All to the output and copies every line on Edit › Copy", () => {
    const log = setup();
    // Edit › Select All (the native menu role, or execCommand on Windows/Linux) asks the body first.
    const selectStart = new Event("selectstart", { bubbles: true, cancelable: true });
    document.body.dispatchEvent(selectStart);
    expect(selectStart.defaultPrevented).toBe(true);
    const selection = window.getSelection()!;
    expect(log.contains(selection.anchorNode) && log.contains(selection.focusNode)).toBe(true);
    const setData = vi.fn();
    fireEvent.copy(log, { clipboardData: { setData } });
    expect(setData).toHaveBeenCalledWith("text/plain", ALL);
  });

  it("leaves Select All alone when the output does not have focus", () => {
    setup();
    document.body.focus();
    (document.activeElement as HTMLElement | null)?.blur();
    const selectStart = new Event("selectstart", { bubbles: true, cancelable: true });
    document.body.dispatchEvent(selectStart);
    expect(selectStart.defaultPrevented).toBe(false);
  });
});

describe("Build output Find (#452)", () => {
  let disposers: Array<() => void> = [];
  const inFile = vi.fn();
  beforeEach(() => {
    useKeymap.setState({ preset: "intellij-macos", overrides: {} });
    disposers = [
      activate(),
      registerActions([
        {
          id: "find.inFile",
          title: "Find",
          category: "Find",
          when: "textEditorActive && (editorFocus || !toolWindowFocus)",
          run: inFile,
        },
      ]),
      installKeyboardDispatcher(),
    ];
    // An editor is open, but focus is in the Build tool window.
    setContext("textEditorActive", true);
    setContext("toolWindowFocus", "build");
    useBuildRun.setState({ status: "success", lines: LINES, dropped: 0, messages: [], selected: null });
  });
  afterEach(() => {
    disposers.reverse().forEach((d) => d());
    setContext("textEditorActive", false);
    setContext("toolWindowFocus", null);
    inFile.mockClear();
  });

  const input = () => screen.getByRole("textbox", { name: "Find in build output" });

  it("is an action bound to ⌘F, enabled while the output has focus", () => {
    expect(bindingsFor("build.findInOutput")).toEqual(["Meta+F"]);
    const log = setup();
    expect(isActionEnabled(getAction("build.findInOutput")!)).toBe(true);
    log.blur();
    expect(isActionEnabled(getAction("build.findInOutput")!)).toBe(false);
  });

  it("opens on ⌘F in the output instead of the editor's Find, and searches every line", () => {
    const log = setup();
    fireEvent.keyDown(log, { key: "f", code: "KeyF", metaKey: true });
    expect(inFile).not.toHaveBeenCalled();
    expect(input()).toHaveFocus();
    // An early, unmounted line is found too.
    fireEvent.change(input(), { target: { value: "t3row00007" } });
    expect(screen.getByText("1/1")).toBeInTheDocument();
    fireEvent.change(input(), { target: { value: "t3row0249" } });
    expect(screen.getByText("1/10")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("search"), { key: "Enter", shiftKey: true });
    expect(screen.getByText("10/10")).toBeInTheDocument();
    expect(log.querySelector("[data-find-current]")?.textContent).toBe("t3row0249");
    expect(log.querySelectorAll("[data-find-match]")).toHaveLength(10);
  });

  it("closes on Escape and returns focus to the output", () => {
    const log = setup();
    fireEvent.keyDown(log, { key: "f", code: "KeyF", metaKey: true });
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(screen.queryByRole("search")).not.toBeInTheDocument();
    expect(log).toHaveFocus();
  });
});

describe("Build output line cap (#452)", () => {
  it("says how many earlier lines the 20,000-line cap discarded", () => {
    useBuildRun.setState({ status: "success", lines: [], dropped: 0, messages: [], selected: null });
    let text = "";
    for (let i = 0; i < 25_000; i++) text += `line ${i}\n`;
    useBuildRun.setState(applyBuildEvent(useBuildRun.getState(), { kind: "output", text, stderr: false }));
    expect(useBuildRun.getState().lines).toHaveLength(20_000);
    render(<BuildView />);
    expect(screen.getByText("5,000 earlier lines were discarded")).toBeInTheDocument();
  });

  it("shows no notice while nothing was discarded", () => {
    render(<BuildView />);
    expect(screen.queryByText(/earlier lines were discarded/)).not.toBeInTheDocument();
  });
});
