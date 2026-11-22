import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { usePlatform } from "@/platform/platformInfo";
import { SessionPanel } from "./RunView";
import { openSampleConsoleSession, runtime, useRun } from "./store";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 20,
    getVirtualItems: () => [],
    scrollToIndex: () => {},
    measureElement: () => {},
    measure: () => {},
  }),
}));

describe("Run console line cap", () => {
  it("says how many of 60,000 lines the 50,000-line cap dropped, with no character limit", () => {
    usePlatform.setState({ os: "macos" });
    const id = openSampleConsoleSession("long");
    const rt = runtime(id)!;
    rt.console.setMaxChars(null);
    let text = "";
    for (let i = 0; i < 60_000; i++) text += `line ${i}\n`;
    rt.console.append({ kind: "stdout", text });
    expect(rt.console.dropped).toBeGreaterThan(0);
    render(<SessionPanel session={useRun.getState().sessions.find((s) => s.id === id)!} />);
    expect(screen.getByText(`${rt.console.dropped.toLocaleString()} earlier lines were discarded`)).toBeInTheDocument();
  });
});
