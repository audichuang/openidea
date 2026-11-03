/**
 * Quiet background fetches, so the branch widget, Branches popup and Git log show
 * what is on the remotes:
 *   - Settings › Git › "Fetch remotes automatically every N minutes" (off by default):
 *     every repository of the project, on that interval, retrying after failures.
 *   - otherwise "Explicitly check for incoming commits on remotes": the selected
 *     repository on project open, then every 15 minutes. `auto` stops for the session
 *     after the first failure (credentials needed, offline); `never` disables it.
 * Failures go to the VCS console; an automatic fetch also shows one warning per
 * streak of failures.
 */
import { Channel } from "@tauri-apps/api/core";
import { call, commands, isTauri, nextRequestId } from "@/platform/ipc";
import { onWorkflowSettingsChange, workflowSettings, type GitSettingsValid } from "@/platform/workflowSettings";
import { notifications } from "@/workbench/contributions";
import { allRepos, logConsole } from "./ops";
import { currentRepo, loadBranches, refreshNow, useVcs } from "./store";

export const FIRST_DELAY = 20_000;
export const INCOMING_INTERVAL = 15 * 60_000;

export interface FetchPlan {
  /** Delay between fetches. */
  interval: number;
  /** Auto fetch (every repository, keeps going after failures) rather than the incoming check. */
  auto: boolean;
}

/** What the background fetch does under `git`; null: nothing (disabled, or `auto` gave up). */
export function fetchPlan(
  git: Pick<GitSettingsValid, "autoFetch" | "autoFetchMinutes" | "incomingCheck">,
  incomingFailed: boolean,
): FetchPlan | null {
  if (git.autoFetch) return { interval: git.autoFetchMinutes * 60_000, auto: true };
  if (git.incomingCheck === "never" || (git.incomingCheck === "auto" && incomingFailed)) return null;
  return { interval: INCOMING_INTERVAL, auto: false };
}

export function installIncomingCheck(): () => void {
  if (!isTauri()) return () => undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let incomingFailed = false;
  // A failing auto fetch warns once, until a fetch succeeds again.
  let warned = false;
  let root: string | null = null;

  const plan = () => fetchPlan(workflowSettings().vcs.git, incomingFailed);

  const schedule = (delay?: number) => {
    clearTimeout(timer);
    const p = plan();
    if (!p || !useVcs.getState().available) return;
    timer = setTimeout(() => void check(), delay ?? p.interval);
  };

  const check = async () => {
    const p = plan();
    if (!p) return;
    const s = useVcs.getState();
    if (!s.available || s.remoteBusy || (!p.auto && !s.branch?.upstream)) return schedule();
    const channel = new Channel<string>();
    channel.onmessage = () => undefined;
    const failures: string[] = [];
    for (const repo of p.auto ? allRepos() : [currentRepo()]) {
      try {
        await call(commands.vcsRemote(repo, nextRequestId(), { op: "fetch" }, channel));
      } catch (e) {
        failures.push(e instanceof Error ? e.message : String(e));
      }
    }
    if (failures.length) {
      const message = failures.join("\n");
      if (p.auto) {
        logConsole("info", `Automatic fetch failed: ${message}`);
        if (!warned)
          notifications().notify({ group: "vcs", level: "warning", title: "Automatic fetch failed", body: message });
        warned = true;
      } else {
        incomingFailed = true;
        logConsole("info", `Checking for incoming commits failed: ${message}`);
      }
    } else warned = false;
    // Some repositories may have fetched even when another failed.
    await refreshNow();
    if (useVcs.getState().branchesLoaded) void loadBranches().catch(() => undefined);
    schedule();
  };

  const unsubVcs = useVcs.subscribe((s, prev) => {
    if (s.root === root && s.available === prev.available) return;
    root = s.root;
    incomingFailed = false;
    warned = false;
    schedule(FIRST_DELAY);
  });
  const unsubSettings = onWorkflowSettingsChange(
    (w) => [w.vcs.git.incomingCheck, w.vcs.git.autoFetch, w.vcs.git.autoFetchMinutes],
    () => {
      incomingFailed = false;
      warned = false;
      schedule(FIRST_DELAY);
    },
  );
  root = useVcs.getState().root;
  schedule(FIRST_DELAY);
  return () => {
    clearTimeout(timer);
    unsubVcs();
    unsubSettings();
  };
}
