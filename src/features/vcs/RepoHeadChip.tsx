import { repoHeadLabel } from "./repoBranches";
import { useVcs } from "./store";

/** `root`'s current branch (or short commit when detached) as a chip; nothing with a single repository. */
export function RepoHeadChip({ root, className }: { root: string; className?: string }) {
  const head = useVcs((s) => (s.roots.length > 1 ? s.heads[root] : undefined));
  if (!head) return null;
  return <span className={className}>{repoHeadLabel(head)}</span>;
}
