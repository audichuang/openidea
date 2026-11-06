//! Keeps git's index in step with a file refactoring, the way `git mv` does: index
//! entries under a moved path move to the new path with their staged blob and mode, so
//! staged content stays staged and unstaged edits stay unstaged. Paths git doesn't
//! track, moves across repositories, and folders outside a repository are left alone.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

/// Index edits for one move, prepared before the files move and applied after.
pub(crate) struct IndexMove {
    root: PathBuf,
    /// `(mode, object id, old path, new path)`, paths relative to `root` with `/`.
    entries: Vec<(String, String, String, String)>,
    /// New paths of intent-to-add entries (`git add -N`): their index blob is a
    /// placeholder, so they are re-added with `add -N` rather than staged as empty files.
    intent_to_add: Vec<String>,
}

/// The index edits that would move the entries at `from` to `to`, or `None` when
/// there is nothing to move (untracked, no repository, different repositories) or when
/// any entry is skip-worktree (sparse checkout) or assume-unchanged: rewriting those
/// entries would drop the flag, so such a move leaves the index alone.
///
/// Known unhandled race: `plan` reads the entries and `apply` writes them back later, so
/// a concurrent `git add` on the same paths in between can be overwritten (rare, not fixed).
pub(crate) fn plan(from: &Path, to: &Path) -> Option<IndexMove> {
    let (root, old) = locate(from)?;
    let (to_root, new) = locate(to)?;
    if root != to_root {
        return None;
    }
    let pathspec = format!(":(literal){old}");
    // `--debug` prints each entry's flags straight from the index, so intent-to-add is
    // read without touching the worktree (a diff would run the project's clean filters).
    let out = run(&root, &["ls-files", "--stage", "--debug", "-z", "--", pathspec.as_str()], None)?;
    let mut intent_to_add = Vec::new();
    let text = String::from_utf8(out.stdout).ok()?;
    let parsed = parse_entries(&text);
    if parsed.iter().any(|(_, _, flags)| flags & (SKIP_WORKTREE | ASSUME_UNCHANGED) != 0) {
        return None;
    }
    let entries: Vec<_> = parsed
        .into_iter()
        .filter_map(|(meta, path, flags)| {
            let ita = flags & INTENT_TO_ADD != 0;
            let mut meta = meta.split(' ');
            let (mode, oid, stage) = (meta.next()?, meta.next()?, meta.next()?);
            // Conflicted entries (stages 1-3) can't be written back as one; a gitlink
            // moves with its `.gitmodules` entry, which this doesn't edit.
            if stage != "0" || mode == "160000" {
                return None;
            }
            let rest = path.strip_prefix(old.as_str())?;
            if !(rest.is_empty() || rest.starts_with('/')) {
                return None;
            }
            let target = format!("{new}{rest}");
            if ita {
                intent_to_add.push(target.clone());
            }
            Some((mode.to_owned(), oid.to_owned(), path.to_owned(), target))
        })
        .collect();
    (!entries.is_empty()).then_some(IndexMove { root, entries, intent_to_add })
}

const INTENT_TO_ADD: u32 = 0x2000_0000;
const SKIP_WORKTREE: u32 = 0x4000_0000;
const ASSUME_UNCHANGED: u32 = 0x8000;

/// Splits `ls-files --stage --debug -z` output into `(meta, path, flags)`.
/// Each entry is `meta\tpath\0` followed by indented stat lines ending in
/// `size: N\tflags: HEX\n`, which run into the next entry's `meta`.
fn parse_entries(text: &str) -> Vec<(&str, &str, u32)> {
    let mut out: Vec<(&str, &str, u32)> = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        let Some((record, tail)) = rest.split_once('\0') else { break };
        let Some((meta, path)) = record.split_once('\t') else { break };
        let mut flags_bits = 0;
        rest = tail;
        if tail.starts_with("  ctime:")
            && let Some((_, flags)) = tail.split_once("\tflags: ")
            && let Some((flags, next)) = flags.split_once('\n')
        {
            flags_bits = u32::from_str_radix(flags, 16).unwrap_or(0);
            rest = next;
        }
        out.push((meta, path, flags_bits));
    }
    out
}

/// Applies all moves in each repository as one index transaction.
pub(crate) fn apply(planned: &[IndexMove]) {
    let mut repositories: Vec<(&Path, Vec<&IndexMove>)> = Vec::new();
    for m in planned {
        if let Some((_, moves)) = repositories.iter_mut().find(|(root, _)| *root == m.root.as_path()) {
            moves.push(m);
        } else {
            repositories.push((&m.root, vec![m]));
        }
    }
    for (root, moves) in repositories {
        if let Err(error) = apply_repository(root, &moves) {
            tracing::warn!("could not move index entries in {}: {error}", root.display());
        }
    }
}

struct IndexLock(Option<PathBuf>);

impl Drop for IndexLock {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn apply_repository(root: &Path, moves: &[&IndexMove]) -> std::io::Result<()> {
    use std::io::{Error, ErrorKind};

    let failed = || Error::other("git index update failed");
    let out = run(root, &["rev-parse", "--git-path", "index"], None).ok_or_else(failed)?;
    let path = String::from_utf8(out.stdout).map_err(|e| Error::new(ErrorKind::InvalidData, e))?;
    let index = dunce::canonicalize(root.join(path.trim_end_matches(['\n', '\r'])))?;
    let mut lock_path = index.as_os_str().to_os_string();
    lock_path.push(".lock");
    let lock_path = PathBuf::from(lock_path);
    // Hold Git's real lock throughout preparation, including intent-to-add writes.
    let mut lock = std::fs::OpenOptions::new().write(true).create_new(true).open(&lock_path)?;
    let mut guard = IndexLock(Some(lock_path.clone()));
    let temporary = tempfile::NamedTempFile::new_in(index.parent().ok_or_else(failed)?)?;
    let metadata = std::fs::metadata(&index)?;
    std::fs::copy(&index, temporary.path())?;
    // Git uses the index timestamp to detect entries that need a racy-clean check.
    temporary.as_file().set_times(std::fs::FileTimes::new().set_modified(metadata.modified()?))?;
    let mut input = Vec::new();
    for m in moves {
        for (_, oid, old, _) in &m.entries {
            input.extend_from_slice(format!("0 {}\t{old}\0", "0".repeat(oid.len())).as_bytes());
        }
    }
    for m in moves {
        for (mode, oid, _, new) in &m.entries {
            if !m.intent_to_add.contains(new) {
                input.extend_from_slice(format!("{mode} {oid}\t{new}\0").as_bytes());
            }
        }
    }
    run_with_index(root, &["update-index", "-z", "--index-info"], Some(&input), Some(temporary.path()))
        .ok_or_else(failed)?;
    for m in moves {
        for new in &m.intent_to_add {
            let pathspec = format!(":(literal){new}");
            run_with_index(root, &["add", "-N", "-f", "--", &pathspec], None, Some(temporary.path()))
                .ok_or_else(failed)?;
        }
    }
    let mut prepared = std::fs::File::open(temporary.path())?;
    std::io::copy(&mut prepared, &mut lock)?;
    lock.set_permissions(std::fs::metadata(&index)?.permissions())?;
    lock.sync_all()?;
    drop(lock);
    std::fs::rename(&lock_path, &index)?;
    guard.0 = None;
    Ok(())
}

/// The repository root containing `path` and `path` relative to it (`/`-separated).
/// `path` and any of its parent folders need not exist yet (a move creates them), so
/// this resolves from the nearest existing ancestor.
fn locate(path: &Path) -> Option<(PathBuf, String)> {
    let mut missing = vec![path.file_name()?.to_str()?];
    let mut dir = path.parent()?;
    let base = loop {
        if let Ok(found) = dunce::canonicalize(dir) {
            break found;
        }
        missing.push(dir.file_name()?.to_str()?);
        dir = dir.parent()?;
    };
    let out = run(&base, &["rev-parse", "--show-toplevel"], None)?;
    let top = String::from_utf8(out.stdout).ok()?;
    let root = dunce::canonicalize(top.trim_end_matches(['\n', '\r'])).ok()?;
    let mut parts = Vec::new();
    for part in base.strip_prefix(&root).ok()?.components() {
        parts.push(part.as_os_str().to_str()?);
    }
    parts.extend(missing.into_iter().rev());
    Some((root, parts.join("/")))
}

/// Runs git in `dir`; `None` when git is missing or the command fails.
fn run(dir: &Path, args: &[&str], stdin: Option<&[u8]>) -> Option<Output> {
    run_with_index(dir, args, stdin, None)
}

fn run_with_index(dir: &Path, args: &[&str], stdin: Option<&[u8]>, index: Option<&Path>) -> Option<Output> {
    let git = ide_vcs::detected_git_executable()?;
    let mut cmd = Command::new(git);
    // A project's own config must not run commands here (untrusted projects included).
    cmd.current_dir(dir)
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=",
            "-c",
            "submodule.recurse=false",
            "-c",
            "protocol.allow=never",
        ])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        // A partial clone's lazy fetch would run the repo's own transport command.
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("LC_ALL", "C")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(index) = index {
        cmd.env("GIT_INDEX_FILE", index);
    }
    ide_core::process::prepare(&mut cmd);
    let mut child = cmd.spawn().ok()?;
    if let Some(input) = stdin {
        let mut pipe = child.stdin.take()?;
        let written = pipe.write_all(input);
        drop(pipe);
        if written.is_err() {
            let _ = child.wait();
            return None;
        }
    }
    let out = child.wait_with_output().ok()?;
    if !out.status.success() {
        tracing::debug!("git {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim());
        return None;
    }
    Some(out)
}

#[cfg(all(test, unix))]
mod tests {
    use super::run;

    #[test]
    fn git_runs_without_lazy_fetch_or_transports() {
        let tmp = tempfile::tempdir().unwrap();
        let out = run(tmp.path(), &["-c", "alias.probe=!printf '%s|' \"$GIT_NO_LAZY_FETCH\"", "probe"], None).unwrap();
        assert_eq!(String::from_utf8(out.stdout).unwrap(), "1|");
        let out = run(tmp.path(), &["-c", "alias.probe=!git config protocol.allow", "probe"], None).unwrap();
        assert_eq!(String::from_utf8(out.stdout).unwrap().trim(), "never");
    }
}

#[cfg(test)]
mod transaction_tests {
    use crate::{Documents, FileMove, FileMoves};
    use ide_core::{LanguageId, WorkspaceEdit};
    use std::path::Path;
    use std::process::Command;
    use std::sync::Arc;

    fn perform(root: &Path, paths: &[(&str, &str)]) {
        let documents =
            Documents::new(Arc::new(|_| {}), Box::new(|_: &Path, _: Option<&str>| LanguageId::new("plaintext")));
        let moves: Vec<_> = paths
            .iter()
            .map(|(from, to)| FileMove { from: root.join(from).into(), to: root.join(to).into() })
            .collect();
        FileMoves::new()
            .perform(&documents, None, &moves, &WorkspaceEdit::default(), "Rename", true, &|edit| {
                documents.apply_file_move_edits(edit)
            })
            .unwrap();
    }

    fn git(root: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .current_dir(root)
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        String::from_utf8(output.stdout).unwrap()
    }

    fn repo() -> tempfile::TempDir {
        let temporary = tempfile::tempdir().unwrap();
        git(temporary.path(), &["init", "-q"]);
        std::fs::create_dir(temporary.path().join("keep")).unwrap();
        std::fs::write(temporary.path().join("keep/base"), "base").unwrap();
        git(temporary.path(), &["add", "."]);
        git(temporary.path(), &["commit", "-qm", "init"]);
        temporary
    }

    #[test]
    fn failed_intent_to_add_keeps_the_whole_repository_index_unchanged() {
        let temporary = repo();
        let root = temporary.path();
        git(root, &["sparse-checkout", "set", "--cone", "keep"]);
        std::fs::write(root.join("keep/ita"), "intent").unwrap();
        git(root, &["add", "-N", "keep/ita"]);
        let before = std::fs::read(root.join(".git/index")).unwrap();
        perform(root, &[("keep/base", "keep/renamed"), ("keep/ita", "excluded/ita")]);
        assert_eq!(std::fs::read(root.join(".git/index")).unwrap(), before);
        assert!(!root.join(".git/index.lock").exists());
    }

    #[test]
    fn transaction_preserves_staged_content_intent_to_add_and_other_flags() {
        let temporary = repo();
        let root = temporary.path();
        std::fs::write(root.join("keep/base"), "staged").unwrap();
        std::fs::write(root.join("keep/flagged"), "flagged").unwrap();
        git(root, &["add", "."]);
        git(root, &["update-index", "--assume-unchanged", "keep/flagged"]);
        let staged = git(root, &["rev-parse", ":keep/base"]);
        std::fs::write(root.join("keep/base"), "unstaged").unwrap();
        std::fs::write(root.join("keep/ita"), "intent").unwrap();
        git(root, &["add", "-N", "keep/ita"]);
        perform(root, &[("keep/base", "keep/renamed"), ("keep/ita", "keep/new-ita")]);
        assert_eq!(git(root, &["rev-parse", ":keep/renamed"]), staged);
        assert_eq!(std::fs::read_to_string(root.join("keep/renamed")).unwrap(), "unstaged");
        assert_eq!(git(root, &["ls-files", "-v", "--", "keep/flagged"]), "h keep/flagged\n");
        assert!(git(root, &["ls-files", "--debug", "--", "keep/new-ita"]).contains("flags: 20004000"));
        assert_eq!(git(root, &["ls-files", "--", "keep/base", "keep/ita"]), "");
        assert!(!root.join(".git/index.lock").exists());
    }

    #[test]
    fn transaction_keeps_unrelated_racy_file_visible_to_git_diff() {
        use std::fs::{File, FileTimes};
        use std::time::{Duration, SystemTime, UNIX_EPOCH};

        let temporary = repo();
        let root = temporary.path();
        git(root, &["config", "core.trustctime", "false"]);
        git(root, &["config", "core.checkStat", "minimal"]);
        let seconds = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() - 10;
        let modified = UNIX_EPOCH + Duration::from_secs(seconds);
        let file = root.join("keep/racy");
        std::fs::write(&file, "staged!!").unwrap();
        File::options().write(true).open(&file).unwrap().set_times(FileTimes::new().set_modified(modified)).unwrap();
        git(root, &["add", "keep/racy"]);
        // Equal file/index timestamps require Git's racy-entry content check.
        File::options()
            .write(true)
            .open(root.join(".git/index"))
            .unwrap()
            .set_times(FileTimes::new().set_modified(modified))
            .unwrap();
        std::fs::write(&file, "changed!").unwrap();
        File::options().write(true).open(&file).unwrap().set_times(FileTimes::new().set_modified(modified)).unwrap();
        assert_eq!(git(root, &["diff", "--name-only", "--", "keep/racy"]), "keep/racy\n");
        perform(root, &[("keep/base", "keep/renamed")]);
        assert_eq!(git(root, &["show", ":keep/racy"]), "staged!!");
        assert_eq!(git(root, &["diff", "--name-only", "--", "keep/racy"]), "keep/racy\n");
        assert_eq!(git(root, &["show", ":keep/renamed"]), "base");
        assert!(!root.join(".git/index.lock").exists());
    }

    #[cfg(unix)]
    fn symlink_index(root: &Path) -> std::path::PathBuf {
        use std::os::unix::fs::symlink;

        let target = root.join(".git/actual-index");
        std::fs::rename(root.join(".git/index"), &target).unwrap();
        std::fs::create_dir(root.join(".git/links")).unwrap();
        symlink("../actual-index", root.join(".git/links/hop")).unwrap();
        symlink("links/hop", root.join(".git/index")).unwrap();
        target
    }

    #[cfg(unix)]
    #[test]
    fn transaction_updates_symlink_index_target_and_preserves_relative_link_chain() {
        let temporary = repo();
        let root = temporary.path();
        let target = symlink_index(root);
        let before = std::fs::read(&target).unwrap();
        perform(root, &[("keep/base", "keep/renamed")]);
        assert_eq!(std::fs::read_link(root.join(".git/index")).unwrap(), Path::new("links/hop"));
        assert_eq!(std::fs::read_link(root.join(".git/links/hop")).unwrap(), Path::new("../actual-index"));
        assert_ne!(std::fs::read(&target).unwrap(), before);
        assert_eq!(git(root, &["show", ":keep/renamed"]), "base");
        assert_eq!(git(root, &["ls-files", "--", "keep/base"]), "");
        assert!(!root.join(".git/actual-index.lock").exists());
        assert!(!root.join(".git/index.lock").exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_index_target_lock_prevents_any_index_change() {
        let temporary = repo();
        let root = temporary.path();
        let target = symlink_index(root);
        let before = std::fs::read(&target).unwrap();
        let lock = root.join(".git/actual-index.lock");
        std::fs::write(&lock, "other git process").unwrap();
        perform(root, &[("keep/base", "keep/renamed")]);
        assert_eq!(std::fs::read_link(root.join(".git/index")).unwrap(), Path::new("links/hop"));
        assert_eq!(std::fs::read_link(root.join(".git/links/hop")).unwrap(), Path::new("../actual-index"));
        assert_eq!(std::fs::read(&target).unwrap(), before);
        assert_eq!(std::fs::read_to_string(&lock).unwrap(), "other git process");
        assert_eq!(git(root, &["show", ":keep/base"]), "base");
        assert_eq!(git(root, &["ls-files", "--", "keep/renamed"]), "");
        assert!(!root.join(".git/index.lock").exists());
    }

    #[cfg(unix)]
    #[test]
    fn transaction_preserves_shared_repository_index_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let temporary = repo();
        let root = temporary.path();
        let index = root.join(".git/index");
        git(root, &["config", "core.sharedRepository", "0660"]);
        std::fs::set_permissions(&index, std::fs::Permissions::from_mode(0o660)).unwrap();
        let before = std::fs::metadata(&index).unwrap().permissions().mode();
        perform(root, &[("keep/base", "keep/renamed")]);
        // Check before another Git command can refresh the index and mask the mode change.
        assert_eq!(std::fs::metadata(&index).unwrap().permissions().mode(), before);
    }

    #[test]
    fn existing_index_lock_is_preserved_and_prevents_any_index_change() {
        let temporary = repo();
        let root = temporary.path();
        let before = std::fs::read(root.join(".git/index")).unwrap();
        std::fs::write(root.join(".git/index.lock"), "other git process").unwrap();
        perform(root, &[("keep/base", "keep/renamed")]);
        assert_eq!(std::fs::read(root.join(".git/index")).unwrap(), before);
        assert_eq!(std::fs::read_to_string(root.join(".git/index.lock")).unwrap(), "other git process");
    }
}
