import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { executeAction } from "@/platform/actions";
import { usePlatform } from "@/platform/platformInfo";
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

describe("macOS", () => {
  const saved = usePlatform.getState();
  afterEach(() => usePlatform.setState(saved));

  it("draws the tabs itself below the toolbar, the system tab bar being hidden", () => {
    usePlatform.setState({ os: "macos", overlayTitleBar: true, framelessTitleBar: false });
    render(<WindowGroupTabs />);
    expect(screen.getByRole("tab", { name: "Frontend" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("button", { name: "Close Backend" }));
    expect(executeAction).toHaveBeenLastCalledWith("window.closeTab", "project-1");
  });

  it("hides them in Distraction Free Mode", () => {
    usePlatform.setState({ os: "macos", overlayTitleBar: true, framelessTitleBar: false });
    render(<WindowGroupTabs hidePageTabs />);
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });
});
