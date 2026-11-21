// @vitest-environment node
/**
 * `*.module.css` imports are typed as an open index signature, so `styles.typo` compiles and is
 * `undefined` at runtime: the element silently loses its styling. This lists every `styles.x`
 * (and `styles["x"]`) whose class the imported module does not define.
 *
 * Dynamic access (`styles[kind]`) is not checked.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";

const SRC = resolve(import.meta.dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [path] : [];
  });
}

const definedCache = new Map<string, Set<string>>();

/** Every class name that appears in a selector (`:global(.x)` included, which only under-reports). */
function definedClasses(cssPath: string): Set<string> {
  let classes = definedCache.get(cssPath);
  if (!classes) {
    const css = readFileSync(cssPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    classes = new Set();
    for (const prelude of css.matchAll(/([^{}]+)\{/g)) {
      for (const m of prelude[1]!.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) classes.add(m[1]!);
    }
    definedCache.set(cssPath, classes);
  }
  return classes;
}

it("every class read from a CSS module is defined in it", () => {
  const missing: string[] = [];
  for (const path of sources(SRC)) {
    const text = readFileSync(path, "utf8");
    for (const imp of text.matchAll(/import\s+(\w+)\s+from\s+["']([^"']+\.module\.css)["']/g)) {
      const [, name, spec] = imp as unknown as [string, string, string];
      if (spec.includes("$")) continue; // a file template's placeholder, not a module
      const cssPath = spec.startsWith("@/") ? join(SRC, spec.slice(2)) : resolve(dirname(path), spec);
      const defined = definedClasses(cssPath);
      const access = new RegExp(`(?<![\\w./])${name}(?:\\.([A-Za-z_]\\w*)|\\[\\s*["']([\\w-]+)["']\\s*\\])`, "g");
      for (const m of text.matchAll(access)) {
        const cls = (m[1] ?? m[2])!;
        if (!defined.has(cls)) {
          const line = text.slice(0, m.index).split("\n").length;
          missing.push(`${cls} at ${path.slice(SRC.length + 1)}:${line} (${spec})`);
        }
      }
    }
  }
  expect(missing).toEqual([]);
});

function stylesheets(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return stylesheets(path);
    return e.name.endsWith(".css") ? [path] : [];
  });
}

/**
 * `X > * + *` makes Chromium restyle the whole subtree of any element whose inline style changes,
 * anywhere in the app: an editor laying itself out restyled every diff of the all-in-one diff, a
 * long frame each. `X > :where(:not(:first-child))` selects the same children at the same specificity.
 */
it("no stylesheet selects a universal element after a universal sibling", () => {
  const found: string[] = [];
  for (const path of stylesheets(SRC)) {
    const css = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const prelude of css.matchAll(/([^{}]+)\{/g)) {
      if (/\*\s*[+~]\s*\*/.test(prelude[1]!)) found.push(`${path.slice(SRC.length + 1)}: ${prelude[1]!.trim()}`);
    }
  }
  expect(found).toEqual([]);
});
