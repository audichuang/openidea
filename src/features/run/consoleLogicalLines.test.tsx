import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { usePlatform } from "@/platform/platformInfo";
import { ConsoleModel, MAX_LINE_LENGTH } from "./console";
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

beforeEach(() => {
  usePlatform.setState({ os: "macos" });
  window.getSelection()?.removeAllRanges();
});

/** One physical line that the model cuts at 8,000 characters, in the middle of `t3boundary`. */
const PHYSICAL = `${"x".repeat(7_997)}t3boundary${"z".repeat(300)}`;

function setup(text = `before\n${PHYSICAL}\nafter\n`) {
  const model = new ConsoleModel();
  model.append({ kind: "stdout", text });
  model.flush();
  render(<ConsoleView model={model} version={1} softWrap={false} follow={false} onFollowChange={() => {}} cwd="/" />);
  return { model, log: screen.getByRole("log") };
}

describe("Run console lines cut at MAX_LINE_LENGTH (#452)", () => {
  it("still renders the cut line as two rows", () => {
    const { model } = setup();
    expect(model.lines.map((l) => l.text.length)).toEqual([6, MAX_LINE_LENGTH, PHYSICAL.length - MAX_LINE_LENGTH, 5]);
  });

  it("copies the physical line without a break at the cut", () => {
    const { model } = setup();
    expect(model.text()).toBe(`before\n${PHYSICAL}\nafter`);
    expect(
      model
        .textChunks()
        .map((c) => c.text)
        .join(""),
    ).toBe(`before\n${PHYSICAL}\nafter\n`);
  });

  it("copies a selection across the cut without a break", () => {
    const { log } = setup();
    const rows = log.querySelectorAll("[data-index]");
    const range = document.createRange();
    range.setStart(rows[1]!, 0);
    range.setEnd(rows[2]!, rows[2]!.childNodes.length);
    window.getSelection()!.addRange(range);
    expect(window.getSelection()!.toString()).toBe(`${PHYSICAL}\n`);
  });

  it("finds a string across the cut as one match, highlighted on both rows", () => {
    const { log } = setup();
    fireEvent.keyDown(log, { key: "f", code: "KeyF", metaKey: true });
    fireEvent.change(screen.getByRole("textbox", { name: "Find in console" }), { target: { value: "t3boundary" } });
    expect(screen.getByText("1/1")).toBeInTheDocument();
    const marks = [...log.querySelectorAll("[data-find-current]")];
    expect(marks.map((m) => m.textContent).join("")).toBe("t3boundary");
    expect(marks.map((m) => m.closest("[data-index]")?.getAttribute("data-index"))).toEqual(["1", "2"]);
  });

  it("counts a match across the cut and one after it once each", () => {
    const { log } = setup(`${"x".repeat(7_995)}needle needle${"z".repeat(10)}\n`);
    fireEvent.keyDown(log, { key: "f", code: "KeyF", metaKey: true });
    fireEvent.change(screen.getByRole("textbox", { name: "Find in console" }), { target: { value: "needle" } });
    expect(screen.getByText("1/2")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("search"), { key: "Enter" });
    expect(screen.getByText("2/2")).toBeInTheDocument();
    expect(log.querySelector('[data-index="1"] [data-find-current]')?.textContent).toBe("needle");
  });
});
