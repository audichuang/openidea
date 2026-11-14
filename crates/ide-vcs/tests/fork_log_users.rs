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
