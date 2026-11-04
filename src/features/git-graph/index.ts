/**
 * Fork-owned Git Graph: a full-width editor tab with the commit graph of every branch and the
 * operations of Git Graph Plus run from the graph. It reaches the vcs feature only through
 * `workbench/gitGraphBridge.ts`.
 */
import { registerActions } from "@/platform/actions";
import { lazyComponent } from "@/ui";
import { editorService, registerEditorKind, registerTitleItem, type EditorInput } from "@/workbench/contributions";
import { GitGraphTitleItem } from "./TitleItem";

export const GIT_GRAPH_KIND = "gitGraph";

export function gitGraphInput(): EditorInput {
  return { kind: GIT_GRAPH_KIND, key: GIT_GRAPH_KIND, data: {} };
}

export function activate(): () => void {
  const disposers = [
    registerEditorKind({
      kind: GIT_GRAPH_KIND,
      component: lazyComponent(() => import("./GitGraphView").then((m) => m.GitGraphEditor)),
      title: () => "Git Graph",
      icon: () => "branch",
      restorable: true,
    }),
    registerTitleItem({
      id: "gitGraph.open",
      title: "Git Graph",
      align: "right",
      priority: -2,
      component: GitGraphTitleItem,
    }),
    registerActions([
      {
        id: "gitGraph.open",
        title: "Git Graph",
        category: "Git",
        icon: "branch",
        keywords: ["log", "history", "tree", "commits"],
        when: "vcsAvailable",
        run: () => void editorService().openInput(gitGraphInput(), { focus: true }),
      },
    ]),
  ];
  return () => disposers.forEach((d) => d());
}
