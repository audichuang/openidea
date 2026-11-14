use ide_vcs::Repo;
use std::path::Path;
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args(["-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false"])
        .args(args)
        .output()
        .unwrap();
    assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn commit_as(dir: &Path, author: &str, file: &str) {
    std::fs::write(dir.join(file), author).unwrap();
    git(dir, &["add", "-A"]);
    let email = format!("user.email={}@example.com", author.to_lowercase());
    git(dir, &["-c", &format!("user.name={author}"), "-c", &email, "commit", "-qm", author]);
}

/// What `git log --all` lists, as the filter showed it before it was cached.
fn expected(dir: &Path) -> Vec<String> {
    let mut users: Vec<String> =
        git(dir, &["log", "--all", "--format=%an <%ae>"]).lines().map(str::to_string).collect();
    users.sort();
    users.dedup();
    users
}

#[test]
fn log_users_follow_new_commits_deleted_branches_and_other_worktrees() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("repo");
    std::fs::create_dir(&dir).unwrap();
    git(&dir, &["init", "-q"]);
    commit_as(&dir, "Ann", "a");
    commit_as(&dir, "Bob", "b");
    let repo = Repo::discover(&dir).unwrap().unwrap();
    assert_eq!(repo.log_users().unwrap(), ["Ann <ann@example.com>", "Bob <bob@example.com>"]);
    // A new commit is added without reading the old history again.
    commit_as(&dir, "Cid", "c");
    assert_eq!(repo.log_users().unwrap(), expected(&dir));
    assert!(repo.log_users().unwrap().contains(&"Cid <cid@example.com>".to_string()));
    // A branch whose only commit goes away with it.
    git(&dir, &["checkout", "-q", "-b", "gone"]);
    commit_as(&dir, "Dee", "d");
    assert_eq!(repo.log_users().unwrap(), expected(&dir));
    git(&dir, &["checkout", "-q", "main"]);
    git(&dir, &["branch", "-qD", "gone"]);
    assert_eq!(repo.log_users().unwrap(), expected(&dir));
    assert!(!repo.log_users().unwrap().contains(&"Dee <dee@example.com>".to_string()));
    // A reset that drops the newest commit.
    git(&dir, &["reset", "-q", "--hard", "HEAD~1"]);
    assert_eq!(repo.log_users().unwrap(), expected(&dir));
    assert!(!repo.log_users().unwrap().contains(&"Cid <cid@example.com>".to_string()));
    // A commit on a detached HEAD in another worktree is reachable from --all too.
    let other = tmp.path().join("other");
    git(&dir, &["worktree", "add", "-q", "--detach", other.to_str().unwrap()]);
    commit_as(&other, "Eve", "e");
    assert_eq!(repo.log_users().unwrap(), expected(&dir));
    assert!(repo.log_users().unwrap().contains(&"Eve <eve@example.com>".to_string()));
}

#[test]
fn log_users_follow_a_deepened_shallow_clone() {
    let tmp = tempfile::tempdir().unwrap();
    let origin = tmp.path().join("origin");
    std::fs::create_dir(&origin).unwrap();
    git(&origin, &["init", "-q"]);
    commit_as(&origin, "Ann", "a");
    commit_as(&origin, "Bob", "b");
    let url = format!("file://{}", origin.display());
    let clone = tmp.path().join("clone");
    git(tmp.path(), &["clone", "-q", "--depth", "1", &url, clone.to_str().unwrap()]);
    let repo = Repo::discover(&clone).unwrap().unwrap();
    assert_eq!(repo.log_users().unwrap(), ["Bob <bob@example.com>"]);
    // No ref moves, yet Ann's commit becomes reachable.
    git(&clone, &["fetch", "-q", "--unshallow"]);
    assert_eq!(repo.log_users().unwrap(), expected(&clone));
    assert!(repo.log_users().unwrap().contains(&"Ann <ann@example.com>".to_string()));
}

#[test]
fn log_users_cache_matches_the_tips_it_is_keyed_by() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("repo");
    std::fs::create_dir(&dir).unwrap();
    git(&dir, &["init", "-q"]);
    commit_as(&dir, "Ann", "a");
    let repo = Repo::discover(&dir).unwrap().unwrap();
    // A ref moves between the tips snapshot and the full read.
    let d = dir.clone();
    ide_vcs::set_log_users_after_tips_hook(Some(Box::new(move || commit_as(&d, "Bob", "b"))));
    let _ = repo.log_users().unwrap();
    ide_vcs::set_log_users_after_tips_hook(None);
    git(&dir, &["reset", "-q", "--hard", "HEAD~1"]);
    assert_eq!(repo.log_users().unwrap(), ["Ann <ann@example.com>"]);
}

#[test]
fn log_users_follow_replace_refs() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("repo");
    std::fs::create_dir(&dir).unwrap();
    git(&dir, &["init", "-q"]);
    commit_as(&dir, "Ann", "a");
    commit_as(&dir, "Bob", "b");
    let repo = Repo::discover(&dir).unwrap().unwrap();
    assert_eq!(repo.log_users().unwrap(), ["Ann <ann@example.com>", "Bob <bob@example.com>"]);
    git(&dir, &["replace", "--graft", "HEAD"]);
    assert_eq!(repo.log_users().unwrap(), expected(&dir));
    assert_eq!(repo.log_users().unwrap(), ["Bob <bob@example.com>"]);
    // A new commit while a replace ref exists is a full read, not an incremental one.
    commit_as(&dir, "Cid", "c");
    assert_eq!(repo.log_users().unwrap(), expected(&dir));
    git(&dir, &["replace", "-d", &git(&dir, &["rev-parse", "HEAD~1"])]);
    assert_eq!(repo.log_users().unwrap(), expected(&dir));
    assert!(repo.log_users().unwrap().contains(&"Ann <ann@example.com>".to_string()));
}

#[test]
fn log_users_follow_grafts_file() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("repo");
    std::fs::create_dir(&dir).unwrap();
    git(&dir, &["init", "-q"]);
    commit_as(&dir, "Ann", "a");
    commit_as(&dir, "Bob", "b");
    let repo = Repo::discover(&dir).unwrap().unwrap();
    assert_eq!(repo.log_users().unwrap(), ["Ann <ann@example.com>", "Bob <bob@example.com>"]);
    let head = git(&dir, &["rev-parse", "HEAD"]);
    std::fs::create_dir_all(dir.join(".git/info")).unwrap();
    std::fs::write(dir.join(".git/info/grafts"), format!("{head}\n")).unwrap();
    assert_eq!(repo.log_users().unwrap(), expected(&dir));
    assert_eq!(repo.log_users().unwrap(), ["Bob <bob@example.com>"]);
    std::fs::remove_file(dir.join(".git/info/grafts")).unwrap();
    assert_eq!(repo.log_users().unwrap(), expected(&dir));
    assert!(repo.log_users().unwrap().contains(&"Ann <ann@example.com>".to_string()));
}
