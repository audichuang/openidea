import { useEffect, useRef, useState } from "react";
import { unifiedMergeView } from "@codemirror/merge";
import { EditorView } from "@codemirror/view";
import type { ClipPasteFile, ClipPasteFileContent } from "@/bindings";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { languageFor, viewerBase } from "./cm";
import { isUnchanged, pasteNonTextLabel, pasteRowTitle } from "./clipNonText";
import styles from "./clip.module.css";

const ACTION_HINT: Record<string, string> = {
  create: "New file: its content after the paste",
  overwrite: "Replaces the existing file: changes from what is on disk",
  delete: "Deletes the file: its content now",
};

/**
 * The paste preview's right pane: the selected file's content as the paste
 * writes it, a diff against the destination for an overwrite, the file being
 * deleted, or why a file is skipped. Read-only; read one file at a time.
 */
export function ClipPastePane({ previewId, file }: { previewId: number; file: ClipPasteFile | null }) {
  const host = useRef<HTMLDivElement>(null);
  const action = file?.action;
  const index = file?.index;
  const key = `${previewId}:${action}:${index}`;
  const nonText = !!file?.nonText;
  // What was read, for the file it was read for: a newer selection ignores an older read.
  const [loaded, setLoaded] = useState<{ key: string; content?: ClipPasteFileContent; error?: string } | null>(null);
  const content = loaded?.key === key ? (loaded.content ?? null) : null;
  const error = loaded?.key === key ? (loaded.error ?? null) : null;

  useEffect(() => {
    if (action === undefined || index === undefined || action === "skip" || nonText) return;
    let alive = true;
    call(commands.clipPastePreviewFile(previewId, action, index)).then(
      (c) => alive && setLoaded({ key, content: c }),
      (e: unknown) => alive && setLoaded({ key, error: String(e) }),
    );
    return () => {
      alive = false;
    };
  }, [previewId, action, index, key, nonText]);

  const path = file?.path;
  useEffect(() => {
    const parent = host.current;
    if (!parent || !content || !path) return;
    const doc = action === "delete" ? (content.current ?? "") : (content.incoming ?? "");
    let view: EditorView | null = null;
    let alive = true;
    void languageFor(path).then((language) => {
      if (!alive) return;
      view = new EditorView({
        doc,
        parent,
        extensions: [
          viewerBase({ readOnly: true }),
          language ?? [],
          action === "overwrite" && content.current !== null
            ? unifiedMergeView({ original: content.current, gutter: true, mergeControls: false })
            : [],
        ],
      });
    });
    return () => {
      alive = false;
      view?.destroy();
    };
  }, [content, action, path]);

  const reason = file?.reason ?? "";
  if (!file) return <div className={styles.paneEmpty}>{tx("Select a file to preview it")}</div>;
  return (
    <div className={styles.pane}>
      <div className={styles.paneHeader}>
        <span className={styles.path} title={file.target ?? file.path}>
          {file.path}
        </span>
        {ACTION_HINT[file.action] && !isUnchanged(file) && (
          <span className={styles.note}>{tx(ACTION_HINT[file.action]!)}</span>
        )}
      </div>
      {nonText ? (
        <div className={styles.paneEmpty}>{pasteNonTextLabel(file)}</div>
      ) : file.action === "skip" ? (
        <div className={styles.paneEmpty}>
          {reason === "CORRUPT_NON_TEXT" ? pasteRowTitle(file) : tx`Skipped: ${reason}`}
        </div>
      ) : error ? (
        <div className={styles.paneEmpty}>{error}</div>
      ) : content?.note ? (
        <div className={styles.paneEmpty}>{tx(content.note)}</div>
      ) : (
        <div ref={host} className={styles.paneEditor} aria-label={tx("File content")} />
      )}
    </div>
  );
}
