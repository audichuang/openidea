/**
 * ClipCode / snip-sync clipboard transfer: copies files, changes, commits or a
 * pull request's changes as the text ClipCode (IntelliJ, VS Code) and snip-sync
 * restore, and pastes such text back after a preview. The payload is built and
 * applied by the backend (`ide-clip`); this module owns the clipboard and the UI.
 */
import { useState } from "react";
import type { ClipCopySource, ClipPastePreview, ClipPasteResult, Commit } from "@/bindings";
import { readClipboardText } from "@/platform/clipboard";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { registerActions, type Action } from "@/platform/actions";
import { Checkbox, Dialog, T } from "@/ui";
import { copyText } from "@/ui/selectableText";
import { notifications } from "@/workbench/contributions";
import { openDialog } from "./dialogs";
import type { LogChange } from "./logChanges";
import { commitRepo } from "./multiRoot";
import { commitsArg } from "./historyActions";
import { refreshNow, useVcs } from "./store";
import styles from "./clip.module.css";

/** Builds the payload for `source` and puts it on the clipboard, reporting what was copied. */
export async function copyClip(source: ClipCopySource): Promise<boolean> {
  let result;
  try {
    result = await call(commands.clipCopy(source));
  } catch (e) {
    notifications().notify({ group: "vcs", level: "warning", title: "ClipCode copy failed", body: String(e) });
    return false;
  }
  await copyText(result.text);
  const { files, commits, chars, lines, skipped } = result;
  const title =
    result.mode === "commits"
      ? tx`${commits} commits copied (${files} files)`
      : result.truncated
        ? tx`${files} files copied (file limit reached)`
        : tx`${files} files copied`;
  const count = lines;
  const parts = [tx`${chars} chars`, tx`${count} lines`];
  if (skipped) parts.push(result.mode === "commits" ? tx`${skipped} not copied` : tx`${skipped} skipped`);
  notifications().notify({ group: "vcs", level: "info", title, body: parts.join(" · ") });
  return true;
}

const repoOf = (c: Commit) => commitRepo(c) ?? useVcs.getState().repo ?? useVcs.getState().root ?? "";

/** Copy Full Source of commits: one commit's files, or the files changed across a contiguous selection. */
export function commitFilesSource(cs: readonly Commit[], paths: string[] = []): ClipCopySource | null {
  if (!cs.length) return null;
  const repo = repoOf(cs[0]!);
  if (cs.length === 1) return { kind: "commitFiles", repo, rev: cs[0]!.id, paths };
  // Newest first: the range is the oldest commit's parent up to the newest.
  const oldest = cs[cs.length - 1]!;
  const base = oldest.parents[0];
  if (!base) return { kind: "commitFiles", repo, rev: cs[0]!.id, paths };
  return { kind: "range", repo, base, tip: cs[0]!.id, paths };
}

/** Copy Commits: the selection (newest first) as a replayable commit payload. */
export function commitsSource(cs: readonly Commit[]): ClipCopySource | null {
  if (!cs.length) return null;
  return { kind: "commits", repo: repoOf(cs[0]!), tip: cs[0]!.id, selected: cs.map((c) => c.id) };
}

/** The Git Log changes browser's files (their commit selection given), as Copy Full Source. */
export function logChangesSource(commits: readonly Commit[], changes: readonly LogChange[]): ClipCopySource | null {
  const root = changes[0]?.repo ?? (commits[0] ? repoOf(commits[0]) : "");
  const paths = changes.map((c) => `${root}/${c.path}`);
  return commitFilesSource(commits, paths);
}

// ---------------------------------------------------------------------------
// Paste

/** ClipCode: Paste and Restore Files — previews the clipboard payload, then writes what is confirmed. */
export async function pasteClip(dest?: string | null) {
  const text = await readClipboardText();
  if (!text.trim()) {
    notifications().notify({ group: "vcs", level: "info", title: "The clipboard is empty" });
    return;
  }
  const preview = await loadPreview(text, dest ?? null, false);
  if (!preview) return;
  openDialog((close) => <PastePreviewDialog text={text} dest={dest ?? null} initial={preview} onClose={close} />);
}

async function loadPreview(text: string, dest: string | null, adjust: boolean): Promise<ClipPastePreview | null> {
  try {
    return await call(commands.clipPastePreview(text, dest, adjust, [...useVcs.getState().roots]));
  } catch (e) {
    notifications().notify({ group: "vcs", level: "warning", title: "Nothing to paste", body: String(e) });
    return null;
  }
}

function reportPaste(r: ClipPasteResult, commits: boolean) {
  const created = r.commits.length;
  const title = commits
    ? tx`${created} commits created`
    : tx`Restored: ${r.created} created, ${r.overwritten} overwritten, ${r.deleted} deleted, ${r.skipped} skipped`;
  notifications().notify({
    group: "vcs",
    level: r.errors.length ? "warning" : "info",
    title,
    body: r.errors.length ? r.errors.join("\n") : undefined,
  });
}

const ACTION_LABEL: Record<string, string> = {
  create: "Create",
  overwrite: "Overwrite",
  delete: "Delete",
  skip: "Skip",
};

/** Keys of file rows: their action kind's index list (creates and overwrites share one). */
const rowKey = (action: string, index: number) => `${action === "delete" ? "d" : "c"}${index}`;

export function PastePreviewDialog({
  text,
  dest,
  initial,
  onClose,
}: {
  text: string;
  dest: string | null;
  initial: ClipPastePreview;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState(initial);
  // Overwrites are off until chosen, as in ClipCode; new files and deletions are on.
  const [checked, setChecked] = useState<Set<string>>(
    () =>
      new Set(
        initial.files
          .filter((f) => f.action === "create" || f.action === "delete")
          .map((f) => rowKey(f.action, f.index)),
      ),
  );
  const [allowOverwrite, setAllowOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const commits = preview.mode === "commits";
  const existing = preview.commits.reduce((n, c) => n + c.files.filter((f) => f.overwrites).length, 0);

  const toggle = (key: string) =>
    setChecked((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const adjust = async (on: boolean) => {
    const next = await loadPreview(text, dest, on);
    if (!next) return;
    setPreview(next);
    setChecked(
      new Set(
        next.files.filter((f) => f.action === "create" || f.action === "delete").map((f) => rowKey(f.action, f.index)),
      ),
    );
  };

  const apply = async () => {
    setBusy(true);
    try {
      const creates = preview.files.filter((f) => f.action === "create" || f.action === "overwrite");
      const deletes = preview.files.filter((f) => f.action === "delete");
      const result = await call(
        commands.clipPasteApply({
          id: preview.id,
          overwrite: creates
            .filter((f) => f.action === "overwrite" && checked.has(rowKey(f.action, f.index)))
            .map((f) => f.index),
          uncheckedCreates: creates.filter((f) => !checked.has(rowKey(f.action, f.index))).map((f) => f.index),
          uncheckedDeletes: deletes.filter((f) => !checked.has(rowKey(f.action, f.index))).map((f) => f.index),
          overwriteExisting: allowOverwrite,
        }),
      );
      reportPaste(result, commits);
      onClose();
      void refreshNow();
    } catch (e) {
      notifications().notify({ group: "vcs", level: "error", title: "Paste failed", body: String(e) });
      setBusy(false);
    }
  };

  const actionable = commits
    ? preview.commits.length > 0 && (!existing || allowOverwrite)
    : preview.files.some((f) => f.action !== "skip" && checked.has(rowKey(f.action, f.index)));

  return (
    <Dialog
      open
      title={commits ? "Paste Commits" : "Paste and Restore Files"}
      onClose={onClose}
      width={720}
      resizable="both"
      buttons={[
        {
          label: commits ? "Replay Commits" : "Restore",
          role: "default",
          disabled: busy || !actionable,
          onClick: () => void apply(),
        },
        { label: "Cancel", role: "cancel" },
      ]}
      footerStart={
        commits && existing ? (
          <Checkbox
            checked={allowOverwrite}
            onChange={setAllowOverwrite}
            label={tx`Overwrite ${existing} existing files`}
          />
        ) : !commits && preview.suggestion ? (
          <Checkbox
            checked={preview.adjusted}
            onChange={(v) => void adjust(v)}
            label={tx`Restore under ${preview.suggestion}`}
          />
        ) : undefined
      }
    >
      <div className={styles.body}>
        <div className={styles.destination}>
          <T>Destination:</T> <span className={styles.path}>{preview.destination}</span>
        </div>
        {commits ? (
          <div className={styles.list} role="list" aria-label={tx("Commits")}>
            {preview.commits.map((c, i) => (
              <div key={i} className={styles.commit} role="listitem">
                <div className={styles.subject}>
                  {i + 1}. {c.message.split("\n")[0]}
                  {c.refused && <span className={styles.refused}>{tx`refused: ${c.refused}`}</span>}
                </div>
                <div className={styles.meta}>
                  {c.authorName} &lt;{c.authorEmail}&gt; · {c.authorDate}
                </div>
                {c.files.map((f, j) => (
                  <div key={j} className={styles.file}>
                    <span className={styles.badge} data-change={f.change}>
                      {f.change}
                    </span>
                    <span className={styles.path}>{f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}</span>
                    {f.overwrites && <span className={styles.note}>{tx("overwrites")}</span>}
                    {f.reason && <span className={styles.note}>{f.reason}</span>}
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div className={styles.list} role="list" aria-label={tx("Files")}>
            {preview.files.map((f) => {
              const key = rowKey(f.action, f.index);
              const skip = f.action === "skip";
              return (
                <div key={`${f.action}${f.index}`} className={styles.row} role="listitem">
                  <Checkbox
                    checked={!skip && checked.has(key)}
                    disabled={skip}
                    onChange={() => toggle(key)}
                    label={f.path}
                  />
                  <span className={styles.badge} data-action={f.action}>
                    {tx(ACTION_LABEL[f.action] ?? f.action)}
                  </span>
                  {f.reason && <span className={styles.note}>{f.reason}</span>}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Actions

const VCS = "vcsAvailable";

/** Paths an action got as its argument: a path or a list of them. */
function pathsArg(arg: unknown): string[] {
  if (typeof arg === "string") return [arg];
  if (Array.isArray(arg)) return arg.filter((p): p is string => typeof p === "string");
  return [];
}

export function registerClipActions(): () => void {
  const actions: Action[] = [
    {
      id: "clip.copyFiles",
      title: "ClipCode: Copy to Clipboard",
      category: "Git",
      icon: "copy",
      description: "Copy the selected files and folders in the ClipCode format",
      run: ({ arg }) => {
        const paths = pathsArg(arg);
        if (paths.length) void copyClip({ kind: "files", paths });
      },
    },
    {
      id: "clip.copyChanges",
      title: "ClipCode: Copy Full Source",
      category: "Git",
      icon: "copy",
      when: VCS,
      run: ({ arg }) => {
        const a = (arg ?? {}) as { paths?: string[]; side?: "working" | "staged" | "unstaged" };
        const paths = a.paths ?? [];
        if (paths.length) void copyClip({ kind: "changes", paths, side: a.side ?? "working" });
      },
    },
    {
      id: "clip.copyCommitFiles",
      title: "ClipCode: Copy Full Source",
      category: "Git",
      icon: "copy",
      when: VCS,
      run: ({ arg }) => {
        const source = commitFilesSource(commitsArg(arg));
        if (source) void copyClip(source);
      },
    },
    {
      id: "clip.copyLogChanges",
      title: "ClipCode: Copy Full Source",
      category: "Git",
      icon: "copy",
      when: VCS,
      hidden: true,
      run: ({ arg }) => {
        const a = arg as { commits: Commit[]; changes: LogChange[] } | undefined;
        const source = a && logChangesSource(a.commits, a.changes);
        if (source) void copyClip(source);
      },
    },
    {
      id: "clip.copyCommits",
      title: "Copy Commits",
      category: "Git",
      icon: "copy",
      description: "Copy the selected commits so snip-sync or OpenIDEA can replay them in another repository",
      when: VCS,
      run: ({ arg }) => {
        const source = commitsSource(commitsArg(arg));
        if (source) void copyClip(source);
      },
    },
    {
      id: "clip.paste",
      title: "ClipCode: Paste and Restore Files",
      category: "Git",
      icon: "paste",
      description: "Restore files or replay commits copied by ClipCode or snip-sync",
      run: ({ arg }) => {
        // The selected repository first (a workspace of several), as snip-sync pastes.
        const dest = pathsArg(arg)[0] ?? useVcs.getState().repo ?? useProject.getState().project?.root ?? null;
        void pasteClip(dest);
      },
    },
  ];
  return registerActions(actions);
}
