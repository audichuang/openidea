import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RootFolder } from "@/platform/languageSettings";
import { useProject } from "@/platform/project";
import { useProjectRoots } from "@/platform/projectRoots";
import type { MenuItem } from "@/ui";
import { newMenuItems } from "./contextMenu";
import { folderKind } from "./folderKind";
import { MemoryFs, setProjectFsForTests } from "./fs";
import { beginNewPackage, checkEditingName, commitEditing } from "./operations";
import { packageKindAt } from "@/platform/packageKind";
import { packageSegments } from "./paths";
import { initProjectTree, loadDir, selectModel, useProjectTree } from "./store";

const root = (path: string, kind: RootFolder["kind"], detectedFrom: string | null): RootFolder => ({
  path,
  kind,
  detectedFrom,
});

const MAVEN: RootFolder[] = [
  root("src/main/java", "source", "pom.xml"),
  root("src/test/java", "test", "pom.xml"),
  root("src/test/resources", "testResources", "pom.xml"),
  root("target", "excluded", "pom.xml"),
];

describe("folder icons", () => {
  it("follow detected and marked roots", () => {
    const kind = (rel: string, excluded = false) => folderKind({ path: `/p/${rel}`, excluded }, MAVEN, "/p");
    expect(kind("src/main/java")).toBe("source");
    expect(kind("src/test/java")).toBe("test");
    expect(kind("src/test/resources")).toBe("testResources");
    expect(kind("target")).toBe("excluded");
    expect(kind("src")).toBe("plain");
    expect(kind("docs", true)).toBe("excluded");
    expect(kind(".github")).toBe("github");
  });
});

describe("New › Package", () => {
  it("is offered inside JVM source roots and Python modules", () => {
    const py = [root("py/src", "source", "py/pyproject.toml")];
    expect(packageKindAt("src/main/java/com", MAVEN)).toBe("jvm");
    expect(packageKindAt("src/test/java", MAVEN)).toBe("jvm");
    expect(packageKindAt("src/test/resources", MAVEN)).toBeNull();
    expect(packageKindAt("target", MAVEN)).toBeNull();
    expect(packageKindAt("gen/kotlin/x", [root("gen/kotlin", "source", null)])).toBe("jvm");
    expect(packageKindAt("py/src/app", py)).toBe("python");
    expect(packageKindAt("py", py)).toBe("python");
    expect(packageKindAt("web", py)).toBeNull();
    // An unmarked Python root still leaves the module a Python module.
    expect(packageKindAt("py/src", [], py)).toBe("python");
  });

  it("keeps a nested non-Python module out of a root-level Python project", () => {
    const mixed = [root("src", "source", "pyproject.toml"), root("frontend/src", "source", "frontend/package.json")];
    expect(packageKindAt("frontend/src/components", mixed)).toBeNull();
    expect(packageKindAt("frontend", mixed)).toBeNull();
    expect(packageKindAt("src/app", mixed)).toBe("python");
    expect(packageKindAt("scripts", mixed)).toBe("python");
  });

  it("classifies Gradle-synced roots like their static detection", () => {
    const gen = (from: string) => [root("src/gen", "source", from)];
    expect(packageKindAt("src/gen/com/x", gen("Gradle"))).toBe("jvm");
    expect(packageKindAt("src/gen/com/x", gen("build.gradle"))).toBe("jvm");
  });

  it("preserves nested Gradle ownership in a Python project", () => {
    const mixed = [
      root("src", "source", "pyproject.toml"),
      root("app/custom/code", "source", "app/Gradle"),
      root("app/generated/resources", "resources", "app/Gradle"),
      root("app/tools/src", "source", "app/tools/pyproject.toml"),
    ];
    expect(packageKindAt("app", mixed)).toBeNull();
    expect(packageKindAt("app/docs", mixed)).toBeNull();
    expect(packageKindAt("app/generated/resources", mixed)).toBeNull();
    expect(packageKindAt("app/custom/code/com", mixed)).toBe("jvm");
    expect(packageKindAt("scripts", mixed)).toBe("python");
    expect(packageKindAt("app/tools/scripts", mixed)).toBe("python");
    expect(packageKindAt("app/docs", [], mixed)).toBeNull();
    expect(packageKindAt("docs", [root("code", "source", "Gradle"), root("py", "source", "pyproject.toml")])).toBe(
      "python",
    );
  });

  it("validates dotted package names", () => {
    expect(packageSegments("com.acme.util", "jvm")).toEqual({ segments: ["com", "acme", "util"], error: null });
    expect(packageSegments("com..x", "jvm").error).toMatch(/Not a valid package name/);
    expect(packageSegments("com.class", "jvm").error).toMatch(/Not a valid package name/);
    expect(packageSegments("my-app", "python").error).toMatch(/Not a valid package name/);
    expect(packageSegments("lambda", "python").error).toMatch(/Not a valid package name/);
    expect(packageSegments(" ", "python").error).toBe("Name cannot be empty");
  });
});

describe("creating packages", () => {
  let fs: MemoryFs;
  beforeEach(() => {
    fs = new MemoryFs({ "/p/src/main/java/App.java": "x", "/p/pkg/__init__.py": "" }, "/p");
    setProjectFsForTests(fs, "/p");
    initProjectTree("/p", "p");
    useProject.setState({
      project: { name: "p", root: "/p", trusted: true, isGit: false, settings: {} } as never,
      settings: {} as never,
    });
    useProjectRoots.setState({ root: "/p", detected: MAVEN });
  });
  afterEach(() => {
    setProjectFsForTests(null);
    initProjectTree(null);
    useProject.setState({ project: null, settings: null });
    useProjectRoots.setState({ root: null, detected: [] });
  });

  it("New menu shows Package instead of Directory in a Java source root", () => {
    const labels = (items: MenuItem[]) => items.map((i) => ("label" in i ? i.label : "-"));
    expect(labels(newMenuItems("/p/src/main/java")).slice(0, 2)).toEqual(["File", "Package"]);
    expect(labels(newMenuItems("/p")).slice(0, 2)).toEqual(["File", "Directory"]);
  });

  it("a dotted JVM package creates nested folders", async () => {
    await loadDir("/p/src/main/java");
    await beginNewPackage("jvm", "/p/src/main/java");
    expect(checkEditingName("com.class").error).toMatch(/Not a valid package name/);
    expect(await commitEditing("com.acme")).toBe(true);
    expect(fs.nodes.get("/p/src/main/java/com/acme")?.kind).toBe("dir");
  });

  it("a Python package gets an __init__.py in every new folder", async () => {
    await loadDir("/p/pkg");
    await beginNewPackage("python", "/p/pkg");
    expect(await commitEditing("api.v1")).toBe(true);
    expect(fs.nodes.has("/p/pkg/api/__init__.py")).toBe(true);
    expect(fs.nodes.has("/p/pkg/api/v1/__init__.py")).toBe(true);
  });
});

it("uses only manifest members in order in workspace Project and Project Files views", () => {
  for (const mode of ["project", "projectFiles"] as const) {
    initProjectTree("/workspace", "Workspace", ["/z", "/a"]);
    useProjectTree.setState({ mode });
    const model = selectModel(useProjectTree.getState());
    expect(model.roots.map((r) => r.path)).toEqual(["/z", "/a"]);
    expect(model.byKey.has("/workspace")).toBe(false);
    initProjectTree("/workspace", "Workspace", ["/a"]);
    expect(selectModel(useProjectTree.getState()).roots.map((r) => r.path)).toEqual(["/a"]);
    initProjectTree("/workspace", "Workspace", []);
    expect(selectModel(useProjectTree.getState()).roots).toEqual([]);
  }
  initProjectTree("/a", "A");
  expect(selectModel(useProjectTree.getState()).roots.map((r) => r.path)).toEqual(["/a"]);
  initProjectTree(null);
});
