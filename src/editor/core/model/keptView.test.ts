/**
 * A hidden tab keeps its view, detached (`slot.ts`). Changes made while it is hidden go into
 * that view, so everything living in it (plugins, Vim, held references) carries on, and a
 * reload replacing the whole text must not make the detached view draw every line.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { diagnosticCount } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";
import { getCM, Vim } from "@replit/codemirror-vim";
import type { Diagnostic } from "@/bindings";
import { registerEditorContribution, type EditorDocContext } from "@/editor/api";
import * as lsp from "@/editor/lsp/lsp";
import { diagnosticsExtension, setFileDiagnostics } from "@/editor/lsp/diagnostics";
import { formatDocument } from "@/editor/lsp/format";
import { vimExtension } from "@/features/vim/engine";
import { breakpointGutter } from "@/features/debugger/editor/breakpointGutter";
import { breakpointsOf, loadBreakpoints, toggleBreakpoint } from "@/features/debugger/breakpoints/store";
import { createMemoryBackend } from "../backend";
import { _resetLanguages } from "../cm/languages";
import { DocumentManager, useDocMeta } from "./document";
import { EditorSlot, type SlotHost } from "./slot";

const host: SlotHost = {
  onFocus: () => {},
  onBlur: () => {},
  onSelection: () => {},
  onUserEdit: () => {},
  onContextMenu: () => {},
};

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const frame = () => new Promise((r) => requestAnimationFrame(r));

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((f) => f());
  useDocMeta.setState({}, true);
  vi.restoreAllMocks();
});

async function open(path: string, text: string, extensions?: (ctx: EditorDocContext) => unknown) {
  _resetLanguages();
  if (extensions)
    cleanups.push(registerEditorContribution({ id: "kept-view-test", extensions: (ctx) => extensions(ctx) as never }));
  const backend = createMemoryBackend({ [path]: text });
  const manager = new DocumentManager(backend, { settings: () => ({}), notify: vi.fn() }, (fn) => fn());
  manager.start();
  const model = await manager.acquire(path);
  const slot = new EditorSlot(model, "t1", host);
  cleanups.push(() => {
    slot.dispose();
    manager.stop();
  });
  const reload = (next: string) =>
    backend.patch(model.doc, [{ from: 0, to: model.sync.localText.length, insert: next }]);
  return { backend, model, slot, reload };
}

/** Shows the tab, lets it measure, then hides it: measured detached, the kept view is out of view. */
async function showThenHide(slot: EditorSlot): Promise<EditorView> {
  const view = slot.mount(document.body);
  await frame();
  slot.unmount();
  view.requestMeasure();
  await frame();
  expect(view.inView).toBe(false);
  return view;
}

const lines = (view: EditorView) => view.contentDOM.querySelectorAll(".cm-line").length;

describe("a hidden tab's kept view", () => {
  it("does not draw a whole reloaded file", async () => {
    const { slot, reload } = await open("/p/a.txt", "old\n".repeat(200));
    const view = await showThenHide(slot);
    const reloaded = "new\n".repeat(20_000);
    reload(reloaded);
    expect(view.state.doc.toString()).toBe(reloaded);
    expect(lines(view)).toBeLessThan(200);
    expect(slot.mount(document.body)).toBe(view);
  });

  it("does not draw a large hunk of a minimal patch over its viewport", async () => {
    const { backend, model, slot } = await open("/p/a.txt", "old\n".repeat(200));
    const view = await showThenHide(slot);
    // Small hunks around, one replacing the visible top of the file with 20k lines.
    backend.patch(model.doc, [
      { from: 0, to: 40, insert: "new\n".repeat(20_000) },
      { from: 400, to: 404, insert: "mid\n" },
    ]);
    expect(view.state.doc.lines).toBe(20_191);
    expect(lines(view)).toBeLessThan(200);
  });

  it("fits the viewport when batched transactions overlap and only their composition maps it large", async () => {
    const { slot } = await open("/p/a.txt", "old\n".repeat(5000));
    const view = await showThenHide(slot);
    const { from, to } = view.viewport;
    expect(from).toBe(0);
    expect(to).toBeLessThan(view.state.doc.length);
    const first = view.state.update({ changes: { from: to, to: to + 3, insert: "new\n".repeat(20_000) } });
    const second = first.state.update({ changes: { from: 1, to: to + 3, insert: "ab" } });
    view.dispatch([first, second]);
    expect(lines(view)).toBeLessThan(200);
  });

  it("keeps small hidden edits where they were (no refit)", async () => {
    const { backend, model, slot } = await open("/p/a.txt", "old\n".repeat(200));
    const view = await showThenHide(slot);
    const before = view.viewport;
    backend.patch(model.doc, [{ from: 0, to: 0, insert: "x\n" }]);
    expect(view.viewport).toEqual({ from: before.from, to: before.to + 2 });
  });

  it("rejects a format result that arrives after a hidden reload, as the view sees the reload", async () => {
    let answer: (edits: unknown) => void = () => {};
    vi.spyOn(lsp, "lspRequest").mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const { model, slot, reload } = await open("/p/a.py", "x=1\n", (ctx) => lsp.lspDoc.of(ctx));
    const view = slot.mount(document.body);
    const formatting = formatDocument(view, { explicit: false });
    await settle();
    slot.unmount();
    reload("y = 2\nz = 3\n");
    answer([{ range: { start: { line: 0, col: 0 }, end: { line: 0, col: 3 } }, newText: "x = 1" }]);
    expect(await formatting).toMatchObject({ applied: false });
    expect(model.sync.localText.toString()).toBe("y = 2\nz = 3\n");
    expect(slot.currentState().doc.toString()).toBe("y = 2\nz = 3\n");
  });

  it("keeps diagnostics cleared while hidden cleared when shown again", async () => {
    const path = "/p/diag.py";
    const item: Diagnostic = {
      range: { start: { line: 0, col: 0 }, end: { line: 0, col: 1 } },
      severity: "error",
      message: "bad",
    } as Diagnostic;
    cleanups.push(() => setFileDiagnostics(path, "test", []));
    const { backend, model, slot } = await open(path, "a\nb\n", (ctx) => [lsp.lspDoc.of(ctx), diagnosticsExtension()]);
    const view = slot.mount(document.body);
    setFileDiagnostics(path, "test", [item]);
    await settle();
    expect(diagnosticCount(view.state)).toBe(1);
    slot.unmount();
    // A reload that leaves the flagged line alone, so the mark maps through it.
    backend.patch(model.doc, [{ from: 4, to: 4, insert: "c\n" }]);
    setFileDiagnostics(path, "test", []);
    await settle();
    const shown = slot.mount(document.body);
    await settle();
    expect(diagnosticCount(shown.state)).toBe(0);
  });

  it("keeps Vim's insert mode across a hidden reload", async () => {
    const { slot, reload } = await open("/p/a.txt", "one\ntwo\n", (ctx) => vimExtension(ctx));
    const view = slot.mount(document.body);
    const cm = getCM(view)!;
    Vim.handleKey(cm as never, "i", "user");
    expect(cm.state.vim?.insertMode).toBe(true);
    slot.unmount();
    reload("one\ntwo\nthree\n");
    const shown = slot.mount(document.body);
    expect(getCM(shown)?.state.vim?.insertMode).toBe(true);
  });

  it("moves breakpoints with edits made while the tab is hidden", async () => {
    localStorage.clear();
    loadBreakpoints("/p");
    const path = "/p/bp.py";
    const { backend, model, slot } = await open(path, "a\nb\nc\n", (ctx) => breakpointGutter(ctx));
    slot.mount(document.body);
    toggleBreakpoint(path, 2);
    await settle();
    slot.unmount();
    backend.patch(model.doc, [{ from: 0, to: 0, insert: "new\nnew\n" }]);
    expect(breakpointsOf(path).map((b) => b.line)).toEqual([4]);
  });

  it("shows the same view again at its scroll offset", async () => {
    const { backend, model, slot } = await open("/p/a.txt", "line\n".repeat(500));
    const view = slot.mount(document.body);
    let top = 0;
    Object.defineProperty(view.scrollDOM, "scrollTop", { get: () => top, set: (v: number) => (top = v) });
    top = 400;
    view.scrollDOM.dispatchEvent(new Event("scroll"));
    slot.unmount();
    top = 0;
    backend.patch(model.doc, [{ from: 0, to: 0, insert: "x\n" }]);
    expect(slot.mount(document.body)).toBe(view);
    expect(view.scrollDOM.scrollTop).toBe(400);
  });
});
