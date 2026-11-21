import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { usePlatform } from "@/platform/platformInfo";
import { adoptSession, appendConsole, useDebug } from "../state";
import { DebugConsole } from "../ui/DebugConsole";

const nav = vi.hoisted(() => ({
  openTarget: vi.fn(async () => {}),
  openUrl: vi.fn(async () => {}),
}));

vi.mock("@/features/run/navigate", async () => {
  const actual = await vi.importActual<typeof import("@/features/run/navigate")>("@/features/run/navigate");
  return {
    ...actual,
    openTarget: nav.openTarget,
    openUrl: nav.openUrl,
  };
});

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 18,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, start: index * 18, size: 18, key: index })),
    scrollToIndex: () => {},
    measureElement: () => {},
    measure: () => {},
  }),
}));

beforeEach(() => {
  usePlatform.setState({ os: "macos" });
  useDebug.setState({ sessions: {}, console: {}, active: null });
  nav.openTarget.mockClear();
  nav.openUrl.mockClear();
  window.getSelection()?.removeAllRanges();
});

describe("Debug console links", () => {
  it("renders clickable file and URL links in output", () => {
    const session = adoptSession(1);
    session.launch = {
      name: "test",
      adapter: "delve",
      request: "launch",
      program: "main.go",
      args: [],
      cwd: "/repo/demo-app",
      env: {},
      extraJson: null,
    };

    appendConsole(1, "stdout", "    /Users/dev/demo-app/pkg/api/server.go:42:\n");
    appendConsole(1, "stdout", "2026-01-01T12:00:00.000+0000 DEBUG pkg/store/db.go:15 failed\n");
    appendConsole(1, "stdout", "Listening on http://localhost:8080/api\n");
    appendConsole(1, "system", "Process finished with exit code 0\n");

    render(<DebugConsole session={session} />);

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(3);

    expect(links[0]?.textContent).toBe("/Users/dev/demo-app/pkg/api/server.go:42");
    expect(links[1]?.textContent).toBe("pkg/store/db.go:15");
    expect(links[2]?.textContent).toBe("http://localhost:8080/api");
  });

  it("navigates to target file on click with resolved cwd", () => {
    const session = adoptSession(1);
    session.launch = {
      name: "test",
      adapter: "delve",
      request: "launch",
      program: "main.go",
      args: [],
      cwd: "/repo/demo-app",
      env: {},
      extraJson: null,
    };

    appendConsole(1, "stdout", "2026-01-01T12:00:00.000+0000 DEBUG pkg/store/db.go:15 failed\n");

    render(<DebugConsole session={session} />);

    const link = screen.getByRole("link", { name: "pkg/store/db.go:15" });
    fireEvent.click(link);

    expect(nav.openTarget).toHaveBeenCalledTimes(1);
    expect(nav.openTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "pkg/store/db.go",
        line: 15,
      }),
      "/repo/demo-app",
    );
  });

  it("opens URL on click", () => {
    const session = adoptSession(1);
    appendConsole(1, "stdout", "See docs at https://example.com/guide\n");

    render(<DebugConsole session={session} />);

    const link = screen.getByRole("link", { name: "https://example.com/guide" });
    fireEvent.click(link);

    expect(nav.openUrl).toHaveBeenCalledTimes(1);
    expect(nav.openUrl).toHaveBeenCalledWith("https://example.com/guide");
  });

  it("does not trigger navigation when text is selected", () => {
    const session = adoptSession(1);
    appendConsole(1, "stdout", "    /Users/dev/demo-app/pkg/api/server.go:42:\n");

    render(<DebugConsole session={session} />);

    // Mock active selection
    const selectionSpy = vi.spyOn(window, "getSelection").mockReturnValue({
      toString: () => "server.go",
    } as unknown as Selection);

    try {
      const link = screen.getByRole("link", { name: "/Users/dev/demo-app/pkg/api/server.go:42" });
      fireEvent.click(link);

      expect(nav.openTarget).not.toHaveBeenCalled();
    } finally {
      selectionSpy.mockRestore();
    }
  });

  it("renders clickable links across >10 KiB lines in DebugConsole", () => {
    const session = adoptSession(1);
    const longLine = `src/start.go:1:1 ${"x".repeat(2_582)} src/col2600.go:10:2 ${"x".repeat(2_400)} src/mid.go:2:2 ${"y".repeat(5_000)} src/end.go:3:3\n`;
    appendConsole(1, "stdout", longLine);

    render(<DebugConsole session={session} />);
    const log = screen.getByRole("log", { name: "Debug console" });
    Object.defineProperty(log, "clientWidth", { configurable: true, value: 800 });
    Object.defineProperty(log, "scrollLeft", { configurable: true, writable: true, value: 0 });
    fireEvent.scroll(log);

    expect(screen.getByRole("link", { name: "src/start.go:1:1" })).toBeInTheDocument();
    // At 13px * 0.60em (7.8px/ch), scrollLeft 20,280 in an 800px viewport displays cols 2,600..2,703.
    Object.defineProperty(log, "scrollLeft", { configurable: true, writable: true, value: 20_280 });
    fireEvent.scroll(log);
    expect(screen.getByRole("link", { name: "src/col2600.go:10:2" })).toBeInTheDocument();
    Object.defineProperty(log, "scrollLeft", { configurable: true, writable: true, value: 39_200 });
    fireEvent.scroll(log);
    expect(screen.getByRole("link", { name: "src/mid.go:2:2" })).toBeInTheDocument();
    Object.defineProperty(log, "scrollLeft", { configurable: true, writable: true, value: 78_400 });
    fireEvent.scroll(log);
    expect(screen.getByRole("link", { name: "src/end.go:3:3" })).toBeInTheDocument();
  });
});
