import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { usePlatform } from "@/platform/platformInfo";
import { ConsoleModel } from "./console";
import { ConsoleView } from "./ConsoleView";

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

/** 1ch = 8px: the probe of 100 zeros measures 800px. */
const CH = 8;
const PAD = 12;
let rectSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  usePlatform.setState({ os: "macos" });
  rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const width = this.textContent === "0".repeat(100) ? 100 * CH : 0;
    return { width, height: 0, top: 0, left: 0, bottom: 0, right: width, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
});
afterEach(() => rectSpy.mockRestore());

function setup(text: string, softWrap = false) {
  const model = new ConsoleModel();
  model.append({ kind: "stdout", text });
  render(
    <ConsoleView model={model} version={1} softWrap={softWrap} follow={false} onFollowChange={() => {}} cwd="/" />,
  );
  const log = screen.getByRole("log");
  Object.defineProperty(log, "clientWidth", { configurable: true, value: 800 });
  Object.defineProperty(log, "scrollLeft", { configurable: true, writable: true, value: 0 });
  fireEvent.scroll(log);
  return log;
}

function find(log: HTMLElement, query: string) {
  fireEvent.keyDown(log, { key: "f", code: "KeyF", metaKey: true });
  fireEvent.change(screen.getByRole("textbox", { name: "Find in console" }), { target: { value: query } });
}

/** Whether columns [start, end) of the line lie inside the horizontal viewport. */
function inView(log: HTMLElement, start: number, end: number) {
  const left = PAD + start * CH;
  const right = PAD + end * CH;
  return left >= log.scrollLeft && right <= log.scrollLeft + log.clientWidth;
}

describe("Run console find on a long line (#452)", () => {
  it("scrolls horizontally to a match at the end of a 7,000-character line", () => {
    const log = setup(`${"x".repeat(7_000)} uniquetail target.txt:1:1\n`);
    find(log, "uniquetail");
    expect(screen.getByText("1/1")).toBeInTheDocument();
    expect(inView(log, 7_001, 7_011)).toBe(true);
    expect(log.querySelector("[data-find-current]")?.textContent).toBe("uniquetail");
  });

  it("scrolls back left for a match near column 0, and leaves a visible match alone", () => {
    const log = setup(`head ${"x".repeat(7_000)} tail\n`);
    find(log, "tail");
    expect(inView(log, 7_006, 7_010)).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Find in console" }), { target: { value: "head" } });
    expect(log.scrollLeft).toBe(0);
  });

  it("does not scroll horizontally under soft wrap", () => {
    const log = setup(`${"x".repeat(7_000)} uniquetail\n`, true);
    find(log, "uniquetail");
    expect(log.scrollLeft).toBe(0);
  });
});
