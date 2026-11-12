// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { EditorState, type Extension } from "@codemirror/state";
import { drawSelection, EditorView } from "@codemirror/view";
import { movedCodeHighlights } from "@/features/vcs/movedCode";
import { seamlessSelection } from "./selectionLayer";

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((v) => v.destroy()));

function cssRules(): number {
  let n = 0;
  for (const sheet of [...document.styleSheets, ...(document.adoptedStyleSheets ?? [])]) n += sheet.cssRules.length;
  return n;
}

function mount(extensions: Extension): void {
  const parent = document.createElement("div");
  document.body.append(parent);
  views.push(new EditorView({ state: EditorState.create({ doc: "a\nb", extensions }), parent }));
}

// A theme built inside an extension factory mounts new CSS rules for every editor that calls it,
// which never go away and make WebKit restyle the whole document each time a diff opens.
it.each([
  ["seamlessSelection", () => [drawSelection(), seamlessSelection()]],
  ["movedCodeHighlights", () => movedCodeHighlights(true)],
])("%s mounts its theme once, however many editors use it", (_name, extensions) => {
  mount(extensions());
  const after = cssRules();
  mount(extensions());
  mount(extensions());
  expect(cssRules()).toBe(after);
});

// The same rule for every theme in the app: one built at module level is mounted once.
it("builds every EditorView theme at module level", () => {
  const sources = (readdirSync("src", { recursive: true }) as string[])
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$|__tests__/.test(f))
    .map((f) => join("src", f));
  const inside = sources.flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line, i) =>
        /EditorView\.(theme|baseTheme)\(/.test(line) &&
        !/^(export )?const \w+ = EditorView\.(theme|baseTheme)\(/.test(line)
          ? [`${file}:${i + 1}`]
          : [],
      ),
  );
  expect(inside).toEqual([]);
});
