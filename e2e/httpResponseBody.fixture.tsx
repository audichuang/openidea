import { useState } from "react";
import type { EditorView } from "@codemirror/view";
import { createRoot } from "react-dom/client";
import "../src/styles/global.css";
import { ResponseBody } from "../src/features/http-client/ResponseBody";
import { DEFAULT_FIND_OPTIONS, findInLines } from "../src/ui/consoleFind";

// `?chars=<n>`: a response body that is one line of ~n characters (a minified body in Raw), ending in
// `last-item`. "Show Formatted" / "Show Raw" swap it with a multi-line text, as the response toggle does.
// `&find=<query>`: the find bar's matches for that query, the first one current.
const params = new URLSearchParams(location.search);
const chars = Number(params.get("chars") ?? 1_000_000);
const record = (i: number) => `{"id":${i},"name":"item-${i}","tags":["a","b"]}`;
const parts: string[] = [];
for (let i = 0, size = 0; size < chars; i++) {
  parts.push((i ? "," : "[") + record(i));
  size += parts[i]!.length;
}
const raw = `${parts.join("")},{"name":"last-item"}]`;
const formatted = Array.from({ length: 2000 }, (_, i) => record(i)).join("\n");

// Characters put into text nodes: what the browser has to lay out.
const drawn = { chars: 0 };
const createTextNode = document.createTextNode.bind(document);
document.createTextNode = (text: string) => {
  drawn.chars += text.length;
  return createTextNode(text);
};
const view: { current: EditorView | null } = { current: null };
Object.assign(window, { drawn, rawLength: raw.length, docLength: () => view.current?.state.doc.length });

const query = params.get("find") ?? "";
const matchesOf = (text: string) =>
  findInLines(
    text.split("\n").map((line, id) => ({ id, text: line })),
    query,
    DEFAULT_FIND_OPTIONS,
  ).matches;
const matches = { raw: matchesOf(raw), formatted: matchesOf(formatted) };

function Fixture() {
  const [showRaw, setShowRaw] = useState(params.has("raw"));
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <button onClick={() => setShowRaw((v) => !v)}>{showRaw ? "Show Formatted" : "Show Raw"}</button>
      {/* Sized like the response pane, so the body scrolls inside its own scroller. */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <ResponseBody
          text={showRaw ? raw : formatted}
          matches={showRaw ? matches.raw : matches.formatted}
          current={0}
          viewRef={view}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
