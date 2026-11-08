/**
 * The non-text file question of a ClipCode copy (`docs/clipcode/non-text-files.md`, "Asking the
 * user"): a copy always runs with Exclude first; when it found non-text files within their limit,
 * the user chooses whether they travel as Base64 before anything reaches the clipboard.
 */
import type { ClipCopyResult, ClipNonTextSummary, ClipPasteFile, ClipReplayFile } from "@/bindings";
import { tx } from "@/platform/i18n";
import { Dialog, T } from "@/ui";
import { openDialog } from "./dialogs";
import { PathText } from "./PathText";
import styles from "./clip.module.css";

export type NonTextChoice = "include" | "exclude" | "cancel";

const MAX_LISTED = 10;
/** The whole-payload limit of the Rust side (`CLIPBOARD_PAYLOAD_MAX`), for the over-limit wording. */
const PAYLOAD_CAP_BYTES = 50 * 1024 * 1024;

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
  if (choice === "include" && !first.nonText.exceedsPayloadCap && !first.nonText.headerCannotBeEscaped) {
    return again();
  }
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
  return f.reason ? skipReasonText(f.reason) : null;
}

/** What a skip or not-copied reason code means to the user (the previews never show the raw code). */
export function skipReasonText(code: string | null | undefined): string {
  switch (code) {
    case undefined:
    case null:
    case "":
      return "";
    case "BINARY":
    case "NON_UTF8":
      return tx("Non-text file, not copied");
    case "NON_UTF8_PATH":
      return tx("File name is not UTF-8, not copied");
    case "UNSUPPORTED_TYPE":
      return tx("Symlink or submodule, not copied");
    case "UNREADABLE":
      return tx("Unreadable, not copied");
    case "NOT_COPIED":
      return tx("Not copied");
    case "UNSAFE_PATH":
      return tx("Unsafe path");
    case "NON_UTF8_TARGET":
      return tx("Existing file is not UTF-8; not overwritten");
    case "CORRUPT_NON_TEXT":
      return tx("Corrupt non-text file");
    case "ALREADY_ABSENT":
      return tx("Already absent");
    case "UNRESOLVED_PATH":
      return tx("Path could not be resolved");
    case "AMBIGUOUS_PATH":
      return tx("Path matches more than one root");
    case "PLACEHOLDER_BODY":
      return tx("Placeholder, no file content");
    case "TARGET_NOT_FILE":
      return tx("Target is a folder; not replaced");
    case "TARGET_COLLISION":
      return tx("Another entry maps to the same file; not applied");
    case "the renamed-from path is a directory":
      return tx("The renamed-from path is a folder");
    case "the path to delete is a directory":
      return tx("The path to delete is a folder");
    case "a directory is in the way of the file":
      return tx("A folder is in the way of the file");
    case "a file is in the way of its parent directory":
      return tx("A file is in the way of its parent folder");
    case "the path differs only in letter case from another one in the destination or the commit":
      return tx("The path differs only in letter case from another one in the destination or the commit");
    default:
      return code;
  }
}

/**
 * A paste result line `<path>: <reason>` whose reason is one of the write-error texts of `restore.rs`
 * (`io_error_text`): the reason is translated, the path kept.
 */
export function errorLineText(line: string): string {
  const at = line.lastIndexOf(": ");
  if (at < 0) return line;
  const translate = (reason: string): string | null => {
    switch (reason) {
      case "Folder is not writable":
        return tx("Folder is not writable");
      case "File or folder not found":
        return tx("File or folder not found");
      case "A file or folder already exists at that path":
        return tx("A file or folder already exists at that path");
      case "A file is in the way of a folder":
        return tx("A file is in the way of a folder");
      case "The target is a folder":
        return tx("The target is a folder");
      case "The disk is full":
        return tx("The disk is full");
      case "The file system is read-only":
        return tx("The file system is read-only");
      case "Could not apply the change":
        return tx("Could not apply the change");
      case "unsafe path":
        return tx("Unsafe path");
      default:
        return null;
    }
  };
  const text = translate(line.slice(at + 2));
  return text === null ? line : `${line.slice(0, at)}: ${text}`;
}

/** A file name for a notice: control characters (a tab) are made visible. */
export function visibleName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f]/g, (c) =>
    c === "\t" ? "\\t" : `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
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
  const cap = formatBytes(PAYLOAD_CAP_BYTES);
  const includeBlocked = summary.exceedsPayloadCap || summary.headerCannotBeEscaped;
  const shown = files.slice(0, MAX_LISTED);
  const more = count - shown.length;
  const over = summary.overLimitCount;
  const unread = summary.unreadOverLimitCount;
  const unreadLimit = formatBytes(summary.unreadLimitBytes);
  const leftOut = summary.limitLeftOutAtLeast ? `${summary.limitLeftOut}+` : String(summary.limitLeftOut);
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
          autoFocus: !includeBlocked,
          disabled: includeBlocked,
          title: summary.exceedsPayloadCap
            ? "The payload with non-text files is over the clipboard size limit"
            : summary.headerCannotBeEscaped
              ? "The header format cannot be escaped"
              : undefined,
          onClick: () => onChoose("include"),
        },
        { label: "Exclude", autoFocus: includeBlocked, onClick: () => onChoose("exclude") },
        { label: "Cancel", role: "cancel", onClick: () => onChoose("cancel") },
      ]}
    >
      <div className={styles.nonText}>
        <div>{tx`Non-text files: ${count}, raw ${raw}`}</div>
        <div className={styles.note}>
          {summary.exceedsPayloadCap
            ? tx`Payload with them: more than ${cap}`
            : tx`Payload with them: about ${estimate}`}
        </div>
        {summary.exceedsPayloadCap && (
          <div className={styles.warn} role="alert">
            <T>Too large for the clipboard: Include is not available.</T>
          </div>
        )}
        {summary.headerCannotBeEscaped && (
          <div className={styles.warn} role="alert">
            <T>
              Include is not available: the header format has no fixed text before $FILE_PATH, so Base64 lines would be
              read as file headers.
            </T>
          </div>
        )}
        <ul className={styles.nonTextList} aria-label={tx("Non-text files")}>
          {shown.map((f) => (
            <li key={f.path} className={styles.nonTextRow}>
              <PathText path={f.path} className={styles.nonTextPath} />
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
        {summary.limitLeftOut > 0 && (
          <div className={styles.note}>{tx`Files left out by the file limit: ${leftOut}`}</div>
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
