import { call, commands, IpcError, isTauri } from "./ipc";
import { ipcPath } from "./paths";

type FormatFiles = (paths: string[]) => string;
const rawPaths: FormatFiles = (paths) => paths.join("\n");

/**
 * The clipboard's text outside a paste event (menus, commands, shortcuts). The macOS webview makes
 * the user confirm such a read with a "Paste" callout and reads nothing when it is dismissed, so
 * the backend reads it where it can; elsewhere the webview does. Rejects like `readText()`.
 */
export async function readPlainText(): Promise<string> {
  const native = isTauri() ? await call(commands.clipboardText()) : null;
  return native ?? (await navigator.clipboard?.readText()) ?? "";
}

/**
 * Puts `text` on the clipboard. The backend writes it where it can, so a copy that first awaits
 * the backend (ClipCode) or runs from a menu does not depend on the webview's user-gesture rules;
 * elsewhere the webview writes it. Rejects when nothing was written.
 */
export async function writePlainText(text: string): Promise<void> {
  if (isTauri() && (await call(commands.clipboardSetText(text)))) return;
  if (!navigator.clipboard?.writeText) throw new Error("The clipboard cannot be written");
  await navigator.clipboard.writeText(text);
}

/**
 * The clipboard's image outside a paste event, read by the backend for the same reason as
 * {@link readPlainText}; `null` when it holds none (or holds files). `undefined` where the backend
 * cannot read it (outside Tauri, Linux): the caller reads it through the webview then.
 */
export async function readClipboardImage(): Promise<Blob | null | undefined> {
  if (!isTauri()) return undefined;
  try {
    const image = await call(commands.clipboardImage());
    return image && new Blob([new Uint8Array(image.data)], { type: image.mime });
  } catch (error) {
    if (error instanceof IpcError && error.kind === "unavailable") return undefined;
    throw error;
  }
}

/** WebKit exposes native file URLs as Files, hiding the pasteboard's text flavor. */
export async function readClipboardText(
  transfer?: DataTransfer | null,
  formatFiles: FormatFiles = rawPaths,
): Promise<string> {
  const text = transfer ? transfer.getData("text/plain") : await readPlainText().catch(() => "");
  if ((text && formatFiles === rawPaths) || (transfer && !hasClipboardFiles(transfer)) || !isTauri()) return text;
  let paths: string[];
  try {
    paths = await call(commands.clipboardFileList());
  } catch {
    return text;
  }
  // Windows also supplies the file list as text; unrelated text still wins.
  if (text && text.replace(/\r\n/g, "\n").split("\n").map(ipcPath).join("\n") !== paths.join("\n")) return text;
  return formatFiles(paths);
}

function hasClipboardFiles(transfer: DataTransfer): boolean {
  return !!transfer.files.length || Array.from(transfer.types).includes("Files");
}

/** Claim synchronously so the native handler cannot emit an empty paste while IPC runs. */
export function pasteClipboardFiles(
  event: ClipboardEvent,
  paste: (text: string) => void,
  formatFiles: FormatFiles = rawPaths,
): boolean {
  const transfer = event.clipboardData;
  if (
    event.defaultPrevented ||
    !transfer ||
    (transfer.getData("text/plain") && formatFiles === rawPaths) ||
    !hasClipboardFiles(transfer)
  )
    return false;
  event.preventDefault();
  event.stopImmediatePropagation();
  void readClipboardText(transfer, formatFiles).then((text) => {
    if (text) paste(text);
  });
  return true;
}
