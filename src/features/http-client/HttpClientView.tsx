/**
 * HTTP Client tool window: the response history (left) and the selected
 * exchange (right): status line, timing, body (pretty-printed JSON / XML /
 * HTML or raw), response headers and the request as sent.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import type { EditorView } from "@codemirror/view";
import type { HttpExchange, HttpHistoryEntry } from "@/platform/ipc";
import {
  Button,
  EmptyState,
  IconButton,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Spinner,
  Tabs,
  T,
  useSelectionBoundary,
} from "@/ui";
import { ConsoleFindBar } from "@/ui/ConsoleFindBar";
import { DEFAULT_FIND_OPTIONS, findInLines, type FindOptions } from "@/ui/consoleFind";
import { formatBinding, hasPrimaryModifier, hostBinding } from "@/platform/keymap";
import { bodyKind, formatMs, formatSize, prettyBody, PRETTY_INLINE_LIMIT, type BodyKind } from "./format";
import { ResponseBody } from "./ResponseBody";
import { cancelRunning, clearHistory, refreshHistory, selectEntry, useHttpClient } from "./store";
import styles from "./HttpClient.module.css";
import { tx } from "@/platform/i18n";

function statusTone(status: number | null | undefined): string {
  if (status == null) return styles.statusError ?? "";
  if (status >= 500 || status >= 400) return styles.statusError ?? "";
  if (status >= 300) return styles.statusRedirect ?? "";
  return styles.statusOk ?? "";
}

function time(ms: number | null): string {
  return new Date(ms ?? 0).toLocaleTimeString();
}

function EntryRow({ entry, selected }: { entry: HttpHistoryEntry; selected: boolean }) {
  return (
    <button
      type="button"
      className={clsx(styles.entry, selected && styles.entrySelected)}
      onClick={() => void selectEntry(entry.id)}
      title={entry.error ?? entry.url}
    >
      <span className={clsx(styles.status, statusTone(entry.status))}>{entry.status ?? "ERR"}</span>
      <span className={styles.method}>{entry.method}</span>
      <span className={styles.url}>{entry.name ?? entry.url}</span>
      <span className={styles.when}>{time(entry.timeMs)}</span>
    </button>
  );
}

type Tab = "body" | "headers" | "request";

/**
 * The body as shown: as received, or pretty-printed. Long bodies are formatted
 * in a worker (null until it answers), cancelled when Raw is chosen or the
 * response closes; the result is kept for switching back.
 */
function useShownBody(kind: BodyKind, body: string | null, raw: boolean): string | null {
  const plain = raw || kind === "text";
  const inline = body != null && body.length <= PRETTY_INLINE_LIMIT;
  const [formatted, setFormatted] = useState<{ source: string; text: string } | null>(null);
  const cached = body != null && formatted?.source === body ? formatted.text : null;
  const small = useMemo(
    () => (body != null && !plain && inline ? prettyBody(kind, body) : null),
    [body, plain, inline, kind],
  );
  useEffect(() => {
    if (body == null || plain || inline || cached != null) return;
    let alive = true;
    const worker = new Worker(new URL("./format.worker.ts", import.meta.url), { type: "module" });
    const done = (text: string) => {
      worker.terminate();
      if (alive) setFormatted({ source: body, text });
    };
    worker.onmessage = (event: MessageEvent<string>) => done(event.data);
    // Shown as received, as when it does not parse.
    worker.onerror = () => done(body);
    worker.postMessage({ kind, body });
    return () => {
      alive = false;
      worker.terminate();
    };
  }, [body, plain, inline, cached, kind]);
  if (body == null || plain) return body;
  return inline ? small : cached;
}

function ExchangeView({ ex }: { ex: HttpExchange }) {
  const [tab, setTab] = useState<Tab>("body");
  const pane = useRef<HTMLDivElement>(null);
  useSelectionBoundary(pane);
  const [raw, setRaw] = useState(false);
  const r = ex.response;
  const kind = useMemo(() => (r?.body != null ? bodyKind(r.contentType, r.body) : "text"), [r]);
  const body = useShownBody(kind, r?.body ?? null, raw);
  const view = useRef<EditorView | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [findOptions, setFindOptions] = useState<FindOptions>(DEFAULT_FIND_OPTIONS);
  const [active, setActive] = useState(0);
  const findInput = useRef<HTMLInputElement>(null);
  const showsEditor = tab === "body" && body != null;
  const searchable = findOpen && showsEditor;
  const lines = useMemo(
    () => (searchable ? (body ?? "").split("\n").map((text, id) => ({ id, text })) : []),
    [searchable, body],
  );
  const found = useMemo(
    () => (searchable ? findInLines(lines, query, findOptions) : { matches: [], overflow: false, invalid: false }),
    [searchable, lines, query, findOptions],
  );
  const activeIndex = found.matches.length ? Math.min(active, found.matches.length - 1) : -1;
  const openFind = () => {
    setFindOpen(true);
    // The bar mounts with this render; focus it (and select the query) once it has.
    requestAnimationFrame(() => findInput.current?.select());
  };
  const closeFind = () => {
    setFindOpen(false);
    (view.current ?? pane.current)?.focus();
  };
  const goToMatch = (step: number) => {
    const n = found.matches.length;
    if (n) setActive((activeIndex + step + n) % n);
  };
  // ⌘F in the response, as in IDEA's response viewer: the find bar of the Run console.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (
      tab === "body" &&
      r?.body != null &&
      e.key.toLowerCase() === "f" &&
      hasPrimaryModifier(e) &&
      !e.altKey &&
      !e.shiftKey
    ) {
      e.preventDefault();
      e.stopPropagation();
      openFind();
    }
  };
  return (
    <div className={styles.exchange}>
      <div className={styles.statusLine}>
        {r ? (
          <>
            <span className={clsx(styles.status, statusTone(r.status))}>
              {r.status} {r.statusText}
            </span>
            <span className={styles.meta}>{r.version}</span>
            <span className={styles.meta} title={`Headers after ${formatMs(r.ttfbMs)}`}>
              {formatMs(r.totalMs)}
            </span>
            <span className={styles.meta}>{formatSize(r.size)}</span>
          </>
        ) : (
          <span className={clsx(styles.status, styles.statusError)}>{ex.entry.error ?? "No response"}</span>
        )}
        <span className={styles.requestLine}>
          {ex.request.method} {ex.request.url}
        </span>
      </div>
      <Tabs
        variant="compact"
        activeId={tab}
        onSelect={(id) => setTab(id as Tab)}
        items={[
          { id: "body", label: "Response" },
          { id: "headers", label: r ? tx`Headers (${r.headers.length})` : "Headers" },
          { id: "request", label: "Request" },
        ]}
        trailing={
          tab === "body" && r?.body != null ? (
            <>
              <IconButton
                icon="search"
                title="Find…"
                shortcut={formatBinding(hostBinding("Meta+F"))}
                pressed={findOpen}
                onClick={() => (findOpen ? closeFind() : openFind())}
              />
              {kind !== "text" && (
                <IconButton
                  icon="soft-wrap"
                  title={raw ? "Show Formatted" : "Show Raw"}
                  pressed={raw}
                  onClick={() => setRaw((v) => !v)}
                />
              )}
            </>
          ) : undefined
        }
      />
      {searchable && (
        <ConsoleFindBar
          query={query}
          onChange={(q) => {
            setQuery(q);
            setActive(0);
          }}
          options={findOptions}
          onOptionsChange={(o) => {
            setFindOptions(o);
            setActive(0);
          }}
          count={found.matches.length}
          active={activeIndex}
          overflow={found.overflow}
          invalid={found.invalid}
          inputRef={findInput}
          onNext={() => goToMatch(1)}
          onPrevious={() => goToMatch(-1)}
          onClose={closeFind}
          label="Find in response"
        />
      )}
      {/* Focusable, so Select All and Copy work on the response like in a read-only editor;
          the body is one, which takes the focus (Select All here would reach only its visible part). */}
      <div
        ref={pane}
        className={styles.tabBody}
        tabIndex={showsEditor ? -1 : 0}
        onFocus={(e) => {
          if (showsEditor && e.target === e.currentTarget) view.current?.focus();
        }}
        onKeyDown={onKeyDown}
      >
        {tab === "body" &&
          (r == null ? (
            <pre className={styles.pre}>{ex.entry.error}</pre>
          ) : r.body == null ? (
            <EmptyState title="Binary response">
              {r.contentType ?? tx("unknown type")}, {formatSize(r.size)}
            </EmptyState>
          ) : body == null ? (
            <div className={styles.center}>
              <Spinner label={tx("Formatting")} />
            </div>
          ) : (
            <div className={styles.bodyView}>
              <ResponseBody text={body} matches={found.matches} current={activeIndex} viewRef={view} />
              {r.truncated && <div className={styles.truncated}>{`… truncated (${formatSize(r.size)} received)`}</div>}
            </div>
          ))}
        {tab === "headers" && r && <HeaderTable headers={r.headers} />}
        {tab === "request" && (
          <pre className={styles.pre}>
            {`${ex.request.method} ${ex.request.url}\n`}
            {ex.request.headers.map(([k, v]) => `${k}: ${v}\n`).join("")}
            {ex.request.body != null ? `\n${ex.request.body}` : ""}
          </pre>
        )}
      </div>
    </div>
  );
}

function HeaderTable({ headers }: { headers: Array<[string, string]> }) {
  return (
    <table className={styles.headers}>
      <tbody>
        {headers.map(([k, v], i) => (
          <tr key={i}>
            <th>{k}</th>
            <td>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function HttpClientView() {
  const history = useHttpClient((s) => s.history);
  const selected = useHttpClient((s) => s.selected);
  const exchange = useHttpClient((s) => (s.selected ? s.exchanges[s.selected] : undefined));
  const running = useHttpClient((s) => s.running);
  useEffect(() => {
    void refreshHistory();
  }, []);
  return (
    <SplitGroup orientation="horizontal" className={styles.root} storageKey="openidea.httpClient.split">
      <SplitPanel id="http-history" defaultSize="32%" minSize="160px">
        <div className={styles.list} role="list" aria-label={tx("Response history")}>
          {running && (
            <div className={styles.runningRow}>
              <Spinner size={12} /> {tx`Sending request #${running.index + 1}…`}
            </div>
          )}
          {history.length === 0 && !running ? (
            <EmptyState title="No requests yet">
              <T>Run a request from an .http file with the gutter ▶ or ⌘↩.</T>
            </EmptyState>
          ) : (
            history.map((h) => <EntryRow key={h.id} entry={h} selected={h.id === selected} />)
          )}
        </div>
      </SplitPanel>
      <SplitHandle />
      <SplitPanel id="http-response" minSize="200px">
        {running ? (
          <div className={styles.pending} role="status">
            <div className={styles.pendingLine}>
              <Spinner size={12} /> {tx`Sending request #${running.index + 1}…`}
            </div>
            {running.method && (
              <div className={styles.pendingRequest}>
                <span className={styles.pendingMethod}>{running.method}</span> {running.url}
              </div>
            )}
            <div>
              <Button onClick={cancelRunning}>
                <T>Stop Request</T>
              </Button>
            </div>
          </div>
        ) : exchange ? (
          <ExchangeView key={exchange.entry.id} ex={exchange} />
        ) : selected ? (
          <div className={styles.center}>
            <Spinner />
          </div>
        ) : (
          <EmptyState title="No response selected" />
        )}
      </SplitPanel>
    </SplitGroup>
  );
}

export function HttpClientHeaderActions() {
  const running = useHttpClient((s) => !!s.running);
  return (
    <>
      <IconButton icon="stop" title="Stop Request" disabled={!running} onClick={cancelRunning} />
      <IconButton icon="refresh" title="Reload History" onClick={() => void refreshHistory()} />
      <IconButton icon="trash" title="Clear History" onClick={() => void clearHistory()} />
    </>
  );
}
