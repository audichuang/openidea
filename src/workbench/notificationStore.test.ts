import { describe, expect, it } from "vitest";
import { useProject } from "@/platform/project";
import { NOTIFICATION_GROUPS, canSuppress, notificationPrefs } from "./notificationStore";

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
