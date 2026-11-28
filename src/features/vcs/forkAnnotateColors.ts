/**
 * Fork: the Annotate gutter keeps the fork's Colors menu (next to Options; IntelliJ's new-UI ramp
 * `--vcs-annotate-N`; the mode saved as `vcs.git.annotateColors` for every window; Hide fades old lines).
 * Upstream's Options › Colors (l0ng-ai/openidea#6582, v0.1.55: localStorage, `--project-color-N` tints)
 * is the same feature and stays behind this switch, off by default. Tests flip it to cover upstream.
 */
export const forkAnnotateColors = { upstream: false };
