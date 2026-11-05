/**
 * Splits a relative directory for middle truncation: `head` may be cut with an ellipsis,
 * `tail` (the last segment with its slash) stays whole, so "src-tauri/src/commands" reads
 * "src-tauri/s…/commands" when narrow. A single segment is all head.
 */
export function splitPathDetail(dir: string): { head: string; tail: string } {
  const i = dir.lastIndexOf("/");
  return i <= 0 ? { head: dir, tail: "" } : { head: dir.slice(0, i), tail: dir.slice(i) };
}
