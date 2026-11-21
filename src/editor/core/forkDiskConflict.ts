/**
 * Fork (#441): the "changed on disk" notification carries no buttons, as before v0.1.50. Upstream's
 * "Load Changes from Disk" (l0ng-ai/openidea#4707) stays on a notification that outlives the
 * conflict, and pressing it after a save and more typing discards that typing. Reload from Disk
 * still loads the disk version. Tests flip it to cover upstream.
 */
export const forkDiskConflict = { upstream: false };
