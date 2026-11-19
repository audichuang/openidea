/**
 * Fork-owned: the Git Log's branch filter popup as the Git Graph toolbar uses it, provided
 * through `workbench/gitGraphBridge.ts`.
 */
import type { GraphBranchFilterProps } from "@/workbench/gitGraphBridge";
import { BranchFilterPopup } from "./BranchFilterPopup";
import { useFavoriteBranchNames } from "./branchOps";
import { chooseMany } from "./dialogs";

export function GraphBranchFilterPopup({ repo, onSelectMany, onClose, ...rest }: GraphBranchFilterProps) {
  // Each repository has its own favorites.
  const favorites = useFavoriteBranchNames(repo);
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
