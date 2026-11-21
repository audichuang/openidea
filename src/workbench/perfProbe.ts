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
import { activeEditor } from "@/editor/api";
import { docBackend, type MemoryBackend } from "@/editor/core/backend";
import type { Branch, Commit, CompletionItem, CompletionKind, LogQuery } from "@/bindings";
import { openProject } from "@/platform/project";
import { setInvokeRoute } from "@/platform/tauriCore";
import { editorService } from "./contributions";
import { gitGraphBridge, provideGitGraphBridge, type GitGraphBridge } from "./gitGraphBridge";

export interface PerfProbe {
  /** Seeds file contents for the in-memory document backend (plain-browser mode). */
  seed(path: string, text: string): void;
  openFile(path: string): Promise<void>;
  /** Opens project `path` in this window (as the welcome screen does), without the window chooser. */
  openProject(path: string): Promise<void>;
  runAction(id: string, arg?: unknown): Promise<boolean>;
  /** Effective keymap bindings of an action, e.g. `["Ctrl+Shift+A"]`. */
  bindings(id: string): string[];
  /** Moves the caret of the active editor and focuses it. */
  setCursor(offset: number): void;
  /** True while the active editor's background syntax parser still has work. */
  parsing(): boolean;
  /** The active editor's text. */
  editorText(): string | null;
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
  editorState(): { path: string; length: number; lines: number; head: number; line: number; word: string } | null;
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
   * Answers the Git Graph PR view with `commits` generated commits between `main`
   * and `feature`. `0` commits removes it and restores the real bridge.
   */
  fakePrCommits(commits: number): void;
}

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
  let restorePrBridge: (() => void) | null = null;
  const probe: PerfProbe = {
    seed(path, text) {
      const backend = docBackend() as Partial<MemoryBackend>;
      if (!backend.files) throw new Error("seed() needs the in-memory backend");
      backend.files.set(path, text);
    },
    openFile: (path) => editorService().openFile(path),
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
        if (cmd === "vcs_log") {
          const { skip, limit, range } = (args as { query: LogQuery }).query;
          if (range === "main..feature") return Promise.resolve(commits);
          if (range === "feature..main") return Promise.resolve([]);
          return Promise.resolve(commits.slice(skip, limit ? skip + limit : undefined));
        }
        return null;
      });
    },
    editorText: () => activeEditor()?.view.state.doc.toString() ?? null,
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
        length: doc.length,
        lines: doc.lines,
        head,
        line: doc.lineAt(head).number - 1,
        word: word ? doc.sliceString(word.from, word.to) : "",
      };
    },
  };
  const w = window as unknown as { __openideaPerf?: PerfProbe };
  w.__openideaPerf = probe;
  return () => {
    restorePrBridge?.();
    restorePrBridge = null;
    delete w.__openideaPerf;
  };
}
