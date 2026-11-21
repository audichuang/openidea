//! Fork-owned: Restricted Mode check for every `graph_*` command declared `trust = always`,
//! matching `trust_vcs_sweep.rs`. Run against a repository whose config names programs for a
//! signed commit, an index read, an external diff, a clean filter and a missing object. None
//! may run.
use ide_core::NullSink;
use ide_host::{Host, HostConfig, catalogue::TrustClass, ops};
use ide_vcs::fork_graph::GraphRevCounts;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git").current_dir(root).args(args).output().unwrap();
    assert!(output.status.success(), "{args:?}: {}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

fn spelled(path: &Path) -> String {
    path.to_str().unwrap().replace('\\', "/")
}

struct Armed {
    root: PathBuf,
    promised: String,
}

fn arm(root: &Path, markers: &Path) -> Armed {
    std::fs::create_dir_all(root.join("src")).unwrap();
    git(root, &["init", "-q", "-b", "main"]);
    for (key, value) in [("user.name", "Test"), ("user.email", "test@example.com"), ("commit.gpgsign", "false")] {
        git(root, &["config", key, value]);
    }
    std::fs::write(root.join("src/a.txt"), "one\ntwo\n").unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "-qm", "first"]);
    let first = git(root, &["rev-parse", "HEAD"]);

    // Feature branch ahead of `first` by 2 commits.
    git(root, &["checkout", "-q", "-b", "feature", &first]);
    std::fs::write(root.join("src/feature.txt"), "f1\n").unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "-qm", "feature 1"]);
    std::fs::write(root.join("src/feature.txt"), "f1\nf2\n").unwrap();
    git(root, &["commit", "-qam", "feature 2"]);

    // Back on main: advance by 1 commit, then add a signature header so plain `git log` starts gpg.
    git(root, &["checkout", "-q", "main"]);
    std::fs::write(root.join("src/a.txt"), "one\ntwo\nthree\n").unwrap();
    git(root, &["commit", "-qam", "second"]);

    let body = git(root, &["cat-file", "commit", "HEAD"]);
    let (headers, message) = body.split_once("\n\n").unwrap();
    let signed = format!(
        "{headers}\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEEfake\n -----END PGP SIGNATURE-----\n\n{message}\n"
    );
    let mut child = Command::new("git")
        .current_dir(root)
        .args(["hash-object", "-t", "commit", "-w", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    std::io::Write::write_all(&mut child.stdin.take().unwrap(), signed.as_bytes()).unwrap();
    let head = String::from_utf8(child.wait_with_output().unwrap().stdout).unwrap().trim().to_owned();
    git(root, &["update-ref", "HEAD", &head]);

    // A branch whose tip has a tree of its own, which is then dropped from the object database.
    git(root, &["checkout", "-q", "-b", "promised", &first]);
    std::fs::write(root.join("only-here.txt"), "promised\n").unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "-qm", "promised"]);
    let promised = git(root, &["rev-parse", "HEAD"]);
    let tree = git(root, &["rev-parse", "HEAD^{tree}"]);
    git(root, &["checkout", "-q", "main"]);
    std::fs::remove_file(root.join(".git/objects").join(&tree[..2]).join(&tree[2..])).unwrap();

    let marker = |name: &str| spelled(&markers.join(name));
    let script = |name: &str| {
        let path = root.join(".git").join(format!("{name}.sh"));
        std::fs::write(&path, format!("#!/bin/sh\necho x > '{}'\nexit 1\n", marker(name))).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        spelled(&path)
    };
    let settings = [
        ("log.showSignature", "true".to_owned()),
        ("gpg.program", script("gpg")),
        ("core.fsmonitor", script("fsmonitor")),
        ("diff.external", script("extdiff")),
        ("filter.marker.clean", format!("echo x > '{}'; cat", marker("filter"))),
        ("extensions.partialClone", "origin".to_owned()),
        ("remote.origin.url", spelled(root)),
        ("remote.origin.promisor", "true".to_owned()),
        ("remote.origin.partialclonefilter", "blob:none".to_owned()),
        ("remote.origin.uploadpack", format!("echo x > '{}'; git-upload-pack", marker("promisor"))),
    ];
    std::fs::write(root.join(".gitattributes"), "*.txt filter=marker\n").unwrap();
    std::fs::write(root.join("src/a.txt"), "ONE\ntwo\nthree\n").unwrap();
    for (key, value) in &settings {
        git(root, &["config", key, value]);
    }
    Armed { root: root.to_path_buf(), promised }
}

fn ran(markers: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(markers)
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn clear(markers: &Path) {
    let _ = std::fs::remove_dir_all(markers);
    std::fs::create_dir_all(markers).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restricted_fork_graph_commands_run_no_program_of_the_repository() {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let markers = base.join("markers");
    clear(&markers);
    let project = arm(&base.join("project"), &markers);
    let host = Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    });
    host.trust.decide(&project.root, false, false).unwrap();
    clear(&markers);
    assert!(!host.open_project("main", &project.root).unwrap().is_trusted());
    assert!(ran(&markers).is_empty(), "open_project ran a program: {:?}", ran(&markers));

    // Every `graph_*` command declared `trust = always` must be swept here; `graph_rev_counts`
    // backs the PR view in Restricted Mode alongside the `vcs_*` queries.
    let dispatcher = ide_host::rpc::Dispatcher::standard();
    let allowed: BTreeSet<&str> = dispatcher
        .commands()
        .into_iter()
        .filter(|c| c.starts_with("graph_") && dispatcher.trust(c) == Some(TrustClass::Always))
        .collect();
    assert_eq!(
        allowed,
        BTreeSet::from(["graph_rev_counts"]),
        "Restricted Mode's allowed graph_* commands differ from the sweep"
    );
    assert!(
        host.authorize("main", dispatcher.trust("graph_rev_counts").unwrap()).is_ok(),
        "graph_rev_counts must be authorized in Restricted Mode"
    );

    clear(&markers);
    let counts =
        ops::fork_graph::graph_rev_counts(&host, "main", Some(project.root.clone()), "main".into(), "feature".into())
            .await
            .unwrap();
    assert_eq!(counts, GraphRevCounts { ahead: 2, behind: 1 });
    assert!(ran(&markers).is_empty(), "graph_rev_counts ran a program: {:?}", ran(&markers));

    clear(&markers);
    let promised_counts = ops::fork_graph::graph_rev_counts(
        &host,
        "main",
        Some(project.root.clone()),
        "main".into(),
        project.promised.clone(),
    )
    .await
    .unwrap();
    assert_eq!(promised_counts, GraphRevCounts { ahead: 1, behind: 1 });
    assert!(ran(&markers).is_empty(), "graph_rev_counts (promised) ran a program: {:?}", ran(&markers));

    // Control: plain git in the same repository starts every one of the fixture's programs.
    clear(&markers);
    for args in [&["log", "-1", "--format=%H"][..], &["status", "--porcelain"], &["ls-tree", &project.promised]] {
        let _ = Command::new("git").current_dir(&project.root).args(args).output().unwrap();
    }
    let _ = Command::new("git").current_dir(&project.root).args(["diff"]).output().unwrap();
    assert_eq!(
        ran(&markers),
        ["extdiff", "filter", "fsmonitor", "gpg", "promisor"],
        "control: the fixture is not live"
    );

    host.shutdown().await;
}
