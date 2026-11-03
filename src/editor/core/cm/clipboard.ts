import { Facet, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { pasteClipboardFiles, readClipboardImage, readClipboardText } from "@/platform/clipboard";
import { tx } from "@/platform/i18n";
import { isRemoteWindow } from "@/platform/remote";
import { notifications } from "@/workbench/contributions";
import { isMarkdown, pasteMarkdownImage, relativeImagePath } from "./markdownImages";

export const clipboardDocumentPath = Facet.define<string, string>({ combine: (paths) => paths[0] ?? "" });

function clipboardFileFormatter(view: EditorView): ((paths: string[]) => string) | undefined {
  const path = view.state.facet(clipboardDocumentPath);
  return isMarkdown(path) && !isRemoteWindow()
    ? (paths) => paths.map((target) => `[](${relativeImagePath(path, target)})`).join("\n")
    : undefined;
}

export function pasteEditorText(view: EditorView, text: string) {
  if (!text || !view.dom.isConnected || view.state.readOnly) return;
  view.dispatch(view.state.replaceSelection(text), { userEvent: "input.paste", scrollIntoView: true });
  view.focus();
}

export async function pasteEditorClipboard(view: EditorView) {
  if (!view.dom.isConnected || view.state.readOnly) return;
  const markdown = isMarkdown(view.state.facet(clipboardDocumentPath));
  // A copied image goes in before its text, as in a paste event. The backend reads it: the
  // webview's own read (execCommand below) makes macOS WebKit ask the user to confirm.
  let image: Blob | null | undefined;
  if (markdown) {
    try {
      image = await readClipboardImage();
    } catch (error) {
      notifications().notify({ level: "error", title: tx("Cannot insert image"), body: String(error) });
      return;
    }
    if (image && pasteMarkdownImage(view, image)) return;
  }
  try {
    // Successful native paste preserves image blobs and may complete after execCommand returns.
    if (markdown && image === undefined && document.queryCommandSupported("paste")) {
      view.focus();
      if (document.execCommand("paste")) return;
    }
    pasteEditorText(view, await readClipboardText(undefined, clipboardFileFormatter(view)));
  } catch {
    if (!view.dom.isConnected || view.state.readOnly) return;
    view.focus();
    document.execCommand("paste");
  }
}

// Markdown image handlers get first refusal, including copied image files.
export const clipboardFilesExtension = Prec.lowest(
  EditorView.domEventHandlers({
    paste(event, view) {
      if (view.state.readOnly) return false;
      return pasteClipboardFiles(event, (text) => pasteEditorText(view, text), clipboardFileFormatter(view));
    },
  }),
);
