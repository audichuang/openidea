/**
 * ClipCode / snip-sync clipboard transfer: copies files, changes, commits or a
 * pull request's changes as the text ClipCode (IntelliJ, VS Code) and snip-sync
 * restore, and pastes such text back after a preview. The payload is built and
 * applied by the backend (`ide-clip`); this module owns the clipboard and the UI.
 */
import { useMemo, useState } from "react";
import clsx from "clsx";
import type {
  ClipCopyResult,
  ClipCopySource,
  ClipPasteFile,
  ClipPastePreview,
  ClipPasteResult,
  Commit,
} from "@/bindings";
import { readClipboardText } from "@/platform/clipboard";
import { tx } from "@/platform/i18n";
import { call, commands, IpcError } from "@/platform/ipc";
import { loadSettings, useProject } from "@/platform/project";
import { workflowSettings, type ClipCodeSettingsValid } from "@/platform/workflowSettings";
import { registerActions, type Action } from "@/platform/actions";
import { Checkbox, Dialog, Icon, T, Tree } from "@/ui";
import { copyText } from "@/ui/selectableText";
import { editorService, notifications, registerMenuGroup } from "@/workbench/contributions";
import { confirmDialog, openDialog, promptText } from "./dialogs";
import type { LogChange } from "./logChanges";
import { logOptions } from "./logOptions";
import { useGitLog } from "./logStore";
import { commitRepo } from "./multiRoot";
import { commitsArg } from "./historyActions";
import { saveAll } from "./ops";
import { refreshNow, useVcs } from "./store";
import { ClipPastePane } from "./ClipPastePane";
import {
  askNonText,
  isCorruptRow,
  isUnchanged,
  pasteRowNote,
  pasteRowTitle,
  replayFileNote,
  resolveNonText,
  skipReasonText,
  visibleName,
} from "./clipNonText";
import { isElided, NameText, PathText } from "./PathText";
import { buildPasteTree, fileKey, filesUnder, rowKey, type PasteNode } from "./clipPasteTree";
import styles from "./clip.module.css";

const grouped = (n: number) => n.toLocaleString("en-US");

/**
 * The ClipCode plugins' copy notification: what was copied and skipped, then the
 * clipboard's chars · lines · words · ~tokens; a warning from 1,000,000 tokens and an
 * error from 2,000,000 (pasting that much into a chat model fails).
 */
function notifyCopied(r: ClipCopyResult, included = false) {
  const parts: string[] = [];
  if (r.mode === "commits") {
    const { commits, files } = r;
    parts.push(tx`${commits} commits copied (${files} files).`);
    if (r.skipped) {
      const skipped = r.skipped;
      parts.push(tx`Not copied (non-text files, not UTF-8 or a symlink): ${skipped}.`);
    }
  } else {
    const files = r.files;
    if (r.skippedSize) {
      const skipped = r.skippedSize;
      parts.push(tx`${files} files copied (${skipped} skipped: size exceeded).`);
    } else parts.push(tx`${files} files copied.`);
    if (r.truncated) {
      const limit = r.fileLimit;
      // The count describes what Include copies, so it only fits a result nobody was asked about or one
      // that included the non-text files.
      const leftOut = r.nonText.count === 0 || included ? r.nonText.limitLeftOut : 0;
      if (leftOut > 0) {
        const more = r.nonText.limitLeftOutAtLeast ? `${leftOut}+` : String(leftOut);
        parts.push(tx`File limit ${limit} reached, files left out: ${more}.`);
      } else parts.push(tx`File limit ${limit} reached.`);
    }
    if (r.nonTextCopied) {
      const carried = r.nonTextCopied;
      parts.push(tx`Non-text files copied as Base64: ${carried}.`);
    }
    if (r.skippedUnreadable) {
      const skipped = r.skippedUnreadable;
      // After Include no non-text file was left out for being non-text, so only unreadable ones remain.
      parts.push(included ? tx`Unreadable: ${skipped}.` : tx`Skipped (non-text file or unreadable): ${skipped}.`);
    }
    if (r.skippedUnportable) {
      const skipped = r.skippedUnportable;
      parts.push(tx`Name not portable: ${skipped}.`);
    }
    if (r.skippedSymlinkDirs) {
      const skipped = r.skippedSymlinkDirs;
      parts.push(tx`Symlinked folder not followed: ${skipped}.`);
    }
  }
  const [chars, lines, words, tokens] = [r.chars, r.lines, r.words, r.tokens].map(grouped);
  let body = tx`${chars} chars · ${lines} lines · ${words} words · ~${tokens} tokens.`;
  const level = r.tokens >= 2_000_000 ? "error" : r.tokens >= 1_000_000 ? "warning" : "info";
  if (level === "error") body += ` ${tx("Over 2,000,000 tokens.")}`;
  else if (level === "warning") body += ` ${tx("Over 1,000,000 tokens.")}`;
  if (r.mode !== "commits") body += namedSkips(r);
  if (!r.notify && level === "info") return;
  notifications().notify({ group: "clipcode", level, title: parts.join(" "), body });
}

/** One line per refused category, naming the first few paths (files mode). */
function namedSkips(r: ClipCopyResult): string {
  let out = "";
  const lists: [string[], (names: string) => string][] = [
    [r.skippedUnreadablePaths, (names) => tx`Unreadable: ${names}`],
    [r.skippedUnportablePaths, (names) => tx`Name not portable: ${names}`],
    [r.skippedSymlinkDirPaths, (names) => tx`Symlinked folder: ${names}`],
  ];
  for (const [paths, line] of lists) {
    if (!paths.length) continue;
    const shown = paths.slice(0, 3);
    const rest = paths.length - shown.length;
    out += `\n${line(shown.map(visibleName).join(", "))}`;
    if (rest > 0) out += ` ${tx`and ${rest} more`}`;
  }
  return out;
}

/** Builds the payload for `source` and puts it on the clipboard, reporting what was copied. */
export async function copyClip(source: ClipCopySource): Promise<boolean> {
  let result: ClipCopyResult;
  try {
    result = await call(commands.clipCopy(source, "exclude"));
  } catch (e) {
    // A commit with no net file changes is not a failure (IntelliJ: information, clipboard untouched).
    if (e instanceof IpcError && e.data?.type === "noNetChanges") {
      notifications().notify({ group: "clipcode", level: "info", title: e.message });
      return false;
    }
    notifications().notify({ group: "clipcode", level: "warning", title: "ClipCode copy failed", body: String(e) });
    return false;
  }
  const first = result;
  const chosen = await resolveNonText(result, askNonText, async () => {
    try {
      return await call(commands.clipCopy(source, "include"));
    } catch (e) {
      notifications().notify({ group: "clipcode", level: "warning", title: "ClipCode copy failed", body: String(e) });
      return null;
    }
  });
  if (!chosen) return false;
  result = chosen;
  // A files copy that kept no file is Nothing to copy, even when a size placeholder fills the text.
  if (result.files === 0 && (result.mode === "files" || result.text === "")) {
    // Not a failure: name what was refused (a symlinked folder, a non-portable name) so the user sees why.
    const named = namedSkips(result).trim();
    notifications().notify({
      group: "clipcode",
      level: "warning",
      title: "Nothing to copy",
      body: named || undefined,
    });
    return false;
  }
  await copyText(result.text);
  notifyCopied(result, result !== first);
  return true;
}

const repoOf = (c: Commit) => commitRepo(c) ?? useVcs.getState().repo ?? useVcs.getState().root ?? "";

/**
 * The loaded log's `parents` are not the commits' real ones: No Merges and the date filter hide
 * commits and rewrite the parents of the shown ones past them (like git's parent rewriting).
 */
function logRewritesParents(): boolean {
  const date = useGitLog.getState().filters.date;
  return logOptions().noMerges || date != null;
}

/**
 * True when `cs` (newest first) is one first-parent chain: each commit's first parent is the
 * next one. Never true while the log rewrites parents, since an unselected commit may sit between.
 */
export function isFirstParentChain(cs: readonly Commit[]): boolean {
  if (logRewritesParents()) return false;
  return cs.every((c, i) => i === cs.length - 1 || c.parents[0] === cs[i + 1]!.id);
}

/**
 * Copy Full Source of commits (newest first): one commit's files; a contiguous first-parent
 * chain as the range from the oldest commit's parent (the empty tree for a root commit); any
 * other selection as the union of what each selected commit changed, so unselected commits
 * in between are left out.
 */
export function commitFilesSource(cs: readonly Commit[], paths: string[] = []): ClipCopySource | null {
  if (!cs.length) return null;
  const repo = repoOf(cs[0]!);
  const tip = cs[0]!.id;
  if (cs.length === 1) return { kind: "commitFiles", repo, rev: tip, paths };
  if (!isFirstParentChain(cs)) return { kind: "commitList", repo, revs: cs.map((c) => c.id), paths };
  const base = cs[cs.length - 1]!.parents[0];
  return base ? { kind: "range", repo, base, tip, paths } : { kind: "rootRange", repo, tip, paths };
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

/**
 * Where a paste lands: files restore under the project root wherever the paste was
 * invoked (ClipCode's PasteAndRestoreFilesAction always resolves from the project, and
 * copies are spelled relative to it), commits replay into the selected repository.
 */
export interface PasteTarget {
  dest: string | null;
  repo: string | null;
}

export const pasteTarget = (): PasteTarget => ({
  dest: useProject.getState().project?.root ?? null,
  repo: currentRepoPath() || null,
});

/** ClipCode: Paste and Restore Files — previews the clipboard payload, then writes what is confirmed. */
export async function pasteClip(target: PasteTarget = pasteTarget()) {
  const text = await readClipboardText();
  if (!text.trim()) {
    notifications().notify({ group: "clipcode", level: "info", title: "The clipboard is empty" });
    return;
  }
  if (/^From [0-9a-f]{7,64} /.test(text)) return pasteBranchSeries(text);
  // Save dirty editors first: the preview snapshots the targets' freshness, and the blur autosave
  // when the dialog takes focus would otherwise change them and fail Restore's revalidation.
  await saveAll();
  const preview = await loadPreview(text, target, false);
  if (!preview) return;
  openDialog((close) => <PastePreviewDialog text={text} target={target} initial={preview} onClose={close} />);
}

async function loadPreview(text: string, target: PasteTarget, adjust: boolean): Promise<ClipPastePreview | null> {
  try {
    return await call(commands.clipPastePreview(text, target.dest, target.repo, adjust, [...useVcs.getState().roots]));
  } catch (e) {
    notifications().notify({ group: "clipcode", level: "warning", title: "Nothing to paste", body: String(e) });
    return null;
  }
}

export function reportPaste(r: ClipPasteResult, commits: boolean) {
  const created = r.commits.length;
  const title = commits
    ? tx`${created} commits created`
    : tx`Restored: ${r.created} created, ${r.overwritten} overwritten, ${r.deleted} deleted, ${r.skipped} skipped`;
  const lines = [
    ...r.notCreated.map((c) => {
      const [number, subject, reason] = [c.number, c.subject, skipReasonText(c.reason)];
      return tx`Commit ${number} (${subject}) not created: ${reason}`;
    }),
    ...r.errors,
  ];
  if (r.unchanged) {
    const unchanged = r.unchanged;
    lines.push(tx`Non-text files already identical, left unchanged: ${unchanged}.`);
  }
  if (r.corruptNonText.length) {
    const shown = r.corruptNonText.slice(0, 3).join(", ");
    const count = r.corruptNonText.length;
    lines.push(tx`Corrupt non-text files skipped (${count}): ${shown}`);
  }
  notifications().notify({
    group: "clipcode",
    level: r.errors.length || r.notCreated.length || r.corruptNonText.length ? "warning" : "info",
    title,
    body: lines.length ? lines.join("\n") : undefined,
  });
}

const ACTION_LABEL: Record<string, string> = {
  create: "Create",
  overwrite: "Overwrite",
  delete: "Delete",
  skip: "Skip",
};

function CheckMark({
  checked,
  indeterminate,
  disabled,
  label,
  onToggle,
}: {
  checked: boolean;
  indeterminate: boolean;
  disabled: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <span
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
      aria-disabled={disabled}
      aria-label={label}
      className={clsx(styles.check, (checked || indeterminate) && styles.checkOn)}
      onMouseDown={(e) => {
        // Toggling does not move the selection, as in the commit tree.
        if (e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        if (!disabled) onToggle();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {indeterminate ? <Icon name="minus" size={10} /> : checked ? <Icon name="check" size={10} /> : null}
    </span>
  );
}

/** Rows on until chosen otherwise: new files, deletions and unchanged targets (never overwrites). */
const defaultChecked = (f: ClipPasteFile) => f.action === "create" || f.action === "delete" || isUnchanged(f);

/** Folders open, and the first file to restore selected, so the pane shows something at once. */
function initialSelection(files: readonly ClipPasteFile[]): string | null {
  const first = files.find((f) => f.action !== "skip") ?? files[0];
  return first ? fileKey(first) : null;
}

function folderKeys(nodes: readonly PasteNode[]): string[] {
  return nodes.flatMap((n) => (n.children ? [n.key, ...folderKeys(n.children)] : []));
}

export function PastePreviewDialog({
  text,
  target,
  initial,
  onClose,
}: {
  text: string;
  target: PasteTarget;
  initial: ClipPastePreview;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState(initial);
  // Overwrites are off until chosen, as in ClipCode; new files and deletions are on.
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(initial.files.filter(defaultChecked).map((f) => rowKey(f.action, f.index))),
  );
  const [allowOverwrite, setAllowOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const tree = useMemo(() => buildPasteTree(preview.files), [preview.files]);
  const [selectedKey, setSelectedKey] = useState(() => initialSelection(initial.files));
  const selectedFile = preview.files.find((f) => fileKey(f) === selectedKey) ?? null;
  const toggleFiles = (files: readonly ClipPasteFile[]) =>
    setChecked((s) => {
      const keys = files.filter((f) => f.action !== "skip").map((f) => rowKey(f.action, f.index));
      const on = !keys.every((k) => s.has(k));
      const next = new Set(s);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  const commits = preview.mode === "commits";
  // An identical non-text target is left untouched: it is no overwrite and needs no permission.
  const overwriteKeys = preview.files
    .filter((f) => f.action === "overwrite" && !isUnchanged(f))
    .map((f) => rowKey(f.action, f.index));
  const overwriteCount = overwriteKeys.length;
  const existing = preview.commits.reduce((n, c) => n + c.files.filter((f) => f.overwrites).length, 0);

  const adjust = async (on: boolean) => {
    const next = await loadPreview(text, target, on);
    if (!next) return;
    setPreview(next);
    setSelectedKey(initialSelection(next.files));
    setChecked(new Set(next.files.filter(defaultChecked).map((f) => rowKey(f.action, f.index))));
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
      notifications().notify({ group: "clipcode", level: "error", title: "Paste failed", body: String(e) });
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
      width={commits ? 720 : 960}
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
        commits ? (
          existing ? (
            <Checkbox
              checked={allowOverwrite}
              onChange={setAllowOverwrite}
              label={tx`Overwrite ${existing} existing files`}
            />
          ) : undefined
        ) : (
          <>
            {overwriteKeys.length > 0 && (
              <Checkbox
                checked={overwriteKeys.every((k) => checked.has(k))}
                onChange={(on) =>
                  setChecked((s) => {
                    const next = new Set(s);
                    for (const k of overwriteKeys) {
                      if (on) next.add(k);
                      else next.delete(k);
                    }
                    return next;
                  })
                }
                label={tx`Overwrite all ${overwriteCount} existing files`}
              />
            )}
            {preview.suggestion && (
              <Checkbox
                checked={preview.adjusted}
                onChange={(v) => void adjust(v)}
                label={tx`Restore under ${preview.suggestion}`}
              />
            )}
          </>
        )
      }
    >
      <div className={clsx(styles.body, !commits && styles.bodyTall)}>
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
                    {f.reason === "CORRUPT_NON_TEXT" ? (
                      <span className={styles.badge} data-action="corrupt" title={tx("Corrupt non-text file")}>
                        {tx("Corrupt")}
                      </span>
                    ) : (
                      <span className={styles.badge} data-change={f.change}>
                        {f.change}
                      </span>
                    )}
                    <PathText path={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path} />
                    {f.overwrites && <span className={styles.note}>{tx("overwrites")}</span>}
                    {replayFileNote(f) && <span className={styles.note}>{replayFileNote(f)}</span>}
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div className={styles.split}>
            <div className={styles.treePane}>
              <Tree<PasteNode>
                roots={tree}
                getKey={(n) => n.key}
                getLabel={(n) => n.name}
                getChildren={(n) => n.children}
                isExpandable={(n) => !!n.children}
                defaultExpanded={folderKeys(tree)}
                selected={new Set(selectedKey ? [selectedKey] : [])}
                onSelectionChange={(_, lead) => {
                  if (lead?.file) setSelectedKey(lead.key);
                }}
                aria-label={tx("Files")}
                renderNode={(n) => {
                  const files = filesUnder(n);
                  const keys = files.filter((f) => f.action !== "skip").map((f) => rowKey(f.action, f.index));
                  const on = keys.filter((k) => checked.has(k)).length;
                  return (
                    <span className={styles.nodeRow}>
                      <CheckMark
                        checked={keys.length > 0 && on === keys.length}
                        indeterminate={on > 0 && on < keys.length}
                        disabled={keys.length === 0}
                        label={n.file ? tx`Restore ${n.file.path}` : tx`Restore the files in ${n.name}`}
                        onToggle={() => toggleFiles(files)}
                      />
                      <span
                        className={styles.nodeName}
                        data-action={n.file?.action}
                        data-elided={isElided(n.name) ? "" : undefined}
                        title={
                          n.file && isCorruptRow(n.file) ? `${n.file.path}\n${pasteRowTitle(n.file)}` : n.file?.path
                        }
                      >
                        <NameText name={n.name} />
                      </span>
                      {n.file && pasteRowNote(n.file) && (
                        <span className={styles.nodeNote} title={pasteRowTitle(n.file) ?? undefined}>
                          {pasteRowNote(n.file)}
                        </span>
                      )}
                      {n.file ? (
                        isCorruptRow(n.file) ? (
                          <span
                            className={styles.badge}
                            data-action="corrupt"
                            title={pasteRowTitle(n.file) ?? undefined}
                          >
                            {tx("Corrupt")}
                          </span>
                        ) : (
                          <span
                            className={styles.badge}
                            data-action={isUnchanged(n.file) ? "unchanged" : n.file.action}
                          >
                            {tx(isUnchanged(n.file) ? "Unchanged" : (ACTION_LABEL[n.file.action] ?? n.file.action))}
                          </span>
                        )
                      ) : (
                        <span className={styles.count}>{files.length}</span>
                      )}
                    </span>
                  );
                }}
              />
            </div>
            <ClipPastePane previewId={preview.id} file={selectedFile} />
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Branch series (ClipCode for VS Code)

const currentRepoPath = () => useVcs.getState().repo ?? useVcs.getState().root ?? "";

/** Copy Branch Commits: `branch` since its fork point from main / master / develop… (or its entire history). */
export async function copyBranchSeries(branch: string, full: boolean) {
  try {
    const r = await call(commands.clipCopyBranchSeries(currentRepoPath(), branch, null, full));
    await copyText(r.text);
    const { commits } = r;
    const base = r.base?.slice(0, 8);
    notifications().notify({
      group: "clipcode",
      level: "info",
      title: base
        ? tx`Copied ${commits} commits from ${branch}. Restoring needs commit ${base} on the other side.`
        : tx`Copied ${commits} commits from ${branch}, self-contained: restores into any repository.`,
    });
  } catch (e) {
    notifications().notify({
      group: "clipcode",
      level: "warning",
      title: "Nothing copied",
      body: String(e),
      actions: full ? undefined : [{ label: "Copy Entire History", run: () => void copyBranchSeries(branch, true) }],
    });
  }
}

/** Paste Branch Commits: restores the clipboard's mbox as a new branch (`git am --3way`). */
async function pasteBranchSeries(text: string) {
  const name = await promptText({
    title: "Paste Branch Commits",
    label: "New branch name",
    okLabel: "Restore",
  });
  if (!name?.value.trim()) return;
  const restore = async (onHead: boolean): Promise<void> => {
    try {
      const r = await call(commands.clipPasteBranchSeries(currentRepoPath(), text, name.value.trim(), onHead));
      const { branch, commits } = r;
      notifications().notify({
        group: "clipcode",
        level: "info",
        title: tx`Restored ${commits} commits as the branch ${branch}.`,
      });
      void refreshNow();
    } catch (e) {
      const message = String(e);
      if (!onHead && message.includes("not in this repository")) {
        const ok = await confirmDialog({
          title: "Base Commit Missing",
          message,
          okLabel: "Try on Current HEAD",
        });
        if (ok) return restore(true);
        return;
      }
      notifications().notify({
        group: "clipcode",
        level: "error",
        title: "Paste Branch Commits failed",
        body: message,
      });
    }
  };
  await restore(false);
}

// ---------------------------------------------------------------------------
// Ignore When Copying

/**
 * ClipCode: Ignore When Copying (IntelliJ): adds (or re-enables) an exclude path rule
 * per selected path, project-relative when inside the project, and switches the
 * exclude rules on (include rules off when filtering was off), as the plugin does.
 */
export function withIgnoredPaths(
  c: ClipCodeSettingsValid,
  paths: readonly string[],
  root: string | null,
): ClipCodeSettingsValid {
  const rules = [...c.filterRules];
  for (const path of paths) {
    const value = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
    const at = rules.findIndex((r) => r.type === "PATH" && r.action === "EXCLUDE" && r.value === value);
    if (at >= 0) rules[at] = { ...rules[at]!, enabled: true };
    else rules.push({ type: "PATH", action: "EXCLUDE", value, enabled: true });
  }
  return {
    ...c,
    useFilters: true,
    useExcludeFilters: true,
    useIncludeFilters: c.useFilters ? c.useIncludeFilters : false,
    filterRules: rules,
  };
}

async function ignorePaths(paths: readonly string[]) {
  const root = useProject.getState().project?.root ?? null;
  const next = withIgnoredPaths(workflowSettings().vcs.clipCode, paths, root);
  await call(commands.settingsSet("project", "vcs.clipCode", JSON.stringify(next)));
  await loadSettings();
  const count = paths.length;
  notifications().notify({
    group: "clipcode",
    level: "info",
    title: tx`Ignored ${count} selected paths when copying with ClipCode.`,
  });
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

/** Local filesystem paths only: not `jdt://` or other virtual documents. */
function isFilesystemPath(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
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
        let paths = pathsArg(arg);
        // From the command palette: the focused editor's file.
        if (!paths.length) {
          const active = editorService().activePath();
          if (active && isFilesystemPath(active)) paths = [active];
        }
        if (!paths.length) {
          notifications().notify({ group: "clipcode", level: "info", title: "No files selected." });
          return;
        }
        void copyClip({ kind: "files", paths });
      },
    },
    {
      id: "clip.copyChanges",
      title: "ClipCode: Copy Full Source",
      category: "Git",
      icon: "copy",
      when: VCS,
      // Only its context menus pass the selection, so it is not offered for a shortcut.
      hidden: true,
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
      // Only its context menus pass the selection, so it is not offered for a shortcut.
      hidden: true,
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
      id: "clip.copyBranchSeries",
      title: "ClipCode: Copy Branch Commits",
      category: "Git",
      icon: "copy",
      when: VCS,
      run: ({ arg }) => {
        const branch = (arg as { branch?: string } | undefined)?.branch ?? useVcs.getState().branch?.head;
        if (branch) void copyBranchSeries(branch, false);
      },
    },
    {
      id: "clip.copyBranchSeriesFull",
      title: "ClipCode: Copy Branch Commits (Entire History)",
      category: "Git",
      icon: "copy",
      when: VCS,
      run: ({ arg }) => {
        const branch = (arg as { branch?: string } | undefined)?.branch ?? useVcs.getState().branch?.head;
        if (branch) void copyBranchSeries(branch, true);
      },
    },
    {
      id: "clip.copyOpenTabs",
      title: "ClipCode: Copy All Open Tabs",
      category: "Git",
      icon: "copy",
      run: () => {
        const paths = (editorService().openPaths?.() ?? []).filter(isFilesystemPath);
        if (!paths.length) {
          notifications().notify({ group: "clipcode", level: "info", title: "No open tabs found to copy." });
          return;
        }
        void copyClip({ kind: "files", paths });
      },
    },
    {
      id: "clip.ignorePaths",
      title: "ClipCode: Ignore When Copying",
      category: "Git",
      run: ({ arg }) => {
        const paths = pathsArg(arg);
        if (paths.length) void ignorePaths(paths);
      },
    },
    {
      id: "clip.paste",
      title: "ClipCode: Paste and Restore Files",
      category: "Git",
      icon: "paste",
      description: "Restore files or replay commits copied by ClipCode or snip-sync",
      // Files restore under the project root wherever this is invoked (a Project view
      // folder included), as in ClipCode; commits replay into the selected repository.
      run: () => void pasteClip(),
    },
  ];
  const unregister = [
    registerActions(actions),
    // The plugin's EditorTabPopupMenu / ProjectViewPopupMenu entries.
    registerMenuGroup({
      id: "clipcode",
      menus: ["editorTab", "projectView", "editor"],
      order: 40,
      items: (menu, { paths }) => {
        const files = paths.filter(isFilesystemPath);
        // The plugin's CutCopyPasteGroup entries, acting on the current file.
        if (menu === "editor") {
          return files.length
            ? [
                { kind: "action" as const, action: "clip.copyFiles", arg: files },
                { kind: "action" as const, action: "clip.paste" },
              ]
            : [];
        }
        return [
          ...(menu === "editorTab"
            ? [{ kind: "action" as const, action: "clip.copyOpenTabs", label: "ClipCode: Copy All Open Tabs" }]
            : []),
          ...(files.length ? [{ kind: "action" as const, action: "clip.ignorePaths", arg: files }] : []),
        ];
      },
    }),
  ];
  return () => unregister.forEach((u) => u());
}
