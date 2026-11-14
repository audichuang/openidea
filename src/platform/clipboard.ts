import { call, commands, IpcError, isTauri } from "./ipc";
import { ipcPath } from "./paths";

/** Native menu actions and async work can outlive WebKit's user activation. */
export async function writeClipboardText(text: string): Promise<void> {
  if (isTauri()) await call(commands.clipboardWriteText(text));
  else await navigator.clipboard.writeText(text);
}

/**
 * The clipboard's plain text, read natively where the backend can (macOS, Linux), else
 * through the WebView. A Paste from a menu has no paste event to read, WebKitGTK's
 * `navigator.clipboard.readText()` gives no text there, and the macOS WebView makes the user
 * confirm such a read with a "Paste" callout. Rejects when the WebView refuses.
 */
export async function readClipboardPlainText(): Promise<string> {
  if (isTauri()) {
    const text = await call(commands.clipboardText()).catch(() => null);
    if (text != null) return text;
  }
  return (await navigator.clipboard?.readText()) ?? "";
}

type FormatFiles = (paths: string[]) => string;
const rawPaths: FormatFiles = (paths) => paths.join("\n");

/**
 * The clipboard's image outside a paste event, read by the backend for the same reason as
 * {@link readClipboardPlainText}; `null` when it holds none (or holds files). `undefined` where the backend
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
  const text = transfer ? transfer.getData("text/plain") : await readClipboardPlainText().catch(() => "");
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
