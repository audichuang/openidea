import type { ClipPasteFile } from "@/bindings";

/** Keys of file rows: their action kind's index list (creates and overwrites share one). */
export const rowKey = (action: string, index: number) => `${action === "delete" ? "d" : "c"}${index}`;

/** Tree keys: a file's row key, `s<i>` for skipped files (their indices are their own), `/<path>` for folders. */
export const fileKey = (f: ClipPasteFile) => (f.action === "skip" ? `s${f.index}` : rowKey(f.action, f.index));

export interface PasteNode {
  key: string;
  /** Folder segments joined by `/` when a folder holds only one folder. */
  name: string;
  file?: ClipPasteFile;
  children?: PasteNode[];
}

/**
 * The preview's files as a folder tree, as IDEA's commit dialog groups changes by
 * directory: folders before files, each by name, and a folder holding only one
 * folder merged into it (`src/main/java`).
 */
export function buildPasteTree(files: readonly ClipPasteFile[]): PasteNode[] {
  interface Dir {
    dirs: Map<string, Dir>;
    files: ClipPasteFile[];
  }
  const root: Dir = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.replace(/\\/g, "/").split("/");
    parts.pop();
    let dir = root;
    for (const [i, part] of parts.entries()) {
      // An absolute path's leading `/` is a segment of its own.
      const seg = part === "" && i === 0 ? "/" : part;
      if (!seg) continue;
      let next = dir.dirs.get(seg);
      if (!next) dir.dirs.set(seg, (next = { dirs: new Map(), files: [] }));
      dir = next;
    }
    dir.files.push(f);
  }
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  const nameOf = (f: ClipPasteFile) => f.path.replace(/\\/g, "/").split("/").pop() ?? f.path;
  const build = (dir: Dir, prefix: string): PasteNode[] => {
    const folders = [...dir.dirs.entries()]
      .sort(([a], [b]) => byName(a, b))
      .map(([seg, sub]) => {
        let name = seg;
        let path = prefix + seg;
        // Merge a chain of folders that each hold only one folder.
        for (let only = sub.dirs.entries().next().value; sub.files.length === 0 && sub.dirs.size === 1 && only;) {
          const [nextSeg, next] = only;
          name = name === "/" ? `/${nextSeg}` : `${name}/${nextSeg}`;
          path = `${path}/${nextSeg}`;
          sub = next;
          only = sub.dirs.entries().next().value;
        }
        return { key: `/${path}`, name, children: build(sub, `${path}/`) };
      });
    const leaves = [...dir.files]
      .sort((a, b) => byName(nameOf(a), nameOf(b)))
      .map((f) => ({ key: fileKey(f), name: nameOf(f), file: f }));
    return [...folders, ...leaves];
  };
  return build(root, "");
}

/** The files under `node`, itself included when it is one. */
export function filesUnder(node: PasteNode): ClipPasteFile[] {
  return node.file ? [node.file] : (node.children ?? []).flatMap(filesUnder);
}
