import { createRoot } from "react-dom/client";
import "../src/styles/global.css";
import type { FileStatus } from "../src/bindings";
import { ChangesTree } from "../src/features/vcs/CommitView";
import { useCommit } from "../src/features/vcs/commitStore";
import { useVcs } from "../src/features/vcs/store";
import { useProject } from "../src/platform/project";

// `?width=<px>&flat`: the staging area's change tree over two repositories, in a panel that narrow.
const params = new URLSearchParams(location.search);
const width = Number(params.get("width") ?? 260);
const repos = ["/w/openidea", "/w/openidea-plugins"];
const file = (root: string, relPath: string, staged: boolean): FileStatus => ({
  path: `${root}/${relPath}`,
  relPath,
  staged: staged ? "modified" : null,
  unstaged: staged ? null : "modified",
  renamedFrom: null,
});
// Unset settings validate to the defaults.
useProject.setState({ settings: { vcs: { git: { stagingArea: true } } } as never });
useVcs.setState({
  root: repos[0],
  roots: repos,
  heads: {
    [repos[0]]: { head: "feat/commit-tree-labels-with-a-long-branch-name", headCommit: "17806ce3" },
    [repos[1]]: { head: "main", headCommit: "29da9754" },
  },
  status: [
    file(repos[0], "src-tauri/src/commands/workspace_symbols_and_navigation.rs", false),
    file(repos[0], "src/features/vcs/CommitView.module.css", true),
    file(repos[1], "plugins/sample/src/lib.rs", false),
    // Siblings at every level keep the folders from being compacted, so the deepest rows are narrow.
    ...["a", "b"].flatMap((leaf) =>
      [
        "crates",
        "crates/ide-sdk",
        "crates/ide-sdk/src",
        "crates/ide-sdk/src/java",
        "crates/ide-sdk/src/java/maven",
      ].map((dir) => file(repos[1], `${dir}/${leaf}/resolve_dependency_management_${leaf}.rs`, leaf === "b")),
    ),
  ],
});
useCommit.setState({ groupByDir: !params.has("flat"), checks: new Map(), selection: [] });

createRoot(document.getElementById("root")!).render(
  <div id="panel" style={{ width, height: 600, display: "flex", flexDirection: "column" }}>
    <ChangesTree mode="commit" />
  </div>,
);
