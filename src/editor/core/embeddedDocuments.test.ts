import { afterEach, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { attachDocument } from "@/editor/api";
import { useProject } from "@/platform/project";
import { _resetLanguages } from "./cm/languages";
import { ipcBackend, type MemoryBackend } from "./backend";
import { activateEmbeddedDocuments, isNotSaved } from "./embeddedDocuments";

vi.mock("./backend", async (original) => {
  const module = await original<typeof import("./backend")>();
  return { ...module, ipcBackend: module.createMemoryBackend({ "/p/a.txt": "original\n", "/p/b.txt": "other\n" }) };
});

afterEach(() => useProject.setState({ settings: null }));

it("retains local changes when another comparison row is selected and saves before releasing document references", async () => {
  _resetLanguages();
  useProject.setState({ settings: { files: { autoSave: false } } as never });
  const documents = activateEmbeddedDocuments();
  const backend = ipcBackend as MemoryBackend;
  const first = await attachDocument("/p/a.txt");
  const view = new EditorView({ doc: first.text(), extensions: [first.extension] });
  try {
    view.dispatch({ changes: { from: 0, insert: "changed " } });
    view.destroy();
    first.release();
    const second = await attachDocument("/p/b.txt");
    const otherView = new EditorView({ doc: second.text(), extensions: [second.extension] });
    otherView.dispatch({ changes: { from: 0, insert: "pending " } });
    otherView.destroy();
    second.release();
    expect(documents.dirty()).toBe(true);
    expect(backend.files.get("/p/a.txt")).toBe("original\n");
    expect(backend.docs.size).toBe(2);
    await documents.savePaths(["/p/a.txt"]);
    expect(backend.files.get("/p/a.txt")).toBe("changed original\n");
    expect(backend.files.get("/p/b.txt")).toBe("other\n");
    expect(documents.dirty()).toBe(true);
    await documents.save();
    expect(backend.files.get("/p/b.txt")).toBe("pending other\n");
    expect(documents.dirty()).toBe(false);
  } finally {
    await documents.dispose();
  }
  expect(backend.docs.size).toBe(0);
});

it("rejects Save while a document whose file changed on disk stays unsaved, so a closing window keeps it", async () => {
  _resetLanguages();
  const documents = activateEmbeddedDocuments();
  const backend = ipcBackend as MemoryBackend;
  const autosave = backend.autosave;
  const doc = await attachDocument("/p/a.txt");
  const view = new EditorView({ doc: doc.text(), extensions: [doc.extension] });
  try {
    view.dispatch({ changes: { from: 0, insert: "mine " } });
    backend.autosave = vi.fn(async () => false);
    const refused = await documents.save().then(
      () => null,
      (error: unknown) => error,
    );
    expect(isNotSaved(refused)).toBe(true);
    expect(String(refused)).toContain("/p/a.txt");
    expect(documents.dirty()).toBe(true);
    expect(backend.files.get("/p/a.txt")).not.toContain("mine");
  } finally {
    backend.autosave = autosave;
    view.destroy();
    doc.release();
    await documents.dispose();
  }
});
