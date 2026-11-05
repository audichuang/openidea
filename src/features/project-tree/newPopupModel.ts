/** IDEA's "New" popup (⌘N): the New › items under a "Search for file type" field. */
import { create } from "zustand";
import { getAction } from "@/platform/actions";
import { fuzzyMatch, resolveMenuItems, type MenuItem } from "@/ui";

export interface NewPopupRow {
  key: string;
  separator?: boolean;
  label: string;
  icon?: string;
  shortcut?: string;
  run?: () => void;
  /** A group ("Other File Types"): picking it lists its entries in place. */
  expand?: boolean;
  /** Matched label indices while filtering. */
  matches?: number[] | null;
}

interface NewPopupState {
  request: { at: { x: number; y: number }; items: MenuItem[]; seq: number } | null;
}

export const useNewPopup = create<NewPopupState>(() => ({ request: null }));
let seq = 0;

export function openNewPopup(at: { x: number; y: number }, items: MenuItem[]) {
  useNewPopup.setState({ request: { at, items, seq: ++seq } });
}

export const closeNewPopup = () => useNewPopup.setState({ request: null });

/** Generic action keywords that would match every template. */
const GENERIC = new Set(["new", "create", "template", "file"]);

/**
 * Enabled entries, filtered by `query`: label matches (highlighted), then
 * entries whose action has a matching keyword (`css` finds Stylesheet).
 * Separators are kept only without a query. Submenus ("Other File Types") are
 * one row until `expanded`; a query searches their entries too.
 */
export function newPopupRows(items: MenuItem[], query: string, expanded = false): NewPopupRow[] {
  const q = query.trim();
  const rows: NewPopupRow[] = [];
  const byKeyword: NewPopupRow[] = [];
  const separator = (key: string) => {
    if (!q && rows.length && !rows[rows.length - 1]!.separator) rows.push({ key, separator: true, label: "" });
  };
  const visit = (list: MenuItem[], prefix: string) => {
    for (const r of resolveMenuItems(list)) {
      if (r.kind === "separator") {
        separator(prefix + r.key);
        continue;
      }
      if (r.kind !== "item" || r.disabled) continue;
      if (r.submenu && !r.run) {
        if (q || expanded) {
          separator(`${prefix}${r.key}:start`);
          visit(r.submenu, `${prefix}${r.key}/`);
          separator(`${prefix}${r.key}:end`);
        } else rows.push({ key: prefix + r.key, label: r.label, icon: r.icon, expand: true });
        continue;
      }
      if (!r.run) continue;
      const row: NewPopupRow = { key: prefix + r.key, label: r.label, icon: r.icon, shortcut: r.shortcut, run: r.run };
      if (!q) {
        rows.push(row);
        continue;
      }
      const matches = fuzzyMatch(r.label, q);
      if (matches) rows.push({ ...row, matches });
      else if (keywordMatch(r.key, q)) byKeyword.push(row);
    }
  };
  visit(items, "");
  while (rows.length && rows[rows.length - 1]!.separator) rows.pop();
  return [...rows, ...byKeyword];
}

function keywordMatch(actionId: string, q: string): boolean {
  const lower = q.toLowerCase().replace(/^\./, "");
  return !!getAction(actionId)?.keywords?.some(
    (k) => !GENERIC.has(k) && k.toLowerCase().replace(/^\./, "").startsWith(lower),
  );
}
