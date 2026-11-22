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
import { createPagedLogGraph, pagesLogGraph, run, type PagedLogGraph, type Steps } from "./pagedLogGraph";

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

/** How a presenter spreads a long layout over tasks. */
export interface LayoutSlices {
  /** Starts a slice of work: the returned function tells when it has run long enough. */
  start(): () => boolean;
  /** Runs the next slice in a later task. */
  later(run: () => void): void;
}

/** Slices of about half a frame, each in its own task, so frames are drawn between them. */
const taskSlices: LayoutSlices = {
  start() {
    const end = performance.now() + 8;
    return () => performance.now() >= end;
  },
  later: (run) => void setTimeout(run, 0),
};

/**
 * `presentLogGraph`, reusing the previous call's layout when a page of commits was appended or a
 * Refresh changed little (see `pagedLogGraph.ts`). Rows are resolved one at a time: draw
 * `row(index)`, not `rows[index]`.
 *
 * With `onReady`, a layout that takes longer than a slice (a Refresh whose change reorders the
 * lanes below it lays the whole list out again) goes on in later tasks: until it is done the
 * call returns the previous presentation, commits and rows together, with `pending` set, and
 * `onReady` is called once it is. Calls in the meantime return the same; the call after
 * `onReady` lays out what it is given then, so commits that came in during a layout are
 * presented by the next one.
 */
export function createLogGraphPresenter(onReady?: () => void, slices: LayoutSlices = taskSlices) {
  type Full = ReturnType<typeof presentLogGraph>;
  type Presented = PagedLogGraph & { linear: Full["linear"]; collapsed: Full["collapsed"]; pending: boolean };
  const paged = createPagedLogGraph();
  let last: { result: PagedLogGraph; presented: Presented } | null = null;
  let job: Steps<PagedLogGraph | null> | null = null;
  /** The layout finished in later tasks, until the call it was for is made again. */
  let finished: { all: readonly RepoCommit[]; longEdges: boolean; result: PagedLogGraph | null } | null = null;
  const take = (steps: Steps<PagedLogGraph | null>) => {
    const expired = slices.start();
    for (;;) {
      const next = steps.next();
      if (next.done) return { result: next.value };
      if (expired()) return null;
    }
  };
  const proceed = (steps: Steps<PagedLogGraph | null>, all: readonly RepoCommit[], longEdges: boolean) => {
    slices.later(() => {
      if (job !== steps) return;
      const done = take(steps);
      if (!done) return proceed(steps, all, longEdges);
      job = null;
      finished = { all, longEdges, result: done.result };
      onReady!();
    });
  };
  return (...args: Parameters<typeof presentLogGraph>): Presented => {
    const [all, options, fragments] = args;
    let result: PagedLogGraph | null;
    if (!pagesLogGraph(options, fragments)) {
      job = null;
      finished = null;
      result = paged.reset();
    } else if (job && last) return { ...last.presented, pending: true };
    else if (finished?.all === all && finished.longEdges === options.longEdges) result = finished.result;
    else {
      finished = null;
      const steps = paged.steps(all, options);
      const done = onReady && last ? take(steps) : { result: run(steps) };
      if (!done) {
        job = steps;
        proceed(steps, all, options.longEdges);
        return { ...last!.presented, pending: true };
      }
      result = done.result;
    }
    if (result) {
      if (last?.result !== result)
        last = { result, presented: { ...result, linear: null, collapsed: null, pending: false } };
      return last.presented;
    }
    last = null;
    const full = presentLogGraph(...args);
    let index: { rows: Map<string, number[]>; children: Map<string, number> } | undefined;
    const indexed = () => {
      if (index) return index;
      index = { rows: new Map(), children: new Map() };
      for (const [i, c] of full.graph.entries()) {
        const rows = index.rows.get(c.id);
        if (rows) rows.push(i);
        else index.rows.set(c.id, [i]);
        for (const p of c.parents) index.children.set(p, (index.children.get(p) ?? 0) + 1);
      }
      return index;
    };
    return {
      ...full,
      pending: false,
      width: full.rows.reduce((width, row) => Math.max(width, row.width), 0),
      row: (index: number): GraphRow | undefined => full.rows[index],
      rowsOf: (id: string) => indexed().rows.get(id) ?? [],
      childCount: (id: string) => indexed().children.get(id) ?? 0,
    };
  };
}
