import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorController, useTabs } from "./controller";
import { createMemoryBackend } from "./backend";
import { initialTabsState } from "./model/tabs";
import { useProject } from "@/platform/project";
import { commands } from "@/platform/ipc";
import * as contributions from "@/workbench/contributions";
import * as light from "./openLightweightEditor";

vi.mock("@/platform/ipc", async (original) => {
  const mod = await original<typeof import("@/platform/ipc")>();
  return { ...mod, isTauri: () => true };
});

let ctrl: EditorController;
const path = "/p/a.ts";

beforeEach(() => {
  vi.spyOn(contributions, "notifications").mockReturnValue({ notify: vi.fn() });
  useTabs.setState(initialTabsState(), true);
  useProject.setState({
    project: { root: "/p", workspace: { projects: ["/p"] } } as never,
    settings: { files: { autoSave: false } } as never,
  });
  vi.spyOn(commands, "windowOpenFileInNewWindow").mockResolvedValue({
    status: "ok",
    data: { kind: "opened", label: "second" },
  });
  vi.spyOn(light, "openLightweightEditor").mockResolvedValue();
});
afterEach(() => {
  ctrl?.stop();
  vi.restoreAllMocks();
  useProject.setState({ project: null, settings: null });
});

// #397: a project text tab still saves and moves to a full project window, not the lightweight editor.
it("saves a project file and opens it in a full project window", async () => {
  const backend = createMemoryBackend({ [path]: "original\n" });
  ctrl = new EditorController(backend);
  ctrl.start();
  await ctrl.openFile(path, { focus: false });
  const s = useTabs.getState();
  const pane = s.activePane;
  const id = s.panes[pane]!.active!;
  ctrl.slotFor(id)!.dispatchLocal({ changes: { from: 0, to: 8, insert: "edited" } });
  const save = vi.spyOn(backend, "save");
  vi.mocked(commands.windowOpenFileInNewWindow).mockImplementation(async () => {
    expect(save).toHaveBeenCalled();
    return { status: "ok", data: { kind: "opened", label: "second" } };
  });
  expect(await ctrl.detachTab(pane, id)).toBe(true);
  expect(commands.windowOpenFileInNewWindow).toHaveBeenCalledWith("/p", path);
  expect(light.openLightweightEditor).not.toHaveBeenCalled();
});
