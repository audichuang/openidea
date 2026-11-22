/**
 * The PR view: what a pull request from one branch into another would contain, computed locally
 * with the forge's three-dot semantics (merge base ↔ head), whatever the remote is hosted on.
 */
import {
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import clsx from "clsx";
import type { Branch, ChangedFile, Commit } from "@/bindings";
import { formatDay } from "@/platform/dateFormat";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import {
  EmptyState,
  Icon,
  IconButton,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Spinner,
  T,
  Tree,
  fileIconName,
} from "@/ui";
import { buildFileTree, dirKeys, type FileTreeNode } from "@/features/vcs/fileTree";
import { baseName, fileCount, KIND_COLOR } from "@/features/vcs/model";
import { useContributions } from "@/workbench/contributions";
import { gitGraphBridge } from "@/workbench/gitGraphBridge";
import { usePaneList } from "./panels";
import { PickerPopup, type PickerItem } from "./PickerPopup";
import { prChoice, setPrChoice, useGraphView } from "./viewState";
import styles from "./GitGraph.module.css";

interface Refs {
  branches: Branch[];
  tags: string[];
}

/** Branches and tags of `repo`, refreshed with the vcs state. */
function useRefs(repo: string, version: number): Refs | null {
  const [value, setValue] = useState<{ repo: string; refs: Refs } | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([
      call(commands.vcsBranches(repo)).catch((): Branch[] => []),
      call(commands.vcsTags(repo)).catch((): string[] => []),
    ]).then(([branches, tags]) => live && setValue({ repo, refs: { branches, tags } }));
    return () => {
      live = false;
    };
  }, [repo, version]);
  return value?.repo === repo ? value.refs : null;
}

const BASE_CANDIDATES = ["main", "master", "develop"];

/**
 * Base and head while nothing is remembered for the repository: head is the current branch
 * (`HEAD` when detached); base is the first of main / master / develop other than head that
 * exists as a local branch, else as `origin/<name>`, else none (the user picks one). The branch
 * list does not tell which branch the remote's HEAD points at, so that is not consulted.
 */
export function defaultPrRefs(
  branches: readonly Branch[],
  current: string | null,
): { base: string | null; head: string } {
  const head = current ?? "HEAD";
  const has = (name: string, remote: boolean) => branches.some((b) => b.name === name && b.remote === remote);
  const local = BASE_CANDIDATES.find((n) => n !== head && has(n, false));
  const remote = BASE_CANDIDATES.map((n) => `origin/${n}`).find((n) => n !== head && has(n, true));
  return { base: local ?? remote ?? null, head };
}

type PrData =
  | { status: "loading" }
  | { status: "same" }
  | { status: "unrelated" }
  | { status: "error"; error: string }
  | { status: "ready"; mergeBase: string; files: ChangedFile[]; commits: Commit[]; behind: number };

const range = (repo: string, from: string, to: string) =>
  call(
    commands.vcsLog(repo, {
      branch: null,
      path: null,
      author: null,
      text: null,
      range: `${from}..${to}`,
      skip: 0,
      limit: 0,
    }),
  );

/**
 * The previous result when a reload computed the same one: every vcs refresh reloads, and new
 * objects would rebuild the embedded diff each time (#362).
 */
function keepIfSame(
  prev: { key: string; data: PrData } | null,
  key: string,
  data: PrData,
): { key: string; data: PrData } {
  return prev?.key === key && JSON.stringify(prev.data) === JSON.stringify(data) ? prev : { key, data };
}

/** Files and commits of a pull request from `head` into `base`; the last result stays while a refresh loads. */
function usePrData(repo: string, base: string | null, head: string, version: number, reload: number): PrData | null {
  const key = `${repo}\0${base ?? ""}\0${head}`;
  const [value, setValue] = useState<{ key: string; data: PrData } | null>(null);
  useEffect(() => {
    if (!base || base === head) return;
    let live = true;
    void (async (): Promise<PrData> => {
      const mergeBase = await call(commands.vcsMergeBase(repo, base, head));
      if (!mergeBase) return { status: "unrelated" };
      const [files, commits, behind] = await Promise.all([
        call(commands.vcsDiffRevisions(repo, mergeBase, head)),
        range(repo, base, head),
        range(repo, head, base),
      ]);
      return { status: "ready", mergeBase, files, commits, behind: behind.length };
    })().then(
      (data) => live && setValue((prev) => keepIfSame(prev, key, data)),
      (e: unknown) =>
        live &&
        setValue((prev) =>
          keepIfSame(prev, key, { status: "error", error: String(e instanceof Error ? e.message : e) }),
        ),
    );
    return () => {
      live = false;
    };
  }, [repo, base, head, key, version, reload]);
  if (!base) return null;
  if (base === head) return { status: "same" };
  return value?.key === key ? value.data : { status: "loading" };
}

/** Picker entries: HEAD, then local and remote branches, then tags. */
function refItems(refs: Refs | null, checked: string | null): PickerItem[] {
  const item = (value: string, section: string, icon: Parameters<typeof Icon>[0]["name"]): PickerItem => ({
    value,
    label: value,
    section,
    icon: <Icon name={icon} size={14} />,
    checked: value === checked,
  });
  const branches = refs?.branches ?? [];
  return [
    item("HEAD", "HEAD", "current-branch"),
    ...branches.filter((b) => !b.remote).map((b) => item(b.name, tx("Local"), "branch")),
    ...branches.filter((b) => b.remote && !b.name.endsWith("/HEAD")).map((b) => item(b.name, tx("Remote"), "branch")),
    ...(refs?.tags ?? []).map((t) => item(t, tx("Tags"), "tag")),
  ];
}

export function PrView(p: {
  repo: string;
  /** The repository's current branch; null when detached. */
  current: string | null;
  version: number;
  /** Bumped by the toolbar's Refresh. */
  reload: number;
}) {
  const { repo, current } = p;
  const choice = useGraphView((s) => prChoice(s, repo));
  const refs = useRefs(repo, p.version);
  const defaults = useMemo(() => defaultPrRefs(refs?.branches ?? [], current), [refs, current]);
  const head = choice.head ?? defaults.head;
  const base = choice.base ?? (refs ? defaults.base : null);
  const data = usePrData(repo, base, head, p.version, p.reload);
  const [picker, setPicker] = useState<{ side: "base" | "head"; anchor: HTMLElement } | null>(null);
  const bridge = gitGraphBridge();
  const ready = data?.status === "ready" ? data : null;

  const refButton = (side: "base" | "head", value: string | null) => (
    <button
      type="button"
      className={clsx(styles.dropdown, styles.prRef)}
      onClick={(e) => setPicker({ side, anchor: e.currentTarget })}
      aria-label={side === "base" ? tx("Base Branch") : tx("Head Branch")}
      aria-haspopup="dialog"
    >
      <Icon name="branch" size={14} />
      <span>{value ?? tx("Choose…")}</span>
      <Icon name="chevron-down" size={12} />
    </button>
  );

  return (
    <div className={styles.pr}>
      <div className={styles.prHeader}>
        {/* Left to right: the branch the pull request comes from, then the one it goes into. */}
        <span className={styles.prSide}>
          <T>From</T>
        </span>
        {refButton("head", head)}
        <IconButton
          icon="arrow-right"
          title="Swap Base and Head"
          disabled={!base}
          onClick={() => base && setPrChoice(repo, { base: head, head: base, file: null })}
        />
        <span className={styles.prSide}>
          <T>into</T>
        </span>
        {refButton("base", base)}
        <span className={styles.spacer} />
        {ready ? (
          <IconButton
            icon="copy"
            title="ClipCode: Copy Changed Files"
            disabled={!ready.files.length}
            onClick={() => ready.commits[0] && void bridge?.copyRange(repo, ready.mergeBase, ready.commits[0].id)}
          />
        ) : null}
      </div>
      {picker ? (
        <PickerPopup
          anchor={picker.anchor}
          items={refItems(refs, picker.side === "base" ? base : head)}
          onPick={(value) => setPrChoice(repo, { [picker.side]: value, file: null })}
          onClose={() => setPicker(null)}
          label="Branches and Tags"
          placeholder="Search branches and tags"
          emptyLabel="No matching branches or tags"
        />
      ) : null}
      <PrBody repo={repo} base={base} head={head} data={data} tab={choice.tab} file={choice.file} refsLoaded={!!refs} />
    </div>
  );
}

function PrBody(p: {
  repo: string;
  base: string | null;
  head: string;
  data: PrData | null;
  tab: "files" | "commits";
  file: string | null;
  refsLoaded: boolean;
}) {
  const { repo, base, head, data } = p;
  if ((!base || !data) && p.refsLoaded)
    return <EmptyState title="Choose a base branch to compare" className={styles.empty} />;
  if (!base || !data || data.status === "loading")
    return <EmptyState title={<Spinner size={16} />} className={styles.empty} />;
  if (data.status === "same") return <EmptyState title="Base and head are the same" className={styles.empty} />;
  if (data.status === "unrelated")
    return (
      <EmptyState title="No common history" className={styles.empty}>
        {tx`${base} and ${head} have no common commit to compare from.`}
      </EmptyState>
    );
  if (data.status === "error")
    return (
      <div className={styles.error} role="alert">
        {data.error}
      </div>
    );
  const ahead = data.commits.length;
  const behind = data.behind;
  return (
    <>
      <div className={styles.prSummary} role="status">
        {tx`Commits: ${ahead} ahead, ${behind} behind ${base}`}
      </div>
      <div className={styles.paneTabs} role="tablist" aria-label={tx("Pull Request")}>
        {(["files", "commits"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={p.tab === tab}
            className={clsx(styles.paneTab, p.tab === tab && styles.paneTabActive)}
            onClick={() => setPrChoice(repo, { tab })}
          >
            {tab === "files" ? <T>Files</T> : <T>Commits</T>}
            <span className={styles.prCount}>{tab === "files" ? data.files.length : ahead}</span>
          </button>
        ))}
      </div>
      <div className={styles.prBody}>
        {p.tab === "files" ? (
          <PrFiles repo={repo} base={base} head={head} mergeBase={data.mergeBase} files={data.files} file={p.file} />
        ) : (
          <PrCommits repo={repo} commits={data.commits} resetKey={`${repo}\0${base}\0${head}`} />
        )}
      </div>
    </>
  );
}

type FileNode = FileTreeNode<ChangedFile>;

/** The files of a tree in display order (the F7 chain and the default selection follow it). */
function treeFiles(nodes: readonly FileNode[], out: ChangedFile[] = []): ChangedFile[] {
  for (const n of nodes) {
    if (n.file) out.push(n.file);
    else treeFiles(n.children, out);
  }
  return out;
}

const NO_KEYS: ReadonlySet<string> = new Set();

function PrFiles(p: {
  repo: string;
  base: string;
  head: string;
  mergeBase: string;
  files: ChangedFile[];
  file: string | null;
}) {
  const { repo, base, head, mergeBase, files } = p;
  const bridge = gitGraphBridge();
  const diffViewer = useContributions((s) => s.editorKinds.get("diff"));
  // Grouped by directory like the GitHub pull request's Changes tree; everything starts expanded.
  const roots = useMemo(() => buildFileTree(files, (f) => f.path), [files]);
  const ordered = useMemo(() => treeFiles(roots), [roots]);
  const allDirs = useMemo(() => dirKeys(roots), [roots]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(NO_KEYS);
  const expanded = useMemo(() => new Set(allDirs.filter((k) => !collapsed.has(k))), [allDirs, collapsed]);
  const index = Math.max(
    0,
    ordered.findIndex((f) => f.path === p.file),
  );
  const selected = ordered[index] ?? null;
  const from = useMemo(() => ({ rev: mergeBase, label: tx`merge-base (${base})` }), [mergeBase, base]);
  const to = useMemo(() => ({ rev: head, label: head }), [head]);
  // F7 / Shift+F7 past the last / first difference moves along the tree here, not to a new tab.
  const [reveal, setReveal] = useState<{ path: string; at: "first" | "last" } | null>(null);
  // A directory row picked in the tree: it shows as selected while the diff keeps the last file.
  const [dirPick, setDirPick] = useState<string | null>(null);
  const input = useMemo(
    () =>
      selected && bridge
        ? bridge.revisionDiffInput(repo, from, to, selected, {
            files: ordered,
            reveal: reveal?.path === selected.path ? reveal.at : undefined,
            onNeighbour: (file, at) => {
              setDirPick(null);
              setReveal({ path: file.path, at });
              setPrChoice(repo, { file: file.path });
            },
          })
        : null,
    [bridge, repo, from, to, selected, ordered, reveal],
  );
  if (!files.length) return <EmptyState title="No changes" className={styles.empty} />;
  const open = (file: ChangedFile) => void bridge?.openRevisionDiff(repo, from, to, ordered, ordered.indexOf(file));
  return (
    <SplitGroup orientation="horizontal" id="git-graph-pr">
      <SplitPanel id="files" defaultSize="30%" minSize="15%">
        <Tree<FileNode>
          roots={roots}
          getKey={(n) => n.key}
          getLabel={(n) => n.name}
          getChildren={(n) => (n.file ? undefined : n.children)}
          isExpandable={(n) => !n.file}
          expanded={expanded}
          onExpandedChange={(next) => setCollapsed(new Set(allDirs.filter((k) => !next.has(k))))}
          selected={dirPick ? new Set([dirPick]) : selected ? new Set([`f:${selected.path}`]) : NO_KEYS}
          multiSelect={false}
          onSelectionChange={(_sel, lead) => {
            if (!lead) return;
            if (!lead.file) {
              setDirPick(lead.key);
              return;
            }
            // A pick in the tree shows the file from its top; only F7 / Shift+F7 select a difference.
            setDirPick(null);
            setReveal(null);
            setPrChoice(repo, { file: lead.file.path });
          }}
          onActivate={(n) => n.file && open(n.file)}
          // Rows as in the GitHub pull request's Changes tree (`github/details/ChangesTree.tsx`).
          renderNode={(n) =>
            n.file ? (
              <span
                className={styles.fileRow}
                title={n.file.oldPath ? `${n.file.oldPath} → ${n.file.path}` : n.file.path}
              >
                <Icon name={fileIconName(n.name)} size={16} className={styles.fileIcon} />
                <span className={styles.fileName} style={{ color: KIND_COLOR[n.file.kind] }}>
                  {n.name}
                </span>
                {n.file.oldPath && (
                  <span className={styles.fileDir}>{tx`renamed from ${baseName(n.file.oldPath)}`}</span>
                )}
              </span>
            ) : (
              <span className={styles.fileRow}>
                <Icon name="folder" size={16} className={styles.fileIcon} />
                <span className={styles.fileName}>{n.name}</span>
                <span className={styles.fileDir}>{fileCount(n.count)}</span>
              </span>
            )
          }
          speedSearch
          aria-label={tx("Changed Files")}
          className={styles.prFiles}
        />
      </SplitPanel>
      <SplitHandle />
      <SplitPanel id="diff" minSize="30%">
        <div className={styles.prDiff}>
          <div className={styles.treeBar}>
            <span className={styles.fileDir}>{selected?.path}</span>
            <span className={styles.spacer} />
            <IconButton icon="external-link" title="Open Diff" onClick={() => selected && open(selected)} />
          </div>
          {input && diffViewer ? (
            <Suspense fallback={<Spinner size={16} />}>
              {/* Keyed: reusing one viewer across files rebuilt its panes several times per switch (#226). */}
              <diffViewer.component key={input.key} input={input} />
            </Suspense>
          ) : null}
        </div>
      </SplitPanel>
    </SplitGroup>
  );
}

function PrCommits({ repo, commits, resetKey }: { repo: string; commits: Commit[]; resetKey: string }) {
  if (!commits.length) return <EmptyState title="No commits" className={styles.empty} />;
  return <PrCommitList repo={repo} commits={commits} resetKey={resetKey} />;
}

function PrCommitList({ repo, commits, resetKey }: { repo: string; commits: Commit[]; resetKey: string }) {
  const [activeRow, setActiveRow] = useState<{ key: string; index: number }>({ key: "", index: -1 });
  const active = activeRow.key === resetKey && activeRow.index < commits.length ? activeRow.index : -1;
  const reveal = useCallback(
    (id: string) => useGraphView.setState({ mode: "graph", selection: { repo, ids: [id] }, panel: "details" }),
    [repo],
  );
  const { scrollRef, rows, height, listProps, rowProps } = usePaneList({
    count: commits.length,
    resetKey,
    version: resetKey,
    active,
    setActive: (index) => setActiveRow({ key: resetKey, index }),
    open: (index) => {
      const c = commits[index];
      if (c) reveal(c.id);
    },
  });
  const title = tx("Show in Graph");
  // Rows used to be buttons, which Space activates; keep that by routing Space through the Enter path.
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== " ") return listProps.onKeyDown(e);
    e.preventDefault();
    if (e.repeat) return;
    listProps.onKeyDown({ ...e, key: "Enter" } as ReactKeyboardEvent);
  };
  return (
    <div ref={scrollRef} className={styles.prCommits} aria-label={tx("Commits")} {...listProps} onKeyDown={onKeyDown}>
      <div role="presentation" className={styles.virtualRows} style={{ height }}>
        {rows.map((v) => {
          const c = commits[v.index]!;
          const rp = rowProps(v.index);
          return (
            <PrCommitRow
              key={c.id}
              commit={c}
              id={rp.id}
              posInSet={rp["aria-posinset"]}
              setSize={rp["aria-setsize"]}
              start={v.start}
              selected={v.index === active}
              title={title}
              onReveal={reveal}
            />
          );
        })}
      </div>
    </div>
  );
}

const PrCommitRow = memo(function PrCommitRow({
  commit: c,
  id,
  posInSet,
  setSize,
  start,
  selected,
  title,
  onReveal,
}: {
  commit: Commit;
  id: string;
  posInSet: number;
  setSize: number;
  start: number;
  selected: boolean;
  title: string;
  onReveal: (id: string) => void;
}) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      aria-setsize={setSize}
      aria-posinset={posInSet}
      className={clsx(styles.prCommit, styles.virtualRow, selected && styles.selected)}
      style={{ transform: `translateY(${start}px)` }}
      title={title}
      onClick={() => onReveal(c.id)}
    >
      <span className={styles.subject}>{c.summary}</span>
      <span className={styles.prCommitMeta}>{c.author}</span>
      <span className={styles.prCommitMeta}>{c.timeMs ? formatDay(new Date(c.timeMs)) : ""}</span>
      <span className={clsx(styles.prCommitMeta, styles.mono)}>{c.shortId}</span>
    </div>
  );
});
