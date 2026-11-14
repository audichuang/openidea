//! A long file history walk must not hold the log index while Git runs: commit details and
//! one-commit queries (inline blame, the blame popup) share that index.
#![cfg(unix)]

use ide_vcs::{LogQuery, Repo};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args([
            "-c",
            "init.defaultBranch=main",
            "-c",
            "user.name=T",
            "-c",
            "user.email=t@e",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[test]
fn details_and_one_commit_queries_do_not_wait_for_a_file_history_walk() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("repo");
    std::fs::create_dir(&dir).unwrap();
    git(&dir, &["init", "-q"]);
    for i in 0..3 {
        std::fs::write(dir.join("file"), format!("{i}")).unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-qm", &format!("c{i}")]);
    }
    // A git whose path-limited history walks take seconds.
    let real = String::from_utf8(Command::new("sh").args(["-c", "command -v git"]).output().unwrap().stdout).unwrap();
    let started = tmp.path().join("walk-started");
    let wrapper = tmp.path().join("slow-git");
    std::fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\ncase \" $* \" in *\" --full-history \"*) : > '{}'; sleep 3;; esac\nexec '{}' \"$@\"\n",
            started.display(),
            real.trim()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
    ide_vcs::set_git_executable(Some(&wrapper));
    let repo = Repo::discover(&dir).unwrap().unwrap();
    repo.set_execution_allowed(true);
    std::thread::scope(|scope| {
        let walk = scope.spawn(|| {
            repo.log(&LogQuery { path: Some("file".into()), follow: true, ..Default::default() }).unwrap().len()
        });
        let deadline = Instant::now() + Duration::from_secs(20);
        while !started.exists() {
            assert!(Instant::now() < deadline, "the history walk never started");
            std::thread::sleep(Duration::from_millis(20));
        }
        let asked = Instant::now();
        let details = repo.log_details("HEAD").unwrap();
        let head = repo.log(&LogQuery { branch: Some("HEAD".into()), limit: 1, ..Default::default() }).unwrap();
        let waited = asked.elapsed();
        assert_eq!(details.message, "c2");
        assert_eq!(head.len(), 1);
        assert!(!walk.is_finished(), "the walk ended before the queries ran; the test proves nothing");
        assert!(waited < Duration::from_secs(2), "queries waited {waited:?} for the walk");
        assert_eq!(walk.join().unwrap(), 3);
    });
    ide_vcs::set_git_executable(None);
}

/// `FH_REPO=<repo> FH_PATH=<file>`: how long commit details and a one-commit query take
/// while the file's history loads cold (medians of 5).
#[test]
#[ignore]
fn measure_queries_during_a_cold_file_history() {
    let (Ok(root), Ok(path)) = (std::env::var("FH_REPO"), std::env::var("FH_PATH")) else { return };
    let mut waits = Vec::new();
    let mut walks = Vec::new();
    for _ in 0..5 {
        let cache = tempfile::tempdir().unwrap();
        let repo = Repo::discover(Path::new(&root)).unwrap().unwrap();
        repo.enable_log_index(cache.path());
        let (repo, path) = (&repo, &path);
        std::thread::scope(|scope| {
            let started = Instant::now();
            let walk = scope.spawn(move || {
                let query = LogQuery {
                    path: Some(path.clone().into()),
                    follow: true,
                    summary_only: true,
                    ..Default::default()
                };
                repo.log(&query).unwrap();
                started.elapsed()
            });
            std::thread::sleep(Duration::from_millis(100));
            let asked = Instant::now();
            repo.log_details("HEAD~3").unwrap();
            repo.log(&LogQuery { branch: Some("HEAD~5".into()), limit: 1, ..Default::default() }).unwrap();
            waits.push(asked.elapsed().as_secs_f64() * 1000.0);
            walks.push(walk.join().unwrap().as_secs_f64() * 1000.0);
        });
    }
    waits.sort_by(f64::total_cmp);
    walks.sort_by(f64::total_cmp);
    println!("queries {:.0}ms (all {waits:.0?}), history {:.0}ms", waits[2], walks[2]);
}
