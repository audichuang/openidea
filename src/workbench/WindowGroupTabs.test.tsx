import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { executeAction } from "@/platform/actions";
import type { Settings } from "@/platform/ipc";
import { usePlatform } from "@/platform/platformInfo";
import { useProject } from "@/platform/project";
import { useWindowGroup } from "@/platform/windowGroups";
import { WindowGroupTabs } from "./WindowGroupTabs";

vi.mock("@/platform/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/actions")>()),
  executeAction: vi.fn(async () => {}),
}));

beforeEach(() => {
  vi.mocked(executeAction).mockClear();
  useWindowGroup.setState({
    tabs: [
      { label: "main", name: "Frontend", root: "/front", current: true },
      { label: "project-1", name: "Backend", root: "/back", current: false },
    ],
  });
});

it("switches and closes the intended project with mouse and keyboard", () => {
  render(<WindowGroupTabs />);
  const first = screen.getByRole("tab", { name: "Frontend" });
  expect(first).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tab", { name: "Backend" })).toHaveAttribute("tabindex", "-1");
  fireEvent.keyDown(first, { key: "ArrowLeft" });
  expect(executeAction).toHaveBeenLastCalledWith("window.selectTab", "project-1");
  fireEvent.click(screen.getByRole("button", { name: "Close Backend" }));
  expect(executeAction).toHaveBeenLastCalledWith("window.closeTab", "project-1");
  fireEvent.click(first);
  expect(executeAction).toHaveBeenLastCalledWith("window.selectTab", "main");
});

it("removes the tab row when the group dissolves", () => {
  useWindowGroup.setState({ tabs: [] });
  render(<WindowGroupTabs />);
  expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
});

describe("macOS system tab bar", () => {
  const saved = usePlatform.getState();
  afterEach(() => {
    usePlatform.setState(saved);
    useProject.setState({ settings: null });
    useWindowGroup.setState({ systemTabBar: { height: 0, top: false } });
  });

  const space = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-window-group='system']");

  it("keeps room for it instead of drawing tabs, on the side the system draws it", () => {
    usePlatform.setState({ os: "macos", overlayTitleBar: true, framelessTitleBar: false });
    useProject.setState({ settings: { appearance: { zoom: 125 } } as Settings });
    useWindowGroup.setState({ systemTabBar: { height: 40, top: false } });
    const below = render(<WindowGroupTabs hidePageTabs />);
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    // Native points over page zoom; Distraction Free keeps the room: the system bar stays.
    expect(space(below.container)?.style.height).toBe("32px");
    expect(space(render(<WindowGroupTabs top />).container)).toBeNull();
    below.unmount();

    useWindowGroup.setState({ systemTabBar: { height: 40, top: true } });
    expect(space(render(<WindowGroupTabs />).container)).toBeNull();
    expect(space(render(<WindowGroupTabs top />).container)?.style.height).toBe("32px");
  });

  it("leaves no room without a tab bar", () => {
    usePlatform.setState({ os: "macos", overlayTitleBar: true, framelessTitleBar: false });
    const { container } = render(<WindowGroupTabs />);
    expect(space(container)).toBeNull();
  });
});
