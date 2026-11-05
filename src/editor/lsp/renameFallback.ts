/**
 * When the language server refuses to rename a top-level type whose name is the
 * file name (jdtls: "Renaming this element is not supported"), ⇧F6 renames the
 * file instead, through the project view's Rename File dialog (which updates
 * usages, the type's own declaration included).
 */
import type { Text } from "@codemirror/state";
import type { NodeAt, Range, SyntaxNode } from "@/bindings";
import { offsetToPos } from "./positions";

/** Languages whose top-level type is named after its file (used when the syntax tree can't tell). */
const TYPE_PER_FILE = new Set(["java"]);

const TYPE_DECLARATION = /^(class|interface|enum|record|annotation_type|object|trait|struct)_(declaration|definition)$/;
/** Ancestors that make a type declaration nested rather than top-level. */
const ENCLOSING =
  /(class|interface|enum|record|annotation_type|object|trait|struct)_(declaration|definition)$|function|method|constructor|lambda|anonymous/;

/** `Foo` for `/p/Foo.java` or `C:\p\Foo.java`. */
export function fileStem(path: string): string {
  const base = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Whether `node` is the name of a type declared at the top of the file (not inside another type or a function). */
export function isTopLevelTypeName(at: NodeAt): boolean {
  const { node, ancestors } = at;
  const decl = ancestors[0];
  if (!decl || !TYPE_DECLARATION.test(decl.kind)) return false;
  if (!(node.field === "name" || /identifier$/.test(node.kind))) return false;
  return !ancestors.slice(1).some((a: SyntaxNode) => ENCLOSING.test(a.kind));
}

export interface FileRenameQuery {
  path: string;
  language: string;
  /** The identifier at the caret. */
  name: string | null;
  /** The syntax node at the caret, or null when the structure service can't say. */
  at: NodeAt | null;
}

/** Whether a refused rename of `name` should rename the file instead. */
export function renamesFileInstead({ path, language, name, at }: FileRenameQuery): boolean {
  if (!name || name !== fileStem(path)) return false;
  if (at) return isTopLevelTypeName(at);
  return TYPE_PER_FILE.has(language);
}

/**
 * The range to ask the syntax tree about for the word `[from, to)`. Never zero-width: the
 * backend skips a node that ends exactly at an empty range, so a caret at the end of `Foo|`
 * would resolve to the enclosing declaration instead of the identifier.
 */
export function wordQueryRange(doc: Text, word: { from: number; to: number }): Range {
  return { start: offsetToPos(doc, word.from), end: offsetToPos(doc, word.to) };
}
