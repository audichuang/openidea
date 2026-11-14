//! A long file history walk must not hold the log index while Git runs: commit details and
//! one-commit queries (inline blame, the blame popup) share that index.
#![cfg(unix)]

use ide_vcs::{LogQuery, Repo};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The Git executable is process-wide: the tests that replace it run one at a time.
static GIT_EXECUTABLE: Mutex<()> = Mutex::new(());

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
    let _git = GIT_EXECUTABLE.lock().unwrap_or_else(|e| e.into_inner());
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

/// A git that waits at `--grep` until `release` exists, after creating `started`.
fn paused_git(dir: &Path, started: &Path, release: &Path) -> std::path::PathBuf {
    let real = String::from_utf8(Command::new("sh").args(["-c", "command -v git"]).output().unwrap().stdout).unwrap();
    let wrapper = dir.join("paused-git");
    std::fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\ncase \" $* \" in *\" --grep=\"*) : > '{}'; i=0; while [ ! -e '{}' ] && [ $i -lt 600 ]; do sleep 0.05; i=$((i+1)); done;; esac\nexec '{}' \"$@\"\n",
            started.display(),
            release.display(),
            real.trim()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
    wrapper
}

#[test]
fn a_branch_switch_during_a_search_does_not_change_its_current_branch_marks() {
    let _git = GIT_EXECUTABLE.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("repo");
    std::fs::create_dir(&dir).unwrap();
    git(&dir, &["init", "-q"]);
    for (i, branch) in [(0, None), (1, None), (2, Some("other")), (3, Some("main"))] {
        if let Some(branch) = branch {
            git(&dir, &["checkout", "-q", "-B", branch, if branch == "other" { "HEAD~1" } else { "main" }]);
        }
        std::fs::write(dir.join("file"), format!("{i}")).unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-qm", &format!("commit {i}")]);
    }
    git(&dir, &["checkout", "-q", "main"]);
    let query = LogQuery {
        branches: vec!["main".into(), "other".into()],
        text: Some("commit".into()),
        summary_only: true,
        ..Default::default()
    };
    let marks = |log: Vec<ide_vcs::Commit>| -> Vec<(String, Option<bool>, Option<Vec<String>>)> {
        log.into_iter().map(|c| (c.id, c.on_current_branch, c.graph_parents)).collect()
    };
    let serial = marks(Repo::discover(&dir).unwrap().unwrap().log(&query).unwrap());
    assert!(serial.iter().any(|row| row.1 == Some(false)) && serial.iter().any(|row| row.1 == Some(true)));

    let started = tmp.path().join("grep-started");
    let release = tmp.path().join("grep-release");
    ide_vcs::set_git_executable(Some(&paused_git(tmp.path(), &started, &release)));
    let repo = Repo::discover(&dir).unwrap().unwrap();
    repo.set_execution_allowed(true);
    let concurrent = std::thread::scope(|scope| {
        let search = scope.spawn(|| repo.log(&query).unwrap());
        let deadline = Instant::now() + Duration::from_secs(20);
        while !started.exists() {
            assert!(Instant::now() < deadline, "the search never reached --grep");
            std::thread::sleep(Duration::from_millis(20));
        }
        git(&dir, &["checkout", "-q", "other"]);
        let head = repo.log(&LogQuery { branch: Some("HEAD".into()), limit: 1, ..Default::default() }).unwrap();
        assert_eq!(head[0].on_current_branch, Some(true));
        git(&dir, &["checkout", "-q", "main"]);
        assert!(!search.is_finished(), "the search ended before the switch; the test proves nothing");
        std::fs::write(&release, "").unwrap();
        search.join().unwrap()
    });
    ide_vcs::set_git_executable(None);
    assert_eq!(marks(concurrent), serial);
    // The view cached for these refs.
    assert_eq!(marks(repo.log(&query).unwrap()), serial);
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
