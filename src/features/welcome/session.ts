/**
 * "Reopen last project on startup" (IDEA: Settings › Appearance & Behavior ›
 * System Settings). The project open when the app last quit is remembered;
 * closing a project explicitly forgets it, so the next start shows the welcome screen.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { create } from "zustand";
import { commands, isCancelled, isTauri, type Settings } from "@/platform/ipc";
import { closeProject, openProject, startupLaunchHandled, startupProjectDecided, useProject } from "@/platform/project";
import { connectRemote, projectLocation, resolveRemoteLocation, useRemoteProgress } from "@/platform/remote";
import { notifications } from "@/workbench/contributions";

const SESSION_KEY = "openidea.session.openProject";
const PREF_KEY = "openidea.welcome.reopenLastProject";
/** Per-window (sessionStorage): the project this window shows, restored when the webview reloads. */
const WINDOW_KEY = "openidea.window.project";

function windowProject(value?: string | null): string | null {
  try {
    if (value === undefined) return sessionStorage.getItem(WINDOW_KEY);
    if (value === null) sessionStorage.removeItem(WINDOW_KEY);
    else sessionStorage.setItem(WINDOW_KEY, value);
  } catch {
    /* storage unavailable */
  }
  return null;
}

/** Tells a window it now records the remembered project (src-tauri/src/windows.rs). */
const SESSION_OWNER_EVENT = "openidea://session-owner";

function isMainWindow(): boolean {
  return !isTauri() || getCurrentWindow().label === "main";
}

/** This window took the remembered project over from `main`, which closed. */
let ownsSession = false;

/**
 * Only `main` keeps the remembered project while it is open: restored window-group members open
 * theirs after `main`, and would otherwise make `main` reopen a group member instead of its own
 * project. Once `main` closes, a window left takes over.
 */
function rememberSession(value: string | null) {
  if (isMainWindow() || ownsSession) write(SESSION_KEY, value);
}

/** Follows the backend's hand-over of the remembered project to this (non-`main`) window. */
function followSessionOwner(): () => void {
  if (isMainWindow()) return () => {};
  let disposed = false;
  let unlisten: (() => void) | undefined;
  // Opened after every window closed, or reloaded after taking over: it already holds it.
  void commands
    .windowOwnsSession()
    .then((owns) => {
      if (owns && !disposed) ownsSession = true;
    })
    .catch(() => {});
  void getCurrentWindow()
    .listen(SESSION_OWNER_EVENT, () => {
      ownsSession = true;
      // What this window shows now is what the next launch reopens.
      write(SESSION_KEY, projectLocation(useProject.getState().project?.root));
    })
    .then((off) => {
      if (disposed) off();
      else unlisten = off;
    });
  return () => {
    disposed = true;
    unlisten?.();
  };
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

export const useSession = create<{ reopenPref: boolean; reopening: string | null }>(() => ({
  reopenPref: read(PREF_KEY) !== "false",
  reopening: null,
}));

export function setReopenPreference(on: boolean) {
  write(PREF_KEY, on ? "true" : "false");
  useSession.setState({ reopenPref: on });
}

/** `general.reopenLastProject` from settings when present, else the local preference. */
export function reopenEnabled(settings: Settings | null | undefined, pref: boolean): boolean {
  const general = (settings as { general?: { reopenLastProject?: unknown } } | null | undefined)?.general;
  return typeof general?.reopenLastProject === "boolean" ? general.reopenLastProject : pref;
}

/**
 * Keeps the remembered project in sync with `main` (or the window that took over once it
 * closed): set while a project is open, cleared on explicit close. Every window remembers its
 * own project for a webview reload.
 */
export function trackSession(): () => void {
  const root = projectLocation(useProject.getState().project?.root);
  if (root) {
    rememberSession(root);
    windowProject(root);
  }
  const stopFollowing = isTauri() ? followSessionOwner() : () => {};
  const stopTracking = useProject.subscribe((s, prev) => {
    // A remote project is remembered by its location (`ssh://…`), reopened over SSH.
    const now = projectLocation(s.project?.root);
    const before = projectLocation(prev.project?.root);
    if (now === before) return;
    if (now) rememberSession(now);
    else if (before && !useSession.getState().reopening) rememberSession(null);
    if (now || !useSession.getState().reopening) windowProject(now);
  });
  return () => {
    stopFollowing();
    stopTracking();
  };
}

export function lastSessionProject(): string | null {
  return read(SESSION_KEY);
}

let attempted = false;
let reopenEpoch = 0;

/** Cancels an in-flight startup project reopen or remote connection and returns to the Welcome screen. */
export function cancelReopen() {
  reopenEpoch++;
  rememberSession(null);
  windowProject(null);
  useSession.setState({ reopening: null });
  // A local open can't be interrupted; `reopen` closes it again once it finishes.
  if (useRemoteProgress.getState().location) {
    useRemoteProgress.setState({ progress: null, location: null });
    useProject.setState({ opening: false, openingPath: null });
    if (isTauri()) void commands.remoteDisconnect().catch(() => {});
  }
}

/** On startup: reopens the project that was open at exit. Robust against a missing folder. */
export async function reopenLastProject(): Promise<void> {
  if (attempted || !isTauri()) return;
  attempted = true;
  try {
    await reopenStartupProject();
  } finally {
    // Reopened or not, this window's startup project is known (window groups wait for it).
    startupProjectDecided();
  }
}

async function reopenStartupProject(): Promise<void> {
  // An explicit launch wins over both this window's and the last session's project.
  await startupLaunchHandled();
  const startup = useProject.getState();
  if (startup.project || startup.lightEdit) return;
  // A reloaded webview gets back its own project, whatever window it is.
  const own = windowProject();
  if (own) {
    await reopen(own);
    return;
  }
  // Secondary windows open the project they were created for (features/app/windows.ts).
  if (!isMainWindow()) return;
  const path = lastSessionProject();
  if (!path) return;
  let settings: Settings | null = null;
  try {
    settings = await commands.settingsGet();
  } catch {
    /* use the local preference */
  }
  if (!reopenEnabled(settings, useSession.getState().reopenPref)) return;
  const current = useProject.getState();
  if (current.project || current.lightEdit) return;
  await reopen(path);
}

async function reopen(path: string) {
  const epoch = ++reopenEpoch;
  const name = path.slice(path.lastIndexOf("/") + 1) || path;
  // Clear before connecting so force-quitting a hung reopen does not loop on the next launch.
  rememberSession(null);
  windowProject(null);
  useSession.setState({ reopening: path });
  try {
    const remote = await resolveRemoteLocation(path);
    if (remote) await connectRemote(remote.target, remote.path);
    else {
      const project = await openProject(path);
      // Cancelled while opening: close it again unless the user has opened another project since.
      if (reopenEpoch !== epoch) {
        if (useProject.getState().project?.root === project.root) await closeProject().catch(() => {});
        return;
      }
    }
    const opened = projectLocation(useProject.getState().project?.root) ?? path;
    rememberSession(opened);
    windowProject(opened);
  } catch (e) {
    rememberSession(null);
    windowProject(null);
    if (reopenEpoch !== epoch || isCancelled(e)) return;
    notifications().notify({
      level: "warning",
      title: `Cannot reopen ${name}`,
      body: e instanceof Error ? e.message : String(e),
      key: "welcome.reopen",
    });
  } finally {
    if (reopenEpoch === epoch) useSession.setState({ reopening: null });
  }
}

/** Tests only. */
export function _resetSessionForTests() {
  attempted = false;
  reopenEpoch = 0;
  ownsSession = false;
  useSession.setState({ reopening: null, reopenPref: read(PREF_KEY) !== "false" });
}
