/**
 * Fork (#439): with several repositories the Branches pane lists each repository's branches under
 * its own row until the user turns Group by Repository off, as before v0.1.50. Upstream's merged
 * rows (l0ng-ai/openidea#4723) act on every repository of a row from one menu: Update and Push go
 * past the row's repositories and favorites go to the VCS repository. Tests flip it to cover upstream.
 */
export const forkBranchesPane = { upstreamMerged: false };
