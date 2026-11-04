/** Loading the graph: pages of commits of the chosen branches, laid out as they arrive. */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Branch, GraphStash, GraphWorkingState } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { gitGraphBridge, type GitGraphRepoState, type GraphCommit } from "@/workbench/gitGraphBridge";

export const PAGE = 300;

export interface GraphFilters {
  /** Branches to show; empty: every branch. */
  branches: string[];
  /** Remote-tracking branches in the "every branch" view. */
  showRemotes: boolean;
}

interface Loaded {
  /** Repository and filters this state belongs to. */
  key: string;
  commits: GraphCommit[];
  branches: Branch[];
  loading: boolean;
  done: boolean;
  error: string | null;
}

export interface GraphData {
  commits: GraphCommit[];
  branches: Branch[];
  loading: boolean;
  done: boolean;
  error: string | null;
  loadMore: () => void;
  reload: () => void;
}

const EMPTY_STATE: GitGraphRepoState = { roots: [], repo: null, heads: {}, operations: {}, version: 0 };

let lastState: GitGraphRepoState = EMPTY_STATE;

function readState(): GitGraphRepoState {
  const next = gitGraphBridge()?.state() ?? EMPTY_STATE;
  const prev = lastState;
  if (
    prev.version !== next.version ||
    prev.roots !== next.roots ||
    prev.repo !== next.repo ||
    prev.heads !== next.heads ||
    prev.operations !== next.operations
  )
    lastState = next;
  return lastState;
}

const subscribeState = (fn: () => void) => gitGraphBridge()?.subscribe(fn) ?? (() => {});

/** The vcs feature's repository state, re-rendering on change. */
export function useRepoState(): GitGraphRepoState {
  return useSyncExternalStore(subscribeState, readState, readState);
}

/** Branch names the log walks from: none for every branch (HEAD, locals and remotes). */
export function logBranches(filters: GraphFilters, branches: readonly Branch[]): string[] {
  if (filters.branches.length) return filters.branches;
  if (filters.showRemotes) return [];
  return ["HEAD", ...branches.filter((b) => !b.remote).map((b) => b.name)];
}

const emptyLoaded = (key: string): Loaded => ({
  key,
  commits: [],
  branches: [],
  loading: true,
  done: false,
  error: null,
});

export function useGraphData(repo: string | null, filters: GraphFilters, version: number): GraphData {
  const key = `${repo ?? ""}\0${filters.showRemotes}\0${filters.branches.join("\0")}`;
  const [loaded, setLoaded] = useState<Loaded>(() => emptyLoaded(key));
  const [reloadKey, setReloadKey] = useState(0);
  /** The state the next page appends to; written only from callbacks. */
  const latest = useRef<Loaded>(loaded);

  /** Branch tips and tags the loaded graph reflects; a vcs refresh reloads only when they move. */
  const refs = useRef<string | null>(null);

  const fetchPage = useCallback(
    async (base: Loaded, preserve = false) => {
      if (!repo) return;
      const loadingState = { ...base, loading: true };
      latest.current = loadingState;
      // A reload in place keeps showing the old graph until the new one arrives.
      setLoaded((cur) => (preserve && cur.key === base.key ? { ...cur, loading: true } : loadingState));
      try {
        const skip = base.commits.length;
        const page = await call(
          commands.vcsLog(repo, {
            branch: null,
            branches: logBranches(filters, base.branches),
            path: null,
            author: null,
            text: null,
            skip,
            limit: PAGE,
            order: "topo",
          }),
        );
        if (latest.current !== loadingState) return;
        const tagged = page.map((c): GraphCommit => ({ ...c, repo }));
        const next: Loaded = {
          ...base,
          commits: skip ? [...base.commits, ...tagged] : tagged,
          loading: false,
          done: page.length < PAGE,
          error: null,
        };
        latest.current = next;
        setLoaded(next);
      } catch (e) {
        if (latest.current !== loadingState) return;
        const failed = { ...base, loading: false, error: String(e instanceof Error ? e.message : e) };
        latest.current = failed;
        setLoaded(failed);
      }
    },
    [repo, filters],
  );

  const load = useCallback(
    async (preserve: boolean, isLive: () => boolean) => {
      if (!repo) return;
      let branches: Branch[] = [];
      let tags: string[] = [];
      try {
        [branches, tags] = await Promise.all([call(commands.vcsBranches(repo)), call(commands.vcsTags(repo))]);
      } catch {
        /* The log still loads from HEAD. */
      }
      if (!isLive()) return;
      const signature = JSON.stringify([branches, tags]);
      if (preserve && signature === refs.current) return;
      refs.current = signature;
      await fetchPage({ ...emptyLoaded(key), branches }, preserve);
    },
    [repo, key, fetchPage],
  );

  useEffect(() => {
    let live = true;
    refs.current = null;
    void load(false, () => live);
    return () => {
      live = false;
    };
  }, [load, reloadKey]);

  // A vcs refresh (commit, checkout, fetch, branch or tag change…): reload when refs moved.
  useEffect(() => {
    let live = true;
    if (refs.current !== null) void load(true, () => live);
    return () => {
      live = false;
    };
  }, [version]);

  const loadMore = useCallback(() => {
    const cur = latest.current;
    if (cur.loading || cur.done || cur.key !== key) return;
    void fetchPage(cur, true);
  }, [fetchPage, key]);

  const current = repo && loaded.key === key ? loaded : emptyLoaded(key);
  return {
    commits: current.commits,
    branches: current.branches,
    loading: !!repo && current.loading,
    done: !repo || current.done,
    error: current.error,
    loadMore,
    reload: () => setReloadKey((k) => k + 1),
  };
}

/** Indexes of commits matching `query` (subject, message, author, email or hash prefix). */
export function findMatches(commits: readonly (GraphCommit | null)[], query: string): number[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: number[] = [];
  commits.forEach((c, i) => {
    if (!c) return;
    if (
      c.id.startsWith(q) ||
      c.message.toLowerCase().includes(q) ||
      c.author.toLowerCase().includes(q) ||
      c.email.toLowerCase().includes(q)
    )
      out.push(i);
  });
  return out;
}

export interface GraphExtras {
  stashes: GraphStash[];
  working: GraphWorkingState | null;
}

const NO_EXTRAS: GraphExtras = { stashes: [], working: null };

/** Stashes and the working tree's changes; refreshed on every vcs refresh (both are cheap). */
export function useGraphExtras(repo: string | null, version: number): GraphExtras {
  const [extras, setExtras] = useState<{ repo: string | null; value: GraphExtras }>({ repo: null, value: NO_EXTRAS });
  useEffect(() => {
    if (!repo) return;
    let live = true;
    void Promise.all([
      call(commands.graphStashes(repo)).catch((): GraphStash[] => []),
      call(commands.graphWorkingState(repo)).catch(() => null),
    ]).then(([stashes, working]) => {
      if (live) setExtras({ repo, value: { stashes, working } });
    });
    return () => {
      live = false;
    };
  }, [repo, version]);
  return extras.repo === repo ? extras.value : NO_EXTRAS;
}
