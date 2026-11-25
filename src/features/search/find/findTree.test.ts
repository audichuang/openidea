import { describe, expect, it } from "vitest";
import type { FileMatches } from "@/platform/ipc";
import { findOccurrence, type TreeModelRow } from "@/ui/Tree";
import {
  COLLAPSE_ALL,
  EXPAND_ALL,
  FindTreeIndex,
  buildFindTree,
  toggleCollapseNode,
  type CollapseState,
  type FindTreeNode,
} from "./findTree";

const file = (i: number, hits = 1 + (i % 3)): FileMatches => {
  const rel = `src/m${(i * 7) % 23}/F${(i * 7919) % 2_000}.ts`;
  return {
    path: `/p/${rel}`,
    relPath: rel,
    matches: Array.from({ length: hits }, (_, line) => ({
      line: line * 2,
      text: "  needle",
      ranges: [[2, 8]],
      textOffset: 0,
    })),
  };
};

const noop = () => {};

/** Growing prefixes of `files`, as streamed batches of the given sizes (the last size repeats). */
function streamSnapshots(files: readonly FileMatches[], batches: readonly number[]): FileMatches[][] {
  const out: FileMatches[][] = [];
  for (let at = 0, i = 0; at < files.length; i++) {
    at = Math.min(files.length, at + batches[Math.min(i, batches.length - 1)]!);
    out.push(files.slice(0, at));
  }
  return out;
}
const isExpanded = (state: CollapseState, key: string) =>
  state.defaultCollapsed ? state.exceptions.has(key) : !state.exceptions.has(key);

/** The rows `Tree` shows for `roots`: the oracle the index must reproduce without flattening. */
function flatten(roots: readonly FindTreeNode[], state: CollapseState): TreeModelRow<FindTreeNode>[] {
  const rows: TreeModelRow<FindTreeNode>[] = [];
  const walk = (nodes: readonly FindTreeNode[], depth: number, parentKey: string | null) => {
    nodes.forEach((node, i) => {
      const expandable = node.kind !== "match";
      const expanded = expandable && isExpanded(state, node.key);
      rows.push({
        node,
        key: node.key,
        depth,
        parentKey,
        expandable,
        expanded,
        posInSet: i + 1,
        setSize: nodes.length,
      });
      if (expanded && node.kind !== "match") walk(node.children, depth + 1, node.key);
    });
  };
  walk(roots, 0, null);
  return rows;
}

function expectSameRows(index: FindTreeIndex, files: readonly FileMatches[], grouped: boolean, state: CollapseState) {
  const model = index.sync(files, grouped, state, noop);
  const expected = flatten(buildFindTree(files, grouped), state);
  expect(model.rowCount).toBe(expected.length);
  const actual = Array.from({ length: model.rowCount }, (_, i) => model.rowAt(i)!);
  expect(actual).toEqual(expected);
  const walked: TreeModelRow<FindTreeNode>[] = [];
  model.forEachRow((r) => walked.push(r));
  expect(walked).toEqual(expected);
  expect(model.rowAt(expected.length)).toBeUndefined();
  expected.forEach((row, i) => {
    expect(model.indexOfKey(row.key)).toBe(i);
    expect(index.getNode(row.key)).toEqual(row.node);
  });
}

describe("FindTreeIndex", () => {
  const all = Array.from({ length: 600 }, (_, i) => file(i));

  it.each([false, true])("lists a growing result list like a full rebuild (grouped: %s)", (grouped) => {
    const index = new FindTreeIndex();
    const snapshots = streamSnapshots(all, [1, 5, 40, 3, 150, 1, 400]);
    for (const files of snapshots) expectSameRows(index, files, grouped, EXPAND_ALL);
  });

  it.each([false, true])("keeps every state of collapsed and expanded nodes (grouped: %s)", (grouped) => {
    const index = new FindTreeIndex();
    const snapshots = streamSnapshots(all, [100, 7, 200, 293]);
    let state = EXPAND_ALL;
    snapshots.forEach((files, step) => {
      expectSameRows(index, files, grouped, state);
      // Toggle some nodes between batches, then switch to and from Collapse All.
      const nodes = buildFindTree(files, grouped);
      const pick = (n: number) => nodes[(n * 13) % nodes.length]!;
      state = toggleCollapseNode(state, pick(step + 1), false);
      expectSameRows(index, files, grouped, state);
      state = toggleCollapseNode(state, pick(step + 2), false);
      state = toggleCollapseNode(state, pick(step + 1), true);
      expectSameRows(index, files, grouped, state);
      if (step === 1) {
        state = COLLAPSE_ALL;
        expectSameRows(index, files, grouped, state);
        state = toggleCollapseNode(state, pick(3), true);
        expectSameRows(index, files, grouped, state);
        state = EXPAND_ALL;
      }
    });
  });

  it("collapsing a directory also collapses its files, so opening it shows only the files", () => {
    const index = new FindTreeIndex();
    const dirs = buildFindTree(all, true);
    const dir = dirs[0]!;
    let state = toggleCollapseNode(EXPAND_ALL, dir.kind === "dir" ? dir.children[0]! : dir, false);
    state = toggleCollapseNode(state, dir, false);
    state = toggleCollapseNode(state, dir, true);
    const model = index.sync(all, true, state, noop);
    const rows = Array.from({ length: model.rowCount }, (_, i) => model.rowAt(i)!);
    const first = rows.find((r) => r.key === dir.key)!;
    const children = rows.filter((r) => r.parentKey === first.key);
    expect(children.length).toBe(dir.kind === "dir" ? dir.children.length : 0);
    expect(children.every((c) => !c.expanded)).toBe(true);
  });

  it("restarts from scratch when the results are not an extension of the previous ones", () => {
    const index = new FindTreeIndex();
    expectSameRows(index, all.slice(0, 300), false, EXPAND_ALL);
    expectSameRows(index, all.slice(300), false, EXPAND_ALL);
    expectSameRows(index, [], false, EXPAND_ALL);
    expectSameRows(index, all.slice(0, 50), true, EXPAND_ALL);
  });

  const options = (excluded: ReadonlySet<string>) => ({
    isOccurrence: (n: FindTreeNode) => n.kind === "match" && !excluded.has(n.key),
  });

  it.each([false, true])("steps through occurrences like the generic walk (grouped: %s)", (grouped) => {
    const files = all.slice(0, 120);
    const index = new FindTreeIndex();
    const model = index.sync(files, grouped, COLLAPSE_ALL, noop);
    const roots = buildFindTree(files, grouped);
    const generic = {
      getKey: (n: FindTreeNode) => n.key,
      getChildren: (n: FindTreeNode) => (n.kind === "match" ? undefined : n.children),
      isExpandable: (n: FindTreeNode) => n.kind !== "match",
    };
    const keys: string[] = [];
    const collect = (nodes: readonly FindTreeNode[]) =>
      nodes.forEach((n) => {
        keys.push(n.key);
        if (n.kind !== "match") collect(n.children);
      });
    collect(roots);
    const excluded = new Set(keys.filter((k) => k.startsWith("m:") && k.length % 4 === 0));
    const leads: Array<string | null> = [null, "m:/missing:0", ...keys.filter((_, i) => i % 7 === 0)];
    for (const lead of leads)
      for (const dir of [1, -1] as const)
        for (const skipSubtree of dir === 1 ? [false, true] : [false]) {
          const want = findOccurrence(roots, lead, dir, { ...generic, ...options(excluded) }, skipSubtree);
          const got = model.findOccurrence(lead, dir, { skipSubtree, ...options(excluded) });
          expect(got?.node).toBe(want?.node);
          expect(got?.ancestors).toEqual(want?.ancestors);
          expect(got && { index: got.index, total: got.total }).toEqual(
            want && { index: want.index, total: want.total },
          );
        }
    const plain = model.findOccurrence(null, 1, {});
    expect(plain?.total).toBe(files.reduce((n, f) => n + f.matches.length, 0));
  });

  it("opens the collapsed ancestors of the occurrence it lands on", () => {
    const index = new FindTreeIndex();
    let state: CollapseState = COLLAPSE_ALL;
    const model = index.sync(all, true, state, (node, open) => (state = toggleCollapseNode(state, node, open)));
    expect(model.rowCount).toBe(buildFindTree(all, true).length);
    const found = model.findOccurrence(null, 1, {})!;
    for (const a of found.ancestors) model.setExpanded(a, true);
    const next = index.sync(all, true, state, noop);
    expect(next.indexOfKey(found.node.key)).toBeGreaterThan(0);
  });

  it("finds usages of a file with 10,000 matches without flattening its lines", () => {
    const big: FileMatches = {
      path: "/p/big.ts",
      relPath: "big.ts",
      matches: Array.from({ length: 10_000 }, (_, line) => ({ line, text: "foo", ranges: [[0, 3]], textOffset: 0 })),
    };
    const index = new FindTreeIndex();
    const model = index.sync([big], false, EXPAND_ALL, noop);
    expect(model.rowCount).toBe(10_001);
    expect(model.indexOfKey("m:/p/big.ts:9999")).toBe(10_000);
    expect(model.rowAt(10_000)).toMatchObject({ key: "m:/p/big.ts:9999", posInSet: 10_000, setSize: 10_000 });
    expect(index.allGroups()).toHaveLength(10_000);
  });
});
