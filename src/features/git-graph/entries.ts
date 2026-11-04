/**
 * Rows of the graph: the loaded commits plus pseudo rows Git Graph Plus shows — the working
 * tree's uncommitted changes above HEAD and each stash right above the commit it was made on.
 */
import type { GraphStash, GraphWorkingState } from "@/bindings";
import type { GraphCommit } from "@/workbench/gitGraphBridge";

export type GraphEntry =
  | { kind: "commit"; id: string; parents: string[]; commit: GraphCommit }
  | { kind: "stash"; id: string; parents: string[]; stash: GraphStash; commit: GraphCommit }
  | { kind: "working"; id: string; parents: string[]; state: GraphWorkingState };

export const WORKING_ID = "*working*";

export const changeCount = (s: GraphWorkingState) => s.staged + s.unstaged + s.untracked + s.conflicted;

/** A stash as a commit row: its commit, with the base it was made on as the only parent. */
export function stashCommit(s: GraphStash, repo: string): GraphCommit {
  const summary = s.message;
  return {
    id: s.id,
    shortId: s.id.slice(0, 8),
    parents: [s.base],
    author: "",
    email: "",
    timeMs: s.timeMs,
    summary,
    message: summary,
    refs: [],
    repo,
  };
}

export function buildEntries(
  commits: readonly GraphCommit[],
  stashes: readonly GraphStash[],
  working: GraphWorkingState | null,
  headCommit: string | null,
  repo: string,
): GraphEntry[] {
  const loaded = new Set(commits.map((c) => c.id));
  const byBase = new Map<string, GraphStash[]>();
  for (const s of stashes) {
    if (!loaded.has(s.base) || loaded.has(s.id)) continue;
    byBase.set(s.base, [...(byBase.get(s.base) ?? []), s]);
  }
  const out: GraphEntry[] = [];
  if (working && changeCount(working) > 0 && headCommit && loaded.has(headCommit))
    out.push({ kind: "working", id: WORKING_ID, parents: [headCommit], state: working });
  for (const c of commits) {
    for (const s of byBase.get(c.id) ?? [])
      out.push({ kind: "stash", id: s.id, parents: [s.base], stash: s, commit: stashCommit(s, repo) });
    out.push({ kind: "commit", id: c.id, parents: c.parents, commit: c });
  }
  return out;
}

/** The layout input: pseudo rows link to their parent with a dashed edge. */
export const layoutInput = (entries: readonly GraphEntry[]) =>
  entries.map((e) =>
    e.kind === "commit" ? { id: e.id, parents: e.parents } : { id: e.id, parents: e.parents, dashed: [true] },
  );
