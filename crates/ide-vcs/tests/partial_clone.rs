//! Partial clones (`--filter=blob:none`) with a sparse checkout: blobs outside the
//! checkout are never fetched, and gitoxide's status cannot read them (#60).

use ide_vcs::{ChangeKind, LogQuery, Repos};
use std::path::Path;
use std::process::Command;

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .current_dir(dir)
        .args(["-c", "init.defaultBranch=main", "-c", "core.autocrlf=false", "-c", "protocol.file.allow=always"])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .expect("git runs");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

fn git_available() -> bool {
    Command::new("git").arg("--version").output().is_ok_and(|o| o.status.success())
}

fn file_url(path: &Path) -> String {
    let path = path.to_string_lossy().replace('\\', "/");
    format!("file:///{}", path.trim_start_matches('/'))
}

#[test]
fn blobless_sparse_clone_keeps_its_repository_and_status() {
    if !git_available() {
        eprintln!("git is not available; skipping");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();

    let source = base.join("source");
    std::fs::create_dir_all(source.join("docs")).unwrap();
    std::fs::create_dir_all(source.join("app")).unwrap();
    git(&source, &["init", "-q"]);
    git(&source, &["config", "user.name", "Test User"]);
    git(&source, &["config", "user.email", "test@example.com"]);
    git(&source, &["config", "commit.gpgsign", "false"]);
    std::fs::write(source.join("README.md"), "hello\n").unwrap();
    let guide: String = (1..=200).map(|i| format!("line {i}\n")).collect();
    std::fs::write(source.join("docs/guide.txt"), &guide).unwrap();
    std::fs::write(source.join("app/main.rs"), "fn main() {}\n").unwrap();
    git(&source, &["add", "-A"]);
    git(&source, &["commit", "-q", "-m", "init"]);

    let bare = base.join("bare.git");
    git(&base, &["clone", "-q", "--bare", "source", "bare.git"]);
    git(&bare, &["config", "uploadpack.allowFilter", "true"]);
    git(&bare, &["config", "uploadpack.allowAnySHA1InWant", "true"]);

    // Cone-mode sparse checkout of the top level only: docs/ and app/ blobs stay remote.
    let work = base.join("work");
    git(&base, &["clone", "-q", "--filter=blob:none", "--sparse", &file_url(&bare), "work"]);
    git(&work, &["config", "user.name", "Test User"]);
    git(&work, &["config", "user.email", "test@example.com"]);
    assert!(!work.join("app/main.rs").exists(), "app/ is outside the sparse checkout");

    std::fs::write(work.join("README.md"), "hello\nchanged\n").unwrap();
    std::fs::write(work.join("new.txt"), "new\n").unwrap();
    // A staged deletion of a never-fetched blob plus a near-identical addition: rename
    // detection has to read the missing blob (`git rm --sparse` needs git 2.35+).
    git(&work, &["rm", "-q", "--sparse", "docs/guide.txt"]);
    let renamed: String = (1..=199).map(|i| format!("line {i}\n")).collect();
    std::fs::write(work.join("guide2.txt"), renamed).unwrap();
    git(&work, &["add", "guide2.txt"]);

    let repos = Repos::discover(&work, &|_| false).unwrap();
    let repo = repos.primary().expect("the partial clone is a repository");
    assert_eq!(repo.root(), work);
    assert_eq!(repo.branch_info().unwrap().head.as_deref(), Some("main"));
    assert_eq!(repo.log(&LogQuery::default()).unwrap().len(), 1);

    let status = repos.status().expect("status of a partial clone");
    let find = |rel: &str| status.iter().find(|f| f.rel_path == rel);
    let readme = find("README.md").expect("README.md listed");
    assert_eq!((readme.staged, readme.unstaged), (None, Some(ChangeKind::Modified)));
    let new = find("new.txt").expect("new.txt listed");
    assert_eq!(new.unstaged, Some(ChangeKind::Untracked));
    let moved = find("guide2.txt").expect("guide2.txt listed");
    assert_eq!(moved.staged, Some(ChangeKind::Renamed));
    assert_eq!(moved.renamed_from.as_deref(), Some("docs/guide.txt"));
    // Skip-worktree entries outside the checkout are not missing files.
    assert!(find("app/main.rs").is_none(), "{status:?}");
    assert_eq!(status.len(), 3, "{status:?}");
}
