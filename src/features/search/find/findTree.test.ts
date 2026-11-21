import { describe, expect, it } from "vitest";
import type { FileMatches } from "@/platform/ipc";
import { findOccurrence, type TreeModelRow } from "@/ui/Tree";
import { FindTreeIndex, buildFindTree, expandableKeys, setNodeCollapsed, type FindTreeNode } from "./findTree";

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
const NONE: ReadonlySet<string> = new Set();

/** Keys of every dir and file node, as the Find window's Collapse All listed them before the index. */
function allExpandableKeys(nodes: readonly FindTreeNode[], out = new Set<string>()): Set<string> {
  for (const n of nodes) {
    if (n.kind === "match") continue;
    out.add(n.key);
    allExpandableKeys(n.children, out);
  }
  return out;
}

/** The rows `Tree` shows for `roots`: the oracle the index must reproduce without flattening. */
function flatten(roots: readonly FindTreeNode[], collapsed: ReadonlySet<string>): TreeModelRow<FindTreeNode>[] {
  const rows: TreeModelRow<FindTreeNode>[] = [];
  const walk = (nodes: readonly FindTreeNode[], depth: number, parentKey: string | null) => {
    nodes.forEach((node, i) => {
      const expandable = node.kind !== "match";
      const expanded = expandable && !collapsed.has(node.key);
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
      if (node.kind !== "match" && expanded) walk(node.children, depth + 1, node.key);
    });
  };
  walk(roots, 0, null);
  return rows;
}

function expectSameRows(
  index: FindTreeIndex,
  files: readonly FileMatches[],
  grouped: boolean,
  collapsed: ReadonlySet<string>,
) {
  const model = index.sync(files, grouped, collapsed, noop);
  const expected = flatten(buildFindTree(files, grouped), collapsed);
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
    for (const files of snapshots) expectSameRows(index, files, grouped, NONE);
  });

  it.each([false, true])("keeps every state of collapsed and expanded nodes (grouped: %s)", (grouped) => {
    const index = new FindTreeIndex();
    const snapshots = streamSnapshots(all, [100, 7, 200, 293]);
    let collapsed = NONE;
    snapshots.forEach((files, step) => {
      expectSameRows(index, files, grouped, collapsed);
      // Toggle some nodes between batches, then switch to and from Collapse All.
      const nodes = buildFindTree(files, grouped);
      const pick = (n: number) => nodes[(n * 13) % nodes.length]!;
      collapsed = setNodeCollapsed(collapsed, pick(step + 1), false);
      expectSameRows(index, files, grouped, collapsed);
      collapsed = setNodeCollapsed(collapsed, pick(step + 2), false);
      collapsed = setNodeCollapsed(collapsed, pick(step + 1), true);
      expectSameRows(index, files, grouped, collapsed);
      if (step === 1) {
        collapsed = expandableKeys(files, grouped);
        expectSameRows(index, files, grouped, collapsed);
        collapsed = setNodeCollapsed(collapsed, pick(3), true);
        expectSameRows(index, files, grouped, collapsed);
        collapsed = NONE;
      }
    });
  });

  it("collapsing a directory also collapses its files, so opening it shows only the files", () => {
    const index = new FindTreeIndex();
    const dirs = buildFindTree(all, true);
    const dir = dirs[0]!;
    let collapsed = setNodeCollapsed(NONE, dir.kind === "dir" ? dir.children[0]! : dir, false);
    collapsed = setNodeCollapsed(collapsed, dir, false);
    collapsed = setNodeCollapsed(collapsed, dir, true);
    const model = index.sync(all, true, collapsed, noop);
    const rows = Array.from({ length: model.rowCount }, (_, i) => model.rowAt(i)!);
    const first = rows.find((r) => r.key === dir.key)!;
    const children = rows.filter((r) => r.parentKey === first.key);
    expect(children.length).toBe(dir.kind === "dir" ? dir.children.length : 0);
    expect(children.every((c) => !c.expanded)).toBe(true);
  });

  it("restarts from scratch when the results are not an extension of the previous ones", () => {
    const index = new FindTreeIndex();
    expectSameRows(index, all.slice(0, 300), false, NONE);
    expectSameRows(index, all.slice(300), false, NONE);
    expectSameRows(index, [], false, NONE);
    expectSameRows(index, all.slice(0, 50), true, NONE);
  });

  const options = (excluded: ReadonlySet<string>) => ({
    isOccurrence: (n: FindTreeNode) => n.kind === "match" && !excluded.has(n.key),
  });

  it.each([false, true])("steps through occurrences like the generic walk (grouped: %s)", (grouped) => {
    const files = all.slice(0, 120);
    const index = new FindTreeIndex();
    const model = index.sync(files, grouped, expandableKeys(files, grouped), noop);
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
    let collapsed: ReadonlySet<string> = expandableKeys(all, true);
    const model = index.sync(
      all,
      true,
      collapsed,
      (node, open) => (collapsed = setNodeCollapsed(collapsed, node, open)),
    );
    expect(model.rowCount).toBe(buildFindTree(all, true).length);
    const found = model.findOccurrence(null, 1, {})!;
    for (const a of found.ancestors) model.setExpanded(a, true);
    const next = index.sync(all, true, collapsed, noop);
    expect(next.indexOfKey(found.node.key)).toBeGreaterThan(0);
  });

  it("finds usages of a file with 10,000 matches without flattening its lines", () => {
    const big: FileMatches = {
      path: "/p/big.ts",
      relPath: "big.ts",
      matches: Array.from({ length: 10_000 }, (_, line) => ({ line, text: "foo", ranges: [[0, 3]], textOffset: 0 })),
    };
    const index = new FindTreeIndex();
    const model = index.sync([big], false, NONE, noop);
    expect(model.rowCount).toBe(10_001);
    expect(model.indexOfKey("m:/p/big.ts:9999")).toBe(10_000);
    expect(model.rowAt(10_000)).toMatchObject({ key: "m:/p/big.ts:9999", posInSet: 10_000, setSize: 10_000 });
    expect(index.allGroups()).toHaveLength(10_000);
  });

  it.each([false, true])("Collapse All lists the keys shown when it is clicked (grouped: %s)", (grouped) => {
    expect(expandableKeys(all, grouped)).toEqual(allExpandableKeys(buildFindTree(all, grouped)));
  });

  // As before the index: files that stream in after Collapse All arrive expanded.
  it.each([false, true])("keeps files streamed after Collapse All expanded (grouped: %s)", (grouped) => {
    const index = new FindTreeIndex();
    const first = all.slice(0, 200);
    const collapsed = expandableKeys(first, grouped);
    expectSameRows(index, first, grouped, collapsed);
    expect(index.sync(first, grouped, collapsed, noop).rowCount).toBe(buildFindTree(first, grouped).length);
    for (const files of streamSnapshots(all, [230, 17, 60])) expectSameRows(index, files, grouped, collapsed);
    if (grouped) return;
    const model = index.sync(all, grouped, collapsed, noop);
    const late = all.find((f) => !collapsed.has(`f:${f.path}`))!;
    expect(model.rowAt(model.indexOfKey(`f:${late.path}`))).toMatchObject({ expanded: true });
  });

  it("finds a match by its key for any path, and only by the key it was listed with", () => {
    const at = (path: string): FileMatches => ({
      path,
      relPath: path,
      matches: [{ line: 7, text: "foo", ranges: [[0, 3]], textOffset: 0 }],
    });
    const index = new FindTreeIndex();
    // An editor-backed result list may have an empty path.
    const files = [at(""), at("C:\\repo\\a.ts"), at("/p/a.ts")];
    const model = index.sync(files, false, NONE, noop);
    for (const f of files) {
      const key = `m:${f.path}:7`;
      expect(index.getNode(key)).toMatchObject({ kind: "match", key });
      expect(model.rowAt(model.indexOfKey(key))?.key).toBe(key);
    }
    for (const key of ["m:/p/a.ts:", "m:/p/a.ts:07", "m:/p/a.ts:7.0", "m:/p/a.ts:8", "m:/p/b.ts:7"]) {
      expect(index.getNode(key)).toBeUndefined();
      expect(model.indexOfKey(key)).toBe(-1);
    }
  });

  /**
   * Walks Next Occurrence from the top to the end, then Previous Occurrence back, through the
   * index, opening what it lands on as `Tree` does (from Collapse All when `collapseAll`).
   */
  function walkAll(files: readonly FileMatches[], grouped: boolean, collapseAll: boolean) {
    const index = new FindTreeIndex();
    let collapsed: ReadonlySet<string> = collapseAll ? expandableKeys(files, grouped) : NONE;
    const toggle = (node: FindTreeNode, open: boolean) => (collapsed = setNodeCollapsed(collapsed, node, open));
    const total = files.reduce((n, f) => n + f.matches.length, 0);
    const forward: string[] = [];
    let lead: string | null = null;
    for (let i = 1; i <= total; i++) {
      const model = index.sync(files, grouped, collapsed, toggle);
      const step = model.findOccurrence(lead, 1, {})!;
      expect(step.index).toBe(i);
      expect(step.total).toBe(total);
      for (const a of step.ancestors) model.setExpanded(a, true);
      const key: string = step.node.key;
      lead = key;
      forward.push(key);
    }
    const model = index.sync(files, grouped, collapsed, toggle);
    expect(model.findOccurrence(lead, 1, {})).toBeNull();
    // Every match was opened on the way, so each one is a visible row now.
    for (const key of forward) expect(model.indexOfKey(key)).toBeGreaterThanOrEqual(0);
    const backward: string[] = [lead!];
    for (let i = total - 1; i >= 1; i--) {
      const step = model.findOccurrence(lead, -1, {})!;
      expect(step.index).toBe(i);
      const key: string = step.node.key;
      lead = key;
      backward.push(key);
    }
    expect(model.findOccurrence(lead, -1, {})).toBeNull();
    expect(new Set(forward).size).toBe(total);
    expect(backward.reverse()).toEqual(forward);
    const roots = buildFindTree(files, grouped);
    const inOrder: string[] = [];
    const collect = (nodes: readonly FindTreeNode[]) =>
      nodes.forEach((n) => (n.kind === "match" ? inOrder.push(n.key) : collect(n.children)));
    collect(roots);
    expect(forward).toEqual(inOrder);
  }

  it("Next and Previous Occurrence walk every match of one file with 10,000 matches", () => {
    walkAll(
      [
        {
          path: "/p/big.ts",
          relPath: "big.ts",
          matches: Array.from({ length: 10_000 }, (_, line) => ({
            line,
            text: "foo",
            ranges: [[0, 3]],
            textOffset: 0,
          })),
        },
      ],
      false,
      true,
    );
  }, 60_000);

  it.each([false, true])(
    "Next and Previous Occurrence walk every match of 10,000 files (grouped: %s)",
    (grouped) => {
      const files = Array.from({ length: 10_000 }, (_, i): FileMatches => {
        const rel = `src/m${i % 50}/F${i}.ts`;
        return {
          path: `/p/${rel}`,
          relPath: rel,
          matches: [{ line: 0, text: "foo", ranges: [[0, 3]], textOffset: 0 }],
        };
      });
      walkAll(files, grouped, false);
    },
    60_000,
  );
});
