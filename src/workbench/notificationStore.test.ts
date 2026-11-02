import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProject } from "@/platform/project";
import { NOTIFICATION_GROUPS, canSuppress, notificationPrefs, notify } from "./notificationStore";

const { showSystemNotification } = vi.hoisted(() => ({
  showSystemNotification: vi.fn(async (_title: string, _body: string) => ({ status: "ok", data: null })),
}));

vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return { ...actual, isTauri: () => true, commands: { ...actual.commands, showSystemNotification } };
});

beforeEach(() => {
  vi.useFakeTimers();
  showSystemNotification.mockClear();
});

afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
});

describe("system toast coalescing", () => {
  it("shows the first toast at once and the rest of a burst as one, naming the last and how many more", () => {
    notify({ level: "info", title: "File a.ts changed" });
    expect(showSystemNotification).toHaveBeenCalledTimes(1);
    expect(showSystemNotification.mock.calls[0]).toEqual(["File a.ts changed", ""]);
    notify({ level: "info", title: "File b.ts changed", body: "written by an agent" });
    notify({ level: "info", title: "File c.ts changed", body: "written by an agent" });
    expect(showSystemNotification).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3000);
    expect(showSystemNotification).toHaveBeenCalledTimes(2);
    expect(showSystemNotification.mock.calls[1]).toEqual([
      "File c.ts changed",
      "written by an agent\n1 more notification",
    ]);
  });

  it("shows a lone balloon's toast as written, without waiting", () => {
    notify({ level: "info", title: "Git refresh failed", body: "no remote" });
    expect(showSystemNotification).toHaveBeenCalledTimes(1);
    expect(showSystemNotification.mock.calls[0]).toEqual(["Git refresh failed", "no remote"]);
    vi.advanceTimersByTime(10_000);
    expect(showSystemNotification).toHaveBeenCalledTimes(1);
  });

  it("keeps waiting while balloons keep arriving", () => {
    notify({ level: "info", title: "First" });
    notify({ level: "info", title: "Second" });
    vi.advanceTimersByTime(2000);
    notify({ level: "info", title: "Third" });
    vi.advanceTimersByTime(2000);
    expect(showSystemNotification).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(showSystemNotification).toHaveBeenCalledTimes(2);
    expect(showSystemNotification.mock.calls[1]).toEqual(["Third", "1 more notification"]);
  });

  it("still summarises a steady stream every 30 seconds", () => {
    notify({ level: "info", title: "Start" });
    for (let i = 0; i < 30; i++) {
      vi.advanceTimersByTime(1000);
      notify({ level: "info", title: `Edit ${i}` });
    }
    expect(showSystemNotification).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(showSystemNotification).toHaveBeenCalledTimes(2);
    expect(showSystemNotification.mock.calls[1]![0]).toBe("Edit 29");
  });

  it("falls back to the count alone when a balloon has no body", () => {
    notify({ level: "warning", title: "Cannot reload Maven projects" });
    notify({ level: "warning", title: "Cannot reload Gradle projects" });
    notify({ level: "warning", title: "Cannot reload sbt projects" });
    vi.advanceTimersByTime(3000);
    expect(showSystemNotification.mock.calls[1]).toEqual(["Cannot reload sbt projects", "1 more notification"]);
  });
});

describe("ClipCode notification group", () => {
  it("is listed in Settings › Notifications under its own title", () => {
    expect(NOTIFICATION_GROUPS).toContainEqual({ id: "clipcode", title: "ClipCode" });
  });

  it("is shown as a balloon and logged by default, as the IntelliJ plugin's group", () => {
    useProject.setState({ settings: null });
    expect(notificationPrefs("clipcode")).toMatchObject({ display: "balloon", log: true });
  });

  it("can be turned off without hiding Version Control notifications", () => {
    useProject.setState({ settings: { notifications: { groups: { clipcode: { display: "none" } } } } as never });
    try {
      expect(canSuppress({ level: "info", group: "clipcode" })).toBe(false);
      expect(canSuppress({ level: "info", group: "vcs" })).toBe(true);
      expect(notificationPrefs("vcs").display).toBe("balloon");
    } finally {
      useProject.setState({ settings: null });
    }
  });
});
