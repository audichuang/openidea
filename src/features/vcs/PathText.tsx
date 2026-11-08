import clsx from "clsx";
import styles from "./clip.module.css";

/** How much of a long file name's end stays visible when its middle is elided. */
const TAIL = 14;

/** A file name as [head, tail]: only a name long enough to elide has a tail, which is never cut. */
export function splitTail(name: string): [string, string] {
  if (name.length <= TAIL * 2) return [name, ""];
  return [name.slice(0, name.length - TAIL), name.slice(-TAIL)];
}

/** A path as [folders with their trailing "/", file name]. */
/** Whether `name` is shown with its middle elided (it renders as head and tail spans). */
export const isElided = (name: string) => splitTail(name)[1] !== "";

export function splitDir(path: string): [string, string] {
  const i = path.lastIndexOf("/");
  return i < 0 ? ["", path] : [path.slice(0, i + 1), path.slice(i + 1)];
}

/**
 * A file name that elides in the middle: names that share a long prefix stay distinguishable by
 * their ends. Short names render as plain text.
 */
export function NameText({ name }: { name: string }) {
  const [head, tail] = splitTail(name);
  if (!tail) return <>{name}</>;
  return (
    <>
      <span className={styles.nameHead}>{head}</span>
      <span className={styles.nameTail}>{tail}</span>
    </>
  );
}

/** A path whose folders elide first and then the middle of the file name; the name's end always shows. */
export function PathText({ path, title, className }: { path: string; title?: string; className?: string }) {
  const [dir, name] = splitDir(path);
  return (
    <span className={clsx(styles.pathText, className)} title={title ?? path}>
      {dir && <span className={styles.pathDir}>{dir}</span>}
      <span className={styles.pathName} data-elided={isElided(name) ? "" : undefined}>
        <NameText name={name} />
      </span>
    </span>
  );
}
