/**
 * Splits a relative directory for middle truncation: `head` gives way first (keeping a couple
 * of characters), then `tail` (the last segment with its slash), each with an ellipsis, so
 * "src-tauri/src/commands" reads "src-tauri/s…/commands", then "s…/comm…" when narrow.
 * A single segment, or a head too short to keep a character beside its ellipsis, is all tail.
 */
export function splitPathDetail(dir: string): { head: string; tail: string } {
  const i = dir.lastIndexOf("/");
  return i <= 2 ? { head: "", tail: dir } : { head: dir.slice(0, i), tail: dir.slice(i) };
}
