import type { Commit } from "@/bindings";
import { writeClipboardText } from "@/platform/clipboard";
import { tx } from "@/platform/i18n";
import clsx from "clsx";
import styles from "../GitLog.module.css";
import { IssueText } from "../issueLinks";
import { useCommitDetails } from "../logDetails";
import { refLabels } from "../logOptions";
import { goToRef } from "../logStore";
import { commitRepo } from "../multiRoot";
import { currentRepo } from "../store";

const REF_KIND_CLASS = {
  head: styles.refHead,
  local: styles.refLocal,
  remote: styles.refRemote,
  tag: styles.refTag,
};

const NO_REMOTES: ReadonlySet<string> = new Set();

export function RefLabels({
  refs,
  compact = false,
  tagNames = true,
  remoteNames = NO_REMOTES,
  left = false,
}: {
  refs: string[];
  compact?: boolean;
  tagNames?: boolean;
  remoteNames?: ReadonlySet<string>;
  left?: boolean;
}) {
  const labels = refLabels(refs, { compact, tagNames }, remoteNames);
  return (
    <span className={clsx(styles.refs, left && styles.refsLeft)}>
      {labels.map((l) => (
        <span key={`${l.kind}:${l.title}`} className={clsx(styles.ref, REF_KIND_CLASS[l.kind])} title={l.title}>
          {l.text}
        </span>
      ))}
    </span>
  );
}

/** A commit's message and metadata; `compact` (one of several selected): without the body. */
export function CommitMessage({ commit, compact = false }: { commit: Commit; compact?: boolean }) {
  const { details, error } = useCommitDetails(commit, !compact);
  const repo = commitRepo(commit) ?? currentRepo();
  const message = details?.message || commit.message;
  const [subject, ...bodyLines] = message.replace(/\s+$/, "").split("\n");
  const body = compact ? "" : bodyLines.join("\n").replace(/^\n+/, "");
  return (
    <div className={clsx(compact && styles.commitEntry)}>
      <div className={styles.subjectLine}>
        <CommitMessageText text={subject ?? ""} repo={repo} />
      </div>
      {body && (
        <div className={styles.fullMessage}>
          <CommitMessageText text={body} repo={repo} />
        </div>
      )}
      <div className={clsx(styles.meta, compact && styles.metaCompact)}>
        <button
          type="button"
          className={clsx(styles.linkButton, styles.hash)}
          title={tx("Copy revision number")}
          onClick={() => void writeClipboardText(commit.id)}
        >
          {commit.shortId}
        </button>{" "}
        {commit.author} &lt;{commit.email}&gt;
        {commit.timeMs ? " " + tx`on ${new Date(commit.timeMs).toLocaleString()}` : ""}
      </div>
      {!compact &&
        commit.committer &&
        (commit.committer !== commit.author ||
          commit.committerEmail !== commit.email ||
          commit.commitTimeMs !== commit.timeMs) && (
          <div className={styles.meta}>
            {tx("Committed by")} {commit.committer} &lt;{commit.committerEmail}&gt;{" "}
            {commit.commitTimeMs ? new Date(commit.commitTimeMs).toLocaleString() : ""}
          </div>
        )}
      {commit.parents.length > 0 && (
        <div className={styles.meta}>
          {tx(commit.parents.length > 1 ? "Merge of" : "Parent")}{" "}
          {commit.parents.map((id, i) => (
            <span key={id}>
              {i > 0 ? ", " : ""}
              <button type="button" className={styles.linkButton} onClick={() => void goToRef(id, repo)}>
                {id.slice(0, 8)}
              </button>
            </span>
          ))}
        </div>
      )}
      {details && (
        <>
          <div className={styles.meta}>
            {tx("Containing branches")}:{" "}
            {details.containingBranches.length
              ? details.containingBranches.map((branch, i) => (
                  <span key={branch}>
                    {i > 0 ? ", " : ""}
                    <button type="button" className={styles.linkButton} onClick={() => void goToRef(branch, repo)}>
                      {branch}
                    </button>
                  </span>
                ))
              : tx("None")}
          </div>
          <div
            className={styles.meta}
            title={[details.signer, details.key, details.fingerprint].filter(Boolean).join("\n")}
          >
            {tx("Signature")}: {signatureLabel(details.signature)}
            {details.signer ? ` · ${details.signer}` : ""}
          </div>
        </>
      )}
      {error && (
        <div role="status" className={styles.meta}>
          {tx("Could not load containing branches or signature details")}
        </div>
      )}
      {commit.refs.length > 0 && (
        <div className={styles.meta}>
          <RefLabels refs={commit.refs} />
        </div>
      )}
    </div>
  );
}

/** Plain text of a compact commit entry, matching what `CommitMessage` renders when `compact` is true. */
export function compactCommitText(commit: Commit): string {
  const [subject] = commit.message.replace(/\s+$/, "").split("\n");
  const date = commit.timeMs ? " " + tx`on ${new Date(commit.timeMs).toLocaleString()}` : "";
  const lines = [subject ?? "", `${commit.shortId} ${commit.author} <${commit.email}>${date}`];
  if (commit.parents.length > 0) {
    const label = tx(commit.parents.length > 1 ? "Merge of" : "Parent");
    lines.push(`${label} ${commit.parents.map((id) => id.slice(0, 8)).join(", ")}`);
  }
  if (commit.refs.length > 0) {
    const refs = refLabels(commit.refs, { compact: false, tagNames: true }, NO_REMOTES)
      .map((l) => l.text)
      .filter(Boolean)
      .join(" ");
    if (refs) lines.push(refs);
  }
  return lines.join("\n");
}

function signatureLabel(code: string) {
  return tx(
    (
      {
        G: "Verified",
        U: "Good signature with unknown trust",
        B: "Bad signature",
        E: "Could not verify",
        N: "Unsigned",
        X: "Expired signature",
        Y: "Expired signing key",
        R: "Revoked signing key",
      } as Record<string, string>
    )[code] ?? "Could not verify",
  );
}

export function CommitSignature({ commit }: { commit: Commit }) {
  const { details, error } = useCommitDetails(commit);
  return (
    <span title={details ? [details.signer, details.key, details.fingerprint].filter(Boolean).join("\n") : undefined}>
      {details ? signatureLabel(details.signature) : error ? tx("Could not verify") : tx("Loading…")}
    </span>
  );
}

function CommitMessageText({ text, repo }: { text: string; repo: string | null | undefined }) {
  return text.split(/\b([a-fA-F0-9]{7,64})\b/g).map((part, i) =>
    i % 2 ? (
      <button type="button" className={styles.linkButton} key={i} onClick={() => void goToRef(part, repo)}>
        {part}
      </button>
    ) : (
      <IssueText key={i} text={part} />
    ),
  );
}
