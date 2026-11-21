import { afterEach, describe, expect, it, vi } from "vitest";
import { provideToolWindowService, type ToolWindowService } from "@/workbench/contributions";
import type { FileMatches, SearchQuery } from "@/platform/ipc";
import { findOccurrence } from "@/ui/Tree";
import { buildFindTree } from "../find/findTree";
import type { FindDeps } from "../find/session";
import {
  closeFindTab,
  disposeFindWindow,
  openEditorResults,
  openInFindWindow,
  pinFindTab,
  rerunFindTab,
  useFindWindow,
} from "../find/windowStore";

const q = (pattern: string): SearchQuery => ({
  pattern,
  isRegex: false,
  caseSensitive: false,
  wholeWord: false,
  include: [],
  exclude: [],
  scope: { kind: "project" },
  maxMatches: 100,
});

const deps: FindDeps = {
  validate: async () => {},
  start: async () => null,
  cancel: () => {},
  nextRequestId: () => 1,
};

const file = (rel: string): FileMatches => ({
  path: `/p/${rel}`,
  relPath: rel,
  matches: [{ line: 0, text: "foo", ranges: [[0, 3]], textOffset: 0 }],
});

afterEach(disposeFindWindow);

describe("Find tool window tabs", () => {
  it("take the tool window and its stripe button away with the last one", () => {
    const hide = vi.fn();
    provideToolWindowService({ show: vi.fn(), hide } as unknown as ToolWindowService);
    const a = openInFindWindow(q("a"), "a", { deps });
    pinFindTab(a, true);
    const b = openInFindWindow(q("b"), "b", { deps });
    closeFindTab(a);
    expect(hide).not.toHaveBeenCalled();
    closeFindTab(b);
    expect(hide).toHaveBeenCalledWith("find", { removeFromStripe: true });
  });

  it("reuses the selected tab unless it is pinned", () => {
    const a = openInFindWindow(q("a"), "a", { deps });
    const b = openInFindWindow(q("b"), "b", { deps });
    expect(useFindWindow.getState().tabs.map((t) => t.title)).toEqual(["b"]);
    expect(useFindWindow.getState().active).toBe(b);
    expect(b).not.toBe(a);

    pinFindTab(b, true);
    const c = openInFindWindow(q("c"), "c", { deps });
    expect(useFindWindow.getState().tabs.map((t) => t.title)).toEqual(["b", "c"]);
    expect(useFindWindow.getState().active).toBe(c);

    // Selecting the pinned tab again opens the next search beside it.
    useFindWindow.setState({ active: b });
    openInFindWindow(q("d"), "d", { deps });
    expect(useFindWindow.getState().tabs.map((t) => t.title)).toEqual(["b", "c", "d"]);
  });

  it("keeps the selected tab with IDEA's Open results in new tab", () => {
    openInFindWindow(q("a"), "a", { deps });
    const b = openInFindWindow(q("b"), "b", { deps, newTab: true });
    expect(useFindWindow.getState().tabs.map((t) => t.title)).toEqual(["a", "b"]);
    expect(useFindWindow.getState().active).toBe(b);
  });
});

describe("buildFindTree", () => {
  const files = [file("src/b.ts"), file("a.ts"), file("src/a.ts")];

  it("lists files flat by path by default", () => {
    const roots = buildFindTree(files);
    expect(roots.map((n) => n.kind)).toEqual(["file", "file", "file"]);
    expect(roots.map((n) => n.key)).toEqual(["f:/p/a.ts", "f:/p/src/a.ts", "f:/p/src/b.ts"]);
  });

  it("groups files by directory on request", () => {
    const roots = buildFindTree(files, true);
    expect(roots.map((n) => (n.kind === "dir" ? [n.label, n.count] : n.kind))).toEqual([
      ["/", 1],
      ["src", 2],
    ]);
  });

  it("sorts paths exactly like localeCompare", () => {
    const paths = [
      "src/B.ts",
      "src/a.ts",
      "src/ä.ts",
      "src/a10.ts",
      "src/a2.ts",
      "src/_x.ts",
      "src/-y.ts",
      "Src/z.ts",
      "src/a b.ts",
      "src/日本.ts",
      "src/a/b.ts",
      "src/a.b/c.ts",
      "README",
      "readme",
      "a.ts",
      "src/É.ts",
      "src/e.ts",
    ];
    const expected = [...paths].sort((a, b) => a.localeCompare(b));
    expect(buildFindTree(paths.map(file)).map((n) => n.key)).toEqual(expected.map((p) => `f:/p/${p}`));
  });

  const occurrenceModel = {
    getKey: (n: ReturnType<typeof buildFindTree>[number]) => n.key,
    getChildren: (n: ReturnType<typeof buildFindTree>[number]) => (n.kind === "match" ? undefined : n.children),
    isExpandable: (n: ReturnType<typeof buildFindTree>[number]) => n.kind !== "match",
  };

  it("Next Occurrence walks every match of one file with 10,000 matches", () => {
    const roots = buildFindTree([
      {
        path: "/p/big.ts",
        relPath: "big.ts",
        matches: Array.from({ length: 10_000 }, (_, line) => ({ line, text: "foo", ranges: [[0, 3]], textOffset: 0 })),
      },
    ]);
    const seen = new Set<string>();
    let lead: string | null = null;
    for (let i = 1; i <= 10_000; i++) {
      const step = findOccurrence(roots, lead, 1, occurrenceModel);
      expect(step).toMatchObject({ index: i, total: 10_000 });
      const key: string = step!.node.key;
      lead = key;
      seen.add(key);
    }
    expect(seen.size).toBe(10_000);
    expect(findOccurrence(roots, lead, 1, occurrenceModel)).toBeNull();
    expect(findOccurrence(roots, lead, -1, occurrenceModel)?.index).toBe(9_999);
  });

  // Each step walks the whole tree, so 10,000 files are checked at every 50th match.
  it("Next Occurrence steps through 10,000 files in order", () => {
    const files = Array.from({ length: 10_000 }, (_, i) => file(`src/m${i % 50}/F${i}.ts`));
    const roots = buildFindTree(files);
    const matches = roots.map((f) => (f.kind === "file" ? f.children[0]!.key : ""));
    expect(findOccurrence(roots, null, 1, occurrenceModel)).toMatchObject({ index: 1, total: 10_000 });
    for (let i = 0; i < 10_000; i += 50) {
      const step = findOccurrence(roots, matches[i]!, 1, occurrenceModel);
      expect(step).toMatchObject({ index: i + 2, total: 10_000 });
      expect(step!.node.key).toBe(matches[i + 1]);
    }
    expect(findOccurrence(roots, matches[9_998]!, 1, occurrenceModel)).toMatchObject({ index: 10_000 });
    expect(findOccurrence(roots, matches[9_999]!, 1, occurrenceModel)).toBeNull();
  });
});

describe("editor-backed Find results", () => {
  it("uses the shared session and recomputes live results on rerun without IPC", async () => {
    const current = file("unsaved.ts");
    current.matches[0]!.text = "foo foo";
    current.matches[0]!.ranges.push([4, 7]);
    const read = vi.fn(() => current);
    const id = openEditorResults({ title: "Occurrences of 'foo'", query: q("foo"), read });
    await vi.waitFor(() => expect(useFindWindow.getState().tabs[0]?.state.status).toBe("done"));
    expect(useFindWindow.getState().tabs[0]?.state.files).toEqual([current]);
    expect(useFindWindow.getState().tabs[0]?.state.matchCount).toBe(2);
    const tree = buildFindTree(useFindWindow.getState().tabs[0]!.state.files);
    expect(tree[0]).toMatchObject({ kind: "file", count: 2 });
    read.mockReturnValue({ ...file("unsaved.ts"), matches: [] });
    rerunFindTab(id);
    await vi.waitFor(() => expect(useFindWindow.getState().tabs[0]?.state.files).toEqual([]));
    expect(read).toHaveBeenCalledTimes(2);
    expect(useFindWindow.getState().tabs[0]?.state.summary?.matches).toBe(0);
  });
});
