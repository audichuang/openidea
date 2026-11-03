/**
 * Read-only text the user can select and copy, like IDEA's Markdown preview,
 * Quick Documentation and message panes. The workbench body is unselectable
 * (chrome); content opts back in with `selectableText`. A right-click on a
 * selection, or anywhere in such content, offers Copy (`copyMenuFor`).
 */
import type { KeyboardEvent } from "react";
import { writePlainText } from "@/platform/clipboard";
import { hasPrimaryModifier, formatBinding } from "@/platform/keymap";
import type { MenuItem } from "./Menu";
import styles from "./SelectableText.module.css";

export const selectableText = styles.selectable!;

const EDITABLE = "input, textarea, [contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']";

function selectionCovers(sel: Selection | null, target: Node): boolean {
  if (!sel || sel.isCollapsed || !sel.toString()) return false;
  for (let i = 0; i < sel.rangeCount; i++) {
    const range = sel.getRangeAt(i);
    if (range.intersectsNode(target) || target.contains(range.commonAncestorContainer)) return true;
  }
  return false;
}

/** The Copy menu for a right-click on `target`, or null when it is not on readable text. */
export function copyMenuFor(target: EventTarget | null): MenuItem[] | null {
  const el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (!el || el.closest(EDITABLE)) return null;
  const sel = window.getSelection();
  const text = selectionCovers(sel, el) ? sel!.toString() : "";
  if (!text && !el.closest(`.${selectableText}`)) return null;
  return [
    {
      id: "copy",
      label: "Copy",
      icon: "copy",
      shortcut: formatBinding("Meta+C"),
      disabled: !text,
      run: () => void copyText(text),
    },
  ];
}

/**
 * Writes `text` to the clipboard, rejecting when it could not. It never falls back to copying the
 * live selection: callers such as ClipCode copy text that is not the selection, and would then
 * report a copy that put something else on the clipboard.
 */
export const copyText = (text: string): Promise<void> => writePlainText(text);

/** Copy a DOM output selection locally, leaving editable children and other views alone. */
export function copySelectionOnKeyDown(
  e: Pick<
    KeyboardEvent<HTMLElement>,
    | "key"
    | "ctrlKey"
    | "metaKey"
    | "altKey"
    | "shiftKey"
    | "defaultPrevented"
    | "nativeEvent"
    | "target"
    | "currentTarget"
    | "preventDefault"
    | "stopPropagation"
  >,
  /** Text to copy instead of `selection.toString()`, for views that do not mount all their text. */
  textOf: (selection: Selection) => string = (selection) => selection.toString(),
): boolean {
  if (e.defaultPrevented || e.nativeEvent.isComposing || e.altKey || e.shiftKey) return false;
  const copy =
    (e.key.toLowerCase() === "c" && (e.ctrlKey || hasPrimaryModifier(e))) ||
    (e.key === "Insert" && e.ctrlKey && !e.metaKey);
  if (!copy || (e.target instanceof Element && e.target.closest(EDITABLE))) return false;
  const selection = window.getSelection();
  if (
    !selection ||
    selection.isCollapsed ||
    !selection.toString() ||
    !e.currentTarget.contains(selection.anchorNode) ||
    !e.currentTarget.contains(selection.focusNode)
  )
    return false;
  e.preventDefault();
  e.stopPropagation();
  void copyText(textOf(selection));
  return true;
}
