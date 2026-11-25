import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { usePlatform } from "@/platform/platformInfo";
import { ConsoleModel } from "./console";
import { ConsoleView } from "./ConsoleView";
import * as linksModule from "./links";

const nav = vi.hoisted(() => ({
  openTarget: vi.fn(async () => {}),
  openUrl: vi.fn(async () => {}),
}));

vi.mock("./navigate", async () => {
  const actual = await vi.importActual<typeof import("./navigate")>("./navigate");
  return {
    ...actual,
    openTarget: nav.openTarget,
    openUrl: nav.openUrl,
  };
});

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 20,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, start: index * 20, size: 20, key: index })),
    scrollToIndex: () => {},
    measureElement: () => {},
    measure: () => {},
  }),
}));

beforeEach(() => {
  usePlatform.setState({ os: "macos" });
  nav.openTarget.mockClear();
  nav.openUrl.mockClear();
  window.getSelection()?.removeAllRanges();
});

describe("ConsoleView long lines and no-newline output", () => {
  it("keeps links clickable on 10 KiB lines and across streamed output chunks", () => {
    const model = new ConsoleModel();
    const longLine = `target.txt:1:1 ${"x".repeat(5_000)} mid/app.ts:9:4 ${"y".repeat(5_000)} tail.go:3\n`;
    model.append({ kind: "stdout", text: longLine });
    // Link split across two streamed chunks.
    model.append({ kind: "stdout", text: "error at src/spl" });
    model.append({ kind: "stdout", text: "it.rs:12:3 here\n" });

    render(
      <ConsoleView model={model} version={1} softWrap={false} follow={false} onFollowChange={() => {}} cwd="/p" />,
    );

    const targetLink = screen.getByRole("link", { name: "target.txt:1:1" });
    fireEvent.click(targetLink);
    expect(nav.openTarget).toHaveBeenCalledWith(expect.objectContaining({ path: "target.txt", line: 1, col: 1 }), "/p");

    const splitLink = screen.getByRole("link", { name: "src/split.rs:12:3" });
    fireEvent.click(splitLink);
    expect(nav.openTarget).toHaveBeenCalledWith(
      expect.objectContaining({ path: "src/split.rs", line: 12, col: 3 }),
      "/p",
    );
  });

  it("bounds mounted link and find-mark DOM nodes horizontally on wide no-lf lines without truncating text", () => {
    const model = new ConsoleModel();
    // Matches the real-app 100000-no-lf pattern: 63-char unit repeated without newlines -> 8,000-char lines.
    const unit = `target.txt:1:1 ${"x".repeat(47)} `;
    model.append({ kind: "stdout", text: unit.repeat(600) });
    expect(model.lines.length).toBeGreaterThanOrEqual(4);
    const fullFirstLine = model.lines[0]!.text;
    expect(fullFirstLine.length).toBe(8_000);

    const view = render(
      <ConsoleView model={model} version={1} softWrap={false} follow={false} onFollowChange={() => {}} cwd="/p" />,
    );
    const log = screen.getByRole("log");
    Object.defineProperty(log, "clientWidth", { configurable: true, value: 800 });
    Object.defineProperty(log, "scrollLeft", { configurable: true, writable: true, value: 0 });
    fireEvent.scroll(log);

    // Before Find: only the links in the visible horizontal window are mounted (not all 127).
    const firstRow = log.querySelector<HTMLElement>('[data-index="0"]')!;
    const linksBeforeFind = firstRow.querySelectorAll('[role="link"]').length;
    expect(linksBeforeFind).toBeGreaterThan(0);
    expect(linksBeforeFind).toBeLessThan(20);

    // Open Find and search "t" (produces 2,000+ matches across the first 4 wide lines).
    fireEvent.keyDown(log, { key: "f", code: "KeyF", metaKey: true });
    const input = screen.getByRole("textbox", { name: "Find in console" });
    fireEvent.change(input, { target: { value: "t" } });
    expect(screen.getByText("1/2000+")).toBeInTheDocument();

    // Full text stays intact in the DOM (no truncation).
    expect(firstRow.textContent).toBe(`${fullFirstLine}\n`);

    // Inline DOM nodes on the first 8,000-char line stay bounded to the horizontal viewport window
    // instead of mounting all 127 links and 500+ <mark> elements at once.
    const marksOnRow0 = firstRow.querySelectorAll("[data-find-match]").length;
    expect(marksOnRow0).toBeGreaterThan(0);
    expect(marksOnRow0).toBeLessThan(120);
    expect(firstRow.querySelectorAll("*").length).toBeLessThan(120);

    // Close Find and scroll horizontally into the middle of an 8,000-char line to verify links there become clickable.
    fireEvent.keyDown(input, { key: "Escape" });
    const midUnit = `mid/scrolled.ts:77:2 `;
    const model2 = new ConsoleModel();
    model2.append({ kind: "stdout", text: `${"a".repeat(3_500)} ${midUnit}${"b".repeat(4_000)}\n` });
    view.rerender(
      <ConsoleView model={model2} version={2} softWrap={false} follow={false} onFollowChange={() => {}} cwd="/p" />,
    );
    Object.defineProperty(log, "scrollLeft", { configurable: true, writable: true, value: 25_000 });
    fireEvent.scroll(log);
    const midLink = screen.getByRole("link", { name: "mid/scrolled.ts:77:2" });
    fireEvent.click(midLink);
    expect(nav.openTarget).toHaveBeenCalledWith(
      expect.objectContaining({ path: "mid/scrolled.ts", line: 77, col: 2 }),
      "/p",
    );
  });

  it("does not re-scan links on unchanged matched lines when new output streams with Find open", () => {
    const model = new ConsoleModel();
    model.append({ kind: "stdout", text: "src/a.ts:1:1 match here\nsrc/b.ts:2:2 match here\n" });
    const view = render(
      <ConsoleView model={model} version={1} softWrap={false} follow={false} onFollowChange={() => {}} cwd="/p" />,
    );
    const log = screen.getByRole("log");
    fireEvent.keyDown(log, { key: "f", code: "KeyF", metaKey: true });
    fireEvent.change(screen.getByRole("textbox", { name: "Find in console" }), { target: { value: "match" } });
    expect(screen.getByText("1/2")).toBeInTheDocument();

    const spy = vi.spyOn(linksModule, "findOutputLinks");
    try {
      model.append({ kind: "stdout", text: "plain trailing line\n" });
      view.rerender(
        <ConsoleView model={model} version={2} softWrap={false} follow={false} onFollowChange={() => {}} cwd="/p" />,
      );
      // Only the newly appended line should invoke findOutputLinks; lines 0 and 1 had identical marks and text.
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith("plain trailing line");
    } finally {
      spy.mockRestore();
    }
  });
});
