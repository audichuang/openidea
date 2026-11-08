/** A searchable single-choice popup for the Git Graph toolbar: type to filter, ↑/↓ to move, Enter to pick. */
import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTx } from "@/platform/i18n";
import { isImeKey } from "@/platform/ime";
import { HighlightedText, Icon, List, Popup, SearchField, T, firstSelectable, fuzzyMatch, listNavigate } from "@/ui";
import styles from "./PickerPopup.module.css";

export interface PickerItem {
  value: string;
  label: string;
  /** Group heading; items of one section must be adjacent. */
  section?: string;
  /** Leading icon or swatch. */
  icon?: ReactNode;
  checked?: boolean;
}

type Row =
  | { type: "section"; key: string; label: string }
  | { type: "item"; key: string; item: PickerItem; matches: number[] | null };

const ROW_HEIGHT = 24;
const MAX_LIST_HEIGHT = 320;

/** The items whose label fuzzily matches `query`, under their section headings; empty sections are left out. */
function pickerRows(items: readonly PickerItem[], query: string): Row[] {
  const q = query.trim();
  const rows: Row[] = [];
  let section: string | undefined;
  for (const item of items) {
    const matches = q ? fuzzyMatch(item.label, q) : null;
    if (q && !matches) continue;
    if (item.section && item.section !== section)
      rows.push({ type: "section", key: `section:${item.section}`, label: item.section });
    section = item.section;
    rows.push({ type: "item", key: `item:${item.value}`, item, matches });
  }
  return rows;
}

const isSection = (r: Row) => r.type === "section";

export function PickerPopup(props: {
  anchor: HTMLElement;
  items: readonly PickerItem[];
  onPick: (value: string) => void;
  onClose: () => void;
  label: string;
  placeholder: string;
  emptyLabel: string;
}) {
  const { anchor, items, onPick, onClose, label, placeholder, emptyLabel } = props;
  const t = useTx();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<number | null>(null);
  const rows = useMemo(() => pickerRows(items, query), [items, query]);
  // Start on the checked item, else the first one; after typing, on the first match.
  const initial = query ? -1 : rows.findIndex((r) => r.type === "item" && r.item.checked);
  const fallback = initial >= 0 ? initial : firstSelectable(rows, isSection);
  const activeIndex = active !== null && rows[active] && !isSection(rows[active]) ? active : fallback;
  const activate = (row: Row | undefined) => {
    if (row?.type !== "item") return;
    onPick(row.item.value);
    onClose();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (isImeKey(e.nativeEvent)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      activate(rows[activeIndex]);
      return;
    }
    const next = listNavigate(e.key, { items: rows, active: activeIndex, isSection, wrap: true });
    if (next !== null) {
      e.preventDefault();
      setActive(next);
    }
  };
  const height = Math.min(MAX_LIST_HEIGHT, Math.max(ROW_HEIGHT * 3, rows.length * ROW_HEIGHT));
  return (
    <Popup open anchor={anchor} onClose={onClose} className={styles.popup} aria-label={t(label)}>
      <div className={styles.search}>
        <SearchField
          data-autofocus
          variant="bare"
          value={query}
          onChange={(value) => {
            setQuery(value);
            setActive(null);
          }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label={placeholder}
        />
      </div>
      <div className={styles.list} style={{ height }}>
        <List
          items={rows}
          getKey={(r) => r.key}
          isSection={isSection}
          renderSection={(r) => <span className={styles.section}>{r.type === "section" ? r.label : ""}</span>}
          activeIndex={activeIndex}
          onActiveChange={setActive}
          onActivate={activate}
          focusable={false}
          hoverSelects
          rowHeight={ROW_HEIGHT}
          aria-label={label}
          className={styles.listBody}
          empty={
            <span className={styles.empty}>
              <T>{emptyLabel}</T>
            </span>
          }
          renderItem={(r) =>
            r.type === "item" ? (
              <span className={styles.row}>
                {r.item.icon}
                <HighlightedText className={styles.label} text={r.item.label} indices={r.matches} tone="accent" />
                {r.item.checked ? <Icon name="check" size={14} className={styles.check} /> : null}
              </span>
            ) : null
          }
        />
      </div>
    </Popup>
  );
}
