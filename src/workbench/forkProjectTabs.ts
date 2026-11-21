/**
 * Fork (#434): New Tab opens the project through `window_open_project_tab`, which places the new
 * window in this window's group (screen, size, fullscreen Space) before it shows, and the Open
 * Project prompt keeps the fork's buttons. `upstream` runs upstream's New Tab instead (open a
 * window, then `window_group_join`); tests flip it to cover upstream.
 */
export const forkProjectTabs = { upstream: false };
