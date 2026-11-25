import { useMemo, useState, type KeyboardEvent } from "react";
import { HighlightedText, Icon, List, Popup, SearchField, T, firstSelectable, fuzzyMatch, listNavigate } from "@/ui";
import { tx } from "@/platform/i18n";
import { isImeKey } from "@/platform/ime";
import { repoName } from "./store";
import styles from "./GitLog.module.css";

type Row = { key: string; root: string; label: string; matches: number[] | null };

const ROW_HEIGHT = 24;
const MAX_LIST_HEIGHT = 320;
const never = () => false;

function buildRows(repositories: readonly string[], query: string): Row[] {
  const q = query.trim();
  const rows: Row[] = [];
  for (const root of repositories) {
    const label = repoName(root);
    const matches = q ? fuzzyMatch(label, q) : null;
    if (q && !matches) continue;
    rows.push({ key: `repo:${root}`, root, label, matches });
  }
  return rows;
}

/** Git Log "Repository" filter: type to narrow the repositories, ↑↓ Enter to pick. */
export function RepositoryFilterPopup({
  anchor,
  repositories,
  selected,
  onSelect,
  onClose,
}: {
  anchor: HTMLElement;
  repositories: readonly string[];
  selected: readonly string[];
  onSelect: (root: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(() => Math.max(0, repositories.indexOf(selected[0] ?? "")));
  const rows = useMemo(() => buildRows(repositories, query), [repositories, query]);
  const activeIndex = rows[active] ? active : firstSelectable(rows, never);
  const activate = (row: Row | undefined) => {
    if (row) onSelect(row.root);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    // Keys that drive an IME candidate window (including the Enter that confirms one) are not list commands.
    if (isImeKey(e.nativeEvent)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      activate(rows[activeIndex]);
      return;
    }
    const next = listNavigate(e.key, { items: rows, active: activeIndex, isSection: never, wrap: true });
    if (next !== null) {
      e.preventDefault();
      setActive(next);
    }
  };
  const height = Math.min(MAX_LIST_HEIGHT, Math.max(ROW_HEIGHT * 3, rows.length * ROW_HEIGHT));
  return (
    <Popup open anchor={anchor} onClose={onClose} className={styles.branchFilterPopup} aria-label={tx("Repository")}>
      <div className={styles.branchFilterSearch}>
        <SearchField
          data-autofocus
          variant="bare"
          value={query}
          onChange={(value) => {
            setQuery(value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search repositories"
          aria-label="Search repositories"
        />
      </div>
      <div className={styles.branchFilterList} style={{ height }}>
        <List
          items={rows}
          getKey={(r) => r.key}
          activeIndex={activeIndex}
          onActiveChange={setActive}
          onActivate={activate}
          focusable={false}
          hoverSelects
          rowHeight={ROW_HEIGHT}
          aria-label="Repositories"
          className={styles.branchFilterListBody}
          empty={
            <span className={styles.branchFilterEmpty}>
              <T>No matching repositories</T>
            </span>
          }
          renderItem={(r) => (
            <span className={styles.branchFilterRow}>
              <HighlightedText className={styles.branchFilterLabel} text={r.label} indices={r.matches} tone="accent" />
              {selected.includes(r.root) && <Icon name="check" size={14} className={styles.branchFilterCheck} />}
            </span>
          )}
        />
      </div>
    </Popup>
  );
}
