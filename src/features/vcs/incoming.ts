/**
 * Settings › Git › "Explicitly check for incoming commits on remotes": a quiet
 * background fetch (on project open, then every `incomingCheckInterval` minutes)
 * so the branch widget, the Branches popup and the Project view show incoming
 * commits. Every repository whose branch has an upstream is fetched, one after
 * another. `auto` stops checking a repository for the session after its first
 * failure (credentials needed, offline); `never` disables it.
 *
 * Settings › Git › "Fetch remotes automatically every N minutes" (fork, off by
 * default) takes the schedule over: every repository, with or without an upstream,
 * every `autoFetchMinutes`, whatever the incoming check says, retrying the ones that
 * failed. A streak of failed automatic fetches shows one warning.
 */
import { Channel } from "@tauri-apps/api/core";
import { call, commands, isTauri, nextRequestId } from "@/platform/ipc";
import { onWorkflowSettingsChange, workflowSettings, type GitSettingsValid } from "@/platform/workflowSettings";
import { notifications } from "@/workbench/contributions";
import { logConsole } from "./ops";
import { loadBranches, refreshNow, useVcs } from "./store";

export const FIRST_DELAY = 20_000;

export interface FetchPlan {
  /** Delay between fetches. */
  interval: number;
  /** Auto fetch (every repository, keeps going after failures) rather than the incoming check. */
  auto: boolean;
}

/** What the background fetch does under `git`; null: nothing. */
export function fetchPlan(
  git: Pick<GitSettingsValid, "autoFetch" | "autoFetchMinutes" | "incomingCheck" | "incomingCheckInterval">,
): FetchPlan | null {
  if (git.autoFetch) return { interval: git.autoFetchMinutes * 60_000, auto: true };
  if (git.incomingCheck === "never") return null;
  return { interval: git.incomingCheckInterval * 60_000, auto: false };
}

const plan = () => fetchPlan(workflowSettings().vcs.git);

/**
 * Fetches each of `roots` whose branch has an upstream (`auto`: every one), one at a time,
 * skipping those in `failed` (a repository that fails is added, its error to `errors`). Stops
 * when `stale()` turns true or a fetch / pull / push of the user's runs. Returns whether
 * anything was fetched.
 */
export async function fetchIncoming(
  roots: readonly string[],
  failed: Set<string>,
  stale: () => boolean = () => false,
  auto = false,
  errors: string[] = [],
): Promise<boolean> {
  let fetched = false;
  for (const root of roots) {
    if (stale() || useVcs.getState().remoteBusy) break;
    if (failed.has(root)) continue;
    if (!auto) {
      const info = await call(commands.vcsBranchInfo(root)).catch(() => null);
      if (!info?.upstream || stale() || useVcs.getState().remoteBusy) continue;
    }
    const channel = new Channel<string>();
    channel.onmessage = () => undefined;
    try {
      await call(commands.vcsRemote(root, nextRequestId(), { op: "fetch" }, channel));
      fetched = true;
    } catch (e) {
      failed.add(root);
      const message = e instanceof Error ? e.message : String(e);
      errors.push(message);
      logConsole(
        "info",
        auto
          ? `Automatic fetch of ${root} failed: ${message}`
          : `Checking for incoming commits in ${root} failed: ${message}`,
      );
    }
  }
  return fetched;
}

export function installIncomingCheck(): () => void {
  if (!isTauri()) return () => undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Repositories whose check failed; `auto` leaves them alone for the session. */
  let failed = new Set<string>();
  let root: string | null = null;
  /** Bumped when the project or the setting changes; a check started before stops. */
  let generation = 0;
  let running = false;
  let disposed = false;
  // A failing auto fetch warns once, until a fetch succeeds again.
  let warned = false;

  const schedule = (delay?: number) => {
    clearTimeout(timer);
    if (disposed) return;
    const p = plan();
    if (!p || !useVcs.getState().available) return;
    timer = setTimeout(() => void check(), delay ?? p.interval);
  };

  const check = async () => {
    // The check already running schedules the next one when it ends.
    if (running) return;
    running = true;
    const started = generation;
    try {
      const s = useVcs.getState();
      const p = plan();
      if (!s.available || !p) return;
      // `always` and auto fetch retry failed repositories on every check.
      const skip = p.auto || workflowSettings().vcs.git.incomingCheck === "always" ? new Set<string>() : failed;
      const roots = s.roots.length ? s.roots : s.root ? [s.root] : [];
      const errors: string[] = [];
      const fetched = await fetchIncoming(roots, skip, () => disposed || generation !== started, p.auto, errors);
      if (p.auto && !disposed && generation === started) {
        if (errors.length) {
          if (!warned)
            notifications().notify({
              group: "vcs",
              level: "warning",
              title: "Automatic fetch failed",
              body: errors.join("\n"),
            });
          warned = true;
        } else if (fetched) warned = false;
      }
      if (fetched && !disposed) {
        await refreshNow();
        if (useVcs.getState().branchesLoaded) void loadBranches().catch(() => undefined);
      }
    } finally {
      running = false;
      schedule(generation === started ? plan()?.interval : FIRST_DELAY);
    }
  };

  const restart = () => {
    generation++;
    failed = new Set();
    warned = false;
    schedule(FIRST_DELAY);
  };

  const unsubVcs = useVcs.subscribe((s, prev) => {
    if (s.root === root && s.available === prev.available) return;
    root = s.root;
    restart();
  });
  const unsubMode = onWorkflowSettingsChange(
    (w) => [w.vcs.git.incomingCheck, w.vcs.git.autoFetch, w.vcs.git.autoFetchMinutes],
    restart,
  );
  const unsubInterval = onWorkflowSettingsChange(
    (w) => w.vcs.git.incomingCheckInterval,
    () => {
      if (!running) schedule();
    },
  );
  root = useVcs.getState().root;
  schedule(FIRST_DELAY);
  return () => {
    disposed = true;
    clearTimeout(timer);
    unsubVcs();
    unsubMode();
    unsubInterval();
  };
}
