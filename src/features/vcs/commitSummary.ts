/** "3 added 1 modified 2 deleted" above the commit message, as IDEA's (pure). */
import type { FileStatus } from "@/bindings";
import { type CheckState, checkOf } from "./changes";
import { type EffectiveKind, effectiveKind, kindOf } from "./model";

export interface CommitSummary {
  added: number;
  modified: number;
  deleted: number;
}

/**
 * What the commit would do to `files` (the ones it takes, as `planCommit` includes them).
 * `checks`: the inclusion checkboxes, which decide each file's part (`planCommit`); `null`
 * with the staging area, which commits the index as it is. Unversioned files are added;
 * renames count as modified.
 */
export function commitSummary(
  files: readonly FileStatus[],
  checks: ReadonlyMap<string, CheckState> | null,
): CommitSummary {
  const out: CommitSummary = { added: 0, modified: 0, deleted: 0 };
  for (const fs of files) {
    const kind = committedKind(fs, checks ? checkOf(fs, checks) : "staged");
    if (!kind || kind === "ignored") continue;
    if (kind === "added" || kind === "untracked") out.added++;
    else if (kind === "deleted") out.deleted++;
    else out.modified++;
  }
  return out;
}

function committedKind(fs: FileStatus, check: CheckState): EffectiveKind | null {
  // Only the index's change is committed.
  if (check === "staged") return fs.staged ? kindOf(fs.staged) : null;
  // A staged deletion whose file is back: staging it all re-adds the file.
  if (check === "all" && fs.staged === "deleted" && fs.unstaged === "untracked") return "modified";
  return effectiveKind(fs);
}
