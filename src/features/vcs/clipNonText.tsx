/**
 * The non-text file question of a ClipCode copy (`docs/clipcode/non-text-files.md`, "Asking the
 * user"): a copy always runs with Exclude first; when it found non-text files within their limit,
 * the user chooses whether they travel as Base64 before anything reaches the clipboard.
 */
import type { ClipCopyResult, ClipNonTextSummary, ClipPasteFile, ClipReplayFile } from "@/bindings";
import { tx } from "@/platform/i18n";
import { Dialog, T } from "@/ui";
import { openDialog } from "./dialogs";
import styles from "./clip.module.css";

export type NonTextChoice = "include" | "exclude" | "cancel";

const MAX_LISTED = 10;

/** Raw byte counts the way the dialog and the paste preview spell them. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "?";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Decides what a copy puts on the clipboard. `first` is the Exclude result; without non-text files
 * it is the answer and nobody is asked. Otherwise `ask` runs: Exclude keeps `first`, Include
 * copies again through `again`, Cancel yields null (nothing is written).
 */
export async function resolveNonText(
  first: ClipCopyResult,
  ask: (summary: ClipNonTextSummary) => Promise<NonTextChoice>,
  again: () => Promise<ClipCopyResult | null>,
): Promise<ClipCopyResult | null> {
  if (first.nonText.count === 0) return first;
  const choice = await ask(first.nonText);
  if (choice === "cancel") return null;
  if (choice === "include" && !first.nonText.exceedsPayloadCap) return again();
  return first;
}

/** "Non-text file · 4.0 KB", plus whether an existing target already holds the bytes. */
export function pasteNonTextLabel(file: ClipPasteFile): string | null {
  const n = file.nonText;
  if (!n) return null;
  const size = formatBytes(n.size);
  const base = tx`Non-text file · ${size}`;
  if (file.action !== "overwrite" && !n.identical) return base;
  return `${base} · ${n.identical ? tx("Identical") : tx("Different")}`;
}

/** An existing non-text target that already holds the pasted bytes: left untouched, needs no overwrite. */
export function isUnchanged(file: ClipPasteFile): boolean {
  return !!file.nonText?.identical;
}

/** A skipped entry whose Base64 payload cannot be decoded: its row shows a Corrupt badge, not a note. */
export function isCorruptRow(file: ClipPasteFile): boolean {
  return file.action === "skip" && file.reason === "CORRUPT_NON_TEXT";
}

/** The short note on a tree row: the size only (a corrupt row has the badge, so no note). */
export function pasteRowNote(file: ClipPasteFile): string | null {
  if (isCorruptRow(file)) return null;
  return file.nonText ? formatBytes(file.nonText.size) : null;
}

/** The full wording of a tree row's note, for its tooltip and the preview pane. */
export function pasteRowTitle(file: ClipPasteFile): string | null {
  if (isCorruptRow(file)) return tx("Corrupt non-text file");
  return pasteNonTextLabel(file);
}

/** What a replayed commit's file row says besides its change: the non-text size, else the reason (a corrupt row has a badge). */
export function replayFileNote(f: ClipReplayFile): string | null {
  if (f.reason === "CORRUPT_NON_TEXT") return null;
  if (f.nonTextSize != null) {
    const size = formatBytes(f.nonTextSize);
    return tx`Non-text file · ${size}`;
  }
  return f.reason;
}

export function NonTextDialog({
  summary,
  onChoose,
}: {
  summary: ClipNonTextSummary;
  onChoose: (choice: NonTextChoice) => void;
}) {
  const { count, files } = summary;
  const raw = formatBytes(summary.totalBytes);
  const estimate = formatBytes(summary.estimatedIncludeBytes);
  const shown = files.slice(0, MAX_LISTED);
  const more = count - shown.length;
  const over = summary.overLimitCount;
  const unread = summary.unreadOverLimitCount;
  const unreadLimit = formatBytes(summary.unreadLimitBytes);
  return (
    <Dialog
      open
      title="Copy non-text files?"
      onClose={() => onChoose("cancel")}
      width={520}
      buttons={[
        {
          label: "Include",
          role: "default",
          autoFocus: !summary.exceedsPayloadCap,
          disabled: summary.exceedsPayloadCap,
          title: summary.exceedsPayloadCap
            ? "The payload with non-text files is over the clipboard size limit"
            : undefined,
          onClick: () => onChoose("include"),
        },
        { label: "Exclude", autoFocus: summary.exceedsPayloadCap, onClick: () => onChoose("exclude") },
        { label: "Cancel", role: "cancel", onClick: () => onChoose("cancel") },
      ]}
    >
      <div className={styles.nonText}>
        <div>{tx`Non-text files: ${count}, raw ${raw}`}</div>
        <div className={styles.note}>{tx`Payload with them: about ${estimate}`}</div>
        {summary.exceedsPayloadCap && (
          <div className={styles.warn} role="alert">
            <T>Too large for the clipboard: Include is not available.</T>
          </div>
        )}
        <ul className={styles.nonTextList} aria-label={tx("Non-text files")}>
          {shown.map((f) => (
            <li key={f.path} className={styles.nonTextRow}>
              <span className={styles.path} title={f.path}>
                {f.path}
              </span>
              <span className={styles.note}>{formatBytes(f.size)}</span>
            </li>
          ))}
        </ul>
        {more > 0 && <div className={styles.note}>{tx`and ${more} more`}</div>}
        {unread > 0 && (
          <div
            className={styles.note}
          >{tx`Not read, over ${unreadLimit} (copied as size placeholders): ${unread}`}</div>
        )}
        {over > 0 && <div className={styles.note}>{tx`Non-text files over the size limit (not copied): ${over}`}</div>}
      </div>
    </Dialog>
  );
}

/** Opens the dialog and resolves with the button pressed (closing it cancels). */
export function askNonText(summary: ClipNonTextSummary): Promise<NonTextChoice> {
  return new Promise((resolve) => {
    openDialog((closeIt) => (
      <NonTextDialog
        summary={summary}
        onChoose={(c) => {
          closeIt();
          resolve(c);
        }}
      />
    ));
  });
}
