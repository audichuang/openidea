import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RootFolder } from "@/platform/languageSettings";
import { useProject } from "@/platform/project";
import { useProjectRoots } from "@/platform/projectRoots";
import type { MenuItem } from "@/ui";
import { menuGroupItems } from "@/workbench/contributions";
import { BUILTIN_FILE_TEMPLATES } from "../files/builtins";
import type { FileTemplate } from "../files/model";
import { newMenuTemplates } from "../files/newMenu";
import { registerNewMenuGroups } from "../index";

const ids = (ts: readonly { id: string }[]) => ts.map((t) => t.id);
const MENU_TEMPLATES = BUILTIN_FILE_TEMPLATES.filter((t) => t.id !== "file");

describe("New menu templates by directory kind", () => {
  it("leads with the JVM templates in a Java package and moves other languages aside", () => {
    const { primary, common, other } = newMenuTemplates(MENU_TEMPLATES, "jvm");
    expect(ids(primary)).toEqual(["java", "kotlin", "package-info"]);
    expect(ids(other)).toEqual([
      "rust",
      "typescript",
      "tsx",
      "javascript",
      "python",
      "go",
      "go-mod",
      "php",
      "php-class",
    ]);
    expect(ids(common)).toEqual([
      "html",
      "markdown",
      "stylesheet",
      "json",
      "yaml",
      "toml",
      "shell",
      "dockerfile",
      "editorconfig",
      "gitignore",
      "tomcat-context",
    ]);
  });

  it("leads with Python File in a Python package and hides package-info", () => {
    const { primary, common, other } = newMenuTemplates(MENU_TEMPLATES, "python");
    expect(ids(primary)).toEqual(["python"]);
    expect(ids(other)).toEqual([
      "rust",
      "typescript",
      "tsx",
      "javascript",
      "go",
      "go-mod",
      "php",
      "php-class",
      "java",
      "kotlin",
    ]);
    expect(ids(common)).not.toContain("package-info");
  });

  it("keeps every template listed in a directory of no particular kind, except package-info", () => {
    const { primary, common, other } = newMenuTemplates(MENU_TEMPLATES, null);
    expect(primary).toEqual([]);
    expect(other).toEqual([]);
    expect(ids(common)).toEqual(ids(MENU_TEMPLATES).filter((id) => id !== "package-info"));
  });

  it.each(["php", "PHP"])("moves custom %s templates aside only in a language package", (extension) => {
    const templates: FileTemplate[] = ["php", "php-class"].map((id) => ({
      id,
      name: id,
      icon: "file",
      extension,
      nameStyle: "asis",
      kinds: [],
    }));
    for (const kind of ["jvm", "python"] as const) {
      const { primary, common, other } = newMenuTemplates(templates, kind);
      expect(primary).toEqual([]);
      expect(common).toEqual([]);
      expect(ids(other)).toEqual(["php", "php-class"]);
    }
    const { primary, common, other } = newMenuTemplates(templates, null);
    expect(primary).toEqual([]);
    expect(ids(common)).toEqual(["php", "php-class"]);
    expect(other).toEqual([]);
  });

  it("classifies user templates by their extension", () => {
    const scala = { ...MENU_TEMPLATES[0]!, id: "my-scala", name: "Scala Object", extension: "scala" };
    const props = { ...MENU_TEMPLATES[0]!, id: "my-props", name: "Properties", extension: "properties" };
    const { primary, common } = newMenuTemplates([props, scala], "jvm");
    expect(ids(primary)).toEqual(["my-scala"]);
    expect(ids(common)).toEqual(["my-props"]);
  });
});

describe("New menu groups", () => {
  const MAVEN: RootFolder[] = [
    { path: "src/main/java", kind: "source", detectedFrom: "pom.xml" },
    { path: "src/test/java", kind: "test", detectedFrom: "pom.xml" },
  ];
  let dispose: () => void;
  const labels = (items: MenuItem[]) =>
    items.map((i) =>
      i.kind === "separator" ? "-" : i.kind === "header" ? i.label : `${i.label ?? ""}${"submenu" in i ? " >" : ""}`,
    );

  beforeEach(() => {
    useProject.setState({
      project: { name: "p", root: "/p", trusted: true, isGit: false, settings: {} } as never,
      settings: {} as never,
    });
    useProjectRoots.setState({ root: "/p", detected: MAVEN });
    dispose = registerNewMenuGroups();
  });

  afterEach(() => {
    dispose();
    useProject.setState({ project: null, settings: null });
    useProjectRoots.setState({ root: null, detected: [] });
  });

  it("puts Java Class first in a Java package and other languages under Other File Types", () => {
    const dir = "/p/src/main/java/com/acme";
    expect(labels(menuGroupItems("newPrimary", { paths: [dir], dirs: [true] }))).toEqual([
      "Java Class",
      "Kotlin Class/File",
      "package-info.java",
      "-",
    ]);
    const rest = menuGroupItems("new", { paths: [dir], dirs: [true] });
    expect(labels(rest)).not.toContain("Java Class");
    expect(labels(rest)).not.toContain("Rust File");
    expect(labels(rest)).toContain("Other File Types >");
    const other = rest.find((i) => "submenu" in i) as { submenu: MenuItem[] };
    expect(labels(other.submenu)).toContain("Rust File");
    expect(other.submenu[0]).toMatchObject({ action: "templates.new.rust", arg: { directory: dir } });
  });

  it("lists every template after File at the project root", () => {
    expect(menuGroupItems("newPrimary", { paths: ["/p"], dirs: [true] })).toEqual([]);
    const rest = labels(menuGroupItems("new", { paths: ["/p"], dirs: [true] }));
    expect(rest.slice(0, 2)).toEqual(["Rust File", "TypeScript File"]);
    expect(rest).toContain("Java Class");
    expect(rest).not.toContain("package-info.java");
    expect(rest).not.toContain("Other File Types >");
  });
});
