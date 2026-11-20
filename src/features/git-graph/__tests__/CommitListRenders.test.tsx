import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Profiler } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { provideGitGraphBridge, type GitGraphBridge, type GraphLaneRow } from "@/workbench/gitGraphBridge";

// The rows the virtualizer shows: `first` .. `first + VISIBLE`, as a scroll position would.
const VISIBLE = 22;
let first = 0;
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 24,
    getVirtualItems: () =>
      Array.from({ length: Math.min(VISIBLE, count - first) }, (_, i) => ({
        index: first + i,
        start: (first + i) * 24,
        key: first + i,
      })),
    scrollToIndex: () => {},
  }),
}));

// Every commit row formats its date once per render, so the calls count row renders.
const formatTimestamp = vi.fn((ms: number) => String(ms));
vi.mock("@/platform/dateFormat", () => ({ formatTimestamp: (ms: number) => formatTimestamp(ms) }));

import { CommitList, type CommitListProps } from "../CommitList";
import type { GraphEntry } from "../entries";

const N = 200;
const entries: GraphEntry[] = Array.from({ length: N }, (_, i) => {
  const id = String(i).padStart(40, "0");
  return {
    kind: "commit",
    id,
    parents: [String(i + 1).padStart(40, "0")],
    commit: {
      id,
      shortId: id.slice(0, 8),
      parents: [],
      author: "Ann",
      email: "ann@example.com",
      timeMs: 1_700_000_000_000 + i,
      summary: `subject ${i}`,
      message: `subject ${i}`,
      refs: i % 10 === 0 ? ["main"] : [],
      repo: "/repo",
    },
  };
});
// Two branch lines: colour 0 on lane 0 throughout, colour 1 on lane 1 in the first half.
const rows: GraphLaneRow[] = entries.map((_, i) => ({
  lane: 0,
  color: 0,
  up: [{ from: 0, to: 0, color: 0 }, ...(i < N / 2 ? [{ from: 1, to: 1, color: 1 }] : [])],
  down: [{ from: 0, to: 0, color: 0 }, ...(i < N / 2 ? [{ from: 1, to: 1, color: 1 }] : [])],
  width: 2,
}));

const bridge = {
  laneColor: (c: number) => `var(--lane-${c})`,
  refLabels: (refs: readonly string[]) => refs.map((name) => ({ kind: "local" as const, name })),
} as unknown as GitGraphBridge;

// One object per prop, as the editor passes them, so only the prop a step changes differs.
const base: CommitListProps = {
  entries,
  rows,
  width: 2,
  done: true,
  loading: false,
  loadMore: () => {},
  selected: [],
  onSelect: () => {},
  head: { head: "main", headCommit: entries[0]!.id },
  branches: [],
  remotes: [],
  remoteBranches: new Set(),
  matches: [],
  current: -1,
  repo: "/repo",
  bisect: null,
};
const props = (over: Partial<CommitListProps> = {}): CommitListProps => ({ ...base, ...over });

let withdraw: () => void;
beforeEach(() => {
  first = 0;
  withdraw = provideGitGraphBridge(bridge);
});
afterEach(() => withdraw());

/** Renders the list and returns how many rows (and list commits) each later step renders. */
function mount(initial: Partial<CommitListProps> = {}) {
  let commits = 0;
  const tree = (p: CommitListProps) => (
    <Profiler id="list" onRender={() => commits++}>
      <CommitList {...p} />
    </Profiler>
  );
  const view = render(tree(props(initial)));
  return {
    container: view.container,
    step(fn: () => void) {
      formatTimestamp.mockClear();
      commits = 0;
      act(fn);
      const counts = { rows: formatTimestamp.mock.calls.length, commits };
      return counts;
    },
    rerender: (p: Partial<CommitListProps>) => view.rerender(tree(props({ ...initial, ...p }))),
  };
}

const rowOf = (i: number) => screen.getByText(`subject ${i}`).closest<HTMLElement>("[data-entry]")!;

describe("Git Graph list render cost", () => {
  it("re-renders only the two rows whose selection changed", () => {
    const list = mount({ selected: [entries[3]!.id] });
    const { rows: n } = list.step(() => list.rerender({ selected: [entries[4]!.id] }));
    expect(n).toBeLessThanOrEqual(2);
    expect(rowOf(4).getAttribute("aria-selected")).toBe("true");
    expect(rowOf(3).getAttribute("aria-selected")).toBe("false");
  });

  it("dims the other branch lines on hover without re-rendering rows", () => {
    const list = mount();
    const { rows: n } = list.step(() => fireEvent.mouseOver(rowOf(5)));
    expect(n).toBe(0);
    // The hovered colour stays bright, every other colour's edges and nodes dim.
    const css = list.container.querySelector("style")?.textContent ?? "";
    expect(css).toMatch(/\[data-lane-color\]:not\(\[data-lane-color="0"\]\)\{opacity:0\.25\}/);
    expect(rowOf(5).querySelector('path[data-lane-color="1"]')).not.toBeNull();
    const { rows: m } = list.step(() => fireEvent.mouseLeave(rowOf(5).parentElement!));
    expect(m).toBe(0);
    expect(list.container.querySelector("style")).toBeNull();
  });

  it("renders only the newly shown row when scrolling by one row", () => {
    const list = mount();
    const { rows: n } = list.step(() => {
      first = 1;
      list.rerender({});
    });
    expect(n).toBe(1);
  });
});
