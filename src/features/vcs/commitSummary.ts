/** "3 added 1 modified 2 deleted" above the commit message, as IDEA's (pure). */
import type { FileStatus } from "@/bindings";
import { effectiveKind, kindOf } from "./model";

export interface CommitSummary {
  added: number;
  modified: number;
  deleted: number;
}

/**
 * What the commit would do to `files` (the ones it takes): with the staging area their
 * staged change, else the file's own. Unversioned files are added; renames count as modified.
 */
export function commitSummary(files: readonly FileStatus[], staging: boolean): CommitSummary {
  const out: CommitSummary = { added: 0, modified: 0, deleted: 0 };
  for (const fs of files) {
    const kind = staging && fs.staged ? kindOf(fs.staged) : effectiveKind(fs);
    if (!kind || kind === "ignored") continue;
    if (kind === "added" || kind === "untracked") out.added++;
    else if (kind === "deleted") out.deleted++;
    else out.modified++;
  }
  return out;
}
