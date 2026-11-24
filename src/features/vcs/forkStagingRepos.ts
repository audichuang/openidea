/**
 * Fork: with the staging area and several repositories, every repository row carries the fork's
 * checkbox (`stagingExcludedRoots`), Commit All included, and the tree always groups by repository.
 * Upstream's staged-repository selection (`excludedStagedRepos`, only with Group By › Repository and
 * two or more repositories with staged changes) replaced it on the rebase onto v0.1.51; it stays
 * behind this flag. Tests flip it to cover upstream.
 */
export const forkStagingRepos = { upstream: false };
