//! File move / rename refactoring: reference updates from the language
//! servers, the move itself (one undoable step) and its undo.
use crate::Host;
use ide_command::command;

use ide_core::{CancellationToken, FileEdit, IdeResult, LanguageId, RequestId, WorkspaceEdit};
use ide_language::Syntax;
use ide_lsp::types::FileRenameEdits;
use ide_syntax::{Snapshot, StructureService};
use ide_workspace::Documents;
use ide_workspace::file_moves::{moved_path, read_text};
use ide_workspace::roots::{PYTHON_FILES, ProjectRoots, RootKind, SourceFolder};
use ide_workspace::{FileMove, UndoOutcome};
use parking_lot::Mutex;
use std::path::{Path, PathBuf};

use super::blocking;

fn pairs(moves: &[FileMove]) -> Vec<(PathBuf, PathBuf)> {
    moves.iter().map(|m| (m.from.to_path_buf(), m.to.to_path_buf())).collect()
}

/// `workspace/willRenameFiles` on every interested server (before the move), plus the
/// Python import updates the IDE makes itself. Cancellable.
#[command(trust = always)]
pub async fn refactor_file_move_edits(
    host: &Host,
    window: &str,
    request: RequestId,
    moves: Vec<FileMove>,
) -> IdeResult<FileRenameEdits> {
    let project = host.project(window)?;
    let token = host.begin_request(request);
    let syntax = host.syntax();
    let result = async {
        let mut result = project.lsp.will_rename_files(&pairs(&moves), token.clone()).await?;
        blocking(move || {
            // basedpyright has no `workspace/willRenameFiles`; a Python server that answered wins.
            if !result.edit.files.iter().any(|f| matches!(f, FileEdit::Edit { path, .. } if is_python(path))) {
                let python = python_import_edits(
                    &project.root,
                    &project.roots(),
                    &project.exclude_globs(),
                    &project.documents,
                    &syntax,
                    &moves,
                    &|| token.is_cancelled(),
                );
                result.edit.files.extend(python.files);
            }
            for m in &moves {
                if let Some(edit) = java_type_rename_edit(&project, &syntax, m, &result.edit, &token) {
                    result.edit.files.push(edit);
                }
            }
            if token.is_cancelled() {
                return Err(ide_core::IdeError::cancelled());
            }
            project.documents.prepare_workspace_edit(&mut result.edit)?;
            Ok(result)
        })
        .await
    }
    .await;
    host.end_request(request);
    result
}

fn is_python(path: &Path) -> bool {
    path.extension().is_some_and(|e| e == "py" || e == "pyi")
}

/// jdtls renames the type of a renamed `Foo.java` only for files it knows (inside a source folder);
/// for a file outside every source root the top-level `Foo` and its uses in that file follow the
/// new name here, so file and public class still agree.
fn java_type_rename_edit(
    project: &crate::project::Project,
    syntax: &Syntax,
    m: &FileMove,
    server: &WorkspaceEdit,
    cancel: &CancellationToken,
) -> Option<FileEdit> {
    let (old, new) = java_type_rename_names(m, server, &project.root, &project.roots())?;
    let text = project.text_of(&m.from).ok()?;
    let edits = java_type_renames(syntax, &project.structure, &text, old, new, cancel);
    (!edits.is_empty()).then(|| FileEdit::Edit { path: m.from.clone(), edits, version: None })
}

/// The old and new type names when the move `m` should rename its file's top-level Java type here:
/// a renamed `.java` file outside the source / test roots that no server edit touches. Inside a
/// root an empty answer means jdtls was not ready, and a file-local rename would hide broken usages.
fn java_type_rename_names<'a>(
    m: &'a FileMove,
    server: &WorkspaceEdit,
    root: &Path,
    roots: &ProjectRoots,
) -> Option<(&'a str, &'a str)> {
    let java = |p: &Path| p.extension().is_some_and(|e| e == "java");
    if !java(&m.from) || !java(&m.to) || !m.from.is_file() {
        return None;
    }
    let old = m.from.file_stem()?.to_str()?;
    let new = m.to.file_stem()?.to_str()?;
    if old == new {
        return None;
    }
    if let Ok(rel) = m.from.strip_prefix(root)
        && roots
            .root_for(&rel.to_string_lossy().replace('\\', "/"))
            .is_some_and(|r| matches!(r.kind, RootKind::Source | RootKind::Test))
    {
        return None;
    }
    let same = |p: &Path| p == &*m.from || std::fs::canonicalize(p).ok() == std::fs::canonicalize(&*m.from).ok();
    let edited =
        server.files.iter().any(|f| matches!(f, FileEdit::Edit { path, edits, .. } if !edits.is_empty() && same(path)));
    (!edited).then_some((old, new))
}

/// Renames of `old` to `new` in a Java file declaring the top-level type `old`: every unqualified
/// identifier spelled `old` (declaration, constructors, `new Old()`).
fn java_type_renames(
    syntax: &Syntax,
    structure: &StructureService,
    text: &str,
    old: &str,
    new: &str,
    cancel: &CancellationToken,
) -> Vec<ide_core::TextEdit> {
    const KEYWORDS: &[&str] = &[
        "abstract",
        "assert",
        "boolean",
        "break",
        "byte",
        "case",
        "catch",
        "char",
        "class",
        "const",
        "continue",
        "default",
        "do",
        "double",
        "else",
        "enum",
        "extends",
        "final",
        "finally",
        "float",
        "for",
        "goto",
        "if",
        "implements",
        "import",
        "instanceof",
        "int",
        "interface",
        "long",
        "native",
        "new",
        "package",
        "private",
        "protected",
        "public",
        "return",
        "short",
        "static",
        "strictfp",
        "super",
        "switch",
        "synchronized",
        "this",
        "throw",
        "throws",
        "transient",
        "try",
        "void",
        "volatile",
        "while",
        "true",
        "false",
        "null",
        "_",
        "var",
        "yield",
        "record",
        "sealed",
        "permits",
    ];
    let valid = new.chars().next().is_some_and(|c| c == '_' || c == '$' || c.is_alphabetic())
        && new.chars().all(|c| c == '_' || c == '$' || c.is_alphanumeric())
        && !KEYWORDS.contains(&new);
    let java = LanguageId::new("java");
    if !valid || !syntax.outline(&java, text).iter().any(|i| i.name == old && i.kind.is_type_like()) {
        return Vec::new();
    }
    let Ok(found) = structure.identifiers_named(&Snapshot::text(&java, text), old, cancel) else { return Vec::new() };
    found
        .into_iter()
        .filter(|o| !o.qualified)
        .map(|o| ide_core::TextEdit { range: o.range, new_text: new.to_owned() })
        .collect()
}

/// The folders Python imports modules from: source and test roots of Python projects (or marked
/// by the user), else the project root. Other languages' roots (`frontend/src`) don't count.
fn python_root<'a>(roots: &'a ProjectRoots, rel: &str) -> &'a str {
    let python = |r: &&SourceFolder| {
        matches!(r.kind, RootKind::Source | RootKind::Test)
            && r.detected_from.as_deref().is_none_or(|f| PYTHON_FILES.iter().any(|p| f.rsplit('/').next() == Some(*p)))
    };
    let inside = |r: &&SourceFolder| r.path.is_empty() || rel == r.path || rel.starts_with(&format!("{}/", r.path));
    roots.roots.iter().filter(python).filter(inside).max_by_key(|r| r.path.len()).map_or("", |r| r.path.as_str())
}

fn rel_path(root: &Path, path: &Path) -> Option<String> {
    Some(path.strip_prefix(root).ok()?.to_string_lossy().replace('\\', "/"))
}

/// The dotted name of a Python module file or package folder and the root it is imported from
/// (`src/a/b.py` → `a.b` from `src` in a `src` layout).
fn python_module(root: &Path, roots: &ProjectRoots, path: &Path, is_dir: bool) -> Option<(String, String)> {
    let rel = rel_path(root, path)?;
    let base = python_root(roots, &rel);
    let inner = if base.is_empty() { rel.as_str() } else { rel.strip_prefix(base)?.trim_start_matches('/') };
    let inner = if is_dir { inner } else { inner.strip_suffix(".py").or_else(|| inner.strip_suffix(".pyi"))? };
    let inner = inner.strip_suffix("/__init__").unwrap_or(inner);
    let valid = |s: &str| {
        s.chars().next().is_some_and(|c| !c.is_ascii_digit()) && s.chars().all(|c| c == '_' || c.is_alphanumeric())
    };
    (!inner.is_empty() && inner.split('/').all(valid)).then(|| (inner.replace('/', "."), base.to_owned()))
}

/// The package relative imports in `file` start from.
fn python_package(root: &Path, roots: &ProjectRoots, file: &Path) -> String {
    let Some((module, _)) = python_module(root, roots, file, false) else { return String::new() };
    if file.file_stem().is_some_and(|s| s == "__init__") {
        module
    } else {
        module.rsplit_once('.').map_or(String::new(), |(p, _)| p.to_owned())
    }
}

/// Whether `dir` holds Python modules (a package or namespace package), at any depth.
fn has_python(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else { return false };
    entries.flatten().any(|e| {
        let path = e.path();
        let name = e.file_name();
        let name = name.to_string_lossy();
        if e.file_type().is_ok_and(|t| t.is_dir()) {
            !name.starts_with('.') && !matches!(name.as_ref(), "node_modules" | "__pycache__") && has_python(&path)
        } else {
            is_python(&path)
        }
    })
}

/// Import updates in the project's Python files for `moves` (paths before the move).
fn python_import_edits(
    root: &Path,
    roots: &ProjectRoots,
    excludes: &[String],
    documents: &Documents,
    syntax: &Syntax,
    moves: &[FileMove],
    cancelled: &(dyn Fn() -> bool + Sync),
) -> WorkspaceEdit {
    // (old, new, root the old module is imported from)
    let mut renames: Vec<(String, String, String)> = Vec::new();
    for m in moves {
        let is_dir = m.from.is_dir();
        let module = if is_dir {
            has_python(&m.from)
        } else {
            let stub_only = m.from.extension().is_some_and(|e| e == "pyi")
                && !moves.iter().any(|o| *o.from == m.from.with_extension("py"));
            // A stub may describe a compiled module that stays where it is.
            is_python(&m.from) && !stub_only && m.from.file_stem().is_some_and(|s| s != "__init__")
        };
        if !module {
            continue;
        }
        let (Some((old, base)), Some((new, _))) =
            (python_module(root, roots, &m.from, is_dir), python_module(root, roots, &m.to, is_dir))
        else {
            continue;
        };
        if old != new && !renames.iter().any(|r| r.0 == old) {
            renames.push((old, new, base));
        }
    }
    if renames.is_empty() {
        return WorkspaceEdit::default();
    }
    // `import utils` in `backend/app.py` means `backend/utils.py`, not `backend/tests/utils.py`.
    let shadowed = |base: &str, module: &str| {
        let p = root.join(base).join(module.replace('.', "/"));
        p.with_extension("py").is_file() || p.with_extension("pyi").is_file() || p.is_dir()
    };
    let names: Vec<&str> = renames.iter().map(|(old, ..)| old.rsplit('.').next().unwrap_or(old)).collect();
    let found: Mutex<Vec<(PathBuf, Vec<ide_core::TextEdit>)>> = Mutex::new(Vec::new());
    ide_vfs::walk_files(root, excludes, |path| {
        if cancelled() || !is_python(path) {
            return;
        }
        let moved = moved_path(path, moves);
        if moved == path {
            let Ok(bytes) = std::fs::read(path) else { return };
            let raw = String::from_utf8_lossy(&bytes);
            if !names.iter().any(|n| raw.contains(n)) {
                return;
            }
        }
        // Through the documents layer: unsaved edits, BOM and encodings as the edits will see them.
        let Ok(text) = read_text(documents, path) else { return };
        let Some(rel) = rel_path(root, path) else { return };
        let base = python_root(roots, &rel);
        let visible: Vec<(String, String)> = renames
            .iter()
            .filter(|(old, _, from)| from == base || !shadowed(base, old))
            .map(|(old, new, _)| (old.clone(), new.clone()))
            .collect();
        let edits = syntax.python_import_edits(
            &text,
            &python_package(root, roots, path),
            &python_package(root, roots, &moved),
            &visible,
        );
        if !edits.is_empty() {
            found.lock().push((path.to_path_buf(), edits));
        }
    });
    let mut files = found.into_inner();
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let files = files.into_iter().map(|(path, edits)| FileEdit::Edit { path: path.into(), edits, version: None });
    WorkspaceEdit { files: files.collect(), ..Default::default() }
}

/// Applies `edit` (from [`refactor_file_move_edits`], possibly empty), moves the
/// files and notifies the servers. Returns the id for [`refactor_undo_file_move`].
#[command(trust = always)]
pub async fn refactor_move_files(
    host: &Host,
    window: &str,
    moves: Vec<FileMove>,
    edit: WorkspaceEdit,
    label: String,
) -> IdeResult<u32> {
    let project = host.project(window)?;
    let p = project.clone();
    let moved = moves.clone();
    // Restricted Mode: no git command may run for the index sync.
    let git_roots = project.is_trusted().then(|| project.repos().roots());
    let id = blocking(move || {
        let apply = |e: &WorkspaceEdit| p.documents.apply_file_move_edits(e);
        p.moves.perform(&p.documents, Some(&p.history), &moved, &edit, &label, git_roots.as_deref(), &apply)
    })
    .await?;
    project.lsp.did_rename_files(&pairs(&moves));
    Ok(id)
}

/// Undoes a file move: moves back and reverts the reference updates.
#[command(trust = always)]
pub async fn refactor_undo_file_move(host: &Host, window: &str, id: u32) -> IdeResult<UndoOutcome> {
    let project = host.project(window)?;
    let p = project.clone();
    let git_roots = project.is_trusted().then(|| project.repos().roots());
    let outcome = blocking(move || p.moves.undo(&p.documents, Some(&p.history), git_roots.as_deref(), id)).await?;
    project.lsp.did_rename_files(&pairs(&outcome.moves));
    Ok(outcome)
}

/// Whether the file move `id` can still be undone.
#[command(trust = always)]
pub fn refactor_can_undo_file_move(host: &Host, window: &str, id: u32) -> IdeResult<bool> {
    Ok(host.project(window)?.moves.can_undo(id))
}

/// "Search in comments and strings": textual occurrences of the moved files'
/// names, qualified names and paths (before the move). Cancellable.
#[command(trust = always)]
pub async fn refactor_file_move_text_edits(
    host: &Host,
    window: &str,
    request: RequestId,
    moves: Vec<FileMove>,
) -> IdeResult<WorkspaceEdit> {
    let project = host.project(window)?;
    let token = host.begin_request(request);
    let cancel = token.clone();
    let result = blocking(move || {
        let replacements = ide_workspace::text_refs::move_replacements(&project.root, &project.roots(), &moves);
        let mut edit = ide_workspace::text_refs::find_text_occurrences(
            &project.root,
            &project.exclude_globs(),
            &replacements,
            &|| cancel.is_cancelled(),
        );
        if cancel.is_cancelled() {
            return Err(ide_core::IdeError::cancelled());
        }
        project.documents.prepare_workspace_edit(&mut edit)?;
        Ok(edit)
    })
    .await;
    host.end_request(request);
    result
}

ide_command::domain!(
    refactor:
    refactor_can_undo_file_move,
    refactor_file_move_edits,
    refactor_file_move_text_edits,
    refactor_move_files,
    refactor_undo_file_move,
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn java_top_level_type_follows_the_file_name() {
        use ide_language::SyntaxCache;
        use std::sync::Arc;
        let syntax = Syntax::new();
        let structure = StructureService::new(Arc::new(SyntaxCache::new(Arc::new(Syntax::new()))));
        let src = "package p;\n\npublic class Standalone {\n    static Standalone it = new Standalone();\n    Standalone() {}\n    void f(Other o) { o.Standalone = 1; }\n    // Standalone\n}\n";
        let renames = |text: &str, old: &str, new: &str| {
            let edits = java_type_renames(&syntax, &structure, text, old, new, &CancellationToken::new());
            let mut doc = ide_text::Document::new(text);
            doc.apply_edits(&edits).unwrap();
            (edits.len(), doc.text())
        };
        let (n, out) = renames(src, "Standalone", "Renamed");
        assert_eq!(n, 4, "{out}");
        assert!(out.contains("public class Renamed {"), "{out}");
        assert!(out.contains("static Renamed it = new Renamed();"), "{out}");
        assert!(out.contains("    Renamed() {}"), "{out}");
        assert!(out.contains("o.Standalone = 1;") && out.contains("// Standalone"), "{out}");
        assert_eq!(renames(src, "Standalone", "Not-Valid").0, 0);
        assert_eq!(renames(src, "Standalone", "int").0, 0);
        assert_eq!(renames(src, "Missing", "Renamed").0, 0);
        assert_eq!(renames("class Outer { class Standalone {} }", "Standalone", "Renamed").0, 0);
    }

    #[test]
    fn java_type_rename_only_outside_source_roots_and_server_edits() {
        let dir = std::env::temp_dir().join(format!("refactor-java-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("docs")).unwrap();
        std::fs::create_dir_all(dir.join("src/main/java")).unwrap();
        std::fs::write(dir.join("docs/Standalone.java"), "class Standalone {}").unwrap();
        std::fs::write(dir.join("src/main/java/App.java"), "class App {}").unwrap();
        let folder = |path: &str, kind| SourceFolder { path: path.into(), kind, detected_from: None };
        let roots = ProjectRoots::compute(vec![folder("src/main/java", RootKind::Source)], &Default::default());
        let mv = |from: &str, to: &str| FileMove { from: dir.join(from).into(), to: dir.join(to).into() };
        let no_edit = WorkspaceEdit::default();
        let edit_of = |path: PathBuf, edits| WorkspaceEdit {
            files: vec![FileEdit::Edit { path: path.into(), edits, version: None }],
            ..Default::default()
        };
        let one = vec![ide_core::TextEdit { range: Default::default(), new_text: "X".into() }];
        let names = |m: &FileMove, server: &WorkspaceEdit| {
            java_type_rename_names(m, server, &dir, &roots).map(|(a, b)| (a.to_owned(), b.to_owned()))
        };

        let out = mv("docs/Standalone.java", "docs/Renamed.java");
        assert_eq!(names(&out, &no_edit), Some(("Standalone".into(), "Renamed".into())));
        assert_eq!(
            names(&out, &edit_of(dir.join("docs/Standalone.java"), vec![])),
            Some(("Standalone".into(), "Renamed".into()))
        );
        assert_eq!(names(&out, &edit_of(dir.join("docs/Standalone.java"), one.clone())), None);
        assert_eq!(names(&mv("docs/Standalone.java", "other/Standalone.java"), &no_edit), None);
        assert_eq!(names(&mv("docs/Standalone.java", "docs/Standalone.txt"), &no_edit), None);
        assert_eq!(names(&mv("docs/Missing.java", "docs/Renamed.java"), &no_edit), None);
        // In a source root an empty answer means jdtls was not ready: no file-local rename.
        assert_eq!(names(&mv("src/main/java/App.java", "src/main/java/Main.java"), &no_edit), None);
        // A server edit spelled through a symlink (macOS `/tmp` vs `/private/tmp`) is the same file.
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.join("docs"), dir.join("link")).unwrap();
            assert_eq!(names(&out, &edit_of(dir.join("link/Standalone.java"), one)), None);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn python_module_names_follow_the_roots() {
        let root = Path::new("/p");
        let folder = |path: &str, kind| SourceFolder { path: path.into(), kind, detected_from: None };
        let roots = ProjectRoots::compute(
            vec![folder("src", RootKind::Source), folder("tests", RootKind::Test)],
            &Default::default(),
        );
        let name = |p: &str, dir| python_module(root, &roots, &root.join(p), dir).map(|(m, _)| m);
        assert_eq!(name("src/tasks/models.py", false).as_deref(), Some("tasks.models"));
        assert_eq!(name("src/tasks/__init__.py", false).as_deref(), Some("tasks"));
        assert_eq!(name("src/tasks", true).as_deref(), Some("tasks"));
        assert_eq!(name("tests/test_models.py", false).as_deref(), Some("test_models"));
        assert_eq!(name("scripts/run.pyi", false).as_deref(), Some("scripts.run"));
        assert_eq!(name("my-scripts/run.py", false), None);
        assert_eq!(name("src/tasks/notes.txt", false), None);
        assert_eq!(python_package(root, &roots, &root.join("src/tasks/cli.py")), "tasks");
        assert_eq!(python_package(root, &roots, &root.join("src/tasks/__init__.py")), "tasks");
    }

    #[test]
    fn python_imports_in_a_mixed_project() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let write = |p: &str, text: &str| {
            let path = root.join(p);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        };
        write("backend/pyproject.toml", "[project]\nname = \"b\"\n");
        write("backend/utils.py", "");
        write("backend/app.py", "import utils\nfrom api import routes\n");
        write("backend/api/__init__.py", "");
        write("backend/api/routes.py", "");
        write("backend/bom.py", "\u{feff}from api import routes\n");
        write("backend/tests/utils.py", "");
        write("backend/tests/test_a.py", "import utils\n");
        write("backend/native/_ext.pyi", "");
        write("backend/uses_ext.py", "from native import _ext\n");
        write("frontend/package.json", "{}");
        write("frontend/src/api/index.js", "");
        let roots = ProjectRoots::compute(ide_workspace::roots::detect(root), &Default::default());
        let documents = Documents::new(
            std::sync::Arc::new(|_| {}),
            Box::new(|_: &Path, _: Option<&str>| ide_core::LanguageId::new("python")),
        );
        let edits = |from: &str, to: &str| {
            let moves = vec![FileMove { from: root.join(from).into(), to: root.join(to).into() }];
            let edit = python_import_edits(root, &roots, &[], &documents, &Syntax::new(), &moves, &|| false);
            edit.files
                .into_iter()
                .filter_map(|f| match f {
                    FileEdit::Edit { path, edits, .. } => Some((rel_path(root, &path).unwrap(), edits)),
                    _ => None,
                })
                .collect::<Vec<_>>()
        };
        // Not Python: a JavaScript folder of the same name.
        assert!(edits("frontend/src/api", "frontend/src/client").is_empty());
        // Same-named modules of different roots.
        let files = edits("backend/tests/utils.py", "backend/tests/helpers.py");
        assert_eq!(files.iter().map(|f| f.0.as_str()).collect::<Vec<_>>(), ["backend/tests/test_a.py"]);
        // A BOM doesn't shift the edit.
        let files = edits("backend/api", "backend/web");
        assert_eq!(files.iter().map(|f| f.0.as_str()).collect::<Vec<_>>(), ["backend/app.py", "backend/bom.py"]);
        assert_eq!(files[1].1[0].range.start, ide_core::Pos { line: 0, col: 5 });
        // A stub without its module.
        assert!(edits("backend/native/_ext.pyi", "backend/native/_ext2.pyi").is_empty());
    }
}
