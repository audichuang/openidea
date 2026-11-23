import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { usePlatform } from "@/platform/platformInfo";
import { ConsoleModel } from "./console";
import { ConsoleView } from "./ConsoleView";
import { revealScrollLeft, textOffsetPx } from "./links";

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

/**
 * Advances measured in Chromium and WebKit for 13px Menlo (the monospace fallback): ASCII 7.827px (1ch),
 * a CJK ideograph 13px (1em, not 2ch), an emoji 16px, a combining mark 0.
 */
const CH = 7.827;
function advance(text: string): number {
  let w = 0;
  for (const c of text) {
    const cp = c.codePointAt(0)!;
    if (cp >= 0x4e00 && cp <= 0x9fff) w += 13;
    else if (cp >= 0x1f300) w += 16;
    else if (cp >= 0x300 && cp <= 0x36f) w += 0;
    else w += CH;
  }
  return w;
}

describe("textOffsetPx", () => {
  it("adds measured advances, ASCII and wide characters alike", () => {
    expect(textOffsetPx("x".repeat(3_000), 3_000, advance)).toBeCloseTo(23_481, 0);
    expect(textOffsetPx("中".repeat(3_000) + "N", 3_000, advance)).toBe(39_000);
  });

  it("moves a tab to the next multiple of four spaces, as `tab-size: 4` draws it", () => {
    // Chromium and WebKit: "ab\tc" is 39.14px wide, "abcde\tc" 70.45px.
    expect(textOffsetPx("ab\tc", 4, advance)).toBeCloseTo(39.14, 1);
    expect(textOffsetPx("abcde\tc", 7, advance)).toBeCloseTo(70.45, 1);
  });

  it("measures emoji and combining marks by their drawn width", () => {
    expect(textOffsetPx("😀😀x", 4, advance)).toBe(32);
    expect(textOffsetPx("é".repeat(300), 600, advance)).toBeCloseTo(300 * CH, 3);
  });
});

describe("revealScrollLeft with a measured font (#477)", () => {
  const viewport = { scrollLeft: 0, clientWidth: 800 };
  const options = { charWidthPx: CH, paddingLeftPx: 12, measure: advance };

  it.each([
    ["3,000 CJK characters", "中".repeat(3_000)],
    ["3,000 ASCII characters", "x".repeat(3_000)],
    ["750 tabs", "\t".repeat(750)],
    ["300 emoji", "😀".repeat(300)],
    ["1,000 combined characters", "é".repeat(1_000)],
  ])("puts a match after %s inside the viewport", (_name, prefix) => {
    const text = `${prefix}CJKNEEDLE`;
    const start = prefix.length;
    const left = revealScrollLeft(text, start, start + 9, viewport, 13, options)!;
    const x = 12 + textOffsetPx(text, start, advance);
    expect(x).toBeGreaterThanOrEqual(left);
    expect(x + 9 * CH).toBeLessThanOrEqual(left + viewport.clientWidth);
  });
});

describe("Run console Find after wide characters (#477)", () => {
  let rectSpy: ReturnType<typeof vi.spyOn>;
  let measureSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    usePlatform.setState({ os: "macos" });
    rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const width = this.textContent === "0".repeat(100) ? 100 * CH : 0;
      return { width, height: 0, top: 0, left: 0, bottom: 0, right: width, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    const ctx = document.createElement("canvas").getContext("2d")!;
    measureSpy = vi.spyOn(ctx, "measureText").mockImplementation((t: string) => ({ width: advance(t) }) as TextMetrics);
  });
  afterEach(() => {
    rectSpy.mockRestore();
    measureSpy.mockRestore();
  });

  it("scrolls to CJKNEEDLE after 3,000 「中」, not 7,760px past it", () => {
    const model = new ConsoleModel();
    model.append({ kind: "stdout", text: `${"中".repeat(3_000)}CJKNEEDLE\n` });
    render(<ConsoleView model={model} version={1} softWrap={false} follow={false} onFollowChange={() => {}} cwd="/" />);
    const log = screen.getByRole("log");
    Object.defineProperty(log, "clientWidth", { configurable: true, value: 800 });
    Object.defineProperty(log, "scrollLeft", { configurable: true, writable: true, value: 0 });
    fireEvent.scroll(log);
    fireEvent.keyDown(log, { key: "f", code: "KeyF", metaKey: true });
    fireEvent.change(screen.getByRole("textbox", { name: "Find in console" }), { target: { value: "CJKNEEDLE" } });
    expect(screen.getByText("1/1")).toBeInTheDocument();
    const x = 12 + 3_000 * 13;
    expect(x).toBeGreaterThanOrEqual(log.scrollLeft);
    expect(x + 9 * CH).toBeLessThanOrEqual(log.scrollLeft + 800);
  });
});
