//! Move / rename of files and folders as one undoable refactoring: the
//! reference updates (a [`WorkspaceEdit`] from the language servers), then the
//! file system operation, with git's index entries following the files (as
//! `git mv` does). Undo moves the files back and reverts the edits.

use crate::documents::Documents;
use crate::history::LocalHistory;
use ide_core::{FileEdit, IdeError, IdeResult, WorkspaceEdit};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};

/// One file or folder move.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileMove {
    pub from: ide_core::IpcPath,
    pub to: ide_core::IpcPath,
}

/// What [`FileMoves::undo`] did.
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UndoOutcome {
    /// Moves reverted (each `from` is the original location again).
    pub moves: Vec<FileMove>,
    /// Edited files changed since the refactoring, so their edits were kept.
    pub conflicts: Vec<ide_core::IpcPath>,
}

struct EditedFile {
    /// Where the file is after the refactoring.
    path: PathBuf,
    before: String,
    after: String,
}

struct MoveRecord {
    id: u32,
    moves: Vec<FileMove>,
    edited: Vec<EditedFile>,
}

/// Undo stack of file refactorings for one project.
#[derive(Default)]
pub struct FileMoves {
    records: Mutex<Vec<MoveRecord>>,
    next: Mutex<u32>,
}

/// Undo records kept per project.
const MAX_RECORDS: usize = 20;

/// `path` after `moves` (a file inside a moved folder moves with it).
pub fn moved_path(path: &Path, moves: &[FileMove]) -> PathBuf {
    let mut out = path.to_path_buf();
    for m in moves {
        if let Ok(rest) = out.strip_prefix(&m.from) {
            out = if rest.as_os_str().is_empty() { m.to.to_path_buf() } else { m.to.join(rest) };
        }
    }
    out
}

/// Text as the document layer sees it (normalized line endings, unsaved edits).
fn read_text(documents: &Documents, path: &Path) -> IdeResult<String> {
    if let Some(text) = documents.text_of(path) {
        return Ok(text);
    }
    let info = documents.open(path)?;
    let text = documents.text_snapshot(info.id).map(|s| s.text);
    documents.close(info.id);
    text
}

/// Replaces the whole text through the document layer (open editors update) and saves.
fn write_text(documents: &Documents, path: &Path, text: &str) -> IdeResult<()> {
    let (doc, transient) = match documents.by_path(path) {
        Some(doc) => (doc, false),
        None => (documents.open(path)?.id, true),
    };
    let result = documents.replace_all(doc, text).and_then(|_| documents.save(doc));
    if transient {
        documents.close(doc);
    }
    result
}

fn edited_paths(edit: &WorkspaceEdit) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for f in &edit.files {
        if let FileEdit::Edit { path, edits, .. } = f
            && !edits.is_empty()
            && !out.iter().any(|p| p == path)
        {
            out.push(path.to_path_buf());
        }
    }
    out
}

impl FileMoves {
    pub fn new() -> Self {
        Self::default()
    }

    /// Applies `edit` (paths as before the move, as `workspace/willRenameFiles`
    /// returns them), then performs `moves`. Edited files are snapshotted in
    /// Local History first. On failure everything done so far is rolled back.
    /// `sync_git_index` is false for untrusted projects: no git command runs then.
    /// Returns the id for [`undo`](Self::undo).
    pub fn perform(
        &self,
        documents: &Documents,
        history: Option<&LocalHistory>,
        moves: &[FileMove],
        edit: &WorkspaceEdit,
        label: &str,
        sync_git_index: bool,
        apply_edit: &dyn Fn(&WorkspaceEdit) -> IdeResult<()>,
    ) -> IdeResult<u32> {
        if moves.is_empty() {
            return Err(IdeError::invalid("nothing to move"));
        }
        for m in moves {
            if !m.from.exists() {
                return Err(IdeError::not_found(format!("{} does not exist", m.from.display())));
            }
            if m.to.starts_with(&m.from) && m.to != m.from {
                return Err(IdeError::invalid(format!("cannot move {} into itself", m.from.display())));
            }
        }
        let paths = edited_paths(edit);
        let mut before = Vec::with_capacity(paths.len());
        for p in &paths {
            let text = read_text(documents, p)?;
            if let Some(h) = history
                && let Err(e) = h.record_event(p, &text, &format!("Before refactoring: {label}"))
            {
                tracing::warn!("local history: {e}");
            }
            before.push(text);
        }
        if !paths.is_empty()
            && let Err(e) = apply_edit(edit)
        {
            restore(documents, &paths, &before);
            return Err(e);
        }
        let index: Vec<_> = if sync_git_index {
            moves.iter().filter_map(|m| crate::git_index::plan(&m.from, &m.to)).collect()
        } else {
            Vec::new()
        };
        let mut done: Vec<&FileMove> = Vec::new();
        for m in moves {
            if let Err(e) = ide_vfs::rename(&m.from, &m.to) {
                for d in done.iter().rev() {
                    let _ = ide_vfs::rename(&d.to, &d.from);
                }
                restore(documents, &paths, &before);
                return Err(e);
            }
            done.push(m);
        }
        if let Some(h) = history
            && let Err(e) = h.follow_moves(moves)
        {
            tracing::warn!("local history: {e}");
        }
        crate::git_index::apply(&index);
        let mut edited = Vec::with_capacity(paths.len());
        for (p, before) in paths.iter().zip(before) {
            let path = moved_path(p, moves);
            let after = read_text(documents, &path).unwrap_or_default();
            edited.push(EditedFile { path, before, after });
        }
        let id = {
            let mut next = self.next.lock();
            *next += 1;
            *next
        };
        let mut records = self.records.lock();
        records.push(MoveRecord { id, moves: moves.to_vec(), edited });
        if records.len() > MAX_RECORDS {
            records.remove(0);
        }
        Ok(id)
    }

    /// Whether `id` can still be undone.
    pub fn can_undo(&self, id: u32) -> bool {
        self.records.lock().iter().any(|r| r.id == id)
    }

    /// Id of the latest undoable refactoring.
    pub fn last(&self) -> Option<u32> {
        self.records.lock().last().map(|r| r.id)
    }

    /// Moves the files back and restores the edited files' text. Files changed
    /// since the refactoring keep their content and are reported as conflicts.
    /// `history` follows the moved-back files, also when undo fails part-way.
    /// `sync_git_index` is false for untrusted projects: no git command runs then.
    pub fn undo(
        &self,
        documents: &Documents,
        history: Option<&LocalHistory>,
        sync_git_index: bool,
        id: u32,
    ) -> IdeResult<UndoOutcome> {
        let record = {
            let mut records = self.records.lock();
            let i = records
                .iter()
                .position(|r| r.id == id)
                .ok_or_else(|| IdeError::not_found("the refactoring can no longer be undone"))?;
            records.remove(i)
        };
        for m in &record.moves {
            if !m.to.exists() {
                return Err(IdeError::not_found(format!("{} no longer exists", m.to.display())));
            }
            if m.from.exists() {
                return Err(IdeError::new(
                    ide_core::error::ErrorKind::AlreadyExists,
                    format!("{} exists again", m.from.display()),
                ));
            }
        }
        let mut outcome = UndoOutcome::default();
        let mut failure = None;
        let planned: Vec<_> = record
            .moves
            .iter()
            .rev()
            .map(|m| if sync_git_index { crate::git_index::plan(&m.to, &m.from) } else { None })
            .collect();
        for m in record.moves.iter().rev() {
            if let Err(e) = ide_vfs::rename(&m.to, &m.from) {
                failure = Some(e);
                break;
            }
            outcome.moves.push(FileMove { from: m.to.clone(), to: m.from.clone() });
        }
        // The record is already consumed, so history and the git index must follow
        // every rename that happened, even when a later step fails.
        let index: Vec<_> = planned.into_iter().take(outcome.moves.len()).flatten().collect();
        crate::git_index::apply(&index);
        if let Some(h) = history
            && !outcome.moves.is_empty()
            && let Err(e) = h.follow_moves(&outcome.moves)
        {
            tracing::warn!("local history: {e}");
        }
        if let Some(e) = failure {
            return Err(e);
        }
        let back: Vec<FileMove> = outcome.moves.clone();
        for f in &record.edited {
            let path = moved_path(&f.path, &back);
            match read_text(documents, &path) {
                Ok(now) if now == f.after => write_text(documents, &path, &f.before)?,
                Ok(now) if now == f.before => {}
                _ => outcome.conflicts.push(path.into()),
            }
        }
        Ok(outcome)
    }
}

fn restore(documents: &Documents, paths: &[PathBuf], before: &[String]) {
    for (p, text) in paths.iter().zip(before) {
        if let Err(e) = write_text(documents, p, text) {
            tracing::warn!("rollback {}: {e}", p.display());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::{LanguageId, Pos, Range, TextEdit};
    use std::fs;
    use std::sync::Arc;

    fn documents() -> Documents {
        Documents::new(Arc::new(|_| {}), Box::new(|_: &Path, _: Option<&str>| LanguageId::new("plaintext")))
    }

    fn apply(documents: &Documents) -> impl Fn(&WorkspaceEdit) -> IdeResult<()> + '_ {
        move |edit| documents.apply_file_move_edits(edit)
    }

    #[test]
    fn move_with_edits_and_undo() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("a")).unwrap();
        fs::write(root.join("a/util.ts"), "export const x = 1;\n").unwrap();
        fs::write(root.join("main.ts"), "import { x } from './a/util';\n").unwrap();
        let docs = documents();
        let history = LocalHistory::open(&root.join(".history"), root).unwrap();
        let moves = FileMoves::new();
        let mv = vec![FileMove { from: root.join("a").into(), to: root.join("b").into() }];
        let edit = WorkspaceEdit {
            files: vec![FileEdit::Edit {
                path: root.join("main.ts").into(),
                version: None,
                edits: vec![TextEdit { range: Range::new(Pos::new(0, 21), Pos::new(0, 22)), new_text: "b".into() }],
            }],
            ..Default::default()
        };
        history.record(&root.join("a/util.ts"), "export const x = 1;\n", "Saved").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let id = moves.perform(&docs, Some(&history), &mv, &edit, "Move", true, &apply(&docs)).unwrap();
        assert!(root.join("b/util.ts").exists() && !root.join("a").exists());
        assert_eq!(fs::read_to_string(root.join("main.ts")).unwrap(), "import { x } from './b/util';\n");
        let snaps = history.list(&root.join("main.ts")).unwrap();
        assert_eq!(snaps[0].label, "Before refactoring: Move");
        // The moved file's history follows it.
        let moved: Vec<String> = history.list(&root.join("b/util.ts")).unwrap().into_iter().map(|e| e.label).collect();
        assert_eq!(moved, vec!["Renaming a to b", "Saved"]);
        assert!(history.list(&root.join("a/util.ts")).unwrap().is_empty());
        assert_eq!(moves.last(), Some(id));

        let undone = moves.undo(&docs, None, true, id).unwrap();
        assert!(undone.conflicts.is_empty());
        assert_eq!(undone.moves, vec![FileMove { from: root.join("b").into(), to: root.join("a").into() }]);
        assert!(root.join("a/util.ts").exists() && !root.join("b").exists());
        assert_eq!(fs::read_to_string(root.join("main.ts")).unwrap(), "import { x } from './a/util';\n");
        assert!(!moves.can_undo(id));
        assert!(moves.undo(&docs, None, true, id).is_err());
    }

    #[test]
    fn failed_undo_still_moves_history_of_files_already_moved_back() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("sub/A.txt"), "a").unwrap();
        fs::write(root.join("B.txt"), "b").unwrap();
        let docs = documents();
        let history = LocalHistory::open(&root.join(".history"), root).unwrap();
        history.record(&root.join("sub/A.txt"), "a", "Saved").unwrap();
        history.record(&root.join("B.txt"), "b", "Saved").unwrap();
        let moves = FileMoves::new();
        let mv = vec![
            FileMove { from: root.join("sub/A.txt").into(), to: root.join("A2.txt").into() },
            FileMove { from: root.join("B.txt").into(), to: root.join("B2.txt").into() },
        ];
        let id = moves.perform(&docs, Some(&history), &mv, &WorkspaceEdit::default(), "Move", true, &apply(&docs)).unwrap();
        // Undo renames B2 back first, then fails on A2 because `sub` is now a file.
        fs::remove_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("sub"), "x").unwrap();
        assert!(moves.undo(&docs, Some(&history), true, id).is_err());
        assert!(root.join("B.txt").exists() && root.join("A2.txt").exists());
        assert!(!history.list(&root.join("B.txt")).unwrap().is_empty());
        assert!(history.list(&root.join("B2.txt")).unwrap().is_empty());
    }

    #[test]
    fn undo_keeps_files_changed_since_and_failed_moves_roll_back() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::write(root.join("Foo.java"), "class Foo {}\n").unwrap();
        fs::write(root.join("Use.java"), "Foo f;\n").unwrap();
        let docs = documents();
        let moves = FileMoves::new();
        let edit = WorkspaceEdit {
            files: vec![
                FileEdit::Edit {
                    path: root.join("Foo.java").into(),
                    version: None,
                    edits: vec![TextEdit { range: Range::new(Pos::new(0, 6), Pos::new(0, 9)), new_text: "Bar".into() }],
                },
                FileEdit::Edit {
                    path: root.join("Use.java").into(),
                    version: None,
                    edits: vec![TextEdit { range: Range::new(Pos::new(0, 0), Pos::new(0, 3)), new_text: "Bar".into() }],
                },
            ],
            ..Default::default()
        };
        let mv = vec![FileMove { from: root.join("Foo.java").into(), to: root.join("Bar.java").into() }];
        let id = moves.perform(&docs, None, &mv, &edit, "Rename", true, &apply(&docs)).unwrap();
        assert_eq!(fs::read_to_string(root.join("Bar.java")).unwrap(), "class Bar {}\n");
        fs::write(root.join("Use.java"), "Bar f; // edited\n").unwrap();
        let undone = moves.undo(&docs, None, true, id).unwrap();
        assert_eq!(fs::read_to_string(root.join("Foo.java")).unwrap(), "class Foo {}\n");
        assert_eq!(undone.conflicts, vec![root.join("Use.java")]);
        assert_eq!(fs::read_to_string(root.join("Use.java")).unwrap(), "Bar f; // edited\n");

        // The target exists: the edit is rolled back and nothing moves.
        fs::write(root.join("Bar.java"), "taken").unwrap();
        let err = moves.perform(&docs, None, &mv, &edit, "Rename", true, &apply(&docs)).unwrap_err();
        assert_eq!(err.kind, ide_core::error::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(root.join("Foo.java")).unwrap(), "class Foo {}\n");
        assert_eq!(fs::read_to_string(root.join("Use.java")).unwrap(), "Bar f; // edited\n");
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .current_dir(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).unwrap()
    }

    fn repo() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        git(tmp.path(), &["init", "-q"]);
        tmp
    }

    fn rename(root: &Path, from: &str, to: &str) -> (FileMoves, u32) {
        let moves = FileMoves::new();
        let mv = vec![FileMove { from: root.join(from).into(), to: root.join(to).into() }];
        let docs = documents();
        let id = moves.perform(&docs, None, &mv, &WorkspaceEdit::default(), "Rename", true, &apply(&docs)).unwrap();
        (moves, id)
    }

    #[test]
    fn renaming_a_staged_file_moves_its_index_entry() {
        let tmp = repo();
        let root = tmp.path();
        fs::write(root.join("new.txt"), "new\n").unwrap();
        git(root, &["add", "new.txt"]);
        rename(root, "new.txt", "renamed.txt");
        assert_eq!(git(root, &["status", "--porcelain"]), "A  renamed.txt\n");
        assert_eq!(git(root, &["ls-files"]), "renamed.txt\n");
    }

    #[test]
    fn moving_a_modified_file_keeps_the_staged_blob_and_unstaged_edits() {
        let tmp = repo();
        let root = tmp.path();
        fs::write(root.join("t.txt"), "one\n").unwrap();
        git(root, &["add", "t.txt"]);
        git(root, &["commit", "-q", "-m", "init"]);
        let blob = git(root, &["rev-parse", "HEAD:t.txt"]);
        fs::write(root.join("t.txt"), "one\nedit\n").unwrap();
        fs::create_dir(root.join("d")).unwrap();
        let (moves, id) = rename(root, "t.txt", "d/t.txt");
        assert_eq!(git(root, &["ls-files"]), "d/t.txt\n");
        assert_eq!(git(root, &["rev-parse", ":d/t.txt"]), blob);
        assert_eq!(fs::read_to_string(root.join("d/t.txt")).unwrap(), "one\nedit\n");
        assert_eq!(git(root, &["diff", "--name-only"]), "d/t.txt\n");

        moves.undo(&documents(), None, true, id).unwrap();
        assert_eq!(git(root, &["ls-files"]), "t.txt\n");
        assert_eq!(git(root, &["status", "--porcelain"]), " M t.txt\n");
    }

    #[test]
    fn moving_into_a_folder_that_does_not_exist_yet_moves_the_index_entry() {
        let tmp = repo();
        let root = tmp.path();
        fs::write(root.join("t.txt"), "t\n").unwrap();
        git(root, &["add", "t.txt"]);
        git(root, &["commit", "-q", "-m", "init"]);
        assert!(!root.join("d").exists());
        let (moves, id) = rename(root, "t.txt", "d/e/t.txt");
        assert_eq!(git(root, &["ls-files"]), "d/e/t.txt\n");
        assert_eq!(git(root, &["ls-files", "--others", "--exclude-standard"]), "");
        assert_eq!(git(root, &["diff", "--name-only"]), "");

        moves.undo(&documents(), id).unwrap();
        assert_eq!(git(root, &["ls-files"]), "t.txt\n");
        assert_eq!(git(root, &["status", "--porcelain"]), "");
    }

    #[test]
    fn moving_a_folder_moves_the_entries_under_it_only() {
        let tmp = repo();
        let root = tmp.path();
        fs::create_dir(root.join("a")).unwrap();
        fs::write(root.join("a/x.txt"), "x\n").unwrap();
        fs::write(root.join("a/y.txt"), "y\n").unwrap();
        fs::write(root.join("a/u.txt"), "untracked\n").unwrap();
        fs::write(root.join("ab.txt"), "sibling\n").unwrap();
        git(root, &["add", "a/x.txt", "ab.txt"]);
        git(root, &["commit", "-q", "-m", "init"]);
        git(root, &["add", "a/y.txt"]);
        rename(root, "a", "b");
        assert_eq!(git(root, &["ls-files"]), "ab.txt\nb/x.txt\nb/y.txt\n");
        assert_eq!(git(root, &["ls-files", "--others", "--exclude-standard"]), "b/u.txt\n");
    }

    #[test]
    fn renaming_an_intent_to_add_file_keeps_it_intent_to_add() {
        let tmp = repo();
        let root = tmp.path();
        fs::write(root.join("k.txt"), "k\n").unwrap();
        git(root, &["add", "k.txt"]);
        git(root, &["commit", "-q", "-m", "init"]);
        fs::write(root.join("m.txt"), "content\n").unwrap();
        git(root, &["add", "-N", "m.txt"]);
        rename(root, "m.txt", "n.txt");
        assert_eq!(git(root, &["status", "--porcelain"]), " A n.txt\n");
        git(root, &["add", "n.txt"]);
        git(root, &["commit", "-q", "-m", "n"]);
        assert_eq!(git(root, &["cat-file", "-s", "HEAD:n.txt"]).trim(), "8");
    }

    #[test]
    fn undoing_an_intent_to_add_rename_restores_intent_to_add() {
        let tmp = repo();
        let root = tmp.path();
        fs::write(root.join("k.txt"), "k\n").unwrap();
        git(root, &["add", "k.txt"]);
        git(root, &["commit", "-q", "-m", "init"]);
        fs::write(root.join("m.txt"), "content\n").unwrap();
        git(root, &["add", "-N", "m.txt"]);
        let (moves, id) = rename(root, "m.txt", "n.txt");
        moves.undo(&documents(), id).unwrap();
        assert_eq!(git(root, &["status", "--porcelain"]), " A m.txt\n");
    }

    #[cfg(unix)]
    #[test]
    fn renaming_does_not_run_a_clean_filter_of_the_project() {
        let tmp = repo();
        let root = tmp.path();
        fs::write(root.join("k.txt"), "k\n").unwrap();
        fs::write(root.join("b.txt"), "b\n").unwrap();
        git(root, &["add", "k.txt", "b.txt"]);
        git(root, &["commit", "-q", "-m", "init"]);
        let marker = root.join("MARKER");
        fs::write(root.join(".gitattributes"), "*.txt filter=probe\n").unwrap();
        git(root, &["config", "filter.probe.clean", &format!("touch {}; cat", marker.display())]);
        // Git re-hashes racily clean entries (through clean filters) on any index write,
        // so let the entries age out first; then touch b.txt so only a diff would hash it.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        git(root, &["update-index", "--refresh"]);
        fs::write(root.join("b.txt"), "b\n").unwrap();
        let _ = fs::remove_file(&marker);
        rename(root, "b.txt", "c.txt");
        assert!(!marker.exists(), "the project's clean filter ran");
        assert_eq!(git(root, &["ls-files"]), "c.txt\nk.txt\n");
    }

    #[test]
    fn renaming_an_intent_to_add_file_onto_an_ignored_path_keeps_it_tracked() {
        let tmp = repo();
        let root = tmp.path();
        fs::write(root.join(".gitignore"), "ignored.txt\n").unwrap();
        git(root, &["add", ".gitignore"]);
        git(root, &["commit", "-q", "-m", "init"]);
        fs::write(root.join("a.txt"), "content\n").unwrap();
        git(root, &["add", "-N", "a.txt"]);
        let (moves, id) = rename(root, "a.txt", "ignored.txt");
        assert_eq!(git(root, &["ls-files"]), ".gitignore\nignored.txt\n");
        assert_eq!(git(root, &["status", "--porcelain"]), " A ignored.txt\n");
        moves.undo(&documents(), id).unwrap();
        assert_eq!(git(root, &["status", "--porcelain"]), " A a.txt\n");
    }

    #[test]
    fn untracked_and_cross_repository_moves_leave_the_index_alone() {
        let tmp = repo();
        let root = tmp.path();
        fs::write(root.join("u.txt"), "u\n").unwrap();
        rename(root, "u.txt", "v.txt");
        assert_eq!(git(root, &["ls-files"]), "");

        fs::write(root.join("t.txt"), "t\n").unwrap();
        git(root, &["add", "t.txt"]);
        let other = repo();
        let docs = documents();
        let mv = vec![FileMove { from: root.join("t.txt").into(), to: other.path().join("t.txt").into() }];
        FileMoves::new().perform(&docs, None, &mv, &WorkspaceEdit::default(), "Move", true, &apply(&docs)).unwrap();
        assert_eq!(git(root, &["ls-files"]), "t.txt\n");
        assert_eq!(git(other.path(), &["ls-files"]), "");
    }

    #[test]
    fn untrusted_projects_run_no_git_command_and_leave_the_index_alone() {
        let tmp = repo();
        let root = tmp.path();
        fs::write(root.join("t.txt"), "t\n").unwrap();
        git(root, &["add", "t.txt"]);
        git(root, &["commit", "-q", "-m", "init"]);
        let index = || std::fs::read(root.join(".git/index")).unwrap();
        let before = index();
        let docs = documents();
        let moves = FileMoves::new();
        let mv = vec![FileMove { from: root.join("t.txt").into(), to: root.join("u.txt").into() }];
        let id = moves.perform(&docs, None, &mv, &WorkspaceEdit::default(), "Rename", false, &apply(&docs)).unwrap();
        assert_eq!(index(), before);
        assert_eq!(git(root, &["ls-files"]), "t.txt\n");
        moves.undo(&docs, None, false, id).unwrap();
        assert_eq!(index(), before);
        assert_eq!(git(root, &["ls-files"]), "t.txt\n");
    }

    #[test]
    fn moved_paths() {
        let mv = vec![FileMove { from: "/p/a".into(), to: "/p/b/a".into() }];
        assert_eq!(moved_path(Path::new("/p/a"), &mv), PathBuf::from("/p/b/a"));
        assert_eq!(moved_path(Path::new("/p/a/x.rs"), &mv), PathBuf::from("/p/b/a/x.rs"));
        assert_eq!(moved_path(Path::new("/p/ab"), &mv), PathBuf::from("/p/ab"));
    }
}
