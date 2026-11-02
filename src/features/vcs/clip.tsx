/**
 * ClipCode / snip-sync clipboard transfer: copies files, changes, commits or a
 * pull request's changes as the text ClipCode (IntelliJ, VS Code) and snip-sync
 * restore, and pastes such text back after a preview. The payload is built and
 * applied by the backend (`ide-clip`); this module owns the clipboard and the UI.
 */
import { useState } from "react";
import type { ClipCopyResult, ClipCopySource, ClipPastePreview, ClipPasteResult, Commit } from "@/bindings";
import { readClipboardText } from "@/platform/clipboard";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { loadSettings, useProject } from "@/platform/project";
import { workflowSettings, type ClipCodeSettingsValid } from "@/platform/workflowSettings";
import { registerActions, type Action } from "@/platform/actions";
import { Checkbox, Dialog, T } from "@/ui";
import { copyText } from "@/ui/selectableText";
import { editorService, notifications, registerMenuGroup } from "@/workbench/contributions";
import { confirmDialog, openDialog, promptText } from "./dialogs";
import type { LogChange } from "./logChanges";
import { commitRepo } from "./multiRoot";
import { commitsArg } from "./historyActions";
import { refreshNow, useVcs } from "./store";
import styles from "./clip.module.css";

const grouped = (n: number) => n.toLocaleString("en-US");

/**
 * The ClipCode plugins' copy notification: what was copied and skipped, then the
 * clipboard's chars · lines · words · ~tokens; a warning from 1,000,000 tokens and an
 * error from 2,000,000 (pasting that much into a chat model fails).
 */
function notifyCopied(r: ClipCopyResult) {
  const parts: string[] = [];
  if (r.mode === "commits") {
    const { commits, files } = r;
    parts.push(tx`${commits} commits copied (${files} files).`);
    if (r.skipped) {
      const skipped = r.skipped;
      parts.push(tx`${skipped} files not copied (binary, not UTF-8 or a symlink).`);
    }
  } else {
    const files = r.files;
    if (r.skippedSize) {
      const skipped = r.skippedSize;
      parts.push(tx`${files} files copied (${skipped} skipped: size exceeded).`);
    } else parts.push(tx`${files} files copied.`);
    if (r.truncated) {
      const limit = r.fileLimit;
      parts.push(tx`File limit ${limit} reached.`);
    }
    if (r.skippedUnreadable) {
      const skipped = r.skippedUnreadable;
      parts.push(tx`${skipped} skipped: not UTF-8 text or unreadable.`);
    }
  }
  const [chars, lines, words, tokens] = [r.chars, r.lines, r.words, r.tokens].map(grouped);
  let body = tx`${chars} chars · ${lines} lines · ${words} words · ~${tokens} tokens.`;
  const level = r.tokens >= 2_000_000 ? "error" : r.tokens >= 1_000_000 ? "warning" : "info";
  if (level === "error") body += ` ${tx("Over 2,000,000 tokens.")}`;
  else if (level === "warning") body += ` ${tx("Over 1,000,000 tokens.")}`;
  if (!r.notify && level === "info") return;
  notifications().notify({ group: "clipcode", level, title: parts.join(" "), body });
}

/** Builds the payload for `source` and puts it on the clipboard, reporting what was copied. */
export async function copyClip(source: ClipCopySource): Promise<boolean> {
  let result;
  try {
    result = await call(commands.clipCopy(source));
  } catch (e) {
    notifications().notify({ group: "clipcode", level: "warning", title: "ClipCode copy failed", body: String(e) });
    return false;
  }
  await copyText(result.text);
  notifyCopied(result);
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
    notifications().notify({ group: "clipcode", level: "info", title: "The clipboard is empty" });
    return;
  }
  if (/^From [0-9a-f]{7,64} /.test(text)) return pasteBranchSeries(text);
  const preview = await loadPreview(text, dest ?? null, false);
  if (!preview) return;
  openDialog((close) => <PastePreviewDialog text={text} dest={dest ?? null} initial={preview} onClose={close} />);
}

async function loadPreview(text: string, dest: string | null, adjust: boolean): Promise<ClipPastePreview | null> {
  try {
    return await call(commands.clipPastePreview(text, dest, adjust, [...useVcs.getState().roots]));
  } catch (e) {
    notifications().notify({ group: "clipcode", level: "warning", title: "Nothing to paste", body: String(e) });
    return null;
  }
}

function reportPaste(r: ClipPasteResult, commits: boolean) {
  const created = r.commits.length;
  const title = commits
    ? tx`${created} commits created`
    : tx`Restored: ${r.created} created, ${r.overwritten} overwritten, ${r.deleted} deleted, ${r.skipped} skipped`;
  notifications().notify({
    group: "clipcode",
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
  const overwriteKeys = preview.files.filter((f) => f.action === "overwrite").map((f) => rowKey(f.action, f.index));
  const overwriteCount = overwriteKeys.length;
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
        const paths = editorService().openPaths?.() ?? [];
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
      run: ({ arg }) => {
        // The selected repository first (a workspace of several), as snip-sync pastes.
        const dest = pathsArg(arg)[0] ?? useVcs.getState().repo ?? useProject.getState().project?.root ?? null;
        void pasteClip(dest);
      },
    },
  ];
  const unregister = [
    registerActions(actions),
    // The plugin's EditorTabPopupMenu / ProjectViewPopupMenu entries.
    registerMenuGroup({
      id: "clipcode",
      menus: ["editorTab", "projectView"],
      order: 40,
      items: (menu, { paths }) => {
        const files = paths.filter((p) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p));
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
