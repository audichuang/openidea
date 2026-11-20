import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import type { Settings } from "@/bindings";
import { useProject } from "@/platform/project";
import { provideGitGraphBridge, type GitGraphBridge, type GraphLaneRow } from "@/workbench/gitGraphBridge";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 24,
    getVirtualItems: () => Array.from({ length: count }, (_, i) => ({ index: i, start: i * 24, key: i })),
    scrollToIndex: () => {},
  }),
}));

// Each row renders its graph once per render: the calls count row renders.
const graphRenders = vi.fn();
vi.mock("../GraphCell", () => ({
  LANE: 14,
  GraphCell: () => {
    graphRenders();
    return null;
  },
}));

import { CommitList, type CommitListProps } from "../CommitList";
import type { GraphEntry } from "../entries";

const NOW = new Date(2026, 10, 20, 15, 0, 30).getTime();
// Row 0 was committed 20 seconds ago, the others on earlier days.
const times = [NOW - 20_000, new Date(2026, 9, 3, 9, 7).getTime(), new Date(2026, 8, 14, 18, 30).getTime()];
const entries: GraphEntry[] = times.map((timeMs, i) => {
  const id = String(i).padStart(40, "0");
  return {
    kind: "commit",
    id,
    parents: [],
    commit: {
      id,
      shortId: id.slice(0, 8),
      parents: [],
      author: "Ann",
      email: "ann@example.com",
      timeMs,
      summary: `subject ${i}`,
      message: `subject ${i}`,
      refs: [],
      repo: "/repo",
    },
  };
});
const rows: GraphLaneRow[] = entries.map(() => ({ lane: 0, color: 0, up: [], down: [], width: 1 }));

const props: CommitListProps = {
  entries,
  generation: 1,
  rows,
  width: 1,
  done: true,
  loading: false,
  loadMore: () => {},
  selected: [],
  onSelect: () => {},
  head: null,
  branches: [],
  remotes: [],
  remoteBranches: new Set(),
  matches: [],
  current: -1,
  repo: "/repo",
  bisect: null,
};

const dateFormat = (o: object) =>
  useProject.setState({ settings: { general: { dateFormat: o } } as unknown as Settings });

let withdraw: () => void;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
  withdraw = provideGitGraphBridge({ refLabels: () => [] } as unknown as GitGraphBridge);
  dateFormat({ overrideSystem: true, pattern: "dd.MM.yyyy", use24Hour: true, pretty: true });
});
afterEach(() => {
  withdraw();
  useProject.setState({ settings: null });
  vi.useRealTimers();
});

const dates = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-entry]")].map((row) => row.children[2]!.textContent);

describe("Git Graph date column", () => {
  it("shows a changed date format on every row without re-rendering the rows", () => {
    const { container } = render(<CommitList {...props} />);
    expect(dates(container)).toEqual(["Moments ago", "03.10.2026 09:07", "14.09.2026 18:30"]);
    graphRenders.mockClear();
    act(() => dateFormat({ overrideSystem: true, pattern: "yyyy-MM-dd", use24Hour: false, pretty: false }));
    expect(dates(container)).toEqual(["2026-11-20 3:00 PM", "2026-10-03 9:07 AM", "2026-09-14 6:30 PM"]);
    expect(graphRenders).not.toHaveBeenCalled();
  });

  it("advances relative dates as the minutes pass without re-rendering the rows", () => {
    const { container } = render(<CommitList {...props} />);
    expect(dates(container)[0]).toBe("Moments ago");
    graphRenders.mockClear();
    act(() => vi.advanceTimersByTime(120_000));
    expect(dates(container)[0]).toBe("2 min ago");
    expect(graphRenders).not.toHaveBeenCalled();
  });
});
