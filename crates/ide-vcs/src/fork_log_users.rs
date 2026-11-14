//! Fork-owned: the Git Log author filter's user list (`Repo::log_users`), cached per state of
//! the refs instead of reading all history each time the filter opens.
//!
//! The list is every `author <email>` reachable from `--all`. The cache key is the set of
//! commits `--all` starts from (`rev-list --all --no-walk`, the same refs, HEADs of other
//! worktrees included). When the refs move but every old start stays reachable (a commit,
//! a fetch), only the new commits are read and added.

use crate::Repo;
use crate::cli;
use ide_core::IdeResult;
use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

struct Entry {
    tips: Vec<String>,
    /// Deepening a shallow clone adds history without moving a ref.
    shallow: Vec<gix::ObjectId>,
    /// Replace refs and grafts rewrite parents without moving a ref.
    rewrites: String,
    users: BTreeSet<String>,
}

/// Per git dir and Restricted Mode: a restricted git reads the repository's config differently.
fn cache() -> &'static Mutex<HashMap<(PathBuf, bool), Entry>> {
    static CACHE: OnceLock<Mutex<HashMap<(PathBuf, bool), Entry>>> = OnceLock::new();
    CACHE.get_or_init(Mutex::default)
}

thread_local! {
    static AFTER_TIPS: std::cell::RefCell<Option<Box<dyn Fn()>>> = const { std::cell::RefCell::new(None) };
}

/// Test seam: runs on this thread right after the tips are snapshotted.
#[doc(hidden)]
pub fn set_after_tips_hook(hook: Option<Box<dyn Fn()>>) {
    AFTER_TIPS.with(|h| *h.borrow_mut() = hook);
}

/// The state of everything that rewrites history: `refs/replace/*` and the grafts files.
fn rewrites(r: &Repo, root: &std::path::Path) -> IdeResult<String> {
    let mut out = cli::run(root, &["for-each-ref", "--format=%(refname) %(objectname)", "refs/replace/"], None)?
        .stdout_str()
        .to_string();
    let mut files = vec![r.gix()?.common_dir().join("info/grafts")];
    files.extend(std::env::var_os("GIT_GRAFT_FILE").map(PathBuf::from));
    for file in files {
        match std::fs::read(&file) {
            Ok(bytes) => out.push_str(&format!("grafts {} {}\n", file.display(), blake3::hash(&bytes).to_hex())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => out.push_str(&format!("grafts {} unreadable {:?}\n", file.display(), e.kind())),
        }
    }
    if let Some(base) = std::env::var_os("GIT_REPLACE_REF_BASE") {
        out.push_str(&format!("base {}\n", base.to_string_lossy()));
    }
    Ok(out)
}

fn add_users(text: &str, into: &mut BTreeSet<String>) {
    into.extend(text.lines().filter(|line| !line.is_empty()).map(str::to_string));
}

pub(crate) fn log_users(r: &Repo, git_dir: &std::path::Path) -> IdeResult<Vec<String>> {
    let root = r.root();
    let mut tips: Vec<String> =
        cli::run(root, &["rev-list", "--all", "--no-walk"], None)?.stdout_str().lines().map(str::to_string).collect();
    tips.sort_unstable();
    tips.dedup();
    AFTER_TIPS.with(|h| {
        if let Some(hook) = h.borrow().as_ref() {
            hook();
        }
    });
    let rewrites = rewrites(r, root)?;
    let mut shallow: Vec<gix::ObjectId> = r
        .gix()?
        .shallow_commits()
        .map_err(crate::repo::gx)?
        .map(|ids| ids.iter().copied().collect())
        .unwrap_or_default();
    shallow.sort_unstable();
    let key = (git_dir.to_path_buf(), crate::execution_allowed());
    let previous = {
        let cache = cache().lock().unwrap_or_else(|p| p.into_inner());
        match cache.get(&key) {
            Some(entry) if entry.shallow != shallow => None,
            Some(entry) if entry.tips == tips && entry.rewrites == rewrites => {
                return Ok(entry.users.iter().cloned().collect());
            }
            // Rewritten history: an old start may reach different commits now, so never go incremental.
            Some(_) if !rewrites.is_empty() => None,
            Some(entry) if entry.rewrites != rewrites => None,
            Some(entry) => Some((entry.tips.clone(), entry.users.clone())),
            None => None,
        }
    };
    let mut found = None;
    if let Some((old_tips, mut old_users)) = previous {
        // Old starts that the new ones no longer reach (a deleted branch, a force push) may
        // have taken users with them: read everything again then.
        let old: String = old_tips.iter().map(|tip| format!("{tip}\n")).collect();
        let new: String = tips.iter().map(|tip| format!("{tip}\n")).collect();
        let lost = cli::run(root, &["rev-list", "--count", "--stdin"], Some(format!("{old}--not\n{new}").as_bytes()));
        if lost.is_ok_and(|out| out.stdout_str().trim() == "0") {
            let added = cli::run(
                root,
                &["log", "--format=%an <%ae>", "--stdin"],
                Some(format!("{new}--not\n{old}").as_bytes()),
            )?;
            add_users(&added.stdout_str(), &mut old_users);
            found = Some(old_users);
        }
    }
    let users = match found {
        Some(users) => users,
        None => {
            // Walk exactly the snapshotted tips, so the cached users match the cached key.
            let mut all = BTreeSet::new();
            if !tips.is_empty() {
                let stdin: String = tips.iter().map(|tip| format!("{tip}\n")).collect();
                add_users(
                    &cli::run(root, &["log", "--format=%an <%ae>", "--stdin"], Some(stdin.as_bytes()))?.stdout_str(),
                    &mut all,
                );
            }
            all
        }
    };
    let list = users.iter().cloned().collect();
    cache().lock().unwrap_or_else(|p| p.into_inner()).insert(key, Entry { tips, shallow, rewrites, users });
    Ok(list)
}
