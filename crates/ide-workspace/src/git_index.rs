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
            (rest.is_empty() || rest.starts_with('/'))
                .then(|| (mode.to_owned(), oid.to_owned(), path.to_owned(), format!("{new}{rest}")))
        })
        .collect();
    (!entries.is_empty()).then_some(IndexMove { root, entries })
}

/// Applies `planned`, one `git update-index` run per move.
pub(crate) fn apply(planned: &[IndexMove]) {
    for m in planned {
        let mut input = Vec::new();
        for (_, oid, old, _) in &m.entries {
            input.extend_from_slice(format!("0 {}\t{old}\0", "0".repeat(oid.len())).as_bytes());
        }
        for (mode, oid, _, new) in &m.entries {
            input.extend_from_slice(format!("{mode} {oid}\t{new}\0").as_bytes());
        }
        if run(&m.root, &["update-index", "-z", "--index-info"], Some(input.as_slice())).is_none() {
            tracing::warn!("could not move index entries in {}", m.root.display());
        }
    }
}

/// The repository root containing `path` and `path` relative to it (`/`-separated).
/// `path` itself need not exist; its parent must.
fn locate(path: &Path) -> Option<(PathBuf, String)> {
    let parent = dunce::canonicalize(path.parent()?).ok()?;
    let name = path.file_name()?.to_str()?;
    let out = run(&parent, &["rev-parse", "--show-toplevel"], None)?;
    let top = String::from_utf8(out.stdout).ok()?;
    let root = dunce::canonicalize(top.trim_end_matches(['\n', '\r'])).ok()?;
    let mut rel = String::new();
    for part in parent.strip_prefix(&root).ok()?.components() {
        rel.push_str(part.as_os_str().to_str()?);
        rel.push('/');
    }
    rel.push_str(name);
    Some((root, rel))
}

/// Runs git in `dir`; `None` when git is missing or the command fails.
fn run(dir: &Path, args: &[&str], stdin: Option<&[u8]>) -> Option<Output> {
    let git = ide_vcs::detected_git_executable()?;
    let mut cmd = Command::new(git);
    // A project's own config must not run commands here (untrusted projects included).
    cmd.current_dir(dir)
        .args(["-c", "core.fsmonitor=false", "-c", "core.hooksPath=", "-c", "submodule.recurse=false"])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
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
