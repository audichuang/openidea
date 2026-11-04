/** Main toolbar button opening the Git Graph tab (hidden without a Git repository). */
import { useContextKeys } from "@/platform/context";
import { IconButton } from "@/ui";
import styles from "./TitleItem.module.css";

export function GitGraphTitleItem() {
  const shown = useContextKeys((c) => !!c.vcsAvailable);
  if (!shown) return null;
  return (
    <IconButton
      icon="branch"
      size="large"
      iconSize={16}
      className={styles.titleButton}
      title="Git Graph"
      action="gitGraph.open"
    />
  );
}
