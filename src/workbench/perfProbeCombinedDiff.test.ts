import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { docBackend, type MemoryBackend } from "@/editor/core/backend";
import { useProject } from "@/platform/project";
import { provideEditorService, type EditorInput } from "./contributions";
import { installPerfProbe, type PerfProbe } from "./perfProbe";

describe("perfProbe openCombinedDiff", () => {
  let backend: MemoryBackend;
  let uninstall: (() => void) | null = null;
  let opened: EditorInput[] = [];

  beforeEach(() => {
    opened = [];
    backend = docBackend() as MemoryBackend;
    backend.files.clear();
    useProject.setState({ project: { name: "acme", root: "/dev/acme-api", trusted: true, isGit: true } as never });
    provideEditorService({
      openInput: vi.fn(async (input: EditorInput) => {
        opened.push(input);
      }),
      openFile: vi.fn(async () => undefined),
      closeInput: vi.fn(),
      dirtyDocumentIds: () => [],
    } as never);
    uninstall = installPerfProbe();
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  it("creates 5,000 editable worktree text files when allEditable is requested", async () => {
    const probe = (window as unknown as { __openideaPerf: PerfProbe }).__openideaPerf;
    const res = await probe.openCombinedDiff(5_000, 0, { allEditable: true, lines: 4, tag: "test-editable" });

    expect(opened).toHaveLength(1);
    const items = (opened[0]!.data as { items: Array<{ path: string; right: { type: string } }> }).items;
    expect(items).toHaveLength(5_000);
    expect(items.every((item) => item.right.type === "worktree" && item.path.endsWith(".ts"))).toBe(true);
    expect(items.every((item) => backend.files.has(item.path))).toBe(true);
    expect(res.paths).toHaveLength(5_000);
    expect(res.paths[0]).toBe(res.first);
    expect(res.paths[4_999]).toBe(res.last);
    expect(res.binary).toBe("");
    expect(typeof probe.hasEditor).toBe("function");
    expect(typeof probe.editAndSaveDiff).toBe("function");
  });

  it("creates mixed binary, large, and editable files by default", async () => {
    const probe = (window as unknown as { __openideaPerf: PerfProbe }).__openideaPerf;
    const res = await probe.openCombinedDiff(100, 500);

    const items = (opened[0]!.data as { items: Array<{ path: string; right: { type: string } }> }).items;
    expect(items).toHaveLength(100);
    expect(items.some((item) => item.path.endsWith(".png"))).toBe(true);
    expect(res.binary.endsWith(".png")).toBe(true);
    expect(res.paths).toHaveLength(100);
  });
});
