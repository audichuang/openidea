import clsx from "clsx";
import { repoColor } from "./model";
import { useVcs } from "./store";
import styles from "./common.module.css";

/** `root`'s colour square, the same in every view naming it; nothing with a single repository. */
export function RepoSwatch({ root, className }: { root: string; className?: string }) {
  const color = useVcs((s) => repoColor(root, s.roots));
  if (!color) return null;
  return <span className={clsx(styles.repoSwatch, className)} style={{ background: color }} aria-hidden="true" />;
}
