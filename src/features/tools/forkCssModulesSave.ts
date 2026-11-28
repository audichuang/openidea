/**
 * Fork (#291): enabling CSS Modules Kit saves tsconfig.json through the guarded save, which never writes
 * over a file changed on disk; a save nobody pressed Save for may not overwrite. Upstream's
 * (l0ng-ai/openidea#6345, v0.1.55) saves with `doc_save`, which overwrites; it stays behind this
 * switch, off by default. Tests flip it to cover upstream.
 */
export const forkCssModulesSave = { upstream: false };
