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

describe("Git Graph arrows", () => {
  // Rows 2 and 150 joined by a long edge on lane 1 whose middle is hidden behind two arrows;
  // row 5's lane leaves past the loaded rows.
  const arrowRows = (loaded: number): GraphLaneRow[] =>
    Array.from({ length: loaded }, (_, i) => ({
      lane: 0,
      color: 0,
      up: [
        { from: 0, to: 0, color: 0 },
        ...(i === 150 ? [{ from: 1, to: 1, color: 1, arrow: "up" as const, targetRow: 2 }] : []),
      ],
      down: [
        { from: 0, to: 0, color: 0 },
        ...(i === 2 ? [{ from: 1, to: 1, color: 1, arrow: "down" as const, targetRow: 150 }] : []),
        ...(i === 5 ? [{ from: 1, to: 1, color: 1, arrow: "down" as const, targetRow: N }] : []),
      ],
      width: 2,
    }));
  const arrowIn = (i: number) => rowOf(i).querySelector<SVGPathElement>('path[role="button"]');

  it("selects the commit at the other end of a down arrow, not the arrow's row", () => {
    const onSelect = vi.fn();
    mount({ rows: arrowRows(N), onSelect });
    // The drawn arrow lets clicks through to the hit path under it.
    const hit = arrowIn(2)!;
    expect(hit.nextElementSibling?.getAttribute("pointer-events")).toBe("none");
    hit.focus();
    fireEvent.click(hit);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith([entries[150]!.id]);
    // Focus moves to the list, so the arrow keys keep working once the arrow's row scrolls away.
    expect(document.activeElement?.getAttribute("role")).toBe("grid");
  });

  it("selects the commit at the other end of an up arrow, also with Enter", () => {
    const onSelect = vi.fn();
    first = 140;
    mount({ rows: arrowRows(N), onSelect });
    fireEvent.click(arrowIn(150)!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenLastCalledWith([entries[2]!.id]);
    fireEvent.keyDown(arrowIn(150)!, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("keeps arrows out of the Tab order, so Tab leaves the list in one step", () => {
    mount({ rows: arrowRows(N) });
    expect(arrowIn(2)!.getAttribute("tabindex")).toBe("-1");
  });

  it("leaves an arrow to a row not loaded yet inert until that row loads", () => {
    const onSelect = vi.fn();
    const shorter = entries.slice(0, N - 10);
    const rowsNow = arrowRows(N);
    const list = mount({ entries: shorter, rows: rowsNow.slice(0, N - 10), onSelect, done: false });
    expect(arrowIn(5)).toBeNull();
    // A click on the row still selects that row.
    fireEvent.click(rowOf(5));
    expect(onSelect).toHaveBeenLastCalledWith([entries[5]!.id]);
    // The page holding the target arrives; row 5's segments are the same objects.
    list.rerender({ entries: [...entries, ...extra], rows: [...rowsNow, ...arrowRows(N + 1).slice(N)] });
    fireEvent.click(arrowIn(5)!);
    expect(onSelect).toHaveBeenLastCalledWith([extra[0]!.id]);
  });
});

const first0 = entries[0] as GraphEntry & { kind: "commit" };
const extra: GraphEntry[] = [
  {
    kind: "commit",
    id: "f".repeat(40),
    parents: [],
    commit: { ...first0.commit, id: "f".repeat(40), shortId: "ffffffff", summary: "beyond", refs: [] },
  },
];
