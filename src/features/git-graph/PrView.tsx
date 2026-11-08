/**
 * The PR view: what a pull request from one branch into another would contain, computed locally
 * with the forge's three-dot semantics (merge base ↔ head), whatever the remote is hosted on.
 */
import { Suspense, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import type { Branch, ChangedFile, Commit } from "@/bindings";
import { formatDay } from "@/platform/dateFormat";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { EmptyState, Icon, IconButton, SplitGroup, SplitHandle, SplitPanel, Spinner, T } from "@/ui";
import { useContributions } from "@/workbench/contributions";
import { gitGraphBridge } from "@/workbench/gitGraphBridge";
import { KIND_LETTER } from "./Details";
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
      (data) => live && setValue({ key, data }),
      (e: unknown) =>
        live && setValue({ key, data: { status: "error", error: String(e instanceof Error ? e.message : e) } }),
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
        <span className={styles.prSide}>
          <T>base</T>
        </span>
        {refButton("base", base)}
        <IconButton
          icon="arrow-left"
          title="Swap Base and Head"
          disabled={!base}
          onClick={() => base && setPrChoice(repo, { base: head, head: base, file: null })}
        />
        <span className={styles.prSide}>
          <T>head</T>
        </span>
        {refButton("head", head)}
        <span className={styles.spacer} />
        {ready ? (
          <IconButton
            icon="copy"
            title="ClipCode: Copy Changed Files"
            disabled={!ready.files.length}
            onClick={() => void bridge?.copyRange(repo, ready.mergeBase, head)}
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
          <PrCommits repo={repo} commits={data.commits} />
        )}
      </div>
    </>
  );
}

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
  const index = Math.max(
    0,
    files.findIndex((f) => f.path === p.file),
  );
  const selected = files[index] ?? null;
  const from = useMemo(() => ({ rev: mergeBase, label: tx`merge-base (${base})` }), [mergeBase, base]);
  const to = useMemo(() => ({ rev: head, label: head }), [head]);
  const input = useMemo(
    () => (selected && bridge ? bridge.revisionDiffInput(repo, from, to, selected) : null),
    [bridge, repo, from, to, selected],
  );
  if (!files.length) return <EmptyState title="No changes" className={styles.empty} />;
  const open = (i: number) => void bridge?.openRevisionDiff(repo, from, to, files, i);
  return (
    <SplitGroup orientation="horizontal" id="git-graph-pr">
      <SplitPanel id="files" defaultSize="30%" minSize="15%">
        <div className={styles.prFiles} role="list" aria-label={tx("Changed Files")}>
          {files.map((f, i) => (
            <div
              key={f.path}
              role="listitem"
              tabIndex={0}
              aria-selected={i === index}
              className={clsx(styles.file, i === index && styles.selected)}
              onClick={() => setPrChoice(repo, { file: f.path })}
              onDoubleClick={() => open(i)}
              onKeyDown={(e) => {
                if (e.key === "Enter") open(i);
              }}
              title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
            >
              <span className={clsx(styles.kind, styles[`kind_${f.kind}`])}>{KIND_LETTER[f.kind] ?? "?"}</span>
              <span className={styles.fileName}>{f.path.split("/").pop()}</span>
              <span className={styles.fileDir}>
                {f.oldPath
                  ? `${f.oldPath} → ${f.path}`
                  : f.path.includes("/")
                    ? f.path.slice(0, f.path.lastIndexOf("/"))
                    : ""}
              </span>
            </div>
          ))}
        </div>
      </SplitPanel>
      <SplitHandle />
      <SplitPanel id="diff" minSize="30%">
        <div className={styles.prDiff}>
          <div className={styles.treeBar}>
            <span className={styles.fileDir}>{selected?.path}</span>
            <span className={styles.spacer} />
            <IconButton icon="external-link" title="Open Diff" onClick={() => open(index)} />
          </div>
          {input && diffViewer ? (
            <Suspense fallback={<Spinner size={16} />}>
              <diffViewer.component input={input} />
            </Suspense>
          ) : null}
        </div>
      </SplitPanel>
    </SplitGroup>
  );
}

function PrCommits({ repo, commits }: { repo: string; commits: Commit[] }) {
  if (!commits.length) return <EmptyState title="No commits" className={styles.empty} />;
  return (
    <div className={styles.prCommits} role="list" aria-label={tx("Commits")}>
      {commits.map((c) => (
        <div key={c.id} role="listitem">
          <button
            type="button"
            className={styles.prCommit}
            title={tx("Show in Graph")}
            onClick={() => useGraphView.setState({ mode: "graph", selection: { repo, ids: [c.id] }, panel: "details" })}
          >
            <span className={styles.subject}>{c.summary}</span>
            <span className={styles.prCommitMeta}>{c.author}</span>
            <span className={styles.prCommitMeta}>{c.timeMs ? formatDay(new Date(c.timeMs)) : ""}</span>
            <span className={clsx(styles.prCommitMeta, styles.mono)}>{c.shortId}</span>
          </button>
        </div>
      ))}
    </div>
  );
}
