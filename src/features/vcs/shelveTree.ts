/** Inclusion tree of the Shelve Changes dialog: files grouped by directory, tri-state folder checkboxes. */
import type { FileStatus } from "@/bindings";
import { buildFileTree, type FileTreeNode } from "./fileTree";
import { relTo, stripSlash } from "./model";

export type ShelveNode = FileTreeNode<FileStatus>;

export function buildShelveTree(files: readonly FileStatus[], root: string): ShelveNode[] {
  return buildFileTree(files, (f) => relTo(root, stripSlash(f.path)));
}

/** Paths (as in `FileStatus.path`) of every file at or below `node`. */
export function nodePaths(node: ShelveNode, out: string[] = []): string[] {
  if (node.file) out.push(node.file.path);
  for (const c of node.children) nodePaths(c, out);
  return out;
}

export function nodeCheck(
  node: ShelveNode,
  selected: ReadonlySet<string>,
): { checked: boolean; indeterminate: boolean } {
  const paths = nodePaths(node);
  const on = paths.filter((p) => selected.has(p)).length;
  return { checked: on > 0 && on === paths.length, indeterminate: on > 0 && on < paths.length };
}

/** Toggles `node`: a fully included node is excluded, otherwise every file below it is included. */
export function toggleNode(node: ShelveNode, selected: ReadonlySet<string>): Set<string> {
  const paths = nodePaths(node);
  const allOn = paths.every((p) => selected.has(p));
  const next = new Set(selected);
  for (const p of paths) {
    if (allOn) next.delete(p);
    else next.add(p);
  }
  return next;
}

/** The first file in display order, for the initial diff preview. */
export function firstFile(nodes: readonly ShelveNode[]): ShelveNode | null {
  for (const n of nodes) {
    if (n.file) return n;
    const inner = firstFile(n.children);
    if (inner) return inner;
  }
  return null;
}
