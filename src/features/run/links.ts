/**
 * Clickable locations in run output: compiler diagnostics and stack traces for
 * common toolchains, plus URLs. Positions are 1-based as printed; consumers
 * convert to the IDE's 0-based lines.
 */

export interface FileTarget {
  /** As printed (relative, absolute or a bare file name). */
  path: string;
  line?: number;
  col?: number;
  /**
   * `path`: resolve against the run directory; `name`: a file name from a JVM
   * stack frame — look it up in the project (`path` then is the file under its
   * package directory, `com/acme/OrderController.kt`, when the frame names the class);
   * `rubyTest`: a Minitest test with no file in its output — `className` is its class, `path` its
   * method name — found by searching the project (`rubyTests.ts`).
   */
  resolve: "path" | "name" | "rubyTest";
  /** JVM frames: the class's binary name (`com.acme.OrderController$Inner`). */
  className?: string;
}

/**
 * The target of a JVM stack frame `at com.acme.Foo.bar(Foo.kt:22)`: the file
 * under its package directory, so frames resolve by fully qualified class name
 * (as in IDEA), not by a bare file name that several packages may share.
 */
export function jvmFrameTarget(className: string | undefined, file: string, line: number | undefined): FileTarget {
  const pkg = className?.includes(".") ? className.slice(0, className.lastIndexOf(".")).replace(/\./g, "/") : "";
  return {
    path: pkg ? `${pkg}/${file}` : file,
    line,
    resolve: "name",
    ...(className ? { className } : {}),
  };
}

export type OutputLink =
  | { kind: "url"; start: number; end: number; url: string }
  | { kind: "file"; start: number; end: number; target: FileTarget };

export interface TextWindow {
  start: number;
  end: number;
}

const num = (s: string | undefined) => (s ? Number(s) : undefined);

// All link matchers anchor on a fixed delimiter or bounded suffix so scanning
// stays strictly linear even on multi-kilobyte lines with no matches.
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/g;
const PYTHON_RE = /File "([^"]+)", line (\d+)/g;
const JVM_FRAME_RE = /\(([\w$.-]+\.(?:java|kt|kts|scala|groovy|clj)):(\d+)\)/g;
const NODE_SUFFIX_RE = /(\.[A-Za-z]\w{0,9}):(\d+):(\d+)/g;
const GENERIC_SUFFIX_RE = /(\.[A-Za-z]\w{0,9})(?::\[?(\d+)(?::(\d+)|,(\d+)\])?|\((\d+)(?:,(\d+))?\))/g;

function isWord(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

function isAsciiLetter(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isSlash(c: number): boolean {
  return c === 47 || c === 92;
}

function isJvmClassChar(c: number): boolean {
  return isWord(c) || c === 36;
}

function isJvmMethodChar(c: number): boolean {
  return isWord(c) || c === 36 || c === 60 || c === 62 || c === 45;
}

function isPathSegChar(c: number): boolean {
  return isWord(c) || c === 46 || c === 64 || c === 43 || c === 45;
}

function isGenericBoundaryBlock(c: number): boolean {
  return isWord(c) || c === 47 || c === 46 || c === 126 || c === 45;
}

/** Extracts `com.acme.Foo` from `…com.acme.Foo.bar(` immediately before `parenIdx`. */
function jvmClassBefore(text: string, parenIdx: number): string | undefined {
  let methodStart = parenIdx;
  while (methodStart > 0 && isJvmMethodChar(text.charCodeAt(methodStart - 1))) methodStart--;
  if (methodStart === parenIdx || methodStart === 0 || text.charCodeAt(methodStart - 1) !== 46) return undefined;
  const dotIdx = methodStart - 1;
  let pos = dotIdx;
  let classStart = dotIdx;
  for (;;) {
    let i = pos;
    while (i > 0 && isJvmClassChar(text.charCodeAt(i - 1))) i--;
    if (i === pos) break;
    classStart = i;
    if (i > 0 && text.charCodeAt(i - 1) === 46) pos = i - 1;
    else break;
  }
  return classStart < dotIdx ? text.slice(classStart, dotIdx) : undefined;
}

/**
 * Finds the leftmost start index (>= `minStart`) of a valid path ending at `dotIdx`,
 * matching `(?:[A-Za-z]:[\\/]|~?\/|\.{1,2}\/)?(?:[\w.@+\-]+[\\/])*[\w@+\-][\w.@+\-]*`,
 * or -1 if no valid stem precedes `dotIdx`.
 */
function findPathStart(text: string, dotIdx: number, minStart: number): number {
  let segStart = dotIdx;
  while (segStart > minStart && isPathSegChar(text.charCodeAt(segStart - 1))) segStart--;
  if (segStart === dotIdx) return -1;
  if (text.charCodeAt(segStart) === 46) {
    let stemStart = segStart + 1;
    while (stemStart < dotIdx && text.charCodeAt(stemStart) === 46) stemStart++;
    return stemStart < dotIdx ? stemStart : -1;
  }
  let pos = segStart;
  while (pos > minStart && isSlash(text.charCodeAt(pos - 1))) {
    const slashIdx = pos - 1;
    let seg = slashIdx;
    while (seg > minStart && isPathSegChar(text.charCodeAt(seg - 1))) seg--;
    if (seg < slashIdx) {
      pos = seg;
      continue;
    }
    if (
      slashIdx - 2 >= minStart &&
      text.charCodeAt(slashIdx - 1) === 58 &&
      isAsciiLetter(text.charCodeAt(slashIdx - 2))
    ) {
      pos = slashIdx - 2;
    } else if (text.charCodeAt(slashIdx) === 47) {
      pos = slashIdx - 1 >= minStart && text.charCodeAt(slashIdx - 1) === 126 ? slashIdx - 1 : slashIdx;
    }
    break;
  }
  return pos;
}

function trimUrl(url: string): string {
  let end = url.length;
  let open = 0;
  let close = 0;
  for (let i = 0; i < end; i++) {
    const c = url.charCodeAt(i);
    if (c === 40) open++;
    else if (c === 41) close++;
  }
  while (end > 0) {
    const last = url[end - 1]!;
    if (".,;:!?'\"".includes(last)) {
      end--;
      continue;
    }
    if (last === ")" && open < close) {
      close--;
      end--;
      continue;
    }
    break;
  }
  return end === url.length ? url : url.slice(0, end);
}

/** Merges sorted non-overlapping `added` links into sorted non-overlapping `existing` links. */
function mergeLinks(existing: OutputLink[], added: OutputLink[]): OutputLink[] {
  if (added.length === 0) return existing;
  if (existing.length === 0) return added;
  const out: OutputLink[] = [];
  let i = 0;
  let j = 0;
  while (i < existing.length && j < added.length) {
    if (existing[i]!.start <= added[j]!.start) out.push(existing[i++]!);
    else out.push(added[j++]!);
  }
  while (i < existing.length) out.push(existing[i++]!);
  while (j < added.length) out.push(added[j++]!);
  return out;
}

/** Linear overlap filter for sorted candidate links against sorted `existing` links. */
function makeOverlapFilter(existing: readonly OutputLink[]): (s: number, e: number) => boolean {
  if (existing.length === 0) return () => true;
  let cursor = 0;
  return (s: number, e: number) => {
    while (cursor < existing.length && existing[cursor]!.end <= s) cursor++;
    return cursor >= existing.length || existing[cursor]!.start >= e;
  };
}

const EMPTY_LINKS: OutputLink[] = [];
const MAX_CACHE_ENTRIES = 1_024;
const MAX_CACHE_CHARS = 2 * 1024 * 1024;
const linkCache = new Map<string, OutputLink[]>();
let cachedChars = 0;

function cacheLinks(text: string, links: OutputLink[]): OutputLink[] {
  if (text.length > MAX_CACHE_CHARS) return links;
  while (linkCache.size >= MAX_CACHE_ENTRIES || cachedChars + text.length > MAX_CACHE_CHARS) {
    const oldest = linkCache.keys().next().value;
    if (oldest === undefined) break;
    linkCache.delete(oldest);
    cachedChars -= oldest.length;
  }
  linkCache.set(text, links);
  cachedChars += text.length;
  return links;
}

function scanOutputLinks(text: string): OutputLink[] {
  const hasColon = text.includes(":");
  const hasParen = text.includes("(");
  const hasDot = text.includes(".");
  const hasPython = text.includes('File "');
  if (!hasColon && !hasParen && !hasPython) return EMPTY_LINKS;

  let links: OutputLink[] = [];

  if (hasColon && text.includes("://")) {
    URL_RE.lastIndex = 0;
    for (let m = URL_RE.exec(text); m; m = URL_RE.exec(text)) {
      const url = trimUrl(m[0]);
      links.push({ kind: "url", start: m.index, end: m.index + url.length, url });
    }
  }

  if (hasPython) {
    const free = makeOverlapFilter(links);
    const added: OutputLink[] = [];
    PYTHON_RE.lastIndex = 0;
    for (let m = PYTHON_RE.exec(text); m; m = PYTHON_RE.exec(text)) {
      const start = m.index;
      const end = start + m[0].length;
      if (free(start, end)) {
        added.push({ kind: "file", start, end, target: { path: m[1]!, line: num(m[2]), resolve: "path" } });
      }
    }
    links = mergeLinks(links, added);
  }

  if (hasParen && hasColon && hasDot) {
    const free = makeOverlapFilter(links);
    const added: OutputLink[] = [];
    JVM_FRAME_RE.lastIndex = 0;
    for (let m = JVM_FRAME_RE.exec(text); m; m = JVM_FRAME_RE.exec(text)) {
      const parenIdx = m.index;
      const file = m[1]!;
      const lineStr = m[2]!;
      const start = parenIdx + 1;
      const end = start + file.length + 1 + lineStr.length;
      if (free(start, end)) {
        added.push({
          kind: "file",
          start,
          end,
          target: jvmFrameTarget(jvmClassBefore(text, parenIdx), file, num(lineStr)),
        });
      }
    }
    links = mergeLinks(links, added);
  }

  if (hasColon && hasDot) {
    const free = makeOverlapFilter(links);
    const added: OutputLink[] = [];
    NODE_SUFFIX_RE.lastIndex = 0;
    let minStart = 0;
    for (let m = NODE_SUFFIX_RE.exec(text); m; m = NODE_SUFFIX_RE.exec(text)) {
      const dotIdx = m.index;
      const extEnd = dotIdx + m[1]!.length;
      const end = dotIdx + m[0].length;
      const pathStart = findPathStart(text, dotIdx, minStart);
      if (pathStart < 0) continue;
      let start = pathStart;
      let filePathStart = pathStart;
      if (pathStart >= minStart + 7 && text.startsWith("file://", pathStart - 7)) {
        start = pathStart - 7;
      } else if (
        text.charCodeAt(pathStart) === 47 &&
        pathStart + 1 < dotIdx &&
        pathStart >= minStart + 6 &&
        text.startsWith("file://", pathStart - 6)
      ) {
        start = pathStart - 6;
        filePathStart = pathStart + 1;
      }
      minStart = end;
      if (free(start, end)) {
        added.push({
          kind: "file",
          start,
          end,
          target: { path: text.slice(filePathStart, extEnd), line: num(m[2]), col: num(m[3]), resolve: "path" },
        });
      }
    }
    links = mergeLinks(links, added);
  }

  if (hasDot && (hasColon || hasParen)) {
    const free = makeOverlapFilter(links);
    const added: OutputLink[] = [];
    GENERIC_SUFFIX_RE.lastIndex = 0;
    let minStart = 0;
    for (let m = GENERIC_SUFFIX_RE.exec(text); m; m = GENERIC_SUFFIX_RE.exec(text)) {
      const dotIdx = m.index;
      const extEnd = dotIdx + m[1]!.length;
      const end = dotIdx + m[0].length;
      const pathStart = findPathStart(text, dotIdx, minStart);
      if (pathStart < 0) continue;
      minStart = end;
      if (pathStart > 0 && isGenericBoundaryBlock(text.charCodeAt(pathStart - 1))) continue;
      if (free(pathStart, end)) {
        added.push({
          kind: "file",
          start: pathStart,
          end,
          target: {
            path: text.slice(pathStart, extEnd),
            line: num(m[2] ?? m[5]),
            col: num(m[3] ?? m[4] ?? m[6]),
            resolve: "path",
          },
        });
      }
    }
    links = mergeLinks(links, added);
  }

  return links.length === 0 ? EMPTY_LINKS : links;
}

/** Finds non-overlapping links in `text`; earlier (more specific) patterns win. */
export function findOutputLinks(text: string): OutputLink[] {
  if (!text) return EMPTY_LINKS;
  const cached = linkCache.get(text);
  if (cached) {
    // Refresh recency for LRU eviction.
    linkCache.delete(text);
    linkCache.set(text, cached);
    return cached;
  }
  return cacheLinks(text, scanOutputLinks(text));
}

/** Monospace column quantization and overscan for horizontal windowing. */
const HORIZONTAL_BUCKET_COLS = 64;
const HORIZONTAL_OVERSCAN_COLS = 64;
/** Fallback 1ch bounds (in em) when layout width cannot be measured (e.g. jsdom). */
const MIN_MONO_CHAR_EM = 0.5;
const MAX_MONO_CHAR_EM = 0.65;
const PROBE_CHARS = 100;

export interface HorizontalWindowOptions {
  /** Measured `1ch` advance width in CSS px; falls back to conservative bounds around `fontSizePx`. */
  charWidthPx?: number | null;
  /** Horizontal padding (in CSS px) before column 0 of the line text. */
  paddingLeftPx?: number;
}

/**
 * Measures the rendered `1ch` advance width of `el`'s font with a temporary zero-footprint
 * probe (no `scrollWidth` impact). Returns `null` when layout geometry is unavailable.
 */
export function measureMonoCharWidth(el: HTMLElement): number | null {
  const doc = el.ownerDocument;
  if (!doc) return null;
  const host = doc.createElement("span");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText =
    "position:absolute;top:0;left:0;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none;";
  const probe = doc.createElement("span");
  probe.style.cssText = "display:inline-block;white-space:pre;";
  probe.textContent = "0".repeat(PROBE_CHARS);
  host.appendChild(probe);
  el.appendChild(host);
  const width = probe.getBoundingClientRect().width;
  host.remove();
  return Number.isFinite(width) && width > 0 ? width / PROBE_CHARS : null;
}

/**
 * Quantized visible column range `[start, end)` for a non-wrapped console viewport,
 * or `null` when the viewport has not been measured yet. Quantization avoids re-rendering
 * rows on small horizontal scrolls while keeping inline decorations bounded on wide lines.
 */
export function horizontalColumnWindow(
  scrollLeft: number,
  clientWidth: number,
  fontSizePx: number,
  options?: HorizontalWindowOptions,
): TextWindow | null {
  if (clientWidth <= 0) return null;
  const measured = options?.charWidthPx;
  const hasMeasured = typeof measured === "number" && Number.isFinite(measured) && measured > 0;
  const minCharWidth = hasMeasured ? measured : Math.max(1, fontSizePx * MIN_MONO_CHAR_EM);
  const maxCharWidth = hasMeasured ? measured : Math.max(1, fontSizePx * MAX_MONO_CHAR_EM);
  const padLeft = Math.max(0, options?.paddingLeftPx ?? 0);
  const leftPx = Math.max(0, scrollLeft - padLeft);
  const rightPx = Math.max(leftPx, scrollLeft + clientWidth - padLeft);
  const firstCol = Math.floor(leftPx / maxCharWidth / HORIZONTAL_BUCKET_COLS) * HORIZONTAL_BUCKET_COLS;
  const lastCol = Math.ceil(rightPx / minCharWidth / HORIZONTAL_BUCKET_COLS) * HORIZONTAL_BUCKET_COLS;
  return {
    start: Math.max(0, firstCol - HORIZONTAL_OVERSCAN_COLS),
    end: lastCol + HORIZONTAL_OVERSCAN_COLS,
  };
}

function isWideCodePoint(c: number): boolean {
  return (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1faff) ||
    (c >= 0x20000 && c <= 0x3fffd)
  );
}

/** Converts a visual column window `[startCol, endCol)` into UTF-16 indices in `text`. */
export function visibleCharWindow(text: string, startCol: number, endCol: number, tabSize = 4): TextWindow {
  if (startCol <= 0 && text.length <= endCol) return { start: 0, end: text.length };
  let col = 0;
  let start = startCol <= 0 ? 0 : text.length;
  let foundStart = startCol <= 0;
  let i = 0;
  while (i < text.length) {
    if (!foundStart && col >= startCol) {
      start = i;
      foundStart = true;
    }
    if (col >= endCol) return { start, end: i };
    const code = text.charCodeAt(i);
    if (code >= 32 && code < 127) {
      col++;
      i++;
      continue;
    }
    if (code === 9) {
      col += tabSize - (col % tabSize);
      i++;
      continue;
    }
    const cp = text.codePointAt(i)!;
    const step = cp > 0xffff ? 2 : 1;
    if (cp >= 32) col += isWideCodePoint(cp) ? 2 : 1;
    i += step;
  }
  return { start, end: text.length };
}

/** Visual column at which UTF-16 index `index` of `text` starts (the rules of `visibleCharWindow`). */
export function columnAt(text: string, index: number, tabSize = 4): number {
  let col = 0;
  const stop = Math.min(index, text.length);
  for (let i = 0; i < stop;) {
    const code = text.charCodeAt(i);
    if (code >= 32 && code < 127) {
      col++;
      i++;
    } else if (code === 9) {
      col += tabSize - (col % tabSize);
      i++;
    } else {
      const cp = text.codePointAt(i)!;
      if (cp >= 32) col += isWideCodePoint(cp) ? 2 : 1;
      i += cp > 0xffff ? 2 : 1;
    }
  }
  return col;
}

/** Width in CSS px of a tab-free run of text in the console font. */
export type TextMeasure = (text: string) => number;

let measureContext: CanvasRenderingContext2D | null | undefined;

/**
 * Measures text in `el`'s font on a canvas, which draws CJK, emoji and combining marks at the
 * width the line does (a CJK ideograph is 1em, not 2ch); null where there is no canvas.
 */
export function canvasTextMeasure(el: HTMLElement): TextMeasure | null {
  if (measureContext === undefined) {
    try {
      measureContext = el.ownerDocument.createElement("canvas").getContext("2d");
    } catch {
      measureContext = null;
    }
  }
  const ctx = measureContext;
  if (!ctx) return null;
  const s = getComputedStyle(el);
  const font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
  const spacing = Number.parseFloat(s.letterSpacing) || 0;
  return (text) => {
    ctx.font = font;
    return ctx.measureText(text).width + spacing * text.length;
  };
}

/**
 * Horizontal offset in px of UTF-16 index `index` in a `white-space: pre` line: measured runs,
 * with each tab moving to the next multiple of `tabSize` spaces (`tab-size`), a stop closer than
 * half a space counting as passed, as CSS Text draws it.
 */
export function textOffsetPx(text: string, index: number, measure: TextMeasure, tabSize = 4): number {
  const stop = Math.min(index, text.length);
  const space = measure(" ");
  const tabWidth = space * tabSize;
  let x = 0;
  for (let from = 0; ;) {
    const tab = text.indexOf("\t", from);
    if (tab < 0 || tab >= stop) return x + measure(text.slice(from, stop));
    x += measure(text.slice(from, tab));
    if (tabWidth > 0) {
      let next = (Math.floor(x / tabWidth) + 1) * tabWidth;
      if (next - x < space / 2) next += tabWidth;
      x = next;
    }
    from = tab + 1;
  }
}

/**
 * The `scrollLeft` that brings `[start, end)` of `text` into a non-wrapped console viewport
 * (centred, or from its start when wider than the viewport), or `null` when it is already visible.
 * With `measure` the offsets are the drawn widths; without it (no canvas) they are columns of 1ch.
 */
export function revealScrollLeft(
  text: string,
  start: number,
  end: number,
  viewport: { scrollLeft: number; clientWidth: number },
  fontSizePx: number,
  options?: HorizontalWindowOptions & { measure?: TextMeasure | null },
): number | null {
  const { scrollLeft, clientWidth } = viewport;
  if (clientWidth <= 0) return null;
  const pad = Math.max(0, options?.paddingLeftPx ?? 0);
  let left: number;
  let right: number;
  const measure = options?.measure;
  if (measure) {
    left = pad + textOffsetPx(text, start, measure);
    right = pad + textOffsetPx(text, end, measure);
  } else {
    const measured = options?.charWidthPx;
    const charWidth =
      typeof measured === "number" && Number.isFinite(measured) && measured > 0
        ? measured
        : fontSizePx * ((MIN_MONO_CHAR_EM + MAX_MONO_CHAR_EM) / 2);
    const startCol = columnAt(text, start);
    left = pad + startCol * charWidth;
    right = pad + (startCol + columnAt(text.slice(start, end), end - start)) * charWidth;
  }
  if (left >= scrollLeft && right <= scrollLeft + clientWidth) return null;
  const width = right - left;
  const target = width >= clientWidth ? left - pad : left - (clientWidth - width) / 2;
  return Math.max(0, Math.round(target));
}

/**
 * Slices sorted, non-overlapping `[start, end)` ranges to those intersecting
 * `[winStart, winEnd)`, always keeping any entry matched by `alwaysKeep` (such as
 * the active find match).
 */
export function sliceRangesInWindow<T extends { start: number; end: number }>(
  items: readonly T[],
  winStart: number,
  winEnd: number,
  alwaysKeep?: (item: T) => boolean,
): readonly T[] {
  if (items.length === 0) return items;
  if (items[0]!.start >= winStart && items[items.length - 1]!.end <= winEnd) return items;

  // Binary search for the first item with `item.end > winStart`.
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (items[mid]!.end <= winStart) lo = mid + 1;
    else hi = mid;
  }

  let endIdx = lo;
  while (endIdx < items.length && items[endIdx]!.start < winEnd) endIdx++;

  if (!alwaysKeep) return lo === 0 && endIdx === items.length ? items : items.slice(lo, endIdx);

  let before: T[] | null = null;
  for (let i = 0; i < lo; i++) {
    const item = items[i]!;
    if (alwaysKeep(item)) (before ??= []).push(item);
  }
  let after: T[] | null = null;
  for (let i = endIdx; i < items.length; i++) {
    const item = items[i]!;
    if (alwaysKeep(item)) (after ??= []).push(item);
  }
  if (!before && !after) return lo === 0 && endIdx === items.length ? items : items.slice(lo, endIdx);
  const middle = lo < endIdx ? items.slice(lo, endIdx) : [];
  return [...(before ?? []), ...middle, ...(after ?? [])];
}

/** Joins `path` onto `base` (POSIX), normalising `.`/`..`. Absolute paths are kept. */
export function joinPath(base: string, path: string): string {
  const p = path.replace(/\\/g, "/").replace(/^file:\/\//, "");
  const full = p.startsWith("/") || /^[A-Za-z]:\//.test(p) ? p : `${base.replace(/\/+$/, "")}/${p}`;
  const out: string[] = [];
  for (const seg of full.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return (/^[A-Za-z]:$/.test(out[0] ?? "") ? "" : "/") + out.join("/");
}
