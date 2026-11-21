import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import type { HttpExchange } from "@/platform/ipc";
import { DEFAULT_FIND_OPTIONS, findInLines } from "@/ui/consoleFind";

vi.mock("./store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./store")>()),
  refreshHistory: vi.fn(async () => {}),
}));
vi.mock("./format", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./format")>();
  return { ...actual, prettyBody: vi.fn(actual.prettyBody) };
});

const format = await import("./format");
const { useHttpClient } = await import("./store");
const { HttpClientView } = await import("./HttpClientView");

/** Stands in for the formatting worker: records what it was asked and answers on demand. */
class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: MessageEvent<string>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  posted: Array<{ kind: string; body: string }> = [];
  terminated = false;
  constructor(readonly url: URL | string) {
    FakeWorker.all.push(this);
  }
  postMessage(data: { kind: string; body: string }) {
    this.posted.push(data);
  }
  terminate() {
    this.terminated = true;
  }
  /** Formats what was posted, as the real worker does. */
  answer() {
    const { kind, body } = this.posted[0]!;
    act(() => this.onmessage?.({ data: format.prettyBody(kind as never, body) } as MessageEvent<string>));
  }
  fail() {
    act(() => this.onerror?.({} as ErrorEvent));
  }
}

function exchangeWith(body: string, contentType: string, truncated = false): HttpExchange {
  return {
    entry: {
      id: "e1",
      timeMs: 0,
      name: null,
      method: "GET",
      url: "http://x/api",
      status: 200,
      totalMs: 5,
      file: null,
      error: null,
    },
    request: { name: null, method: "GET", url: "http://x/api", headers: [], body: null },
    response: {
      status: 200,
      statusText: "OK",
      version: "HTTP/1.1",
      headers: [["content-type", contentType]],
      contentType,
      body,
      size: body.length,
      truncated,
      ttfbMs: 1,
      totalMs: 5,
    },
  };
}

function show(ex: HttpExchange) {
  useHttpClient.setState({ history: [ex.entry], exchanges: { e1: ex }, selected: "e1" });
  return render(<HttpClientView />);
}

/** ~`n` records of single-line JSON, the last named `last-item`. */
function minifiedJson(n: number): string {
  const items = Array.from({ length: n }, (_, i) => ({ id: i, name: `item-${i}`, tags: ["a", "b"] }));
  items.push({ id: n, name: "last-item", tags: [] });
  return JSON.stringify(items);
}

function editorOf(el: Element): EditorView {
  const view = EditorView.findFromDOM(el as HTMLElement);
  if (!view) throw new Error("the response body is not an editor view");
  return view;
}

/**
 * The body shown. A new view gets a long line on screen after its first
 * measure (a frame later), so this waits for it.
 */
async function expectBody(text: string) {
  await vi.waitFor(() => expect(editorOf(screen.getByLabelText("Response body")).state.doc.toString()).toBe(text));
}

describe("HTTP Client large responses", () => {
  beforeEach(() => {
    FakeWorker.all = [];
    vi.stubGlobal("Worker", FakeWorker);
    Element.prototype.scrollIntoView ??= () => {};
    vi.mocked(format.prettyBody).mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    useHttpClient.setState({ history: [], exchanges: {}, selected: null });
  });

  it("formats a large body in a worker, not on the main thread", () => {
    const body = minifiedJson(20_000);
    expect(body.length).toBeGreaterThan(256_000);
    show(exchangeWith(body, "application/json"));
    expect(vi.mocked(format.prettyBody)).not.toHaveBeenCalled();
    expect(FakeWorker.all).toHaveLength(1);
    expect(FakeWorker.all[0]!.posted).toEqual([{ kind: "json", body }]);
    expect(screen.getByLabelText("Formatting")).toBeTruthy();
    FakeWorker.all[0]!.answer();
    const view = editorOf(screen.getByLabelText("Response body"));
    expect(view.state.doc.toString()).toBe(format.prettyJson(body));
  });

  it("mounts only part of a large body, with the whole text in the view", () => {
    const body = Array.from({ length: 20_000 }, (_, i) => `${i} INFO processed order item-${i}`).join("\n");
    show(exchangeWith(body, "text/plain"));
    const el = screen.getByLabelText("Response body");
    expect((el.textContent ?? "").length).toBeLessThan(body.length / 10);
    expect(editorOf(el).state.doc.toString()).toBe(body);
  });

  it("formats small bodies at once, without a worker", () => {
    show(exchangeWith('{"a":[1,2]}', "application/json"));
    expect(FakeWorker.all).toHaveLength(0);
    expect(editorOf(screen.getByLabelText("Response body")).state.doc.toString()).toBe(
      '{\n  "a": [\n    1,\n    2\n  ]\n}',
    );
  });

  it("cancels formatting when switched to Raw, and keeps the result once formatted", async () => {
    const body = minifiedJson(20_000);
    show(exchangeWith(body, "application/json"));
    const first = FakeWorker.all[0]!;
    fireEvent.click(screen.getByRole("button", { name: "Show Raw" }));
    expect(first.terminated).toBe(true);
    await expectBody(body);
    fireEvent.click(screen.getByRole("button", { name: "Show Formatted" }));
    expect(FakeWorker.all).toHaveLength(2);
    FakeWorker.all[1]!.answer();
    const pretty = format.prettyJson(body);
    expect(editorOf(screen.getByLabelText("Response body")).state.doc.toString()).toBe(pretty);
    // Back and forth again: no more formatting.
    fireEvent.click(screen.getByRole("button", { name: "Show Raw" }));
    fireEvent.click(screen.getByRole("button", { name: "Show Formatted" }));
    expect(FakeWorker.all).toHaveLength(2);
    expect(editorOf(screen.getByLabelText("Response body")).state.doc.toString()).toBe(pretty);
  });

  it("offers Find only once a body being formatted is shown", () => {
    show(exchangeWith(minifiedJson(20_000), "application/json"));
    const find = screen.getByRole("button", { name: /^Find/ });
    expect(find).toHaveProperty("disabled", true);
    fireEvent.click(find);
    const pane = screen.getByLabelText("Formatting").closest<HTMLElement>("[data-selection-scope]")!;
    fireEvent.keyDown(pane, { key: "f", metaKey: true, ctrlKey: true });
    expect(find.getAttribute("aria-pressed")).not.toBe("true");
    FakeWorker.all[0]!.answer();
    expect(find).toHaveProperty("disabled", false);
  });

  it("brings the open find bar back focused once the body switched to is formatted", async () => {
    const body = minifiedJson(20_000);
    show(exchangeWith(body, "application/json"));
    fireEvent.click(screen.getByRole("button", { name: "Show Raw" }));
    await expectBody(body);
    fireEvent.keyDown(screen.getByLabelText("Response body"), { key: "f", metaKey: true, ctrlKey: true });
    expect(screen.getByLabelText("Find in response", { selector: "input" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show Formatted" }));
    expect(screen.getByLabelText("Formatting")).toBeTruthy();
    expect(screen.queryByLabelText("Find in response", { selector: "input" })).toBeNull();
    FakeWorker.all[1]!.answer();
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("Find in response", { selector: "input" })),
    );
  });

  it("stops formatting when the response is closed", () => {
    const { unmount } = show(exchangeWith(minifiedJson(20_000), "application/json"));
    unmount();
    expect(FakeWorker.all[0]!.terminated).toBe(true);
  });

  it("shows the body as received when the worker fails", async () => {
    const body = minifiedJson(20_000);
    show(exchangeWith(body, "application/json"));
    FakeWorker.all[0]!.fail();
    await expectBody(body);
  });

  it("keeps the find marks right when switching between Formatted and Raw", async () => {
    const body = minifiedJson(50);
    show(exchangeWith(body, "application/json"));
    fireEvent.keyDown(screen.getByLabelText("Response body"), { key: "f", metaKey: true, ctrlKey: true });
    act(() => {
      fireEvent.change(screen.getByLabelText("Find in response", { selector: "input" }), {
        target: { value: "last-item" },
      });
    });
    const current = () => screen.getByLabelText("Response body").querySelector("[data-find-current]")?.textContent;
    expect(current()).toBe("last-item");
    // Formatted: far down; Raw: one line. The marks follow each text.
    fireEvent.click(screen.getByRole("button", { name: "Show Raw" }));
    await expectBody(body);
    expect(screen.getByText("1/1")).toBeTruthy();
    expect(current()).toBe("last-item");
    fireEvent.click(screen.getByRole("button", { name: "Show Formatted" }));
    await expectBody(format.prettyJson(body));
    expect(current()).toBe("last-item");
  });

  it("finds every match of a large formatted body, the last line included", () => {
    const body = minifiedJson(20_000);
    show(exchangeWith(body, "application/json"));
    FakeWorker.all[0]!.answer();
    const el = screen.getByLabelText("Response body");
    fireEvent.keyDown(el, { key: "f", metaKey: true, ctrlKey: true });
    const input = screen.getByLabelText("Find in response", { selector: "input" });
    act(() => {
      fireEvent.change(input, { target: { value: "last-item" } });
    });
    expect(screen.getByText("1/1")).toBeTruthy();
    const pretty = format.prettyJson(body);
    const expected = findInLines(
      pretty.split("\n").map((text, id) => ({ id, text })),
      "last-item",
      DEFAULT_FIND_OPTIONS,
    );
    expect(expected.matches).toHaveLength(1);
    // The same count and overflow as the console find over the same lines.
    act(() => {
      fireEvent.change(input, { target: { value: "item-" } });
    });
    const many = findInLines(
      pretty.split("\n").map((text, id) => ({ id, text })),
      "item-",
      DEFAULT_FIND_OPTIONS,
    );
    expect(many.overflow).toBe(true);
    expect(screen.getByText(`1/${many.matches.length}+`)).toBeTruthy();
  });

  it("searches a plain query in one pass over the body, not line by line", () => {
    const body = Array.from({ length: 20_000 }, (_, i) => `${i} INFO processed order item-${i}`).join("\n");
    show(exchangeWith(`${body}\nlast-item`, "text/plain"));
    fireEvent.keyDown(screen.getByLabelText("Response body"), { key: "f", metaKey: true, ctrlKey: true });
    const input = screen.getByLabelText("Find in response", { selector: "input" });
    const exec = vi.spyOn(RegExp.prototype, "exec");
    try {
      act(() => {
        fireEvent.change(input, { target: { value: "last-item" } });
      });
      expect(screen.getByText("1/1")).toBeTruthy();
      // One search of 20,001 lines: not one run of the query per line.
      const runs = exec.mock.contexts.filter((re) => (re as RegExp).source === "last-item").length;
      expect(runs).toBeGreaterThan(0);
      expect(runs).toBeLessThan(10);
    } finally {
      exec.mockRestore();
    }
    const mark = screen.getByLabelText("Response body").querySelector("[data-find-current]");
    expect(mark?.textContent).toBe("last-item");
  });

  it("keeps carriage returns and line numbers of a CRLF body", () => {
    const body = "alpha\r\nbeta\r\ngamma beta";
    show(exchangeWith(body, "text/plain"));
    const el = screen.getByLabelText("Response body");
    const view = editorOf(el);
    expect(view.state.doc.toString()).toBe(body);
    expect(view.state.doc.lines).toBe(3);
    fireEvent.keyDown(el, { key: "f", metaKey: true, ctrlKey: true });
    act(() => {
      fireEvent.change(screen.getByLabelText("Find in response", { selector: "input" }), {
        target: { value: "beta" },
      });
    });
    expect([...el.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["beta", "beta"]);
  });

  it("copies the whole body after Select All", () => {
    const body = Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join("\n");
    show(exchangeWith(body, "text/plain"));
    const el = screen.getByLabelText("Response body");
    const view = editorOf(el);
    view.focus();
    fireEvent.keyDown(view.contentDOM, { key: "a", ctrlKey: true, metaKey: false });
    // Either primary modifier, as on macOS / elsewhere.
    if (view.state.selection.main.to !== body.length)
      fireEvent.keyDown(view.contentDOM, { key: "a", metaKey: true, ctrlKey: false });
    expect(view.state.selection.main.from).toBe(0);
    expect(view.state.selection.main.to).toBe(body.length);
    const setData = vi.fn();
    fireEvent.copy(view.contentDOM, { clipboardData: { setData, clearData: () => {}, getData: () => "" } });
    expect(setData).toHaveBeenCalledWith("text/plain", body);
  });

  it("hands the focus from the pane to the body, so Select All covers all of it", () => {
    show(exchangeWith("alpha\nbeta", "text/plain"));
    const view = editorOf(screen.getByLabelText("Response body"));
    const pane = view.dom.closest<HTMLElement>("[data-selection-scope]")!;
    expect(pane.tabIndex).toBe(-1);
    act(() => pane.focus());
    expect(document.activeElement).toBe(view.contentDOM);
  });

  it("still says when the backend cut the body", () => {
    show(exchangeWith("partial", "text/plain", true));
    expect(screen.getByText(/truncated \(7 B received\)/)).toBeTruthy();
  });
});
