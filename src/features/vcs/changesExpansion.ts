/** Which rows of the changes tree are open, as in IDEA's Commit tree (pure). */
import type { ChangeNode } from "./changes";

/**
 * Whether a row starts open: groups do, except Unversioned Files; a repository or
 * directory row only when it is the single child of an open row, so a chain of single
 * children opens down to the first branching (the first level of real folders shows).
 */
export function defaultOpen(node: ChangeNode, parentOpen: boolean, siblings: number): boolean {
  if (node.type === "file") return false;
  if (node.type === "group") return node.group !== "unversioned";
  return parentOpen && siblings === 1;
}

/** Keys of the open rows: the user's choices (`overrides`, key → open) over the defaults. */
export function expandedKeys(roots: readonly ChangeNode[], overrides: ReadonlyMap<string, boolean>): Set<string> {
  const out = new Set<string>();
  const walk = (nodes: readonly ChangeNode[], parentOpen: boolean) => {
    for (const n of nodes) {
      if (n.type === "file") continue;
      const open = overrides.get(n.key) ?? defaultOpen(n, parentOpen, nodes.length);
      if (open) out.add(n.key);
      if (n.children) walk(n.children, open);
    }
  };
  walk(roots, true);
  return out;
}
