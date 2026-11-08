import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ClipPasteFile, ClipPastePreview } from "@/bindings";
import { commands } from "@/platform/ipc";
import { PastePreviewDialog } from "../clip";
import { buildPasteTree, filesUnder, type PasteNode } from "../clipPasteTree";

const file = (path: string, action: string, index: number, reason: string | null = null): ClipPasteFile => ({
  index,
  path,
  target: `/p/${path}`,
  action,
  reason,
  nonText: null,
});

const shape = (nodes: readonly PasteNode[]): unknown[] =>
  nodes.map((n) => (n.children ? { [n.name]: shape(n.children) } : `${n.name}:${n.file!.action}`));

describe("buildPasteTree", () => {
  it("groups files by folder, folders first, and merges single-folder chains", () => {
    const tree = buildPasteTree([
      file("src/main/java/b/B.java", "create", 0),
      file("src/main/java/a/A.java", "overwrite", 1),
      file("README.md", "create", 2),
      file("src/main/java/a/old.txt", "delete", 0),
      file("docs/x.png", "skip", 0, "NON_UTF8_TARGET"),
    ]);
    expect(shape(tree)).toEqual([
      { docs: ["x.png:skip"] },
      { "src/main/java": [{ a: ["A.java:overwrite", "old.txt:delete"] }, { b: ["B.java:create"] }] },
      "README.md:create",
    ]);
    expect(filesUnder(tree[1]!).map((f) => f.path)).toHaveLength(3);
  });

  it("reads Windows separators and keeps absolute paths whole", () => {
    const tree = buildPasteTree([file("C:\\w\\a.txt", "create", 0), file("/ext/lib/b.txt", "create", 1)]);
    expect(shape(tree)).toEqual([{ "/ext/lib": ["b.txt:create"] }, { "C:/w": ["a.txt:create"] }]);
  });

  it("keys a skipped file apart from the create sharing its index", () => {
    const tree = buildPasteTree([file("a.txt", "create", 0), file("b.txt", "skip", 0, "UNRESOLVED_PATH")]);
    expect(new Set(tree.map((n) => n.key)).size).toBe(2);
  });
});

describe("PastePreviewDialog files mode", () => {
  const preview: ClipPastePreview = {
    id: 7,
    mode: "files",
    destination: "/p",
    files: [
      file("src/api/a.ts", "overwrite", 0),
      file("src/api/b.ts", "create", 1),
      file("src/main.ts", "create", 2),
      file("old.ts", "delete", 0),
      file("bin.dat", "skip", 0, "NON_UTF8_TARGET"),
    ],
    commits: [],
    suggestion: null,
    adjusted: false,
  };

  beforeEach(() => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    vi.spyOn(commands, "clipPastePreviewFile").mockResolvedValue({
      status: "ok",
      data: { incoming: "new\n", current: "old\n", note: null, nonText: null },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const check = (name: string) => screen.getByRole("checkbox", { name });

  it("shows the folders, toggles a folder's files together, and applies as before", async () => {
    const apply = vi.spyOn(commands, "clipPasteApply").mockResolvedValue({
      status: "ok",
      data: {
        created: 1,
        overwritten: 0,
        deleted: 1,
        skipped: 1,
        commits: [],
        errors: [],
        unchanged: 0,
        corruptNonText: [],
      },
    });
    render(<PastePreviewDialog text="" target={{ dest: "/p", repo: null }} initial={preview} onClose={() => {}} />);
    // The first file to restore is shown at once: the overwrite, against the disk.
    await waitFor(() => expect(commands.clipPastePreviewFile).toHaveBeenCalledWith(7, "overwrite", 0));
    // Overwrites start unchecked, the rest checked, so the `src/api` folder is mixed.
    expect(check("Restore the files in api").getAttribute("aria-checked")).toBe("mixed");
    fireEvent.mouseDown(check("Restore the files in api"), { button: 0 });
    expect(check("Restore src/api/a.ts").getAttribute("aria-checked")).toBe("true");
    expect(check("Restore src/api/b.ts").getAttribute("aria-checked")).toBe("true");
    expect(check("Restore src/main.ts").getAttribute("aria-checked")).toBe("true");
    fireEvent.mouseDown(check("Restore the files in api"), { button: 0 });
    expect(check("Restore src/api/a.ts").getAttribute("aria-checked")).toBe("false");
    expect(check("Restore src/api/b.ts").getAttribute("aria-checked")).toBe("false");
    expect(check("Restore src/main.ts").getAttribute("aria-checked")).toBe("true");
    expect(check("Restore bin.dat").getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(apply).toHaveBeenCalled());
    expect(apply.mock.calls[0]![0]).toEqual({
      id: 7,
      overwrite: [],
      uncheckedCreates: [0, 1],
      uncheckedDeletes: [],
      overwriteExisting: false,
    });
  });
});
