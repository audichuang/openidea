/**
 * Fork decision (#526): the Commit and Local Changes trees keep rows at the pane width, giving
 * way in order and cutting paths in the middle, so Stage / Unstage stay in reach. Upstream's
 * horizontal scroll (l0ng-ai/openidea#6121) stays behind this flag. Tests flip it to cover upstream.
 */
export const forkChangesScroll = { upstream: false };
