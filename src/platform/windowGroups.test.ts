import { describe, expect, it, vi } from "vitest";
import { startupProjectDecided, useProject } from "./project";
import { installWindowGroups, reorderedTabs } from "./windowGroups";

const mocks = vi.hoisted(() => ({ restore: vi.fn(async () => null) }));

vi.mock("./ipc", async (original) => {
  const real = await original<typeof import("./ipc")>();
  return {
    ...real,
    isTauri: () => true,
    call: (value: unknown) => value,
    onIdeEvent: () => () => {},
    commands: {
      ...real.commands,
      windowGroupCurrent: async () => [],
      windowGroupRestore: mocks.restore,
    },
  };
});

describe("project window order", () => {
  const tabs = ["a", "b", "c"].map((label) => ({ label, name: label, current: label === "b", root: `/${label}` }));
  it("moves a tab across its neighbours without changing the source or active window", () => {
    expect(reorderedTabs(tabs, "a", "c")).toEqual(["b", "c", "a"]);
    expect(reorderedTabs(tabs, "c", "a")).toEqual(["c", "a", "b"]);
    expect(tabs.map((t) => t.label)).toEqual(["a", "b", "c"]);
    expect(tabs.find((t) => t.current)?.label).toBe("b");
  });
  it("ignores external drags and missing targets", () => {
    expect(reorderedTabs(tabs, "outside", "b")).toEqual(["a", "b", "c"]);
    expect(reorderedTabs(tabs, "a", "outside")).toEqual(["a", "b", "c"]);
  });
});

describe("restoring the saved window groups", () => {
  it("restores them at startup also when the window stays on welcome", async () => {
    useProject.setState({ project: null, lightEdit: false });
    const dispose = installWindowGroups();
    // Welcome may still be reopening the last project: restoring now would reopen it elsewhere.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.restore).not.toHaveBeenCalled();
    startupProjectDecided();
    await vi.waitFor(() => expect(mocks.restore).toHaveBeenCalledTimes(1));
    dispose();
  });
});
