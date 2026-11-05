/**
 * Fork-owned: the Git Log's branch filter popup as the Git Graph toolbar uses it, provided
 * through `workbench/gitGraphBridge.ts`.
 */
import { useEffect } from "react";
import type { GraphBranchFilterProps } from "@/workbench/gitGraphBridge";
import { BranchFilterPopup } from "./BranchFilterPopup";
import { loadFavoriteBranches, useFavoriteBranches } from "./branchOps";
import { chooseMany } from "./dialogs";
import { useVcs } from "./store";

export function GraphBranchFilterPopup({ repo, onSelectMany, onClose, ...rest }: GraphBranchFilterProps) {
  const root = useVcs((s) => s.root);
  const stored = useFavoriteBranches((s) => s.names);
  useEffect(() => loadFavoriteBranches(), [root]);
  // Stored favorites belong to the vcs feature's selected repository; others use the defaults.
  const favorites = repo === root ? stored : null;
  const selectMany = async () => {
    onClose();
    const r = await chooseMany({
      title: "Filter by Branch",
      options: ["HEAD", ...rest.branches.filter((b) => !b.name.endsWith("/HEAD")).map((b) => b.name)],
      initial: [...rest.selected],
      customLabel: "Other revisions (comma-separated):",
    });
    if (r) onSelectMany(r);
  };
  return <BranchFilterPopup {...rest} favorites={favorites} onClose={onClose} onSelectMany={() => void selectMany()} />;
}
