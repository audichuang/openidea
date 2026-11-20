import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import type { GraphCommit } from "@/workbench/gitGraphBridge";

const { scrollToIndex } = vi.hoisted(() => ({ scrollToIndex: vi.fn() }));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 24,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 24, key: index })),
    scrollToIndex,
  }),
}));

import { CommitList, type CommitListProps } from "../CommitList";
import type { GraphEntry } from "../entries";

const entry = (id: string): GraphEntry => {
  const commit: GraphCommit = {
    id,
    shortId: id.slice(0, 8),
    parents: [],
    author: "a",
    email: "a@example.com",
    timeMs: 0,
    summary: id,
    message: id,
    refs: [],
    repo: "/repo",
  };
  return { kind: "commit", id, parents: [], commit };
};
const page = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => entry(`c${from + i}`));

const props = (entries: GraphEntry[], selected: string[], generation = 1): CommitListProps => ({
  entries,
  generation,
  rows: [],
  width: 1,
  done: true,
  loading: false,
  loadMore: () => {},
  selected,
  onSelect: () => {},
  head: null,
  branches: [],
  remotes: [],
  remoteBranches: new Set(),
  matches: [],
  current: -1,
  repo: "/repo",
  bisect: null,
});

describe("CommitList reveal", () => {
  beforeEach(() => scrollToIndex.mockClear());

  // #404: the next page loading scrolled the list back to the selected row.
  it("does not scroll back to an unchanged selection when entries change", () => {
    const selected = ["c3"];
    const first = page(0, 10);
    const { rerender } = render(<CommitList {...props(first, selected)} />);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    expect(scrollToIndex).toHaveBeenLastCalledWith(3, { align: "auto" });

    rerender(<CommitList {...props([...first, ...page(10, 20)], selected)} />);
    rerender(<CommitList {...props(page(0, 20), selected)} />);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
  });

  it("reveals a new selection, including the same row selected again", () => {
    const entries = page(0, 20);
    const { rerender } = render(<CommitList {...props(entries, [])} />);
    expect(scrollToIndex).not.toHaveBeenCalled();

    rerender(<CommitList {...props(entries, ["c12"])} />);
    expect(scrollToIndex).toHaveBeenLastCalledWith(12, { align: "auto" });

    rerender(<CommitList {...props(entries, ["c12"])} />);
    expect(scrollToIndex).toHaveBeenCalledTimes(2);
  });

  it("reveals a selection made before its row loaded once the row appears, then only once", () => {
    const selected = ["c15"];
    const { rerender } = render(<CommitList {...props(page(0, 10), selected)} />);
    expect(scrollToIndex).not.toHaveBeenCalled();

    rerender(<CommitList {...props(page(0, 20), selected)} />);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    expect(scrollToIndex).toHaveBeenLastCalledWith(15, { align: "auto" });

    rerender(<CommitList {...props(page(0, 30), selected)} />);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
  });

  // A filter switch or reload replaces the list with an unchanged selection: reveal it again once its row is back.
  it("reveals an unchanged selection once more when the list is replaced, then not on its page appends", () => {
    const selected = ["c15"];
    const { rerender } = render(<CommitList {...props(page(0, 20), selected, 1)} />);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);

    // Remote branches hidden: the selected commit is gone from the new list.
    rerender(<CommitList {...props([], selected, 2)} />);
    rerender(<CommitList {...props(page(0, 10), selected, 2)} />);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);

    // Shown again: the list starts over and the row comes back with a later page.
    rerender(<CommitList {...props([], selected, 3)} />);
    rerender(<CommitList {...props(page(0, 10), selected, 3)} />);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    rerender(<CommitList {...props(page(0, 20), selected, 3)} />);
    expect(scrollToIndex).toHaveBeenCalledTimes(2);
    expect(scrollToIndex).toHaveBeenLastCalledWith(15, { align: "auto" });

    rerender(<CommitList {...props(page(0, 30), selected, 3)} />);
    expect(scrollToIndex).toHaveBeenCalledTimes(2);
  });

  it("does not reveal when a refresh in place drops the selected row and brings it back", () => {
    const selected = ["c15"];
    const { rerender } = render(<CommitList {...props(page(0, 20), selected)} />);
    rerender(<CommitList {...props(page(0, 10), selected)} />);
    rerender(<CommitList {...props(page(0, 20), selected)} />);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
  });
});
