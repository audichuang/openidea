import {
  collapseLinear,
  compactLanes,
  computeGraph,
  hideLongEdges,
  linearizeMerges,
  pruneFilteredEdges,
  straightenLaneChanges,
  type GraphRow,
} from "./graph";
import { commitKey, graphCommit, type RepoCommit } from "./multiRoot";
import type { LogOptions } from "./logOptions";
import { createPagedLogGraph, pagesLogGraph, type PagedLogGraph } from "./pagedLogGraph";

/** The same displayed adjacency drives painting, navigation and fragment actions. */
export function presentLogGraph(
  all: readonly RepoCommit[],
  options: LogOptions,
  fragments: { expanded: ReadonlySet<string>; collapsed: ReadonlySet<string>; merges: ReadonlySet<string> },
  keep: ReadonlySet<string>,
) {
  const source = all.map(graphCommit);
  const collapsed =
    options.collapseLinear || fragments.collapsed.size
      ? collapseLinear(
          source,
          new Set([...keep, ...fragments.expanded]),
          options.collapseLinear ? undefined : fragments.collapsed,
        )
      : null;
  const expanded = fragments.merges.has("*")
    ? new Set(source.filter((c) => !fragments.merges.has(c.id)).map((c) => c.id))
    : fragments.merges;
  const linear = options.linearizeMerges ? linearizeMerges(collapsed?.graph ?? source, expanded) : null;
  const graph = pruneFilteredEdges(linear?.graph ?? collapsed?.graph ?? source);
  const byId = new Map(all.map((c) => [commitKey(c), c]));
  const commits = graph.map((c) => byId.get(c.id)!);
  const laid = computeGraph(graph).rows;
  const rows = straightenLaneChanges(compactLanes(options.longEdges ? laid : hideLongEdges(laid)));
  return { commits, graph, rows, linear, collapsed };
}

/**
 * `presentLogGraph`, reusing the previous call's layout when a page of commits was appended (see
 * `pagedLogGraph.ts`). Rows are resolved one at a time: draw `row(index)`, not `rows[index]`.
 */
export function createLogGraphPresenter() {
  type Full = ReturnType<typeof presentLogGraph>;
  type Presented = PagedLogGraph & { linear: Full["linear"]; collapsed: Full["collapsed"] };
  const paged = createPagedLogGraph();
  let last: { result: PagedLogGraph; presented: Presented } | null = null;
  return (...args: Parameters<typeof presentLogGraph>): Presented => {
    const [all, options, fragments] = args;
    const result = pagesLogGraph(options, fragments) ? paged(all, options) : null;
    if (result) {
      if (last?.result !== result) last = { result, presented: { ...result, linear: null, collapsed: null } };
      return last.presented;
    }
    const full = presentLogGraph(...args);
    return { ...full, row: (index: number): GraphRow | undefined => full.rows[index] };
  };
}
