//! File move / rename refactoring: reference updates from the language
//! servers, the move itself (one undoable step) and its undo.
use crate::Host;
use ide_command::command;

use ide_core::{CancellationToken, FileEdit, IdeResult, LanguageId, RequestId, WorkspaceEdit};
use ide_language::Syntax;
use ide_lsp::types::FileRenameEdits;
use ide_syntax::{Snapshot, StructureService};
use ide_workspace::file_moves::moved_path;
use ide_workspace::roots::{ProjectRoots, RootKind};
use ide_workspace::{FileMove, UndoOutcome};
use parking_lot::Mutex;
use std::path::{Path, PathBuf};

use super::blocking;

fn pairs(moves: &[FileMove]) -> Vec<(PathBuf, PathBuf)> {
    moves.iter().map(|m| (m.from.to_path_buf(), m.to.to_path_buf())).collect()
}

/// `workspace/willRenameFiles` on every interested server (before the move). Cancellable.
#[command(trust = always)]
pub async fn refactor_file_move_edits(
    host: &Host,
    window: &str,
    request: RequestId,
    moves: Vec<FileMove>,
) -> IdeResult<FileRenameEdits> {
    let project = host.project(window)?;
    let token = host.begin_request(request);
    let result = project.lsp.will_rename_files(&pairs(&moves), token.clone()).await;
    host.end_request(request);
    let mut result = result?;
    let syntax = host.syntax();
    blocking(move || {
        // basedpyright has no `workspace/willRenameFiles`; a Python server that answered wins.
        if !result.edit.files.iter().any(|f| matches!(f, FileEdit::Edit { path, .. } if is_python(path))) {
            let python = python_import_edits(&project, &syntax, &moves, &|| token.is_cancelled());
            result.edit.files.extend(python.files);
        }
        for m in &moves {
            if let Some(edit) = java_type_rename_edit(&project, &syntax, m, &result.edit, &token) {
                result.edit.files.push(edit);
            }
        }
        project.documents.prepare_workspace_edit(&mut result.edit)?;
        Ok(result)
    })
    .await
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

/// The dotted name of a Python module file or package folder, from its project's Python roots
/// (`src/a/b.py` → `a.b` in a `src` layout).
fn python_module(root: &Path, roots: &ProjectRoots, path: &Path, is_dir: bool) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?.to_string_lossy().replace('\\', "/");
    let base = roots
        .root_for(&rel)
        .filter(|r| matches!(r.kind, RootKind::Source | RootKind::Test))
        .map_or("", |r| r.path.as_str());
    let inner = if base.is_empty() { rel.as_str() } else { rel.strip_prefix(base)?.trim_start_matches('/') };
    let inner = if is_dir { inner } else { inner.strip_suffix(".py").or_else(|| inner.strip_suffix(".pyi"))? };
    let inner = inner.strip_suffix("/__init__").unwrap_or(inner);
    let valid = |s: &str| {
        s.chars().next().is_some_and(|c| !c.is_ascii_digit()) && s.chars().all(|c| c == '_' || c.is_alphanumeric())
    };
    (!inner.is_empty() && inner.split('/').all(valid)).then(|| inner.replace('/', "."))
}

/// The package relative imports in `file` start from.
fn python_package(root: &Path, roots: &ProjectRoots, file: &Path) -> String {
    let Some(module) = python_module(root, roots, file, false) else { return String::new() };
    if file.file_stem().is_some_and(|s| s == "__init__") {
        module
    } else {
        module.rsplit_once('.').map_or(String::new(), |(p, _)| p.to_owned())
    }
}

/// Import updates in the project's Python files for `moves` (paths before the move).
fn python_import_edits(
    project: &crate::project::Project,
    syntax: &Syntax,
    moves: &[FileMove],
    cancelled: &(dyn Fn() -> bool + Sync),
) -> WorkspaceEdit {
    let root = &project.root;
    let roots = project.roots();
    let renames: Vec<(String, String)> = moves
        .iter()
        .filter_map(|m| {
            let is_dir = m.from.is_dir();
            if !is_dir && (!is_python(&m.from) || m.from.file_stem().is_some_and(|s| s == "__init__")) {
                return None;
            }
            let old = python_module(root, &roots, &m.from, is_dir)?;
            let new = python_module(root, &roots, &m.to, is_dir)?;
            (old != new).then_some((old, new))
        })
        .collect();
    if renames.is_empty() {
        return WorkspaceEdit::default();
    }
    let names: Vec<&str> = renames.iter().map(|(old, _)| old.rsplit('.').next().unwrap_or(old)).collect();
    let found: Mutex<Vec<(PathBuf, Vec<ide_core::TextEdit>)>> = Mutex::new(Vec::new());
    ide_vfs::walk_files(root, &project.exclude_globs(), |path| {
        if cancelled() || !is_python(path) {
            return;
        }
        let moved = moved_path(path, moves);
        let text = match project.documents.text_of(path) {
            Some(t) => t,
            None => match std::fs::read_to_string(path) {
                Ok(t) => t,
                Err(_) => return,
            },
        };
        if moved == path && !names.iter().any(|n| text.contains(n)) {
            return;
        }
        let edits = syntax.python_import_edits(
            &text,
            &python_package(root, &roots, path),
            &python_package(root, &roots, &moved),
            &renames,
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
    let trusted = project.is_trusted();
    let id = blocking(move || {
        let apply = |e: &WorkspaceEdit| p.documents.apply_file_move_edits(e);
        p.moves.perform(&p.documents, Some(&p.history), &moved, &edit, &label, trusted, &apply)
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
    let trusted = project.is_trusted();
    let outcome = blocking(move || p.moves.undo(&p.documents, Some(&p.history), trusted, id)).await?;
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
    use ide_workspace::roots::SourceFolder;

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
        let name = |p: &str, dir| python_module(root, &roots, &root.join(p), dir);
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
}
