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
/// there is nothing to move (untracked, no repository, different repositories).
pub(crate) fn plan(from: &Path, to: &Path) -> Option<IndexMove> {
    let (root, old) = locate(from)?;
    let (to_root, new) = locate(to)?;
    if root != to_root {
        return None;
    }
    let pathspec = format!(":(literal){old}");
    let out = run(&root, &["ls-files", "--stage", "-z", "--", pathspec.as_str()], None)?;
    // An intent-to-add entry shows as an added file in the index-to-worktree diff.
    let ita_out =
        run(&root, &["diff", "--no-ext-diff", "--name-only", "-z", "--diff-filter=A", "--", pathspec.as_str()], None)?;
    let ita: std::collections::HashSet<String> =
        String::from_utf8(ita_out.stdout).ok()?.split('\0').filter(|p| !p.is_empty()).map(str::to_owned).collect();
    let mut intent_to_add = Vec::new();
    let entries: Vec<_> = String::from_utf8(out.stdout)
        .ok()?
        .split('\0')
        .filter_map(|record| {
            let (meta, path) = record.split_once('\t')?;
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
            if ita.contains(path) {
                intent_to_add.push(target.clone());
            }
            Some((mode.to_owned(), oid.to_owned(), path.to_owned(), target))
        })
        .collect();
    (!entries.is_empty()).then_some(IndexMove { root, entries, intent_to_add })
}

/// Applies `planned`, one `git update-index` run per move.
pub(crate) fn apply(planned: &[IndexMove]) {
    for m in planned {
        let mut input = Vec::new();
        for (_, oid, old, _) in &m.entries {
            input.extend_from_slice(format!("0 {}\t{old}\0", "0".repeat(oid.len())).as_bytes());
        }
        for (mode, oid, _, new) in &m.entries {
            if m.intent_to_add.contains(new) {
                continue;
            }
            input.extend_from_slice(format!("{mode} {oid}\t{new}\0").as_bytes());
        }
        if run(&m.root, &["update-index", "-z", "--index-info"], Some(input.as_slice())).is_none() {
            tracing::warn!("could not move index entries in {}", m.root.display());
            continue;
        }
        for new in &m.intent_to_add {
            let pathspec = format!(":(literal){new}");
            if run(&m.root, &["add", "-N", "--", pathspec.as_str()], None).is_none() {
                tracing::warn!("could not re-add intent-to-add entry {new} in {}", m.root.display());
            }
        }
    }
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
