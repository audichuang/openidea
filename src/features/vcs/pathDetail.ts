/**
 * Splits a relative directory for middle truncation: `head` gives way first, then `tail` (the
 * last segment with its slash). A single segment, or a head too short to keep a character
 * beside its ellipsis, is all tail.
 */
export function splitPathDetail(dir: string): { head: string; tail: string } {
  const i = dir.lastIndexOf("/");
  return i <= 2 ? { head: "", tail: dir } : { head: dir.slice(0, i), tail: dir.slice(i) };
}

/**
 * `dir` as one string no wider than `width` (per `measure`), cut in the middle:
 * "src-tauri/src/commands" reads "src-t…/commands", then "s…/comm…" when narrower, and "…"
 * when nothing else fits. The head keeps one character before the last segment is cut.
 */
export function fitPathDetail(dir: string, width: number, measure: (text: string) => number): string {
  if (measure(dir) <= width) return dir;
  const { head, tail } = splitPathDetail(dir);
  const headChars = Array.from(head);
  const tailChars = Array.from(tail);
  // Largest count in [min, max] whose candidate fits; widths grow with the count.
  const longest = (min: number, max: number, candidate: (n: number) => string): string | null => {
    let lo = min;
    let hi = max;
    let best: string | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const text = candidate(mid);
      if (measure(text) <= width) {
        best = text;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return best;
  };
  const cutHead = longest(1, headChars.length - 1, (n) => `${headChars.slice(0, n).join("")}…${tail}`);
  if (cutHead) return cutHead;
  const prefix = headChars.length ? `${headChars[0]}…` : "";
  // A cut last segment keeps its slash and one character.
  const minTail = tail.startsWith("/") ? 2 : 1;
  return longest(minTail, tailChars.length - 1, (n) => `${prefix}${tailChars.slice(0, n).join("")}…`) ?? "…";
}
