//! Fork-owned: the Git Graph view's queries and operations (`ide_vcs::fork_graph`) against a
//! real repository.

use ide_vcs::Repo;
use ide_vcs::fork_graph::*;
use std::path::Path;
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args(["-c", "init.defaultBranch=main", "-c", "user.name=Ann", "-c", "user.email=ann@example.com"])
        .args(["-c", "commit.gpgsign=false", "-c", "core.hooksPath=.git/hooks"])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .expect("git runs");
    assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn commit(dir: &Path, file: &str, text: &str) -> String {
    std::fs::write(dir.join(file), text).unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", text]);
    git(dir, &["rev-parse", "HEAD"])
}

fn repo() -> (tempfile::TempDir, Repo) {
    let tmp = tempfile::tempdir().unwrap();
    git(tmp.path(), &["init", "-q"]);
    let repo = Repo::discover(tmp.path()).unwrap().expect("repository");
    repo.set_execution_allowed(true);
    (tmp, repo)
}

#[test]
fn stashes_carry_their_commit_and_base() {
    let (tmp, repo) = repo();
    let dir = tmp.path();
    let base = commit(dir, "a.txt", "one");
    std::fs::write(dir.join("a.txt"), "changed").unwrap();
    git(dir, &["stash", "push", "-q", "-m", "wip on a"]);
    let stash = git(dir, &["rev-parse", "stash@{0}"]);
    let stashes = repo.graph_stashes().unwrap();
    assert_eq!(stashes.len(), 1);
    assert_eq!(stashes[0].index, 0);
    assert_eq!(stashes[0].id, stash);
    assert_eq!(stashes[0].base, base);
    assert!(stashes[0].message.contains("wip on a"), "{:?}", stashes[0].message);
    assert!(stashes[0].time_ms > 0.0);
}

#[test]
fn no_stashes_is_empty() {
    let (tmp, repo) = repo();
    commit(tmp.path(), "a.txt", "one");
    assert!(repo.graph_stashes().unwrap().is_empty());
}

#[test]
fn working_state_counts_staged_unstaged_and_untracked() {
    let (tmp, repo) = repo();
    let dir = tmp.path();
    commit(dir, "a.txt", "one");
    commit(dir, "b.txt", "two");
    std::fs::write(dir.join("a.txt"), "staged").unwrap();
    git(dir, &["add", "a.txt"]);
    std::fs::write(dir.join("b.txt"), "unstaged").unwrap();
    std::fs::write(dir.join("new.txt"), "untracked").unwrap();
    assert_eq!(
        repo.graph_working_state().unwrap(),
        GraphWorkingState { staged: 1, unstaged: 1, untracked: 1, conflicted: 0 }
    );
}

#[test]
fn reflog_lists_head_moves_newest_first() {
    let (tmp, repo) = repo();
    let dir = tmp.path();
    let first = commit(dir, "a.txt", "one");
    let second = commit(dir, "a.txt", "two");
    let log = repo.graph_reflog("HEAD", 10).unwrap();
    assert_eq!(log.iter().map(|e| e.id.clone()).collect::<Vec<_>>(), vec![second, first]);
    assert_eq!(log[0].selector, "HEAD@{0}");
    assert!(log[0].action.starts_with("commit"), "{:?}", log[0].action);
    assert_eq!(repo.graph_reflog("HEAD", 1).unwrap().len(), 1);
    assert!(repo.graph_reflog("--all", 1).is_err());
}

#[test]
fn author_stats_count_commits_per_author() {
    let (tmp, repo) = repo();
    let dir = tmp.path();
    commit(dir, "a.txt", "one");
    commit(dir, "a.txt", "two");
    assert_eq!(
        repo.graph_author_stats().unwrap(),
        vec![GraphAuthorStat { name: "Ann".into(), email: "ann@example.com".into(), commits: 2 }]
    );
}

#[test]
fn tree_lists_every_file_of_a_revision() {
    let (tmp, repo) = repo();
    let dir = tmp.path();
    std::fs::create_dir(dir.join("src")).unwrap();
    let first = commit(dir, "src/main rs.txt", "main");
    commit(dir, "README.md", "readme");
    let tree = repo.graph_tree(&first).unwrap();
    assert_eq!(tree, vec![GraphTreeEntry { path: "src/main rs.txt".into(), kind: "blob".into(), size: Some(4.0) }]);
    assert_eq!(repo.graph_tree("HEAD").unwrap().len(), 2);
}

#[test]
fn bisect_names_the_first_bad_commit_and_resets() {
    let (tmp, repo) = repo();
    let dir = tmp.path();
    let good = commit(dir, "a.txt", "1");
    let c2 = commit(dir, "a.txt", "2");
    let bad_first = commit(dir, "a.txt", "3");
    let bad = commit(dir, "a.txt", "4");
    assert!(!repo.graph_bisect_state().unwrap().active);

    let mut state = repo.graph_bisect(&GraphBisectOp::Start { bad: bad.clone(), good: good.clone() }).unwrap();
    assert!(state.active);
    // Answer each step by whether the commit is at or after `bad_first`.
    let order = [&good, &c2, &bad_first, &bad];
    let pos = |id: &str| order.iter().position(|c| c.as_str() == id).unwrap();
    for _ in 0..4 {
        if state.culprit.is_some() {
            break;
        }
        let current = state.current.clone().expect("a commit to test");
        state = if pos(&current) >= pos(&bad_first) {
            repo.graph_bisect(&GraphBisectOp::Bad { rev: current }).unwrap()
        } else {
            repo.graph_bisect(&GraphBisectOp::Good { rev: current }).unwrap()
        };
    }
    assert_eq!(state.culprit.as_deref(), Some(bad_first.as_str()));

    let after = repo.graph_bisect(&GraphBisectOp::Reset).unwrap();
    assert!(!after.active);
    assert_eq!(git(dir, &["rev-parse", "HEAD"]), bad);
}

#[test]
fn ref_ops_delete_and_push_tags_and_set_upstream() {
    let (tmp, repo) = repo();
    let dir = tmp.path();
    let remote = tempfile::tempdir().unwrap();
    git(remote.path(), &["init", "-q", "--bare"]);
    git(dir, &["remote", "add", "origin", remote.path().to_str().unwrap()]);
    let head = commit(dir, "a.txt", "one");
    git(dir, &["push", "-q", "origin", "main"]);
    git(dir, &["tag", "v1"]);

    repo.graph_ref_op(&GraphRefOp::PushTag { remote: "origin".into(), name: "v1".into() }).unwrap();
    assert_eq!(git(remote.path(), &["rev-parse", "refs/tags/v1"]), head);

    repo.graph_ref_op(&GraphRefOp::DeleteRemoteTag { remote: "origin".into(), name: "v1".into() }).unwrap();
    assert_eq!(git(remote.path(), &["tag", "--list"]), "");

    repo.graph_ref_op(&GraphRefOp::DeleteTag { name: "v1".into() }).unwrap();
    assert_eq!(git(dir, &["tag", "--list"]), "");

    repo.graph_ref_op(&GraphRefOp::SetUpstream { branch: "main".into(), upstream: "origin/main".into() }).unwrap();
    assert_eq!(git(dir, &["rev-parse", "--abbrev-ref", "main@{upstream}"]), "origin/main");
    repo.graph_ref_op(&GraphRefOp::UnsetUpstream { branch: "main".into() }).unwrap();
    assert!(
        Command::new("git").current_dir(dir).args(["rev-parse", "main@{upstream}"]).output().unwrap().status.code()
            != Some(0)
    );

    assert!(repo.graph_ref_op(&GraphRefOp::DeleteTag { name: "--all".into() }).is_err());
}
