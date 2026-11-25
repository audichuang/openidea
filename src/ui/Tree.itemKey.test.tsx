import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { Tree, type TreeModel, type TreeModelRow } from "./Tree";

// Counts the virtualizer's key lookups: it remeasures every row from the first whenever its
// `getItemKey` changes identity, so a new closure per render costs O(rows) on every render.
const itemKeyCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("@tanstack/react-virtual", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-virtual")>();
  const counted = new WeakMap<object, (i: number) => unknown>();
  return {
    ...actual,
    useVirtualizer: (options: Parameters<typeof actual.useVirtualizer>[0]) => {
      const own = options.getItemKey;
      let getItemKey = own && counted.get(own);
      if (own && !getItemKey) {
        getItemKey = (i: number) => {
          itemKeyCalls.count++;
          return own(i);
        };
        counted.set(own, getItemKey);
      }
      return actual.useVirtualizer({ ...options, getItemKey } as typeof options);
    },
  };
});

interface N {
  id: string;
}

const ROWS = 20_000;
const nodes: N[] = Array.from({ length: ROWS }, (_, i) => ({ id: `n${i}` }));
const modelRows: TreeModelRow<N>[] = nodes.map((node, i) => ({
  node,
  key: node.id,
  depth: 0,
  parentKey: null,
  expandable: false,
  expanded: false,
  posInSet: i + 1,
  setSize: ROWS,
}));
const model: TreeModel<N> = {
  rowCount: ROWS,
  rowAt: (i) => modelRows[i],
  indexOfKey: (key) => modelRows.findIndex((r) => r.key === key),
  forEachRow: (visit) => modelRows.forEach(visit),
  setExpanded: () => {},
  findOccurrence: () => null,
};

const common = {
  "aria-label": "Rows",
  getKey: (n: N) => n.id,
  getLabel: (n: N) => n.id,
  getChildren: () => undefined,
  isExpandable: () => false,
};

describe("Tree virtualizer keys", () => {
  it.each([
    ["a model", { model }],
    ["roots", { roots: nodes }],
  ])("does not look up every row's key again when %s re-renders with the same rows", (_, source) => {
    const { rerender } = render(<Tree<N> {...common} {...source} selected={new Set(["n1"])} />);
    itemKeyCalls.count = 0;
    rerender(<Tree<N> {...common} {...source} selected={new Set(["n2"])} />);
    rerender(<Tree<N> {...common} {...source} selected={new Set(["n3"])} />);
    expect(itemKeyCalls.count).toBeLessThan(ROWS);
  });
});
