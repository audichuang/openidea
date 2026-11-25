/**
 * Incremental order-statistic tree for Find tool window results.
 *
 * Streamed files are inserted in O(log n) into an AVL tree keyed by the same
 * `Intl.Collator` path order as `buildFindTree`. Each node maintains its
 * visible row count, so `Tree` can read only the visible viewport in O(log n)
 * per row without flattening or re-sorting the entire result list per frame.
 */
import type { FileMatches } from "@/platform/ipc";
import type { TreeModel, TreeModelRow } from "@/ui";
import { basename, relDir } from "../common/open";
import { countFileMatches, isStreamExtension } from "./session";
import { groupState, usageKey, type ReplaceMarks, type UsageGroup } from "./replaceFlow";

export type FindTreeNode =
  | { kind: "dir"; key: string; label: string; count: number; children: FindTreeNode[] }
  | { kind: "file"; key: string; path: string; name: string; dir: string; count: number; children: FindTreeNode[] }
  | {
      kind: "match";
      key: string;
      path: string;
      line: number;
      col: number;
      endCol: number;
      text: string;
      /** Column of `text` in the real line. */
      textCol: number;
      ranges: Array<[number, number]>;
      starts: Array<{ line: number; col: number }>;
    };

type DirNode = FindTreeNode & { kind: "dir" };
type FileNode = FindTreeNode & { kind: "file" };
type MatchNode = FindTreeNode & { kind: "match" };

/** Same order as `String.prototype.localeCompare`, without its per-call setup. */
const collator = new Intl.Collator();

/** A file's node and its sort key, built once per streamed `FileMatches`. */
interface FileEntry {
  node: FileNode;
  rel: string;
}

const fileEntries = new WeakMap<FileMatches, FileEntry>();

function fileEntry(f: FileMatches): FileEntry {
  let entry = fileEntries.get(f);
  if (entry) return entry;
  const dir = relDir(f.relPath);
  const children: MatchNode[] = f.matches.map((m) => {
    const lead = m.text.length - m.text.trimStart().length;
    const text = m.text.slice(lead).trimEnd();
    const first = m.ranges[0] ?? [0, 0];
    return {
      kind: "match",
      key: `m:${f.path}:${m.line}`,
      path: f.path,
      line: m.line,
      col: first[0] + m.textOffset,
      endCol: first[1] + m.textOffset,
      text,
      textCol: lead + m.textOffset,
      ranges: m.ranges
        .map(([s, e]) => [Math.max(0, s - lead), Math.min(text.length, e - lead)] as [number, number])
        .filter(([s, e]) => e > s),
      starts: m.ranges.map(([s]) => ({ line: m.line, col: s + m.textOffset })),
    };
  });
  const name = basename(f.relPath);
  const node: FileNode = {
    kind: "file",
    key: `f:${f.path}`,
    path: f.path,
    name,
    dir,
    count: countFileMatches(f),
    children,
  };
  entry = { node, rel: dir ? `${dir}/${name}` : name };
  fileEntries.set(f, entry);
  return entry;
}

const byRel = (a: FileEntry, b: FileEntry) => collator.compare(a.rel, b.rel);

/**
 * Streamed file matches as file → line nodes, flat and sorted by path (IDEA's
 * default), or under their directory with `groupByDirectory`.
 */
export function buildFindTree(files: readonly FileMatches[], groupByDirectory = false): FindTreeNode[] {
  if (!groupByDirectory)
    return files
      .map(fileEntry)
      .sort(byRel)
      .map((e) => e.node);
  const dirs = new Map<string, DirNode>();
  for (const f of files) {
    const { node } = fileEntry(f);
    let d = dirs.get(node.dir);
    if (!d) {
      d = { kind: "dir", key: `d:${node.dir}`, label: node.dir || "/", count: 0, children: [] };
      dirs.set(node.dir, d);
    }
    d.children.push(node);
    d.count += node.count;
  }
  return [...dirs.values()].sort((a, b) => collator.compare(a.label, b.label));
}

/** The usages under a node (itself for a match). */
export function nodeGroups(node: FindTreeNode): UsageGroup[] {
  if (node.kind === "match") return [{ key: node.key, path: node.path, starts: node.starts }];
  return node.children.flatMap(nodeGroups);
}

/** True when every usage under `node` is excluded; short-circuits in O(1) when nothing is excluded. */
export function isNodeExcluded(node: FindTreeNode, marks: ReplaceMarks): boolean {
  if (marks.excluded.size === 0) return false;
  if (node.kind === "match") return groupState(node, marks) === "excluded";
  if (node.children.length === 0) return true;
  for (const child of node.children) if (!isNodeExcluded(child, marks)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Collapse state (O(1) toggle, Collapse All and Expand All)

const EMPTY_KEYS: ReadonlySet<string> = new Set();

export interface CollapseState {
  /** True after Collapse All: nodes stay collapsed unless listed in `exceptions`. */
  defaultCollapsed: boolean;
  /** Keys whose expanded state differs from `!defaultCollapsed`. */
  exceptions: ReadonlySet<string>;
}

export const EXPAND_ALL: CollapseState = { defaultCollapsed: false, exceptions: EMPTY_KEYS };
export const COLLAPSE_ALL: CollapseState = { defaultCollapsed: true, exceptions: EMPTY_KEYS };

function isExpandedKey(state: CollapseState, key: string): boolean {
  return state.defaultCollapsed ? state.exceptions.has(key) : !state.exceptions.has(key);
}

/** Returns a new `CollapseState` with `node` opened or closed, or `state` unchanged. */
export function toggleCollapseNode(state: CollapseState, node: FindTreeNode, open: boolean): CollapseState {
  if (node.kind === "match") return state;
  const matchesDefault = open === !state.defaultCollapsed;
  let next: Set<string> | null = null;
  const apply = (key: string, wantOpen: boolean) => {
    const isDefault = wantOpen === !state.defaultCollapsed;
    const has = (next ?? state.exceptions).has(key);
    if (isDefault ? has : !has) {
      next ??= new Set(state.exceptions);
      if (isDefault) next.delete(key);
      else next.add(key);
    }
  };
  apply(node.key, open);
  // Collapsing a directory also collapses its child files, matching Tree's collapse rule.
  if (!open && node.kind === "dir") {
    for (const child of node.children) apply(child.key, false);
  }
  if (!next) return state;
  if (matchesDefault && next.size === 0) return state.defaultCollapsed ? COLLAPSE_ALL : EXPAND_ALL;
  return { defaultCollapsed: state.defaultCollapsed, exceptions: next };
}

// ---------------------------------------------------------------------------
// Order-statistic AVL tree

interface AvlNode<E> {
  entry: E;
  left: AvlNode<E> | null;
  right: AvlNode<E> | null;
  parent: AvlNode<E> | null;
  height: number;
  size: number;
  rows: number;
  ownRows: number;
}

function updateAvl<E>(n: AvlNode<E>) {
  const lh = n.left ? n.left.height : 0;
  const rh = n.right ? n.right.height : 0;
  n.height = (lh > rh ? lh : rh) + 1;
  n.size = 1 + (n.left ? n.left.size : 0) + (n.right ? n.right.size : 0);
  n.rows = n.ownRows + (n.left ? n.left.rows : 0) + (n.right ? n.right.rows : 0);
}

function balanceFactor<E>(n: AvlNode<E>): number {
  return (n.left ? n.left.height : 0) - (n.right ? n.right.height : 0);
}

class OrderedTree<E> {
  root: AvlNode<E> | null = null;

  get size(): number {
    return this.root ? this.root.size : 0;
  }

  get rows(): number {
    return this.root ? this.root.rows : 0;
  }

  clear() {
    this.root = null;
  }

  private rotateLeft(x: AvlNode<E>): AvlNode<E> {
    const y = x.right!;
    const b = y.left;
    const p = x.parent;
    y.left = x;
    x.parent = y;
    x.right = b;
    if (b) b.parent = x;
    y.parent = p;
    if (!p) this.root = y;
    else if (p.left === x) p.left = y;
    else p.right = y;
    updateAvl(x);
    updateAvl(y);
    return y;
  }

  private rotateRight(y: AvlNode<E>): AvlNode<E> {
    const x = y.left!;
    const b = x.right;
    const p = y.parent;
    x.right = y;
    y.parent = x;
    y.left = b;
    if (b) b.parent = y;
    x.parent = p;
    if (!p) this.root = x;
    else if (p.left === y) p.left = x;
    else p.right = x;
    updateAvl(y);
    updateAvl(x);
    return x;
  }

  insert(entry: E, ownRows: number, compare: (a: E, b: E) => number): AvlNode<E> {
    const node: AvlNode<E> = {
      entry,
      left: null,
      right: null,
      parent: null,
      height: 1,
      size: 1,
      rows: ownRows,
      ownRows,
    };
    if (!this.root) {
      this.root = node;
      return node;
    }
    let cur = this.root;
    for (;;) {
      // Equal keys go right so in-order traversal keeps earlier insertions first (stable order).
      if (compare(entry, cur.entry) < 0) {
        if (!cur.left) {
          cur.left = node;
          node.parent = cur;
          break;
        }
        cur = cur.left;
      } else {
        if (!cur.right) {
          cur.right = node;
          node.parent = cur;
          break;
        }
        cur = cur.right;
      }
    }
    let p: AvlNode<E> | null = node.parent;
    while (p) {
      updateAvl(p);
      const bf = balanceFactor(p);
      if (bf > 1) {
        if (balanceFactor(p.left!) < 0) this.rotateLeft(p.left!);
        p = this.rotateRight(p);
      } else if (bf < -1) {
        if (balanceFactor(p.right!) > 0) this.rotateRight(p.right!);
        p = this.rotateLeft(p);
      }
      p = p.parent;
    }
    return node;
  }

  setOwnRows(node: AvlNode<E>, nextOwnRows: number) {
    const delta = nextOwnRows - node.ownRows;
    if (delta === 0) return;
    node.ownRows = nextOwnRows;
    for (let cur: AvlNode<E> | null = node; cur; cur = cur.parent) cur.rows += delta;
  }

  findByRow(rowIndex: number): { node: AvlNode<E>; offset: number; rank: number } | undefined {
    let cur = this.root;
    if (!cur || rowIndex < 0 || rowIndex >= cur.rows) return undefined;
    let rem = rowIndex;
    let rank = 0;
    while (cur) {
      const leftRows = cur.left ? cur.left.rows : 0;
      if (rem < leftRows) {
        cur = cur.left;
      } else if (rem < leftRows + cur.ownRows) {
        return { node: cur, offset: rem - leftRows, rank: rank + (cur.left ? cur.left.size : 0) };
      } else {
        rem -= leftRows + cur.ownRows;
        rank += (cur.left ? cur.left.size : 0) + 1;
        cur = cur.right;
      }
    }
    return undefined;
  }

  rowStartOf(node: AvlNode<E>): number {
    let row = node.left ? node.left.rows : 0;
    for (let cur = node; cur.parent; cur = cur.parent) {
      if (cur === cur.parent.right) row += (cur.parent.left ? cur.parent.left.rows : 0) + cur.parent.ownRows;
    }
    return row;
  }

  recomputeAllRows(ownRowsOf: (entry: E) => number) {
    const walk = (n: AvlNode<E> | null): number => {
      if (!n) return 0;
      const left = walk(n.left);
      const right = walk(n.right);
      n.ownRows = ownRowsOf(n.entry);
      n.rows = left + n.ownRows + right;
      return n.rows;
    };
    walk(this.root);
  }

  forEachInOrder(visit: (entry: E, rank: number) => void) {
    let rank = 0;
    const walk = (n: AvlNode<E> | null) => {
      if (!n) return;
      walk(n.left);
      visit(n.entry, rank++);
      walk(n.right);
    };
    walk(this.root);
  }
}

// ---------------------------------------------------------------------------
// Fenwick tree for O(log k) prefix sums over files within one directory

class RowFenwick {
  private values: number[] = [];
  private tree: number[] = [0];
  total = 0;

  get length(): number {
    return this.values.length;
  }

  push(val: number) {
    const idx = this.values.length;
    this.values.push(val);
    this.total += val;
    const i = idx + 1;
    // Sum of the (lowbit(i) - 1) elements immediately preceding i.
    let sum = val;
    const lowbit = i & -i;
    for (let step = 1; step < lowbit; step <<= 1) sum += this.tree[i - step]!;
    this.tree.push(sum);
  }

  set(index: number, val: number) {
    const delta = val - this.values[index]!;
    if (delta === 0) return;
    this.values[index] = val;
    this.total += delta;
    const n = this.values.length;
    for (let i = index + 1; i <= n; i += i & -i) this.tree[i] = this.tree[i]! + delta;
  }

  /** Sum of values[0..index-1]. */
  sumBefore(index: number): number {
    let sum = 0;
    for (let i = index; i > 0; i -= i & -i) sum += this.tree[i]!;
    return sum;
  }

  /** Smallest index whose prefix sum exceeds `target`, with remainder offset inside that entry. */
  findByOffset(target: number): { index: number; offset: number } {
    const n = this.values.length;
    let pos = 0;
    let acc = 0;
    let bit = 1;
    while (bit << 1 <= n) bit <<= 1;
    for (; bit > 0; bit >>= 1) {
      const next = pos + bit;
      if (next <= n && acc + this.tree[next]! <= target) {
        pos = next;
        acc += this.tree[next]!;
      }
    }
    return { index: pos, offset: target - acc };
  }

  rebuild(rowCountOf: (index: number) => number) {
    const n = this.values.length;
    this.total = 0;
    for (let i = 0; i < n; i++) {
      const v = rowCountOf(i);
      this.values[i] = v;
      this.total += v;
      this.tree[i + 1] = v;
    }
    for (let i = 1; i <= n; i++) {
      const p = i + (i & -i);
      if (p <= n) this.tree[p] = this.tree[p]! + this.tree[i]!;
    }
  }
}

// ---------------------------------------------------------------------------
// Incremental FindTreeIndex

interface FlatFileItem {
  node: FileNode;
  rel: string;
  treeNode: AvlNode<FlatFileItem> | null;
}

interface DirItem {
  node: DirNode;
  bit: RowFenwick;
  treeNode: AvlNode<DirItem> | null;
}

interface GroupedFileRef {
  node: FileNode;
  dir: DirItem;
  indexInDir: number;
}

const compareFlat = (a: FlatFileItem, b: FlatFileItem) => collator.compare(a.rel, b.rel);
const compareDir = (a: DirItem, b: DirItem) => collator.compare(a.node.label, b.node.label);

/** Lazily cached `line -> childIndex` lookup for files with many matches. */
const matchLineMaps = new WeakMap<FileNode, Map<number, number>>();

function findMatchIndex(file: FileNode, line: number): number {
  const children = file.children as MatchNode[];
  const len = children.length;
  if (len <= 32) {
    for (let i = 0; i < len; i++) if (children[i]!.line === line) return i;
    return -1;
  }
  // Matches from search are sorted by line; check binary search first, fall back to a cached map.
  let lo = 0;
  let hi = len - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const ml = children[mid]!.line;
    if (ml === line) return mid;
    if (ml < line) lo = mid + 1;
    else hi = mid - 1;
  }
  let map = matchLineMaps.get(file);
  if (!map) {
    map = new Map<number, number>();
    for (let i = 0; i < len; i++) map.set(children[i]!.line, i);
    matchLineMaps.set(file, map);
  }
  return map.get(line) ?? -1;
}

function parseMatchKey(key: string): { fileKey: string; line: number } | null {
  if (!key.startsWith("m:")) return null;
  const sep = key.lastIndexOf(":");
  if (sep <= 2) return null;
  const line = Number(key.slice(sep + 1));
  if (!Number.isFinite(line)) return null;
  return { fileKey: `f:${key.slice(2, sep)}`, line };
}

/**
 * Maintains the sorted Find result tree incrementally across streamed frames
 * and exposes it as a `TreeModel` whose per-frame cost is O(Δ log N).
 */
export class FindTreeIndex {
  private files: readonly FileMatches[] = [];
  private grouped = false;
  private collapse: CollapseState = EXPAND_ALL;
  private onToggle: (node: FindTreeNode, open: boolean) => void = () => {};

  private flatTree = new OrderedTree<FlatFileItem>();
  private flatByKey = new Map<string, FlatFileItem>();

  private dirTree = new OrderedTree<DirItem>();
  private dirByKey = new Map<string, DirItem>();
  private groupedByFileKey = new Map<string, GroupedFileRef>();

  private rawByPath = new Map<string, FileMatches>();
  private cachedModel: TreeModel<FindTreeNode> | null = null;

  sync(
    files: readonly FileMatches[],
    grouped: boolean,
    collapse: CollapseState,
    onToggle: (node: FindTreeNode, open: boolean) => void,
  ): TreeModel<FindTreeNode> {
    this.onToggle = onToggle;
    const sameFiles = files === this.files;
    const sameMode = grouped === this.grouped;
    const sameCollapse = collapse === this.collapse;
    if (sameFiles && sameMode && sameCollapse && this.cachedModel) return this.cachedModel;

    const prevCollapse = this.collapse;
    this.collapse = collapse;

    if (!sameMode || !isStreamExtension(files, this.files)) {
      this.rebuild(files, grouped);
    } else {
      if (!sameCollapse) this.applyCollapseChange(prevCollapse, collapse);
      if (files.length > this.files.length) this.append(files, this.files.length);
      this.files = files;
    }

    this.cachedModel = this.createModelSnapshot();
    return this.cachedModel;
  }

  getNode(key: string): FindTreeNode | undefined {
    if (key.startsWith("f:")) {
      return this.grouped ? this.groupedByFileKey.get(key)?.node : this.flatByKey.get(key)?.node;
    }
    if (key.startsWith("d:")) {
      return this.grouped ? this.dirByKey.get(key)?.node : undefined;
    }
    const parsed = parseMatchKey(key);
    if (!parsed) return undefined;
    const file = this.grouped
      ? this.groupedByFileKey.get(parsed.fileKey)?.node
      : this.flatByKey.get(parsed.fileKey)?.node;
    if (!file) return undefined;
    const idx = findMatchIndex(file, parsed.line);
    return idx >= 0 ? file.children[idx] : undefined;
  }

  getFileMatches(path: string): FileMatches | undefined {
    return this.rawByPath.get(path);
  }

  /** Computes all usage groups in display order (only called on Replace All click). */
  allGroups(): UsageGroup[] {
    const out: UsageGroup[] = [];
    const pushFile = (file: FileNode) => {
      for (const m of file.children as MatchNode[]) {
        out.push({ key: m.key, path: m.path, starts: m.starts });
      }
    };
    if (this.grouped) {
      this.dirTree.forEachInOrder((dir) => {
        for (const f of dir.node.children as FileNode[]) pushFile(f);
      });
    } else {
      this.flatTree.forEachInOrder((item) => pushFile(item.node));
    }
    return out;
  }

  /** Short-circuiting check whether at least one usage is still pending replacement. */
  hasPendingUsage(marks: ReplaceMarks): boolean {
    if (marks.excluded.size === 0 && marks.done.size === 0) return this.files.length > 0;
    for (const f of this.files) {
      for (const m of f.matches) {
        for (const [col] of m.ranges) {
          const k = usageKey({ path: f.path, line: m.line, col: col + m.textOffset });
          if (!marks.excluded.has(k) && !marks.done.has(k)) return true;
        }
      }
    }
    return false;
  }

  private rebuild(files: readonly FileMatches[], grouped: boolean) {
    this.files = files;
    this.grouped = grouped;
    this.flatTree.clear();
    this.flatByKey.clear();
    this.dirTree.clear();
    this.dirByKey.clear();
    this.groupedByFileKey.clear();
    this.rawByPath.clear();
    this.append(files, 0);
  }

  private append(files: readonly FileMatches[], from: number) {
    if (!this.grouped) {
      for (let i = from; i < files.length; i++) {
        const raw = files[i]!;
        this.rawByPath.set(raw.path, raw);
        const { node, rel } = fileEntry(raw);
        const item: FlatFileItem = { node, rel, treeNode: null };
        const open = isExpandedKey(this.collapse, node.key);
        const ownRows = 1 + (open ? node.children.length : 0);
        item.treeNode = this.flatTree.insert(item, ownRows, compareFlat);
        this.flatByKey.set(node.key, item);
      }
      return;
    }

    for (let i = from; i < files.length; i++) {
      const raw = files[i]!;
      this.rawByPath.set(raw.path, raw);
      const { node } = fileEntry(raw);
      const dirKey = `d:${node.dir}`;
      let dir = this.dirByKey.get(dirKey);
      if (!dir) {
        const dirNode: DirNode = { kind: "dir", key: dirKey, label: node.dir || "/", count: 0, children: [] };
        dir = { node: dirNode, bit: new RowFenwick(), treeNode: null };
        dir.treeNode = this.dirTree.insert(dir, 1, compareDir);
        this.dirByKey.set(dirKey, dir);
      }
      const indexInDir = dir.node.children.length;
      dir.node.children.push(node);
      dir.node.count += node.count;
      const fileOpen = isExpandedKey(this.collapse, node.key);
      dir.bit.push(1 + (fileOpen ? node.children.length : 0));
      if (isExpandedKey(this.collapse, dirKey)) {
        this.dirTree.setOwnRows(dir.treeNode!, 1 + dir.bit.total);
      }
      this.groupedByFileKey.set(node.key, { node, dir, indexInDir });
    }
  }

  private applyCollapseChange(prev: CollapseState, next: CollapseState) {
    if (prev.defaultCollapsed !== next.defaultCollapsed || Math.abs(prev.exceptions.size - next.exceptions.size) > 64) {
      this.recomputeAllRows();
      return;
    }
    const changed: string[] = [];
    for (const k of prev.exceptions) if (!next.exceptions.has(k)) changed.push(k);
    for (const k of next.exceptions) if (!prev.exceptions.has(k)) changed.push(k);
    if (changed.length > 64) {
      this.recomputeAllRows();
      return;
    }
    for (const k of changed) this.updateKeyRows(k);
  }

  private updateKeyRows(key: string) {
    if (!this.grouped) {
      const item = this.flatByKey.get(key);
      if (!item?.treeNode) return;
      const open = isExpandedKey(this.collapse, key);
      this.flatTree.setOwnRows(item.treeNode, 1 + (open ? item.node.children.length : 0));
      return;
    }
    if (key.startsWith("d:")) {
      const dir = this.dirByKey.get(key);
      if (!dir?.treeNode) return;
      const open = isExpandedKey(this.collapse, key);
      this.dirTree.setOwnRows(dir.treeNode, 1 + (open ? dir.bit.total : 0));
      return;
    }
    if (key.startsWith("f:")) {
      const ref = this.groupedByFileKey.get(key);
      if (!ref?.dir.treeNode) return;
      const fileOpen = isExpandedKey(this.collapse, key);
      ref.dir.bit.set(ref.indexInDir, 1 + (fileOpen ? ref.node.children.length : 0));
      if (isExpandedKey(this.collapse, ref.dir.node.key)) {
        this.dirTree.setOwnRows(ref.dir.treeNode, 1 + ref.dir.bit.total);
      }
    }
  }

  private recomputeAllRows() {
    if (!this.grouped) {
      this.flatTree.recomputeAllRows((item) =>
        isExpandedKey(this.collapse, item.node.key) ? 1 + item.node.children.length : 1,
      );
      return;
    }
    this.dirTree.recomputeAllRows((dir) => {
      const children = dir.node.children as FileNode[];
      dir.bit.rebuild((i) => {
        const f = children[i]!;
        return isExpandedKey(this.collapse, f.key) ? 1 + f.children.length : 1;
      });
      return isExpandedKey(this.collapse, dir.node.key) ? 1 + dir.bit.total : 1;
    });
  }

  private rowAt(index: number): TreeModelRow<FindTreeNode> | undefined {
    if (!this.grouped) {
      const hit = this.flatTree.findByRow(index);
      if (!hit) return undefined;
      const file = hit.node.entry.node;
      if (hit.offset === 0) {
        return {
          node: file,
          key: file.key,
          depth: 0,
          parentKey: null,
          expandable: true,
          expanded: isExpandedKey(this.collapse, file.key),
          posInSet: hit.rank + 1,
          setSize: this.flatTree.size,
        };
      }
      const match = file.children[hit.offset - 1]!;
      return {
        node: match,
        key: match.key,
        depth: 1,
        parentKey: file.key,
        expandable: false,
        expanded: false,
        posInSet: hit.offset,
        setSize: file.children.length,
      };
    }

    const hit = this.dirTree.findByRow(index);
    if (!hit) return undefined;
    const dir = hit.node.entry;
    if (hit.offset === 0) {
      return {
        node: dir.node,
        key: dir.node.key,
        depth: 0,
        parentKey: null,
        expandable: true,
        expanded: isExpandedKey(this.collapse, dir.node.key),
        posInSet: hit.rank + 1,
        setSize: this.dirTree.size,
      };
    }
    const { index: fileIdx, offset: fileOff } = dir.bit.findByOffset(hit.offset - 1);
    const file = dir.node.children[fileIdx] as FileNode;
    if (fileOff === 0) {
      return {
        node: file,
        key: file.key,
        depth: 1,
        parentKey: dir.node.key,
        expandable: true,
        expanded: isExpandedKey(this.collapse, file.key),
        posInSet: fileIdx + 1,
        setSize: dir.node.children.length,
      };
    }
    const match = file.children[fileOff - 1]!;
    return {
      node: match,
      key: match.key,
      depth: 2,
      parentKey: file.key,
      expandable: false,
      expanded: false,
      posInSet: fileOff,
      setSize: file.children.length,
    };
  }

  private indexOfKey(key: string): number {
    if (!this.grouped) {
      if (key.startsWith("f:")) {
        const item = this.flatByKey.get(key);
        return item?.treeNode ? this.flatTree.rowStartOf(item.treeNode) : -1;
      }
      const parsed = parseMatchKey(key);
      if (!parsed) return -1;
      const item = this.flatByKey.get(parsed.fileKey);
      if (!item?.treeNode || !isExpandedKey(this.collapse, parsed.fileKey)) return -1;
      const childIdx = findMatchIndex(item.node, parsed.line);
      return childIdx >= 0 ? this.flatTree.rowStartOf(item.treeNode) + 1 + childIdx : -1;
    }

    if (key.startsWith("d:")) {
      const dir = this.dirByKey.get(key);
      return dir?.treeNode ? this.dirTree.rowStartOf(dir.treeNode) : -1;
    }
    if (key.startsWith("f:")) {
      const ref = this.groupedByFileKey.get(key);
      if (!ref?.dir.treeNode || !isExpandedKey(this.collapse, ref.dir.node.key)) return -1;
      return this.dirTree.rowStartOf(ref.dir.treeNode) + 1 + ref.dir.bit.sumBefore(ref.indexInDir);
    }
    const parsed = parseMatchKey(key);
    if (!parsed) return -1;
    const ref = this.groupedByFileKey.get(parsed.fileKey);
    if (
      !ref?.dir.treeNode ||
      !isExpandedKey(this.collapse, ref.dir.node.key) ||
      !isExpandedKey(this.collapse, parsed.fileKey)
    )
      return -1;
    const childIdx = findMatchIndex(ref.node, parsed.line);
    if (childIdx < 0) return -1;
    return this.dirTree.rowStartOf(ref.dir.treeNode) + 1 + ref.dir.bit.sumBefore(ref.indexInDir) + 1 + childIdx;
  }

  private forEachRow(visit: (row: TreeModelRow<FindTreeNode>) => void) {
    if (!this.grouped) {
      const total = this.flatTree.size;
      this.flatTree.forEachInOrder((item, rank) => {
        const file = item.node;
        const open = isExpandedKey(this.collapse, file.key);
        visit({
          node: file,
          key: file.key,
          depth: 0,
          parentKey: null,
          expandable: true,
          expanded: open,
          posInSet: rank + 1,
          setSize: total,
        });
        if (!open) return;
        const len = file.children.length;
        for (let i = 0; i < len; i++) {
          const match = file.children[i]!;
          visit({
            node: match,
            key: match.key,
            depth: 1,
            parentKey: file.key,
            expandable: false,
            expanded: false,
            posInSet: i + 1,
            setSize: len,
          });
        }
      });
      return;
    }

    const totalDirs = this.dirTree.size;
    this.dirTree.forEachInOrder((dir, dirRank) => {
      const dirOpen = isExpandedKey(this.collapse, dir.node.key);
      visit({
        node: dir.node,
        key: dir.node.key,
        depth: 0,
        parentKey: null,
        expandable: true,
        expanded: dirOpen,
        posInSet: dirRank + 1,
        setSize: totalDirs,
      });
      if (!dirOpen) return;
      const files = dir.node.children as FileNode[];
      for (let fi = 0; fi < files.length; fi++) {
        const file = files[fi]!;
        const fileOpen = isExpandedKey(this.collapse, file.key);
        visit({
          node: file,
          key: file.key,
          depth: 1,
          parentKey: dir.node.key,
          expandable: true,
          expanded: fileOpen,
          posInSet: fi + 1,
          setSize: files.length,
        });
        if (!fileOpen) continue;
        const len = file.children.length;
        for (let mi = 0; mi < len; mi++) {
          const match = file.children[mi]!;
          visit({
            node: match,
            key: match.key,
            depth: 2,
            parentKey: file.key,
            expandable: false,
            expanded: false,
            posInSet: mi + 1,
            setSize: len,
          });
        }
      }
    });
  }

  private findOccurrence(
    lead: string | null,
    dir: 1 | -1,
    options?: { skipSubtree?: boolean; isOccurrence?: (node: FindTreeNode) => boolean },
  ): { node: FindTreeNode; ancestors: FindTreeNode[]; index: number; total: number } | null {
    const skipSubtree = !!options?.skipSubtree;
    const accept = options?.isOccurrence ?? ((n: FindTreeNode) => n.kind === "match");
    let total = 0;
    let leadFound = false;
    let passedLead = false;
    let firstOcc: { node: FindTreeNode; ancestors: FindTreeNode[]; index: number } | null = null;
    let lastOcc: { node: FindTreeNode; ancestors: FindTreeNode[]; index: number } | null = null;
    let nextOcc: { node: FindTreeNode; ancestors: FindTreeNode[]; index: number } | null = null;
    let prevOcc: { node: FindTreeNode; ancestors: FindTreeNode[]; index: number } | null = null;

    const visitFile = (file: FileNode, dirNode: DirNode | null, skipFromDir: boolean) => {
      const isLeadFile = !leadFound && lead !== null && file.key === lead;
      if (isLeadFile) {
        leadFound = true;
        if (!skipSubtree) passedLead = true;
      }
      const ancestors: FindTreeNode[] = dirNode ? [dirNode, file] : [file];
      const matches = file.children as MatchNode[];
      for (let i = 0; i < matches.length; i++) {
        const m = matches[i]!;
        const isLeadMatch = !leadFound && lead !== null && m.key === lead;
        if (isLeadMatch) leadFound = true;
        if (accept(m)) {
          total++;
          const occ = { node: m, ancestors, index: total };
          if (!firstOcc) firstOcc = occ;
          lastOcc = occ;
          if (!leadFound) prevOcc = occ;
          else if (passedLead && !nextOcc && !isLeadMatch && !skipFromDir) nextOcc = occ;
        }
        if (isLeadMatch) passedLead = true;
      }
      if (isLeadFile && skipSubtree) passedLead = true;
    };

    if (!this.grouped) {
      this.flatTree.forEachInOrder((item) => visitFile(item.node, null, false));
    } else {
      this.dirTree.forEachInOrder((d) => {
        const isLeadDir = !leadFound && lead !== null && d.node.key === lead;
        if (isLeadDir) {
          leadFound = true;
          if (!skipSubtree) passedLead = true;
        }
        const skipChildren = isLeadDir && skipSubtree;
        for (const f of d.node.children as FileNode[]) visitFile(f, d.node, skipChildren);
        if (skipChildren) passedLead = true;
      });
    }

    if (total === 0) return null;
    const hit = !leadFound ? (dir === 1 ? firstOcc : lastOcc) : dir === 1 ? nextOcc : prevOcc;
    return hit ? { ...hit, total } : null;
  }

  private createModelSnapshot(): TreeModel<FindTreeNode> {
    return {
      rowCount: this.grouped ? this.dirTree.rows : this.flatTree.rows,
      rowAt: (index) => this.rowAt(index),
      indexOfKey: (key) => this.indexOfKey(key),
      setExpanded: (node, open) => this.onToggle(node, open),
      forEachRow: (visit) => this.forEachRow(visit),
      findOccurrence: (lead, dir, options) => this.findOccurrence(lead, dir, options),
    };
  }
}
