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

/** What a replayed commit's file row says besides its change: the non-text wording, else the reason. */
export function replayFileNote(f: ClipReplayFile): string | null {
  if (f.reason === "CORRUPT_NON_TEXT") return tx("Corrupt non-text file");
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
          autoFocus: true,
          disabled: summary.exceedsPayloadCap,
          title: summary.exceedsPayloadCap
            ? "The payload with non-text files is over the clipboard size limit"
            : undefined,
          onClick: () => onChoose("include"),
        },
        { label: "Exclude", onClick: () => onChoose("exclude") },
        { label: "Cancel", role: "cancel", onClick: () => onChoose("cancel") },
      ]}
    >
      <div className={styles.nonText}>
        <div>{tx`${count} non-text files, raw ${raw}`}</div>
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
        {over > 0 && (
          <div
            className={styles.note}
          >{tx`${over} non-text files are over the size limit and will not be copied.`}</div>
        )}
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
