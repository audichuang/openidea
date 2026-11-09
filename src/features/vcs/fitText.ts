/**
 * Fitting a name or path into a width by shortening it in JS, on whole characters. The CSS ways of eliding
 * (`text-overflow`, a pixel clip) either leave a gap before the text that follows or draw half a letter, so the
 * shortened string, ellipsis included, is chosen here and rendered as plain text.
 */

/** Measures the rendered width of a string in px. */
export type Measure = (text: string) => number;

/** How much of a long file name's end stays visible when its middle is elided. */
const TAIL = 14;

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/** The user-perceived characters of `s`: a cut between them never splits a letter, an accent or an emoji. */
export function chars(s: string): string[] {
  return segmenter ? Array.from(segmenter.segment(s), (x) => x.segment) : Array.from(s);
}

/** A path as [folders with their trailing "/", file name]. */
export function splitDir(path: string): [string, string] {
  const i = path.lastIndexOf("/");
  return i < 0 ? ["", path] : [path.slice(0, i + 1), path.slice(i + 1)];
}

/** Folders as [first segment with its "/", the rest]: the rest elides first, the first segment stays. */
export function splitFirstSegment(dir: string): [string, string] {
  const i = dir.indexOf("/");
  return i < 0 ? [dir, ""] : [dir.slice(0, i + 1), dir.slice(i + 1)];
}

/** The largest n in [0, max] for which `fits(n)` holds (`fits` goes from true to false), or -1 if none does. */
function largest(max: number, fits: (n: number) => boolean): number {
  let lo = -1;
  let hi = max;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * `prefix` + `name`, with the name's middle replaced by "…" until the whole fits `avail`. The name's end
 * (its extension) stays; only when that alone is too wide does it lose characters from its front.
 */
export function fitName(prefix: string, name: string, avail: number, measure: Measure): string {
  if (measure(prefix + name) <= avail) return prefix + name;
  const cs = chars(name);
  if (cs.length < 2) return prefix + name;
  const tailLen = Math.min(TAIL, cs.length - 1);
  const tail = cs.slice(-tailLen);
  const headMax = cs.length - tailLen;
  const h = largest(headMax, (n) => measure(`${prefix}${cs.slice(0, n).join("")}…${tail.join("")}`) <= avail);
  if (h >= 0) return `${prefix}${cs.slice(0, h).join("")}…${tail.join("")}`;
  const t = largest(tailLen, (n) => measure(`${prefix}…${tail.slice(tailLen - n).join("")}`) <= avail);
  return `${prefix}…${tail.slice(tailLen - Math.max(t, 0)).join("")}`;
}

/**
 * A path fitted into `avail`: the folders shrink first (down to the first segment and an ellipsis), then the
 * file name's middle. The ellipsis is part of the returned string, directly against the text after it.
 */
export function fitPath(path: string, avail: number, measure: Measure): string {
  if (measure(path) <= avail) return path;
  const [dir, name] = splitDir(path);
  const [first, rest] = splitFirstSegment(dir);
  if (!rest) return fitName(dir, name, avail, measure);
  const rc = chars(rest);
  const k = largest(rc.length - 1, (n) => measure(`${first}${rc.slice(0, n).join("")}…/${name}`) <= avail);
  if (k >= 0) return `${first}${rc.slice(0, k).join("")}…/${name}`;
  return fitName(`${first}…/`, name, avail, measure);
}
