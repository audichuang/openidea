import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { FileMatches, SearchQuery, SearchSummary } from "@/platform/ipc";

const treeSpy = {
  getKeyCallsPerRender: [] as number[],
  rowAtCallsPerRender: [] as number[],
  expandedSizes: [] as number[],
  forEachRowCalls: 0,
  reset() {
    this.getKeyCallsPerRender = [];
    this.rowAtCallsPerRender = [];
    this.expandedSizes = [];
    this.forEachRowCalls = 0;
  },
};

const pendingUsagesSpy = vi.fn();

vi.mock("./replaceFlow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./replaceFlow")>();
  return {
    ...actual,
    pendingUsages: (...args: Parameters<typeof actual.pendingUsages>) => {
      pendingUsagesSpy(...args);
      return actual.pendingUsages(...args);
    },
  };
});

vi.mock("@/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/ui")>();
  return {
    ...actual,
    Tree: function InstrumentedTree<T>(props: React.ComponentProps<typeof actual.Tree<T>>) {
      let calls = 0;
      let rowAtCalls = 0;
      const wrappedGetKey = (node: T) => {
        calls++;
        return props.getKey(node);
      };
      // Every row read through the model counts, and any walk over all of its rows.
      const model = props.model && {
        ...props.model,
        rowAt: (i: number) => (rowAtCalls++, props.model!.rowAt(i)),
        forEachRow: (visit: Parameters<typeof props.model.forEachRow>[0]) => {
          treeSpy.forEachRowCalls++;
          props.model!.forEachRow(visit);
        },
      };
      const out = actual.Tree({ ...props, model, getKey: wrappedGetKey });
      treeSpy.getKeyCallsPerRender.push(calls);
      treeSpy.rowAtCallsPerRender.push(rowAtCalls);
      treeSpy.expandedSizes.push(props.expanded?.size ?? 0);
      return out;
    },
  };
});

import { FindToolWindow } from "./FindToolWindow";
import type { FindDeps } from "./session";
import { disposeFindWindow, openInFindWindow, useFindViewOptions } from "./windowStore";

const query: SearchQuery = {
  pattern: "needle",
  isRegex: false,
  caseSensitive: false,
  wholeWord: false,
  include: [],
  exclude: [],
  scope: { kind: "project" },
  maxMatches: 0,
};

const makeFile = (i: number): FileMatches => {
  const relPath = `src/m${(i * 7) % 23}/F${(i * 7919) % 10_000}.ts`;
  return {
    path: `/p/${relPath}`,
    relPath,
    matches: [{ line: 0, text: `  const needle${i} = 1`, ranges: [[8, 14]], textOffset: 0 }],
  };
};

async function streamBatches(total: number, batchSize: number, groupByDirectory: boolean) {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"],
  });
  useFindViewOptions.setState({ preview: false, groupByDirectory });

  let onFile!: (f: FileMatches) => void;
  let finish!: (s: SearchSummary | null) => void;
  const deps: FindDeps = {
    validate: async () => {},
    nextRequestId: () => 1,
    cancel: () => {},
    start: (_id, _q, cb) =>
      new Promise<SearchSummary | null>((resolve) => {
        onFile = cb;
        finish = resolve;
      }),
  };

  openInFindWindow(query, "needle", { deps });
  render(<FindToolWindow />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

  for (let i = 0; i < total; i += batchSize) {
    await act(async () => {
      for (let j = i; j < i + batchSize; j++) onFile(makeFile(j));
      await vi.advanceTimersToNextFrame();
    });
  }
  await act(async () => {
    finish({ files: total, matches: total, limitHit: false, cancelled: false, elapsedMs: 10 });
    await vi.advanceTimersByTimeAsync(0);
  });

  expect(screen.getByText(/1,000 matches in 1,000 files/)).toBeInTheDocument();
}

afterEach(() => {
  disposeFindWindow();
  vi.useRealTimers();
  treeSpy.reset();
  pendingUsagesSpy.mockClear();
});

describe("FindToolWindow incremental streaming", () => {
  it("does not compute pendingUsages on each render during a normal Find search", async () => {
    await streamBatches(1_000, 40, false);
    expect(pendingUsagesSpy).toHaveBeenCalledTimes(0);
  });

  it.each([false, true])(
    "does not rebuild O(total) expanded sets or flatten all rows per frame (grouped: %s)",
    async (grouped) => {
      await streamBatches(1_000, 40, grouped);
      const maxExpandedSize = Math.max(...treeSpy.expandedSizes);
      const maxGetKeyCalls = Math.max(...treeSpy.getKeyCallsPerRender);
      expect({ maxExpandedSize, maxGetKeyCalls }).toEqual({
        maxExpandedSize: 0,
        maxGetKeyCalls: expect.any(Number),
      });
      expect(maxGetKeyCalls).toBeLessThan(150);
      // Rows in view only (jsdom has no viewport height, so only the overscan), never all of them.
      expect(Math.max(...treeSpy.rowAtCallsPerRender)).toBeLessThan(150);
      expect(Math.max(...treeSpy.rowAtCallsPerRender)).toBeGreaterThan(0);
      expect(treeSpy.forEachRowCalls).toBe(0);
    },
  );
});
