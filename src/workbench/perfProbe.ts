/**
 * Hooks for the performance harness (`perf/`), exposed as `window.__openideaPerf`.
 * Loaded only in dev and in `vite build --mode perf`; release builds never
 * include it. Measurement itself lives in the harness so it stays out of the app.
 */
import { completionStatus, currentCompletions } from "@codemirror/autocomplete";
import { syntaxParserRunning } from "@codemirror/language";
import { forEachDiagnostic } from "@codemirror/lint";
import { executeAction } from "@/platform/actions";
import { bindingsFor } from "@/platform/keymap";
import { activeEditor, editorsFor } from "@/editor/api";
import { docBackend, type MemoryBackend } from "@/editor/core/backend";
import { subscribeDiagnostics } from "@/editor/lsp/diagnostics";
import type {
  Branch,
  ChangedFile,
  Commit,
  CompletionItem,
  CompletionKind,
  FileMatches,
  HttpExchange,
  HttpHistoryEntry,
  LogQuery,
  SearchQuery,
  SearchSummary,
} from "@/bindings";
import { openProject } from "@/platform/project";
import { setInvokeRoute } from "@/platform/tauriCore";
import { nextRequestId } from "@/platform/ipc";
import { editorService } from "./contributions";
import { gitGraphBridge, provideGitGraphBridge, type GitGraphBridge } from "./gitGraphBridge";

export interface PerfProbe {
  /** Seeds file contents for the in-memory document backend (plain-browser mode). */
  seed(path: string, text: string): void;
  openFile(path: string): Promise<void>;
  /** Opens a document while observing fresh backend publications, excluding cached/local diagnostics. */
  openFileForDiagnostics(path: string, source: string): Promise<number>;
  /** Whether the current opening has received its producer's publication and is still active. */
  diagnosticsPublished(generation: number): boolean;
  /** Opens project `path` in this window (as the welcome screen does), without the window chooser. */
  openProject(path: string): Promise<void>;
  runAction(id: string, arg?: unknown): Promise<boolean>;
  /** Effective keymap bindings of an action, e.g. `["Ctrl+Shift+A"]`. */
  bindings(id: string): string[];
  /** Moves the caret of the active editor and focuses it. */
  setCursor(offset: number): void;
  /** True while the active editor's background syntax parser still has work. */
  parsing(): boolean;
  /** The active editor's text, optionally restricted to a UTF-16 offset range. */
  editorText(from?: number, to?: number): string | null;
  /** Inserts `text` after the first `after` in the active editor, as an edit of the user's; the offset after it. */
  insertAfter(after: string, text: string): number;
  /** Replaces the active editor's whole text, as an edit of the user's. */
  setText(text: string): void;
  /** Labels of the completion lookup open in the active editor. */
  completions(): string[];
  /** True while a completion source of the active editor has not answered yet. */
  completionPending(): boolean;
  /** The diagnostics in the active editor (0-based line). */
  diagnostics(): Array<{ line: number; severity: string; message: string }>;
  /** 0-based line of the active editor shown at viewport `y` (e.g. a gutter marker's), or -1. */
  lineAtY(y: number): number;
  /** Document length and caret (offset, 0-based line, the word around it) of the active editor. */
  editorState(): {
    doc: number;
    path: string;
    length: number;
    lines: number;
    head: number;
    line: number;
    col: number;
    word: string;
  } | null;
  /**
   * Answers code completion with `items` generated items (a language server's
   * list); other language server requests report no server. `0` removes it.
   */
  fakeCompletion(items: number): void;
  /**
   * Answers the Git Log with `commits` generated commits (a main line with
   * feature branches merging into it), paged like the backend, each page after
   * `latencyMs` (a `git log` call). `0` commits removes it.
   */
  fakeGitLog(commits: number, latencyMs?: number, longBranches?: number): void;
  /**
   * Opens an all-in-one diff of `files` generated files changed between two revisions, answering
   * the Git reads its blocks make: 40 lines each, every 50th file 1,000 lines.
   */
  openCombinedDiff(files: number): Promise<{ first: string; last: string }>;
  /** Opens an empty Run console session before streaming starts so UI (e.g. Find) can mount first. */
  openConsoleSession(mode: "long" | "no-lf"): Promise<string>;
  /** Streams long-line or no-newline output into a Run console session. */
  streamConsoleOutput(options: {
    mode: "long" | "no-lf";
    count: number;
    perFrame: number;
    lineLength?: number;
    sessionId?: string;
  }): Promise<{ lines: number; dropped: number }>;
  /**
   * Answers the Git Graph PR view with `commits` generated commits between `main`
   * and `feature`. `0` commits removes it and restores the real bridge.
   */
  fakePrCommits(commits: number): void;
  /**
   * Answers the Git Graph PR view with `ahead` commits in `main..feature` and
   * `behind` commits in `feature..main`, supporting triggered vcs refreshes and
   * fetch-count stats. Both `0` removes it and restores the real bridge.
   */
  fakePrRefresh(ahead: number, behind: number): void;
  /** Bumps the fake PR bridge's vcs version (like a file save / git refresh). */
  triggerPrRefresh(): void;
  /** Fetch and refresh counters collected by `fakePrRefresh`. */
  prRefreshStats(): { logCalls: number; commitsFetched: number; countCalls: number; diffCalls: number };
  resetPrRefreshStats(): void;
  /**
   * Opens a Find tool window tab whose search streams `files` generated files
   * with `hitsPerFile` matching lines of about `lineLength` characters each, one
   * file per task as the backend's channel delivers them, at most 4 files a
   * millisecond (a backend that finds 4,000 files in about a second). Resolves
   * once the last file and the summary were delivered (or the search was cancelled).
   */
  fakeFindStream(files: number, hitsPerFile?: number, lineLength?: number): Promise<void>;
  /**
   * Adds one HTTP Client history entry whose response body is ~`bytes` of
   * generated `shape` text (single-line JSON, deeply nested JSON, XML or plain
   * text lines), ending in `last-item`. `0` bytes removes it.
   */
  fakeHttpResponse(shape: HttpBodyShape, bytes: number): void;
  /**
   * Opens an all-in-one diff of `files` generated files, answering the Git and file reads its
   * blocks make: small edits between two revisions, every 25th file binary, every 100th one of
   * 2,000 lines, one of `bigLines` changed lines, and one working file (editable) half-way down.
   * Resolves with the paths of the big and the editable file.
   */
  openCombinedDiff(files: number, bigLines: number): Promise<{ big: string; editable: string }>;
  /** Whether a document of `path` shown in a view (an editor, a diff pane) has unsaved changes. */
  unsaved(path: string): boolean;
}

export type HttpBodyShape = "json" | "nested" | "xml" | "text";

/** The sample project the perf build opens (`registerDevSamples`). */
const PERF_ROOT = "/dev/acme-api";

const KINDS: CompletionKind[] = [
  "method",
  "function",
  "field",
  "variable",
  "class",
  "interface",
  "property",
  "keyword",
];

// Completion details as a language server reports them (code, not UI text).
const RESULT = "Promise<Result<Order>>";
const qualified = (name: string) => ["com", "acme", name].join(".");

function completionItem(i: number): CompletionItem {
  const kind = KINDS[i % KINDS.length]!;
  // Shared prefixes so typing narrows the list gradually, like real symbols.
  const label = `${["get", "set", "create", "update", "find", "to", "is", "on"][i % 8]}${["Order", "Item", "Customer", "Invoice", "Payment", "Status"][(i >> 3) % 6]}${i}`;
  return {
    label,
    labelDetail: kind === "method" || kind === "function" ? "(id: string, options?: Options)" : null,
    labelDescription: null,
    detail: kind === "class" || kind === "interface" ? qualified(label) : RESULT,
    kind,
    documentation: null,
    sortText: String(i).padStart(5, "0"),
    filterText: null,
    preselect: false,
    deprecated: i % 97 === 0,
    insertText: label,
    isSnippet: false,
    replaceRange: null,
    replaceRangeTab: null,
    additionalEdits: [],
    commitCharacters: [],
    command: null,
    data: null,
    server: 1,
  };
}

function commit(i: number, count: number): Commit {
  const id = (n: number) => n.toString(16).padStart(40, "0");
  // Newest first: parents have higher indices. Every 12th commit merges a branch
  // started 7 commits back; every third commit skips ahead, keeping a few lanes open.
  const merge = i % 12 === 0 && i + 7 < count;
  const next = i % 3 === 2 && i + 3 < count ? i + 3 : i + 1;
  const parents = i + 1 >= count ? [] : merge ? [id(i + 1), id(i + 7)] : [id(next)];
  const time = Date.UTC(2026, 10, 5) - i * 3_600_000;
  const summary = `${["feat", "fix", "refactor", "test"][i % 4]}(orders): ${merge ? "merge" : "update"} order flow step ${i}`;
  return {
    id: id(i),
    shortId: id(i).slice(-8),
    parents,
    author: ["Ada Lovelace", "Linus Torvalds", "Grace Hopper", "Ken Thompson"][i % 4]!,
    email: `dev${i % 4}@acme.dev`,
    committer: "CI",
    committerEmail: "ci@acme.dev",
    timeMs: time,
    commitTimeMs: time,
    summary,
    message: summary,
    messageTruncated: false,
    refs: i === 0 ? ["HEAD -> main", "origin/main"] : i % 250 === 0 ? [`tag: v1.${count - i}`] : [],
  };
}

/** `lines` lines of a generated source file; the two revisions differ on every 7th line. */
function revisionText(file: number, lines: number, rev: string): string {
  return Array.from({ length: lines }, (_, i) =>
    i % 7 === 3
      ? `export const v${file}_${i} = compute("${rev}", ${i});`
      : `export const v${file}_${i} = compute(${i});`,
  ).join("\n");
}

/** ~`bytes` of response body text of `shape`; the last record is named `last-item`. */
function httpBody(shape: HttpBodyShape, bytes: number): string {
  const parts: string[] = [];
  let size = 0;
  const push = (s: string) => {
    parts.push(s);
    size += s.length;
  };
  const record = (i: number) =>
    `{"id":${i},"name":"item-${i}","price":${(i * 1.25).toFixed(2)},"tags":["a","b"],"owner":{"id":${i % 97},"active":${i % 2 === 0}}}`;
  switch (shape) {
    case "json":
      for (let i = 0; size < bytes; i++) push((i ? "," : "[") + record(i));
      return `${parts.join("")},{"name":"last-item"}]`;
    case "nested": {
      // Records 40 levels deep, side by side.
      const depth = 40;
      const open = Array.from({ length: depth }, (_, d) => `{"level${d}":`).join("");
      const close = "}".repeat(depth);
      for (let i = 0; size < bytes; i++) push(`${i ? "," : "["}${open}${record(i)}${close}`);
      return `${parts.join("")},{"name":"last-item"}]`;
    }
    case "xml":
      for (let i = 0; size < bytes; i++)
        push(
          `<item id="${i}"><name>item-${i}</name><price>${(i * 1.25).toFixed(2)}</price><tags><tag>a</tag></tags></item>`,
        );
      return `<root>${parts.join("")}<item><name>last-item</name></item></root>`;
    case "text":
      for (let i = 0; size < bytes; i++) push(`${i} INFO  order-service  processed order item-${i} in ${i % 50} ms\n`);
      return `${parts.join("")}last-item`;
  }
}

/** `lines` lines of a generated source file; `rev` changes every 7th line (all of them with `all`). */
function combinedSource(n: number, lines: number, rev: string, all = false): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++)
    out.push(
      all || i % 7 === 3
        ? `export const value${n}_${i} = compute("${rev}", ${i}); // ${rev}`
        : `export const value${n}_${i} = compute("base", ${i});`,
    );
  return out.join("\n");
}

type Route = (cmd: string, args: unknown) => Promise<unknown> | null;
const routes = new Map<string, Route>();

/** Installs (or with `null` removes) one fake backend; the first that answers a command wins. */
function setRoute(name: string, next: Route | null) {
  if (next) routes.set(name, next);
  else routes.delete(name);
  setInvokeRoute(
    routes.size
      ? (cmd, args) => {
          for (const r of routes.values()) {
            const answer = r(cmd, args);
            if (answer) return answer;
          }
          return null;
        }
      : null,
  );
}

function requireView() {
  const view = activeEditor()?.view;
  if (!view) throw new Error("no active editor");
  return view;
}

export function installPerfProbe(): () => void {
  let diagnosticGeneration = 0;
  let diagnosticOpening: { generation: number; path: string; doc: number | null; published: boolean } | null = null;
  let stopDiagnostics: (() => void) | null = null;
  let restorePrBridge: (() => void) | null = null;
  let bumpPrRefresh: (() => void) | null = null;
  let prStats = { logCalls: 0, commitsFetched: 0, countCalls: 0, diffCalls: 0 };
  const probe: PerfProbe = {
    seed(path, text) {
      const backend = docBackend() as Partial<MemoryBackend>;
      if (!backend.files) throw new Error("seed() needs the in-memory backend");
      backend.files.set(path, text);
    },
    openFile: (path) => editorService().openFile(path),
    async openFileForDiagnostics(path, source) {
      stopDiagnostics?.();
      const opening = { generation: ++diagnosticGeneration, path, doc: null as number | null, published: false };
      diagnosticOpening = opening;
      stopDiagnostics = subscribeDiagnostics(path, (publication) => {
        if (diagnosticOpening === opening && publication?.source === source) opening.published = true;
      });
      try {
        await editorService().openFile(path);
        const editor = activeEditor();
        if (diagnosticOpening !== opening || editor?.ctx.path !== path)
          throw new Error("diagnostics opening was superseded");
        opening.doc = editor.ctx.doc;
        return opening.generation;
      } catch (error) {
        if (diagnosticOpening === opening) {
          stopDiagnostics?.();
          stopDiagnostics = null;
          diagnosticOpening = null;
        }
        throw error;
      }
    },
    diagnosticsPublished(generation) {
      const opening = diagnosticOpening;
      const editor = activeEditor();
      return (
        !!opening &&
        opening.generation === generation &&
        opening.published &&
        editor?.ctx.path === opening.path &&
        editor.ctx.doc === opening.doc
      );
    },
    openProject: async (path) => void (await openProject(path)),
    runAction: (id, arg) => executeAction(id, arg),
    bindings: (id) => bindingsFor(id),
    setCursor(offset) {
      const view = requireView();
      view.dispatch({ selection: { anchor: Math.min(offset, view.state.doc.length) }, scrollIntoView: true });
      view.focus();
    },
    parsing() {
      const view = activeEditor()?.view;
      return !!view && syntaxParserRunning(view);
    },
    fakeCompletion(count) {
      const items = Array.from({ length: count }, (_, i) => completionItem(i));
      setRoute(
        "completion",
        count
          ? (cmd, args) => {
              if (cmd === "lsp_completion") return Promise.resolve({ isIncomplete: false, items });
              if (cmd === "lsp_resolve_completion") return Promise.resolve((args as { item: CompletionItem }).item);
              if (cmd.startsWith("lsp_"))
                return Promise.reject({ kind: "unavailable", message: "No language server available" });
              return null;
            }
          : null,
      );
    },
    fakeGitLog(count, latencyMs = 0, longBranches = 0) {
      const commits = Array.from({ length: count }, (_, i) => commit(i, count));
      // Short merges alone miss the cost of several long-lived lanes crossing the same rows.
      for (let i = 0; i < longBranches; i++) {
        const tip = commits[i]!;
        const base = commits[count - longBranches + i]!;
        tip.parents = [base.id];
        tip.refs = [`branch-${i}`];
      }
      setRoute(
        "gitLog",
        count
          ? (cmd, args) => {
              if (cmd !== "vcs_log") return null;
              const { skip, limit, range } = (args as { query: LogQuery }).query;
              // Outgoing commits (`@{u}..HEAD`) and the like: none.
              if (range) return Promise.resolve([]);
              const page = commits.slice(skip, limit ? skip + limit : undefined);
              return new Promise((resolve) => setTimeout(() => resolve(page), latencyMs));
            }
          : null,
      );
    },
    async openCombinedDiff(files) {
      const paths = Array.from(
        { length: files },
        (_, i) => `/dev/acme-api/src/gen/pkg${Math.floor(i / 50)}/File${i}.ts`,
      );
      const index = new Map(paths.map((path, i) => [path, i]));
      setRoute("combinedDiff", (cmd, args) => {
        if (cmd === "vcs_diff_entries")
          return Promise.resolve(
            (args as { entries: { path: string }[] }).entries.map(() => ({ mode: "100644", gitlink: null })),
          );
        const { path, rev } = (args ?? {}) as { path?: string; rev?: string };
        const i = path === undefined ? undefined : index.get(path);
        if (i === undefined) return null;
        if (cmd === "vcs_file_mode") return Promise.resolve("100644");
        if (cmd === "fs_probe") return Promise.resolve({ size: 1024, binary: false, tooLarge: false });
        if (cmd === "vcs_file_at") return Promise.resolve(revisionText(i, i % 50 === 49 ? 1_000 : 40, rev ?? ""));
        return null;
      });
      await editorService().openInput({
        kind: "combined-diff",
        key: `combined-diff:perf:${files}`,
        path: paths[0] ?? "",
        data: {
          items: paths.map((path) => ({
            path,
            left: { type: "rev", rev: "HEAD~1" },
            right: { type: "rev", rev: "HEAD" },
          })),
        },
      });
      return { first: paths[0] ?? "", last: paths.at(-1) ?? "" };
    },
    async openConsoleSession(mode) {
      const { openSampleConsoleSession } = await import("@/features/run/store");
      return openSampleConsoleSession(mode);
    },
    async streamConsoleOutput(options) {
      const { startSampleConsoleOutput } = await import("@/features/run/store");
      return startSampleConsoleOutput(options);
    },
    async fakeFindStream(files, hitsPerFile = 1, lineLength = 80) {
      // Dev / perf builds only: the harness needs a Find tab without a Tauri channel.
      const { openInFindWindow } = await import("@/features/search/find/windowStore");
      const filler = "x".repeat(Math.max(0, lineLength - 24));
      // Synthetic source lines as search reports them (code, not UI text).
      const lineText = (line: number) => `    val needle${line} = "${filler}"`;
      const file = (i: number): FileMatches => {
        const relPath = `src/module${i % 40}/pkg${i % 7}/Orders${i}.kt`;
        return {
          path: `/dev/acme-api/${relPath}`,
          relPath,
          matches: Array.from({ length: hitsPerFile }, (_, line) => ({
            line,
            text: lineText(line),
            ranges: [[8, 14]],
            textOffset: 0,
          })),
        };
      };
      const query: SearchQuery = {
        pattern: "needle",
        isRegex: false,
        caseSensitive: false,
        wholeWord: false,
        include: [],
        exclude: [],
        scope: { kind: "project" },
        maxMatches: 0,
      };
      await new Promise<void>((delivered) => {
        let cancelled = false;
        openInFindWindow(query, "needle", {
          deps: {
            validate: async () => {},
            nextRequestId,
            cancel: () => void (cancelled = true),
            start: (_request, _query, onFile) =>
              new Promise((resolve) => {
                // One message per file, each in its own task, like a Tauri channel.
                const port = new MessageChannel();
                const start = performance.now();
                let i = 0;
                const finish = (summary: SearchSummary | null) => {
                  port.port1.close();
                  resolve(summary);
                  delivered();
                };
                port.port1.onmessage = () => {
                  if (cancelled) return finish(null);
                  const wait = start + i / 4 - performance.now();
                  if (wait > 0) return void setTimeout(() => port.port2.postMessage(0), wait);
                  onFile(file(i++));
                  if (i < files) port.port2.postMessage(0);
                  else
                    finish({
                      files,
                      matches: files * hitsPerFile,
                      limitHit: false,
                      cancelled: false,
                      elapsedMs: 0,
                    });
                };
                port.port2.postMessage(0);
              }),
          },
        });
      });
    },
    editorText: (from = 0, to) => activeEditor()?.view.state.doc.sliceString(from, to) ?? null,
    fakePrCommits(count) {
      restorePrBridge?.();
      restorePrBridge = null;
      if (!count) {
        setRoute("prCommits", null);
        return;
      }
      const commits = Array.from({ length: count }, (_, i) => commit(i, count));
      const mergeBase = (count + 1).toString(16).padStart(40, "0");
      const repo = "/dev/acme-api";
      const branches: Branch[] = [
        {
          name: "feature",
          remote: false,
          current: true,
          upstream: null,
          ahead: count,
          behind: 0,
          lastCommitMs: commits[0]?.timeMs ?? null,
        },
        {
          name: "main",
          remote: false,
          current: false,
          upstream: null,
          ahead: 0,
          behind: 0,
          lastCommitMs: commits[count - 1]?.timeMs ?? null,
        },
      ];
      const realBridge = gitGraphBridge();
      if (realBridge) {
        const fakeState = {
          roots: [repo],
          repo,
          heads: { [repo]: { head: "feature", headCommit: commits[0]?.id ?? null } },
          operations: {},
          version: 1,
        };
        const wrapped: GitGraphBridge = {
          ...realBridge,
          state: () => fakeState,
          subscribe: () => () => {},
        };
        const withdraw = provideGitGraphBridge(wrapped);
        restorePrBridge = () => {
          withdraw();
          provideGitGraphBridge(realBridge);
        };
      }
      setRoute("prCommits", (cmd, args) => {
        if (cmd === "vcs_branches") return Promise.resolve(branches);
        if (cmd === "vcs_tags") return Promise.resolve([]);
        if (cmd === "vcs_merge_base") return Promise.resolve(mergeBase);
        if (cmd === "vcs_diff_revisions") return Promise.resolve([]);
        if (cmd === "vcs_remotes") return Promise.resolve([]);
        if (cmd === "graph_stashes") return Promise.resolve([]);
        if (cmd === "graph_working_state")
          return Promise.resolve({ staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });
        if (cmd === "graph_bisect_state")
          return Promise.resolve({ active: false, current: null, culprit: null, output: "" });
        if (cmd === "graph_rev_counts") return Promise.resolve({ ahead: count, behind: 0 });
        if (cmd === "vcs_log") {
          const { skip, limit, range } = (args as { query: LogQuery }).query;
          if (range === "main..feature") return Promise.resolve(commits.slice(skip, limit ? skip + limit : undefined));
          if (range === "feature..main") return Promise.resolve([]);
          return Promise.resolve(commits.slice(skip, limit ? skip + limit : undefined));
        }
        return null;
      });
    },
    fakePrRefresh(ahead, behind) {
      restorePrBridge?.();
      restorePrBridge = null;
      bumpPrRefresh = null;
      prStats = { logCalls: 0, commitsFetched: 0, countCalls: 0, diffCalls: 0 };
      if (!ahead && !behind) {
        setRoute("prRefresh", null);
        return;
      }
      const repo = "/dev/acme-api";
      const mergeBase = (ahead + behind + 1).toString(16).padStart(40, "0");
      const headCommit = ahead > 0 ? (0).toString(16).padStart(40, "0") : mergeBase;
      const branches: Branch[] = [
        {
          name: "feature",
          remote: false,
          current: true,
          upstream: null,
          ahead,
          behind,
          lastCommitMs: Date.UTC(2026, 10, 5),
        },
        {
          name: "main",
          remote: false,
          current: false,
          upstream: null,
          ahead: 0,
          behind: 0,
          lastCommitMs: Date.UTC(2026, 10, 5),
        },
      ];
      const files: ChangedFile[] = Array.from({ length: 10 }, (_, i) => ({
        path: `src/module${i}/OrderService${i}.ts`,
        kind: i % 3 === 0 ? "added" : "modified",
        oldPath: null,
      }));
      const listeners = new Set<() => void>();
      let version = 1;
      const realBridge = gitGraphBridge();
      if (realBridge) {
        let fakeState = {
          roots: [repo],
          repo,
          heads: { [repo]: { head: "feature", headCommit } },
          operations: {},
          version,
        };
        const wrapped: GitGraphBridge = {
          ...realBridge,
          state: () => fakeState,
          subscribe: (fn) => {
            listeners.add(fn);
            return () => listeners.delete(fn);
          },
        };
        const withdraw = provideGitGraphBridge(wrapped);
        bumpPrRefresh = () => {
          version += 1;
          fakeState = { ...fakeState, version };
          listeners.forEach((fn) => fn());
        };
        restorePrBridge = () => {
          listeners.clear();
          withdraw();
          provideGitGraphBridge(realBridge);
        };
      }
      setRoute("prRefresh", (cmd, args) => {
        if (cmd === "vcs_branches") return Promise.resolve(branches);
        if (cmd === "vcs_tags") return Promise.resolve([]);
        if (cmd === "vcs_merge_base") return Promise.resolve(mergeBase);
        if (cmd === "vcs_diff_revisions") {
          prStats.diffCalls += 1;
          return Promise.resolve(files.map((f) => ({ ...f })));
        }
        if (cmd === "graph_rev_counts") {
          prStats.countCalls += 1;
          const { base, head } = args as { base: string; head: string };
          if (base === "main" && head === "feature") return Promise.resolve({ ahead, behind });
          if (base === "feature" && head === "main") return Promise.resolve({ ahead: behind, behind: ahead });
          return Promise.resolve({ ahead: 0, behind: 0 });
        }
        if (cmd === "vcs_remotes") return Promise.resolve([]);
        if (cmd === "graph_stashes") return Promise.resolve([]);
        if (cmd === "graph_working_state")
          return Promise.resolve({ staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });
        if (cmd === "graph_bisect_state")
          return Promise.resolve({ active: false, current: null, culprit: null, output: "" });
        if (cmd === "vcs_log") {
          const { skip, limit, range } = (args as { query: LogQuery }).query;
          if (!range) {
            const graphTotal = Math.min(ahead, 300);
            const start = Math.min(skip, graphTotal);
            const end = limit > 0 ? Math.min(graphTotal, start + limit) : graphTotal;
            return Promise.resolve(Array.from({ length: end - start }, (_, i) => commit(start + i, graphTotal)));
          }
          prStats.logCalls += 1;
          const total = range === "main..feature" ? ahead : range === "feature..main" ? behind : 0;
          const start = Math.min(skip, total);
          const end = limit > 0 ? Math.min(total, start + limit) : total;
          const page = Array.from({ length: end - start }, (_, i) => commit(start + i, total));
          prStats.commitsFetched += page.length;
          return Promise.resolve(page);
        }
        return null;
      });
    },
    triggerPrRefresh() {
      bumpPrRefresh?.();
    },
    prRefreshStats: () => ({ ...prStats }),
    resetPrRefreshStats() {
      prStats = { logCalls: 0, commitsFetched: 0, countCalls: 0, diffCalls: 0 };
    },
    fakeHttpResponse(shape, bytes) {
      if (!bytes) return setRoute("http", null);
      const body = httpBody(shape, bytes);
      const contentType = shape === "xml" ? "application/xml" : shape === "text" ? "text/plain" : "application/json";
      const url = `http://localhost:8080/api/${shape}`;
      const entry: HttpHistoryEntry = {
        id: `perf-${shape}-${bytes}`,
        timeMs: Date.UTC(2026, 10, 5),
        name: null,
        method: "GET",
        url,
        status: 200,
        totalMs: 120,
        file: null,
        error: null,
      };
      const exchange: HttpExchange = {
        entry,
        request: { name: null, method: "GET", url, headers: [], body: null },
        response: {
          status: 200,
          statusText: "OK",
          version: "HTTP/1.1",
          headers: [["content-type", contentType]],
          contentType,
          body,
          size: body.length,
          truncated: false,
          ttfbMs: 40,
          totalMs: 120,
        },
      };
      setRoute("http", (cmd) => {
        if (cmd === "http_history") return Promise.resolve([entry]);
        if (cmd === "http_history_get") return Promise.resolve(exchange);
        return null;
      });
    },
    async openCombinedDiff(files, bigLines) {
      const dir = (i: number) => `${PERF_ROOT}/src/gen/pkg${Math.floor(i / 50)}`;
      const bigAt = Math.floor(files / 3);
      const editAt = Math.floor(files / 2);
      const path = (i: number) =>
        i === bigAt
          ? `${dir(i)}/Generated${i}.ts`
          : i % 25 === 24
            ? `${dir(i)}/image${i}.png`
            : `${dir(i)}/File${i}.ts`;
      const big = path(bigAt);
      const editable = path(editAt);
      const lines = (i: number) => (i === bigAt ? bigLines : i % 100 === 50 ? 2_000 : 40);
      const index = new Map(Array.from({ length: files }, (_, i) => [path(i), i]));
      const items = Array.from({ length: files }, (_, i) => {
        const p = path(i);
        const worktree = i === editAt || p.endsWith(".png");
        return {
          path: p,
          left: { type: "rev", rev: "HEAD~1" },
          right: worktree ? { type: "worktree" } : { type: "rev", rev: "HEAD" },
        };
      });
      const backend = docBackend() as Partial<MemoryBackend>;
      if (!backend.files) throw new Error("openCombinedDiff() needs the in-memory backend");
      backend.files.set(editable, combinedSource(editAt, lines(editAt), "HEAD"));
      for (const item of items)
        if (item.path.endsWith(".png")) backend.files.set(item.path, "\u0089PNG\r\n\u001a\n\u0000");
      setRoute("combinedDiff", (cmd, args) => {
        const { path: p, rev } = (args ?? {}) as { path?: string; rev?: string | null };
        const i = p == null ? undefined : index.get(p);
        if (i === undefined) return null;
        if (cmd === "vcs_file_mode") return Promise.resolve("100644");
        if (cmd === "fs_probe") return Promise.resolve({ size: 1024, binary: p!.endsWith(".png"), tooLarge: false });
        if (cmd === "vcs_file_at")
          return Promise.resolve(
            p!.endsWith(".png")
              ? "\u0089PNG\r\n\u001a\n\u0000"
              : combinedSource(i, lines(i), rev === "HEAD" ? "HEAD" : "base", i === bigAt && rev === "HEAD"),
          );
        return null;
      });
      await editorService().openInput({
        kind: "combined-diff",
        key: `combined-diff:perf:${files}`,
        path: items[0]?.path ?? "",
        data: { items, title: "Combined Changes Diff" },
      });
      return { big, editable };
    },
    unsaved(path) {
      const dirty = new Set(editorService().dirtyDocumentIds?.() ?? []);
      return editorsFor(path).some((e) => dirty.has(e.ctx.doc));
    },
    insertAfter(after, text) {
      const view = requireView();
      const at = view.state.doc.toString().indexOf(after);
      if (at < 0) throw new Error(`no ${JSON.stringify(after)} in the active editor`);
      const from = at + after.length;
      view.dispatch({ changes: { from, insert: text }, userEvent: "input" });
      return from + text.length;
    },
    setText(text) {
      const view = requireView();
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: "input" });
    },
    completions: () => currentCompletions(requireView().state).map((c) => c.label),
    completionPending: () => completionStatus(requireView().state) === "pending",
    diagnostics() {
      const found: Array<{ line: number; severity: string; message: string }> = [];
      const state = activeEditor()?.view.state;
      if (!state) return found;
      forEachDiagnostic(state, (d, from) =>
        found.push({ line: state.doc.lineAt(from).number - 1, severity: d.severity, message: d.message }),
      );
      return found;
    },
    lineAtY(y) {
      const view = activeEditor()?.view;
      if (!view) return -1;
      const block = view.lineBlockAtHeight(y - view.documentTop);
      return view.state.doc.lineAt(block.from).number - 1;
    },
    editorState() {
      const e = activeEditor();
      if (!e) return null;
      const { doc, selection } = e.view.state;
      const head = selection.main.head;
      const word = e.view.state.wordAt(head);
      return {
        path: e.ctx.path,
        doc: e.ctx.doc,
        length: doc.length,
        lines: doc.lines,
        head,
        line: doc.lineAt(head).number - 1,
        col: head - doc.lineAt(head).from,
        word: word ? doc.sliceString(word.from, word.to) : "",
      };
    },
  };
  const w = window as unknown as { __openideaPerf?: PerfProbe };
  w.__openideaPerf = probe;
  return () => {
    stopDiagnostics?.();
    restorePrBridge?.();
    restorePrBridge = null;
    delete w.__openideaPerf;
  };
}
