/** Which "New › Package" flavour a folder offers, from the project's roots. */
import { rootFor, type RootFolder } from "./languageSettings";
import { relativePath, useProject } from "./project";
import { currentDetectedRoots, currentRoots } from "./projectRoots";

/** Package flavour of New › Package (JVM, dotted) / New › Python Package (`__init__.py`). */
export type PackageKind = "jvm" | "python";

// Gradle sync markers retain the owning module directory (ide-host `with_gradle_roots`).
const JVM_BUILD = /(^|\/)(pom\.xml|build\.gradle(\.kts)?)$|(^|\/)Gradle$/;
const PY_BUILD = /(^|\/)(pyproject\.toml|setup\.py|setup\.cfg|Pipfile|requirements\.txt)$/;
const JVM_DIR = /(^|\/)(java|kotlin|scala|groovy)$/;

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
  const root = rootFor(roots, rel);
  if (root?.kind === "excluded") return null;
  if (
    (root?.kind === "source" || root?.kind === "test") &&
    (JVM_BUILD.test(root.detectedFrom ?? "") || JVM_DIR.test(root.path))
  )
    return "jvm";
  // The innermost module wins: a Python file at the repo root must not claim
  // `frontend/` when `frontend/package.json` is the deeper recognised module.
  let python = -1;
  let other = -1;
  for (const r of [...roots, ...detected]) {
    if (!r.detectedFrom) continue;
    const dir = moduleDir(r.detectedFrom);
    if (!within(rel, dir)) continue;
    if (PY_BUILD.test(r.detectedFrom)) python = Math.max(python, dir.length);
    else other = Math.max(other, dir.length);
  }
  return python >= 0 && python >= other ? "python" : null;
}

/** `packageKindAt` for an absolute directory of the open project, from the current roots. */
export function packageKindOf(directory: string | null | undefined): PackageKind | null {
  const root = useProject.getState().project?.root;
  if (!directory || !root) return null;
  const rel = directory === root ? "" : relativePath(root, directory);
  return packageKindAt(rel, currentRoots(), currentDetectedRoots());
}
