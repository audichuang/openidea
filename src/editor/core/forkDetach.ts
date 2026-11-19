/**
 * Fork (#397): "Open in New Window" on a project text tab keeps the full project window
 * (ClipCode, language features) instead of upstream's lightweight editor, whose tab handoff can
 * drop edits made before the aux window registers the document. Tests flip it to cover upstream.
 */
export const forkDetach = { lightweight: false };
