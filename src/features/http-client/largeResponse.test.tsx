import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import type { HttpExchange } from "@/platform/ipc";
import { DEFAULT_FIND_OPTIONS, findInLines } from "@/ui/consoleFind";
import { DISPLAY_LINE, displayed } from "./displayLines";

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

/** The text in the view: its document without the line breaks that split long lines for display. */
function shownText(view: EditorView): string {
  const { offsets } = view.state.field(displayed);
  const doc = view.state.doc.toString();
  if (!offsets.length) return doc;
  const parts: string[] = [];
  let from = 0;
  offsets.forEach((offset, i) => {
    const at = offset + i;
    expect(doc[at]).toBe("\n");
    parts.push(doc.slice(from, at));
    from = at + 1;
  });
  parts.push(doc.slice(from));
  return parts.join("");
}

/** The body shown. */
async function expectBody(text: string) {
  await vi.waitFor(() => expect(shownText(editorOf(screen.getByLabelText("Response body")))).toBe(text));
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
    expect(shownText(view)).toBe(format.prettyJson(body));
  });

  it("mounts only part of a large body, with the whole text in the view", () => {
    const body = Array.from({ length: 20_000 }, (_, i) => `${i} INFO processed order item-${i}`).join("\n");
    show(exchangeWith(body, "text/plain"));
    const el = screen.getByLabelText("Response body");
    expect((el.textContent ?? "").length).toBeLessThan(body.length / 10);
    expect(shownText(editorOf(el))).toBe(body);
  });

  it("formats small bodies at once, without a worker", () => {
    show(exchangeWith('{"a":[1,2]}', "application/json"));
    expect(FakeWorker.all).toHaveLength(0);
    expect(shownText(editorOf(screen.getByLabelText("Response body")))).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
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
    expect(shownText(editorOf(screen.getByLabelText("Response body")))).toBe(pretty);
    // Back and forth again: no more formatting.
    fireEvent.click(screen.getByRole("button", { name: "Show Raw" }));
    fireEvent.click(screen.getByRole("button", { name: "Show Formatted" }));
    expect(FakeWorker.all).toHaveLength(2);
    expect(shownText(editorOf(screen.getByLabelText("Response body")))).toBe(pretty);
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

  it("gives the focus to the body once a body switched to is formatted", async () => {
    const body = minifiedJson(20_000);
    show(exchangeWith(body, "application/json"));
    fireEvent.click(screen.getByRole("button", { name: "Show Raw" }));
    await expectBody(body);
    // WebKit leaves no focus after a click on a button.
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    fireEvent.click(screen.getByRole("button", { name: "Show Formatted" }));
    expect(screen.getByLabelText("Formatting")).toBeTruthy();
    FakeWorker.all[1]!.answer();
    expect(document.activeElement).toBe(screen.getByLabelText("Response body"));
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

  it("copies and finds a long line as received, across the splits that display it", async () => {
    const body = Array.from({ length: 4_000 }, (_, i) => `item-${i}`).join(" ");
    expect(body.length).toBeGreaterThan(3 * DISPLAY_LINE);
    show(exchangeWith(body, "text/plain"));
    const el = screen.getByLabelText("Response body");
    const view = editorOf(el);
    expect(view.state.doc.lines).toBeGreaterThan(3);
    // A selection across a split copies the text as received.
    const at = view.state.field(displayed).offsets[0]!;
    view.focus();
    view.dispatch({ selection: { anchor: at - 5, head: at + 6 } });
    const setData = vi.fn();
    const copy = () =>
      fireEvent.copy(view.contentDOM, { clipboardData: { setData, clearData: () => {}, getData: () => "" } });
    copy();
    expect(setData).toHaveBeenLastCalledWith("text/plain", body.slice(at - 5, at + 5));
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    copy();
    expect(setData).toHaveBeenLastCalledWith("text/plain", body);
    // A match across a split is marked whole.
    const query = body.slice(at - 20, at + 20);
    fireEvent.keyDown(el, { key: "f", metaKey: true, ctrlKey: true });
    act(() => {
      fireEvent.change(screen.getByLabelText("Find in response", { selector: "input" }), {
        target: { value: query },
      });
    });
    expect(screen.getByText("1/1")).toBeTruthy();
    const current: string[] = [];
    for (const set of view.state.facet(EditorView.decorations))
      (typeof set === "function" ? set(view) : set).between(0, view.state.doc.length, (from, to, deco) => {
        if (deco.spec.attributes?.["data-find-current"] != null) current.push(view.state.sliceDoc(from, to));
      });
    expect(current).toEqual([`${query.slice(0, 20)}\n${query.slice(20)}`]);
  });

  it("copies the whole line as received with nothing selected, also when it is split for display", () => {
    const body = `first\n${"x".repeat(2 * DISPLAY_LINE + 5)}\nlast`;
    show(exchangeWith(body, "text/plain"));
    const view = editorOf(screen.getByLabelText("Response body"));
    view.focus();
    const setData = vi.fn();
    const copyAt = (pos: number) => {
      view.dispatch({ selection: { anchor: pos } });
      fireEvent.copy(view.contentDOM, { clipboardData: { setData, clearData: () => {}, getData: () => "" } });
    };
    copyAt(view.state.doc.line(3).from + 5);
    expect(setData).toHaveBeenLastCalledWith("text/plain", body.split("\n")[1]);
    copyAt(2);
    expect(setData).toHaveBeenLastCalledWith("text/plain", "first");
  });

  it("widens a Select All of the drawn lines (WebKit's Edit menu) to the whole body", () => {
    const body = Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join("\n");
    show(exchangeWith(body, "text/plain"));
    const view = editorOf(screen.getByLabelText("Response body"));
    view.focus();
    expect(view.viewport.to).toBeLessThan(view.state.doc.length);
    // What WebKit's own Select All does in an editable element: select from the first to the last text drawn.
    const lines = view.contentDOM.querySelectorAll(".cm-line");
    const first = lines[0]!.firstChild!;
    const last = lines[lines.length - 1]!.lastChild!;
    act(() => {
      document.getSelection()!.setBaseAndExtent(first, 0, last, last.textContent!.length);
      (view as unknown as { observer: { flush(): void } }).observer.flush();
    });
    expect(view.state.selection.main).toMatchObject({ from: 0, to: body.length });
  });

  it("leaves keyboard selections that end at the drawn lines as they are", () => {
    const body = "x".repeat(2 * DISPLAY_LINE + 5);
    show(exchangeWith(body, "text/plain"));
    const view = editorOf(screen.getByLabelText("Response body"));
    view.focus();
    const end = view.state.doc.line(1).to;
    expect(view.viewport.to).toBe(end);
    view.dispatch({ selection: { anchor: 0, head: end - 1 } });
    fireEvent.keyDown(view.contentDOM, { key: "ArrowRight", shiftKey: true });
    expect(view.state.selection.main).toMatchObject({ anchor: 0, head: end });
    view.dispatch({ selection: { anchor: 5 } });
    fireEvent.keyDown(view.contentDOM, { key: "l", altKey: true });
    expect(view.state.selection.main).toMatchObject({ from: 0, to: end + 1 });
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
