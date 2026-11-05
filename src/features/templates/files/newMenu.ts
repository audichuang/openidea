/**
 * Which file templates the New › menu offers for a directory, IDEA style: in a
 * Java package the JVM templates lead the menu, templates of other languages
 * move to "Other File Types", and language-neutral ones stay in between.
 */
import type { PackageKind } from "@/platform/packageKind";
import type { FileTemplate } from "./model";

/** Language a template belongs to; null for language-neutral files (HTML, JSON, Dockerfile…). */
type TemplateLanguage = PackageKind | "rust" | "go" | "web";

const LANGUAGE_BY_EXTENSION: Record<string, TemplateLanguage> = {
  java: "jvm",
  kt: "jvm",
  kts: "jvm",
  groovy: "jvm",
  scala: "jvm",
  py: "python",
  rs: "rust",
  go: "go",
  mod: "go",
  ts: "web",
  tsx: "web",
  js: "web",
  jsx: "web",
  mjs: "web",
  cjs: "web",
  vue: "web",
  svelte: "web",
};

/** Templates that only make sense inside a package of their language (elsewhere: From Template… only). */
const PACKAGE_ONLY = new Set(["package-info"]);

export function templateLanguage(t: Pick<FileTemplate, "extension">): TemplateLanguage | null {
  return LANGUAGE_BY_EXTENSION[t.extension.toLowerCase()] ?? null;
}

export interface NewMenuTemplates {
  /** Listed before File / Directory. */
  primary: FileTemplate[];
  /** Listed after File / Directory. */
  common: FileTemplate[];
  /** Under "Other File Types". */
  other: FileTemplate[];
}

/**
 * Splits the New › templates for a directory of `kind` (`packageKindAt`).
 * Without a kind every template stays listed, except package-only ones.
 */
export function newMenuTemplates(templates: readonly FileTemplate[], kind: PackageKind | null): NewMenuTemplates {
  const out: NewMenuTemplates = { primary: [], common: [], other: [] };
  for (const t of templates) {
    const language = templateLanguage(t);
    if (kind && language === kind) out.primary.push(t);
    else if (PACKAGE_ONLY.has(t.id)) continue;
    else if (!kind || language === null) out.common.push(t);
    else out.other.push(t);
  }
  return out;
}
