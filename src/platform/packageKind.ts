/** Which "New › Package" flavour a folder offers, from the project's roots. */
import { rootFor, type RootFolder } from "./languageSettings";
import { isJvmSourcePackage } from "@/ui/folderPresentation";
import { relativePath, useProject } from "./project";
import { currentDetectedRoots, currentRoots } from "./projectRoots";

/** Package flavour of New › Package (JVM, dotted) / New › Python Package (`__init__.py`). */
export type PackageKind = "jvm" | "python";

const PY_BUILD = /(^|\/)(pyproject\.toml|setup\.py|setup\.cfg|Pipfile|requirements\.txt)$/;

const moduleDir = (buildFile: string) =>
  buildFile.includes("/") ? buildFile.slice(0, buildFile.lastIndexOf("/")) : "";
const within = (rel: string, dir: string) => !dir || rel === dir || rel.startsWith(`${dir}/`);

/**
 * `jvm` inside a Java / Kotlin source or test root (IDEA shows "Package" there
 * instead of "Directory"); `python` inside a Python module (PyCharm's "Python Package").
 */
export function packageKindAt(
  rel: string,
  roots: readonly RootFolder[],
  detected: readonly RootFolder[] = [],
): PackageKind | null {
  if (rootFor(roots, rel)?.kind === "excluded") return null;
  if (isJvmSourcePackage(rel, roots)) return "jvm";
  const python = [...roots, ...detected].some(
    (r) => r.detectedFrom && PY_BUILD.test(r.detectedFrom) && within(rel, moduleDir(r.detectedFrom)),
  );
  return python ? "python" : null;
}

/** `packageKindAt` for an absolute directory of the open project, from the current roots. */
export function packageKindOf(directory: string | null | undefined): PackageKind | null {
  const root = useProject.getState().project?.root;
  if (!directory || !root) return null;
  const rel = directory === root ? "" : relativePath(root, directory);
  return packageKindAt(rel, currentRoots(), currentDetectedRoots());
}
