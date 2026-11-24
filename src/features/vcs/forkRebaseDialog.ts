/**
 * Fork: Interactively Rebase from Here opens the fork's virtualized plan dialog, as before the
 * rebase onto v0.1.51 (thousands of commits stay responsive; autosquash rows are ordered in the
 * dialog). Upstream's flow (l0ng-ai/openidea#5174: Git's own todo for autosquash and
 * `rebase.updateRefs`, otherwise its RebasePlanDialog) stays behind this flag. Unit tests flip
 * `upstream`; E2E tests, which drive the built app, set the localStorage key.
 */
export const forkRebaseDialog = { upstream: false };

export const UPSTREAM_REBASE_DIALOG_KEY = "openidea.fork.upstreamRebaseDialog";

export function upstreamRebaseDialog(): boolean {
  if (forkRebaseDialog.upstream) return true;
  try {
    return localStorage.getItem(UPSTREAM_REBASE_DIALOG_KEY) === "true";
  } catch {
    return false;
  }
}
