/**
 * Fork (#437): the Changes toolbar's Shelve button opens the Shelve Changes dialog (preview, pick the files, then
 * shelve), as before v0.1.50, instead of upstream's Shelve Silently (l0ng-ai/openidea#4620), which shelves the
 * active changelist at once. Shelve Silently keeps its shortcut and action. Tests flip it to cover upstream.
 */
export const forkShelveButton = { upstream: false };
