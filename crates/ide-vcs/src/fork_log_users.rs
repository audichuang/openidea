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
    users: BTreeSet<String>,
}

/// Per git dir and Restricted Mode: a restricted git reads the repository's config differently.
fn cache() -> &'static Mutex<HashMap<(PathBuf, bool), Entry>> {
    static CACHE: OnceLock<Mutex<HashMap<(PathBuf, bool), Entry>>> = OnceLock::new();
    CACHE.get_or_init(Mutex::default)
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
    let key = (git_dir.to_path_buf(), crate::execution_allowed());
    let previous = {
        let cache = cache().lock().unwrap_or_else(|p| p.into_inner());
        match cache.get(&key) {
            Some(entry) if entry.tips == tips => return Ok(entry.users.iter().cloned().collect()),
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
            let mut all = BTreeSet::new();
            add_users(&cli::run(root, &["log", "--all", "--format=%an <%ae>"], None)?.stdout_str(), &mut all);
            all
        }
    };
    let list = users.iter().cloned().collect();
    cache().lock().unwrap_or_else(|p| p.into_inner()).insert(key, Entry { tips, users });
    Ok(list)
}
