import clsx from "clsx";
import { useLayoutEffect, useRef, useState } from "react";
import styles from "./clip.module.css";

/** How much of a long file name's end stays visible when its middle is elided. */
const TAIL = 14;

/** A name this short is never elided: its head would be too short to tell names apart. */
const MIN_ELIDED = TAIL + 6;

/** A file name as [head, tail]: only a name long enough to elide has a tail, which is never cut. */
export function splitTail(name: string): [string, string] {
  if (name.length <= MIN_ELIDED) return [name, ""];
  return [name.slice(0, name.length - TAIL), name.slice(-TAIL)];
}

/** Whether `name` is shown with its middle elided (it renders as head and tail spans). */
export const isElided = (name: string) => splitTail(name)[1] !== "";

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

/**
 * A file name that elides in the middle: names that share a long prefix stay distinguishable by
 * their ends. Short names render as plain text.
 */
export function NameText({ name }: { name: string }) {
  const [head, tail] = splitTail(name);
  const headRef = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState(false);
  // The head's own `text-overflow` ellipsis leaves a blank of up to one character before the tail. While the
  // head is cut, it is clipped at the pixel instead and the tail draws the ellipsis, so the name reads as one.
  useLayoutEffect(() => {
    const el = headRef.current;
    if (!el) return;
    const measure = () => setClipped(el.scrollWidth > el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [head, tail]);
  if (!tail) return <>{name}</>;
  const flag = clipped ? "" : undefined;
  return (
    <>
      <span ref={headRef} className={styles.nameHead} data-clipped={flag}>
        {head}
      </span>
      <span className={styles.nameTail} data-clipped={flag}>
        {tail}
      </span>
    </>
  );
}

/**
 * A path whose folders elide first (down to the first segment and an ellipsis), then the middle of the file
 * name; the name's end always shows. The layout rules live in `clip.module.css` (`.pathDirRest` shrinks with
 * a far larger factor than `.pathName`).
 */
export function PathText({ path, title, className }: { path: string; title?: string; className?: string }) {
  const [dir, name] = splitDir(path);
  const [first, rest] = splitFirstSegment(dir);
  return (
    <span className={clsx(styles.pathText, className)} title={title ?? path}>
      {first && <span className={styles.pathDirFirst}>{first}</span>}
      {rest && <span className={styles.pathDirRest}>{rest}</span>}
      <span className={styles.pathName} data-elided={isElided(name) ? "" : undefined}>
        <NameText name={name} />
      </span>
    </span>
  );
}
