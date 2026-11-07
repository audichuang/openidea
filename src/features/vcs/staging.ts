/**
 * IDEA's staging area (Settings › Version Control › Git › "Enable staging area"):
 * the Commit tool window shows the index itself — Staged and Unstaged changes, a
 * partially staged file in both — instead of change lists with inclusion checkboxes,
 * and Commit commits exactly what is staged.
 */
import type { ChangeKind, FileStatus } from "@/bindings";
import { useWorkflowSettings, workflowSettings, type WorkflowSettings } from "@/platform/workflowSettings";
import { GROUP_LABEL, renamedFromPath, repoNodes, type ChangeNode, type CommitPlan, type GroupId } from "./changes";
import type { DiffData, DiffSide } from "./diffInput";
import { effectiveKind, kindOf, stripSlash } from "./model";

/** The staging area only replaces the Commit tool window (the non-modal commit interface), as in IDEA. */
const stagingOn = (w: WorkflowSettings) => w.vcs.git.stagingArea && w.vcs.commit.nonModal;

export const isStagingArea = () => stagingOn(workflowSettings());
export const useStagingArea = () => useWorkflowSettings(stagingOn);

/** Changes the index can hold on either side (not conflicts, untracked or ignored files). */
const indexed = (k: ChangeKind | null) => !!k && k !== "untracked" && k !== "ignored" && k !== "conflicted";

const conflicted = (fs: FileStatus) => fs.staged === "conflicted" || fs.unstaged === "conflicted";

/**
 * The groups a file shows under: a partially staged file is both staged and unstaged.
 * An unversioned file is unstaged too with `untrackedInUnstaged` (VS Code's two groups),
 * else in IDEA's own Unversioned Files.
 */
export function stagingGroups(fs: FileStatus, untrackedInUnstaged = false): GroupId[] {
  if (conflicted(fs)) return ["conflicts"];
  if (fs.unstaged === "ignored") return [];
  const out: GroupId[] = [];
  if (indexed(fs.staged)) out.push("staged");
  if (indexed(fs.unstaged)) out.push("unstaged");
  if (fs.unstaged === "untracked" && !fs.staged) out.push(untrackedInUnstaged ? "unstaged" : "unversioned");
  return out;
}

/** Files whose staged changes the next commit takes. */
export function stagedFiles(status: readonly FileStatus[]): FileStatus[] {
  return status.filter((fs) => !conflicted(fs) && indexed(fs.staged));
}

/** Commit with the staging area: the index as it is — nothing staged or unstaged first. */
export function stagingPlan(status: readonly FileStatus[]): CommitPlan {
  return { stage: [], exclude: [], included: stagedFiles(status), partial: [] };
}

const ORDER: GroupId[] = ["conflicts", "staged", "unstaged", "unversioned"];

/** A file's change on one side of the index (the tree colors it by that change, not the combined one). */
function sideKind(fs: FileStatus, group: GroupId) {
  if (group === "staged" && fs.staged) return kindOf(fs.staged);
  if (group === "unstaged" && fs.unstaged) return kindOf(fs.unstaged);
  return effectiveKind(fs) ?? "modified";
}

function withSide(nodes: ChangeNode[], group: GroupId): ChangeNode[] {
  for (const n of nodes) {
    if (n.type === "file" && n.files[0]) n.kind = sideKind(n.files[0], group);
    if (n.children) withSide(n.children, group);
  }
  return nodes;
}

/** IDEA's staging area names its groups "Staged" / "Unstaged", not "Group By › Staging State"'s "… Changes". */
const STAGING_LABEL: Record<GroupId, string> = { ...GROUP_LABEL, staged: "Staged", unstaged: "Unstaged" };

/** Merge Conflicts / Staged / Unstaged / Unversioned Files, each grouped by repository and directory. */
export function buildStagingTree(
  status: readonly FileStatus[],
  root: string,
  groupByDir: boolean,
  repos: readonly string[] = [],
  untrackedInUnstaged = false,
): ChangeNode[] {
  const byGroup = new Map<GroupId, FileStatus[]>();
  for (const fs of status)
    for (const g of stagingGroups(fs, untrackedInUnstaged)) {
      let list = byGroup.get(g);
      if (!list) byGroup.set(g, (list = []));
      list.push(fs);
    }
  const out: ChangeNode[] = [];
  for (const g of ORDER) {
    const files = byGroup.get(g);
    if (!files?.length) continue;
    const children = withSide(repoNodes(files, root, g, groupByDir, g, repos), g);
    out.push({ key: `group:${g}`, type: "group", label: STAGING_LABEL[g], group: g, children, files });
  }
  return out;
}

/** Absolute paths to unstage for `files`; a staged rename also unstages its source (the deletion half). */
export function unstagePaths(files: readonly FileStatus[]): string[] {
  const out: string[] = [];
  for (const fs of files) {
    if (!indexed(fs.staged)) continue;
    out.push(stripSlash(fs.path));
    const from = renamedFromPath(fs);
    if (from) out.push(from);
  }
  return out;
}

/** Absolute paths to stage for `files`: unstaged edits and unversioned files. */
export function stagePaths(files: readonly FileStatus[]): string[] {
  return files
    .filter((fs) => !conflicted(fs) && (indexed(fs.unstaged) || fs.unstaged === "untracked"))
    .map((fs) => stripSlash(fs.path));
}

const NONE = (label: string): DiffSide => ({ type: "text", text: "", label });
const INDEX: DiffSide = { type: "rev", rev: ":0" };

/** The diff of one side of the index: Staged = HEAD ↔ index; Unstaged = index ↔ working file. */
export function stagingDiffData(fs: FileStatus, group: GroupId): DiffData | null {
  const path = stripSlash(fs.path);
  if (group === "staged") {
    const from = renamedFromPath(fs);
    const left: DiffSide =
      fs.staged === "added"
        ? NONE("(does not exist)")
        : from && fs.renamedFrom
          ? { type: "rev", rev: "HEAD", path: from, label: `HEAD (${fs.renamedFrom})` }
          : { type: "rev", rev: "HEAD" };
    return { path, left, right: fs.staged === "deleted" ? NONE("(deleted)") : INDEX };
  }
  if (group === "unstaged")
    return {
      path,
      // An unversioned file has nothing in the index yet.
      left: fs.unstaged === "untracked" ? NONE("(does not exist)") : INDEX,
      right: fs.unstaged === "deleted" ? NONE("(deleted)") : { type: "worktree" },
    };
  return null;
}
