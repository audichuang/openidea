//! Working tree status via gitoxide (parallel index refresh + dirwalk), or the git
//! CLI for partial clones and sparse checkouts, which gitoxide cannot read fully.

use crate::repo::{gx, to_string};
use crate::{ChangeKind, FileStatus, Repo};
use gix::status::index_worktree::Item as WtItem;
use gix::status::plumbing::index_as_worktree::{Change as WtChange, EntryStatus};
use ide_core::IdeResult;
use ide_core::ignored::IgnoredNames;
use std::collections::{BTreeMap, HashSet};

#[derive(Debug, Default, PartialEq)]
struct Entry {
    staged: Option<ChangeKind>,
    unstaged: Option<ChangeKind>,
    renamed_from: Option<String>,
}

/// Changes by repository-relative path, and the conflicted paths among them.
#[derive(Default)]
struct Changes {
    map: BTreeMap<String, Entry>,
    conflicts: HashSet<String>,
}

pub(crate) fn status(r: &Repo) -> IdeResult<Vec<FileStatus>> {
    let repo = r.gix()?;
    let ignored = r.ignored.read().unwrap_or_else(|p| p.into_inner()).clone();
    let changes = if needs_git_cli(&repo) {
        cli_changes(r, &ignored)?
    } else {
        match gix_changes(&repo, &ignored) {
            Ok(changes) => changes,
            // Same idea as `blob_data`: a repository gitoxide cannot read (an object
            // missing locally) may still be readable by git itself.
            Err(e) => {
                tracing::debug!("gitoxide status of {} failed, using git: {e}", r.root().display());
                cli_changes(r, &ignored).map_err(|_| e)?
            }
        }
    };
    Ok(finish(r, changes, &ignored))
}

/// Partial clones lack blobs that gitoxide does not fetch on demand, and sparse
/// checkouts carry skip-worktree entries it does not honour: git reads both.
fn needs_git_cli(repo: &gix::Repository) -> bool {
    let config = repo.config_snapshot();
    let enabled = |key: &str| config.boolean(key).unwrap_or(false);
    enabled("core.sparseCheckout")
        || config.string("extensions.partialClone").is_some()
        || repo.remote_names().iter().any(|name| enabled(&format!("remote.{name}.promisor")))
}

/// Status through `git status --porcelain=v2`, without taking the index lock (no
/// stat refresh write-back, so no index change for the watcher to report).
fn cli_changes(r: &Repo, ignored: &IgnoredNames) -> IdeResult<Changes> {
    let restricted = !crate::execution_allowed();
    // Restricted Mode: status compares content through the repository's clean
    // filters, and checks dirty submodules with their own configuration.
    let overrides = if restricted {
        let config = crate::cli::run(r.root(), &["config", "--null", "--list"], None)?;
        crate::cli::filter_overrides_from(&config.stdout_str())?
    } else {
        Vec::new()
    };
    let mut args: Vec<&str> = overrides.iter().map(String::as_str).collect();
    args.extend(["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all"]);
    if restricted {
        // Restricted git may not fetch missing blobs, and rename detection needs them.
        args.extend(["--no-renames", "--ignore-submodules=dirty"]);
    }
    let out = crate::cli::run(r.root(), &args, None)?;
    Ok(parse_porcelain_v2(&out.stdout, ignored))
}

/// Parses NUL-terminated `git status --porcelain=v2 -z` output into the same entries
/// the gitoxide path produces.
fn parse_porcelain_v2(out: &[u8], ignored: &IgnoredNames) -> Changes {
    fn staged(c: char) -> Option<ChangeKind> {
        match c {
            'M' | 'T' => Some(ChangeKind::Modified),
            'A' | 'C' => Some(ChangeKind::Added),
            'D' => Some(ChangeKind::Deleted),
            'R' => Some(ChangeKind::Renamed),
            _ => None,
        }
    }
    fn unstaged(c: char) -> Option<ChangeKind> {
        match c {
            'M' | 'T' => Some(ChangeKind::Modified),
            // Worktree-side renames and copies come from intent-to-add entries.
            'A' | 'R' | 'C' => Some(ChangeKind::Added),
            'D' => Some(ChangeKind::Deleted),
            _ => None,
        }
    }
    let mut changes = Changes::default();
    let mut tokens = out.split(|b| *b == 0).filter(|t| !t.is_empty()).map(String::from_utf8_lossy);
    while let Some(token) = tokens.next() {
        let Some((kind, rest)) = token.split_once(' ') else { continue };
        match kind {
            // `1 XY sub mH mI mW hH hI path`, or `2 XY sub mH mI mW hH hI Xscore path`
            // followed by the original path as the next token.
            "1" | "2" => {
                let count = if kind == "1" { 8 } else { 9 };
                let fields: Vec<&str> = rest.splitn(count, ' ').collect();
                let from = if kind == "2" { tokens.next().map(|t| t.into_owned()) } else { None };
                if fields.len() < count {
                    continue;
                }
                let mut xy = fields[0].chars();
                let (x, y) = (xy.next().unwrap_or('.'), xy.next().unwrap_or('.'));
                let entry = changes.map.entry(fields[count - 1].to_owned()).or_default();
                entry.staged = staged(x);
                entry.unstaged = unstaged(y);
                if x == 'R' {
                    entry.renamed_from = from.clone();
                }
                if y == 'R'
                    && let Some(from) = from
                {
                    // gitoxide reports a worktree rename as a deletion plus a new file.
                    changes.map.entry(from).or_default().unstaged = Some(ChangeKind::Deleted);
                }
            }
            // `u XY sub m1 m2 m3 mW h1 h2 h3 path`
            "u" => {
                let fields: Vec<&str> = rest.splitn(10, ' ').collect();
                if fields.len() < 10 {
                    continue;
                }
                let path = fields[9].to_owned();
                changes.conflicts.insert(path.clone());
                changes.map.entry(path).or_default().unstaged = Some(ChangeKind::Conflicted);
            }
            "?" => {
                if ignored.is_ignored_path(rest) {
                    continue;
                }
                changes.map.entry(rest.to_owned()).or_default().unstaged = Some(ChangeKind::Untracked);
            }
            _ => {}
        }
    }
    changes
}

fn gix_changes(repo: &gix::Repository, ignored: &IgnoredNames) -> IdeResult<Changes> {
    let mut map: BTreeMap<String, Entry> = BTreeMap::new();
    let mut conflicts: HashSet<String> = HashSet::new();

    // Stamp before status can read the index: stamping after the load could capture
    // an external `git switch`, `add` or commit's new index and allow the stale
    // snapshot to overwrite it. A change between the stamp and the read only skips
    // one stat refresh, which is safe.
    let index_path = repo.index_path();
    let opened = crate::index_writes::stamp(&index_path);
    let platform = repo
        .status(gix::progress::Discard)
        .map_err(gx)?
        .untracked_files(gix::status::UntrackedFiles::Files)
        .index_worktree_rewrites(None)
        .index_worktree_submodules(gix::status::Submodule::AsConfigured { check_dirty: true })
        .tree_index_track_renames(gix::status::tree_index::TrackRenames::Given(gix::diff::Rewrites::default()));
    let mut iter = platform.into_iter(Vec::<gix::bstr::BString>::new()).map_err(gx)?;
    for item in iter.by_ref() {
        let item = item.map_err(gx)?;
        match item {
            gix::status::Item::IndexWorktree(wt) => match wt {
                WtItem::Modification { rela_path, status, .. } => {
                    let path = to_string(rela_path.as_ref());
                    let kind = match status {
                        EntryStatus::Conflict { .. } => {
                            conflicts.insert(path.clone());
                            ChangeKind::Conflicted
                        }
                        EntryStatus::Change(WtChange::Removed) => ChangeKind::Deleted,
                        EntryStatus::Change(_) => ChangeKind::Modified,
                        EntryStatus::IntentToAdd => ChangeKind::Added,
                        EntryStatus::NeedsUpdate(_) => continue,
                    };
                    map.entry(path).or_default().unstaged = Some(kind);
                }
                WtItem::DirectoryContents { entry, .. } => {
                    if entry.status != gix::dir::entry::Status::Untracked {
                        continue;
                    }
                    let mut path = to_string(entry.rela_path.as_ref());
                    if ignored.is_ignored_path(&path) {
                        continue;
                    }
                    if entry.disk_kind.is_some_and(|k| k.is_dir()) && !path.ends_with('/') {
                        path.push('/');
                    }
                    map.entry(path).or_default().unstaged = Some(ChangeKind::Untracked);
                }
                WtItem::Rewrite { dirwalk_entry, .. } => {
                    // Rewrites are disabled for index↔worktree, but stay correct if git config enables them.
                    let path = to_string(dirwalk_entry.rela_path.as_ref());
                    map.entry(path).or_default().unstaged = Some(ChangeKind::Untracked);
                }
            },
            gix::status::Item::TreeIndex(change) => {
                use gix::diff::index::ChangeRef;
                match change {
                    ChangeRef::Addition { location, .. } => {
                        map.entry(to_string(location.as_ref())).or_default().staged = Some(ChangeKind::Added);
                    }
                    ChangeRef::Deletion { location, .. } => {
                        map.entry(to_string(location.as_ref())).or_default().staged = Some(ChangeKind::Deleted);
                    }
                    ChangeRef::Modification { location, .. } => {
                        map.entry(to_string(location.as_ref())).or_default().staged = Some(ChangeKind::Modified);
                    }
                    ChangeRef::Rewrite { source_location, location, copy, .. } => {
                        let e = map.entry(to_string(location.as_ref())).or_default();
                        if copy {
                            e.staged = Some(ChangeKind::Added);
                        } else {
                            e.staged = Some(ChangeKind::Renamed);
                            e.renamed_from = Some(to_string(source_location.as_ref()));
                        }
                    }
                }
            }
        }
    }
    // Serialize write-back and identity capture with watcher queries.
    if let Some(mut outcome) = iter.into_outcome()
        && outcome.has_changes()
    {
        let mut writes = crate::index_writes::lock();
        // Another process rewrote the index while this status run was reading it
        // (a branch switch rewriting thousands of worktree files is the usual case).
        // Writing the stale snapshot back would restore the previous branch's tree,
        // so drop the refresh and let the next status re-read the current index.
        #[cfg(test)]
        run_between_read_and_write();
        if opened.still_holds(&index_path) {
            match outcome.write_changes() {
                Some(Ok(_)) => writes.record(&index_path),
                Some(Err(e)) => tracing::debug!("could not write refreshed index: {e}"),
                None => {}
            }
        } else {
            tracing::debug!("index changed during status; skipping the stat refresh write-back");
        }
    }

    Ok(Changes { map, conflicts })
}

fn finish(r: &Repo, changes: Changes, ignored: &IgnoredNames) -> Vec<FileStatus> {
    let Changes { map, conflicts } = changes;
    map.into_iter()
        .filter(|(_, e)| e.staged.is_some() || e.unstaged.is_some())
        // Ignored names mean "the IDE treats these as nonexistent": hide their tracked
        // changes too, not just untracked hits above. Conflicts stay visible so merges
        // cannot stall on a file the user cannot see.
        .filter(|(rel, _)| conflicts.contains(rel) || !ignored.is_ignored_path(rel))
        .map(|(rel, mut e)| {
            if conflicts.contains(&rel) {
                e.staged = None;
                e.renamed_from = None;
                e.unstaged = Some(ChangeKind::Conflicted);
            }
            FileStatus {
                path: r.abs_path(&rel).into(),
                rel_path: rel,
                staged: e.staged,
                unstaged: e.unstaged,
                renamed_from: e.renamed_from,
            }
        })
        .collect()
}

/// Lets a test land an external index write in the window between the status run
/// reading the index and its write-back — the interleaving issue #471 describes.
#[cfg(test)]
fn run_between_read_and_write() {
    let mut hook = BETWEEN_READ_AND_WRITE.with(|h| h.borrow_mut().take());
    if let Some(hook) = hook.take() {
        hook();
    }
}

#[cfg(test)]
thread_local! {
    static BETWEEN_READ_AND_WRITE: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .current_dir(dir)
            .args(["-c", "init.defaultBranch=main", "-c", "core.autocrlf=false"])
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .expect("git runs");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn entry(staged: Option<ChangeKind>, unstaged: Option<ChangeKind>, from: Option<&str>) -> Entry {
        Entry { staged, unstaged, renamed_from: from.map(str::to_owned) }
    }

    #[test]
    fn porcelain_v2_entries_map_like_the_gitoxide_path() {
        use ChangeKind::*;
        let hash = "ce013625030ba8dba906f756967f9e9ca394464a";
        let out = [
            format!("1 .M N... 100644 100644 100644 {hash} {hash} README.md"),
            format!("1 A. N... 000000 100644 100644 {hash} {hash} dir/with space.txt"),
            format!("1 MD N... 100644 100644 000000 {hash} {hash} both.txt"),
            format!("1 .A N... 000000 000000 100644 {hash} {hash} intent.txt"),
            format!("2 R. N... 100644 100644 100644 {hash} {hash} R99 new name.txt"),
            "docs/old name.txt".to_owned(),
            format!("2 C. N... 100644 100644 100644 {hash} {hash} C100 copy.txt"),
            "orig.txt".to_owned(),
            format!("u UU N... 100644 100644 100644 100644 {hash} {hash} {hash} merge me.txt"),
            "? untracked file.txt".to_owned(),
            "? nested/".to_owned(),
            "? node_modules/x.js".to_owned(),
        ]
        .join("\0")
            + "\0";
        let ignored = IgnoredNames::new(&["node_modules".to_owned()]);
        let changes = parse_porcelain_v2(out.as_bytes(), &ignored);
        let got: Vec<(&str, &Entry)> = changes.map.iter().map(|(k, v)| (k.as_str(), v)).collect();
        assert_eq!(
            got,
            [
                ("README.md", &entry(None, Some(Modified), None)),
                ("both.txt", &entry(Some(Modified), Some(Deleted), None)),
                ("copy.txt", &entry(Some(Added), None, None)),
                ("dir/with space.txt", &entry(Some(Added), None, None)),
                ("intent.txt", &entry(None, Some(Added), None)),
                ("merge me.txt", &entry(None, Some(Conflicted), None)),
                ("nested/", &entry(None, Some(Untracked), None)),
                ("new name.txt", &entry(Some(Renamed), None, Some("docs/old name.txt"))),
                ("untracked file.txt", &entry(None, Some(Untracked), None)),
            ]
        );
        assert_eq!(changes.conflicts, HashSet::from(["merge me.txt".to_owned()]));
    }

    fn commit_all(dir: &Path, msg: &str) {
        git(dir, &["add", "-A"]);
        git(dir, &["commit", "-q", "-m", msg]);
    }

    /// #60 review: the git CLI status reads the repository's own config, so in
    /// Restricted Mode it must not run the repository's clean or process filters.
    #[cfg(unix)]
    #[test]
    fn restricted_cli_status_does_not_run_repository_filters() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        git(dir, &["init", "-q"]);
        git(dir, &["config", "user.name", "Test User"]);
        git(dir, &["config", "user.email", "test@example.com"]);
        git(dir, &["config", "commit.gpgsign", "false"]);
        std::fs::write(dir.join("a.txt"), "aaaa\n").unwrap();
        commit_all(dir, "base");

        let script = dir.join(".git/marker.sh");
        let marker = dir.join(".git/executed");
        std::fs::write(&script, format!("#!/bin/sh\ntouch '{}'\ncat\n", marker.display())).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let script = script.to_str().unwrap();
        git(dir, &["config", "filter.marker.clean", script]);
        git(dir, &["config", "filter.marker.required", "true"]);
        // Takes the git CLI path without a remote.
        git(dir, &["config", "core.sparseCheckout", "true"]);
        std::fs::create_dir_all(dir.join(".git/info")).unwrap();
        std::fs::write(dir.join(".git/info/attributes"), "*.txt filter=marker\n").unwrap();
        // Same size, new content: status has to compare content through the filter.
        std::fs::write(dir.join("a.txt"), "bbbb\n").unwrap();

        let repo = Repo::discover(dir).unwrap().expect("repository found");
        repo.set_execution_allowed(false);
        let status = repo.status().expect("restricted status");
        assert!(!marker.exists(), "Restricted Mode ran a repository filter");
        let a = status.iter().find(|f| f.rel_path == "a.txt").expect("a.txt listed");
        assert_eq!(a.unstaged, Some(ChangeKind::Modified), "{status:?}");

        // Control: the fixture's filter does run for plain git.
        git(dir, &["--no-optional-locks", "status", "--porcelain"]);
        assert!(marker.exists(), "control status did not run the clean filter");
    }

    /// #471: a status run that read the index before an external `git switch`
    /// finished must not write its stale snapshot back over the new index.
    #[test]
    fn an_external_index_write_during_status_is_not_overwritten() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        git(dir, &["init", "-q"]);
        git(dir, &["config", "user.name", "Test User"]);
        git(dir, &["config", "user.email", "test@example.com"]);
        git(dir, &["config", "commit.gpgsign", "false"]);
        std::fs::write(dir.join("base.txt"), "base\n").unwrap();
        commit_all(dir, "base");
        // A branch that differs by a file and a deletion, so a switch rewrites the index.
        git(dir, &["checkout", "-q", "-b", "other"]);
        std::fs::write(dir.join("other.txt"), "other\n").unwrap();
        std::fs::remove_file(dir.join("base.txt")).unwrap();
        commit_all(dir, "other");
        git(dir, &["checkout", "-q", "main"]);
        // Rewrite a file with identical content: its stat info no longer matches the
        // index, so the status run refreshes it and has an index write-back to make.
        std::fs::write(dir.join("base.txt"), "base\n").unwrap();

        let repo = Repo::discover(dir).unwrap().expect("repository found");
        let switched = dir.to_path_buf();
        let hook_ran = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let ran = hook_ran.clone();
        BETWEEN_READ_AND_WRITE.with(|h| {
            *h.borrow_mut() = Some(Box::new(move || {
                ran.store(true, std::sync::atomic::Ordering::SeqCst);
                git(&switched, &["switch", "-q", "--force", "other"]);
            }));
        });
        // The status result itself describes the tree as it was when it read the index
        // (base.txt still modified there); what matters is that it does not write that
        // snapshot back over the index `git switch` produced.
        repo.status().expect("status runs");
        assert!(hook_ran.load(std::sync::atomic::Ordering::SeqCst), "the external write landed mid-status");

        // The index on disk is the one `git switch` wrote: its entries match the new branch.
        let listed = Command::new("git").current_dir(dir).args(["ls-files"]).output().unwrap();
        let files = String::from_utf8_lossy(&listed.stdout);
        assert!(files.contains("other.txt"), "{files}");
        assert!(!files.contains("base.txt"), "{files}");
        // Nothing staged: HEAD and index agree.
        let staged = Command::new("git").current_dir(dir).args(["diff", "--cached", "--stat"]).output().unwrap();
        assert!(staged.stdout.is_empty(), "{}", String::from_utf8_lossy(&staged.stdout));
    }
}
