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

/** The options that shape the displayed graph; every other option leaves it as it is. */
export type GraphOptions = Pick<LogOptions, "collapseLinear" | "linearizeMerges" | "longEdges">;

/** The same displayed adjacency drives painting, navigation and fragment actions. */
export function presentLogGraph(
  all: readonly RepoCommit[],
  options: GraphOptions,
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
  const unpruned = linear?.graph ?? collapsed?.graph ?? source;
  const graph = pruneFilteredEdges(unpruned);
  const byId = new Map(all.map((c) => [commitKey(c), c]));
  const commits = graph.map((c) => byId.get(c.id)!);
  const laid = computeGraph(graph).rows;
  const rows = straightenLaneChanges(compactLanes(options.longEdges ? laid : hideLongEdges(laid)));
  return { commits, graph, unpruned, rows, linear, collapsed };
}

/** How a presenter spreads a long layout over tasks. */
export interface LayoutSlices {
  /** Starts a slice of work: the returned function tells when it has run long enough. */
  start(): () => boolean;
  /** Runs the next slice in a later task. */
  later(run: () => void): void;
}

/** Time a slice takes: most of a frame, leaving the rest to draw it and handle input. */
const SLICE_MS = 12;

/**
 * Slices of most of a frame, each in its own task. The next slice is posted as a message:
 * `setTimeout` waits at least 4 ms once nested, which made laying out take a third longer.
 */
const taskSlices: LayoutSlices = {
  start() {
    const end = performance.now() + SLICE_MS;
    return () => performance.now() >= end;
  },
  later(run) {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      run();
    };
    channel.port2.postMessage(null);
  },
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
      row: (index: number): GraphRow | undefined => full.rows[index],
      rowsOf: (id: string) => indexed().rows.get(id) ?? [],
      childCount: (id: string) => indexed().children.get(id) ?? 0,
    };
  };
}
