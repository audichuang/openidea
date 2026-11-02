//! snip-sync's copy / paste acceptance cases (docs/real-ui-operator-protocol.md at
//! 81654b1: T03–T13, T15, T17–T28, T13b, T32, B42, C-nonutf8, C-blocked) run against
//! OpenIDEA's ClipCode backend on the same fixture (`fixtures/clip-fixture.sh`). The
//! case ids in the test names are the protocol's; their pass lines are the oracles.
#![cfg(unix)]

use ide_clip::settings::Settings;
use ide_host::ops::clip::{
    ClipChangeSide, ClipCopySource, ClipPasteApply, ClipPastePreview, copy, paste_apply, paste_preview,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// The ClipCode defaults, as the `snip` CLI copies with (file limit 30).
fn cli() -> Settings {
    Settings::default()
}

struct Fix {
    _tmp: tempfile::TempDir,
    root: PathBuf,
}

impl Fix {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap().join("round");
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/clip-fixture.sh");
        let out = Command::new("sh").arg(&script).arg(&base).output().unwrap();
        assert!(out.status.success(), "fixture: {}", String::from_utf8_lossy(&out.stderr));
        Self { _tmp: tmp, root: base.join("fixtures") }
    }
    fn p(&self, rel: &str) -> PathBuf {
        self.root.join(rel)
    }
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim_end().to_string()
}

fn read(path: PathBuf) -> String {
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// The commit of `commits-src` whose subject is `subject`.
fn sha(repo: &Path, subject: &str) -> String {
    let log = git(repo, &["log", "--all", "--format=%H%x09%s"]);
    log.lines()
        .find_map(|l| l.split_once('\t').filter(|(_, s)| *s == subject).map(|(h, _)| h.to_string()))
        .unwrap_or_else(|| panic!("no commit '{subject}' in\n{log}"))
}

fn commits(repo: &Path, tip: &str, selected: &[&str]) -> ClipCopySource {
    ClipCopySource::Commits {
        repo: repo.to_path_buf(),
        tip: tip.to_string(),
        selected: selected.iter().map(|s| s.to_string()).collect(),
    }
}

fn rows(p: &ClipPastePreview) -> Vec<(String, String)> {
    p.files.iter().map(|f| (f.path.clone(), f.action.clone())).collect()
}

fn row(p: &ClipPastePreview, path: &str) -> (String, u32) {
    let f = p.files.iter().find(|f| f.path == path).unwrap_or_else(|| panic!("no row {path}: {:?}", rows(p)));
    (f.action.clone(), f.index)
}

fn overwrite_all(p: &ClipPastePreview) -> Vec<u32> {
    p.files.iter().filter(|f| f.action == "overwrite").map(|f| f.index).collect()
}

fn apply(p: &ClipPastePreview, req: ClipPasteApply) -> ide_host::ops::clip::ClipPasteResult {
    paste_apply(ClipPasteApply { id: p.id, ..req }).unwrap()
}

fn ws_dst_repos(f: &Fix) -> Vec<PathBuf> {
    (1..=15).map(|i| f.p(&format!("ws-dst/repo{i:02}"))).collect()
}

#[test]
fn t03_t04_multi_repo_changes_land_in_their_repositories() {
    let f = Fix::new();
    let src = f.p("ws-src");
    let repos = ws_dst_repos(&f);
    let other_status = git(&f.p("ws-dst/repo08"), &["status", "--porcelain"]);
    let other_head = git(&f.p("ws-dst/repo08"), &["rev-parse", "HEAD"]);

    // T03: repo01's and repo03's unrelated.txt, both existing in the destination. The copy is
    // anchored on the workspace (`repo01/…`, `repo03/…`), so it restores into the destination
    // workspace's root, as ClipCode's Paste and Restore Files always resolves from the project.
    let copied = copy(
        &src,
        ClipCopySource::Changes {
            paths: vec![src.join("repo01/unrelated.txt"), src.join("repo03/unrelated.txt")],
            side: ClipChangeSide::Staged,
        },
        &cli(),
    )
    .unwrap();
    assert_eq!(copied.files, 2);
    assert!(copied.text.starts_with("// clipcode-root: ws-src\n"), "{}", copied.text);
    let p = paste_preview(&f.p("ws-dst"), &copied.text, false, &repos, &cli()).unwrap();
    assert_eq!(p.suggestion, None);
    let targets: Vec<_> = p.files.iter().map(|r| (r.action.as_str(), r.target.clone().unwrap())).collect();
    assert_eq!(targets.len(), 2, "{targets:?}");
    assert!(targets.iter().all(|(a, _)| *a == "overwrite"), "{targets:?}");
    let r = apply(&p, ClipPasteApply { overwrite: overwrite_all(&p), ..Default::default() });
    assert_eq!((r.overwritten, r.skipped), (2, 0), "{r:?}");
    assert_eq!(read(f.p("ws-dst/repo01/unrelated.txt")), "from-repo01");
    assert_eq!(read(f.p("ws-dst/repo03/unrelated.txt")), "from-repo03");

    // T04: two new files and two existing ones in four repositories.
    let copied = copy(
        &src,
        ClipCopySource::Changes {
            paths: ["repo02/only-src.txt", "repo05/only-src.txt", "repo06/shared.txt", "repo07/shared.txt"]
                .iter()
                .map(|p| src.join(p))
                .collect(),
            side: ClipChangeSide::Staged,
        },
        &cli(),
    )
    .unwrap();
    let p = paste_preview(&f.p("ws-dst"), &copied.text, false, &repos, &cli()).unwrap();
    let r = apply(&p, ClipPasteApply { overwrite: overwrite_all(&p), ..Default::default() });
    assert_eq!((r.created, r.overwritten), (2, 2), "{r:?}");
    assert_eq!(read(f.p("ws-dst/repo05/only-src.txt")), "create-b");
    assert_eq!(read(f.p("ws-dst/repo07/shared.txt")), "src-over-2");
    assert_eq!(git(&f.p("ws-dst/repo08"), &["status", "--porcelain"]), other_status);
    assert_eq!(git(&f.p("ws-dst/repo08"), &["rev-parse", "HEAD"]), other_head);
}

#[test]
fn t05_staged_changes_restore_with_their_labels() {
    let f = Fix::new();
    let src = f.p("files-src");
    let copied =
        copy(&src, ClipCopySource::Changes { paths: vec![src.clone()], side: ClipChangeSide::Staged }, &cli()).unwrap();
    let t = &copied.text;
    for header in ["[NEW] staged-new.txt", "[MODIFIED] both.txt", "[DELETED] gone.txt", "[MOVED] new-name.txt"] {
        assert!(t.contains(&format!("// file: {header}")), "missing {header}:\n{t}");
    }
    assert!(t.contains("index-body") && !t.contains("worktree-body"), "{t}");
    assert!(!t.contains("old-name.txt"), "no deletion of the rename's old path:\n{t}");

    let p = paste_preview(&f.p("files-dst"), t, false, &[], &cli()).unwrap();
    let (action, both) = row(&p, "both.txt");
    assert_eq!(action, "overwrite");
    let r = apply(&p, ClipPasteApply { overwrite: vec![both], ..Default::default() });
    assert_eq!((r.created, r.overwritten, r.deleted, r.skipped), (2, 1, 1, 0), "{r:?}");
    assert_eq!(read(f.p("files-dst/both.txt")), "index-body");
    assert_eq!(read(f.p("files-dst/new-name.txt")), "old");
    assert!(!f.p("files-dst/gone.txt").exists());
    assert_eq!(read(f.p("files-dst/old-name.txt")), "old-dest\n");
}

#[test]
fn t06_the_index_and_the_working_tree_copy_different_bytes() {
    let f = Fix::new();
    let src = f.p("files-src");
    let staged =
        copy(&src, ClipCopySource::Changes { paths: vec![src.join("both.txt")], side: ClipChangeSide::Staged }, &cli())
            .unwrap();
    let disk = copy(&src, ClipCopySource::Files { paths: vec![src.join("both.txt")] }, &cli()).unwrap();
    assert!(staged.text.contains("index-body"), "{}", staged.text);
    assert!(disk.text.contains("worktree-body"), "{}", disk.text);
}

#[test]
fn t07_t08_t09_t10_t11_t12_folder_binary_size_empty_unicode_and_selection() {
    let f = Fix::new();
    let src = f.p("files-src");
    let dst = f.p("files-dst");

    // T07: five text files copied, the binary and UTF-16 ones skipped.
    let folder = copy(&src, ClipCopySource::Files { paths: vec![src.join("folder")] }, &cli()).unwrap();
    assert_eq!((folder.files, folder.skipped), (5, 2), "{folder:?}");
    let p = paste_preview(&dst, &folder.text, false, &[], &cli()).unwrap();
    let r = apply(&p, ClipPasteApply::default());
    assert_eq!(r.created, 5, "{r:?}");
    assert_eq!(read(dst.join("folder/c.txt")), "folder-c");
    assert_eq!(read(dst.join("folder/utf16.txt")), "keep-utf16\n");
    assert!(!dst.join("folder/bin.dat").exists());

    // T08: binary / non-UTF-8 alone: nothing to copy; with a text file, they carry nothing.
    assert!(
        copy(&src, ClipCopySource::Files { paths: vec![src.join("binary.dat"), src.join("folder/utf16.txt")] }, &cli())
            .is_err()
    );
    let mixed = copy(
        &src,
        ClipCopySource::Files {
            paths: vec![src.join("binary.dat"), src.join("folder/utf16.txt"), src.join("folder/a.txt")],
        },
        &cli(),
    )
    .unwrap();
    let p = paste_preview(&dst, &mixed.text, false, &[], &cli()).unwrap();
    let overwrite = overwrite_all(&p);
    apply(&p, ClipPasteApply { overwrite, ..Default::default() });
    assert_eq!(read(dst.join("binary.dat")), "keep-bin\n");
    assert_eq!(read(dst.join("folder/utf16.txt")), "keep-utf16\n");

    // T09: over the size limit: alone nothing; with another file a placeholder that never restores.
    assert!(copy(&src, ClipCopySource::Files { paths: vec![src.join("large.txt")] }, &cli()).is_err());
    let sized = copy(&src, ClipCopySource::Files { paths: vec![src.join("large.txt"), src.join("empty.txt")] }, &cli())
        .unwrap();
    assert!(sized.text.contains("// File skipped: size exceeds limit"), "{}", &sized.text[..200.min(sized.text.len())]);
    let p = paste_preview(&dst, &sized.text, false, &[], &cli()).unwrap();
    apply(&p, ClipPasteApply::default());
    assert!(!dst.join("large.txt").exists());
    // T10: the empty file exists, zero bytes.
    assert_eq!(fs::metadata(dst.join("empty.txt")).unwrap().len(), 0);

    // T11: a path with spaces and CJK, and CRLF content.
    let odd = copy(
        &src,
        ClipCopySource::Files { paths: vec![src.join("路徑 有空白/檔案.txt"), src.join("crlf.txt")] },
        &cli(),
    )
    .unwrap();
    let p = paste_preview(&dst, &odd.text, false, &[], &cli()).unwrap();
    apply(&p, ClipPasteApply::default());
    assert_eq!(read(dst.join("路徑 有空白/檔案.txt")), "中文");
    assert_eq!(read(dst.join("crlf.txt")), "line");

    // T12: an unchecked new file and an unchosen overwrite stay as they are.
    let two =
        copy(&src, ClipCopySource::Files { paths: vec![src.join("overwrite.txt"), src.join("folder/d.txt")] }, &cli())
            .unwrap();
    fs::remove_file(dst.join("folder/d.txt")).unwrap();
    let p = paste_preview(&dst, &two.text, false, &[], &cli()).unwrap();
    let (action, d) = row(&p, "folder/d.txt");
    assert_eq!(action, "create");
    assert_eq!(row(&p, "overwrite.txt").0, "overwrite");
    let r = apply(&p, ClipPasteApply { unchecked_creates: vec![d], ..Default::default() });
    assert_eq!(r.created + r.overwritten, 0, "{r:?}");
    assert!(!dst.join("folder/d.txt").exists());
    assert_eq!(read(dst.join("overwrite.txt")), "do-not-touch\n");
}

#[test]
fn t13_t15_stale_destination_and_invalid_clipboard() {
    let f = Fix::new();
    let src = f.p("files-src");
    let dst = f.p("files-dst");
    let copied = copy(&src, ClipCopySource::Files { paths: vec![src.join("folder/a.txt")] }, &cli()).unwrap();
    let p = paste_preview(&dst, &copied.text, false, &[], &cli()).unwrap();
    fs::create_dir_all(dst.join("folder")).unwrap();
    fs::write(dst.join("folder/a.txt"), "written outside\n").unwrap();
    assert!(paste_apply(ClipPasteApply { id: p.id, ..Default::default() }).is_err());
    assert_eq!(read(dst.join("folder/a.txt")), "written outside\n");

    assert!(paste_preview(&dst, "QA invalid clipboard payload", false, &[], &cli()).is_err());
}

#[test]
fn t17_commits_must_form_one_first_parent_chain() {
    let f = Fix::new();
    let repo = f.p("commits-src");
    let side = sha(&repo, "SIDE");
    let c2 = sha(&repo, "C2 rename delete emoji");
    let err = copy(&repo, commits(&repo, &c2, &[&c2, &side]), &cli()).unwrap_err();
    assert!(err.message.contains("not contiguous"), "{}", err.message);
}

fn c1_to_c3(f: &Fix) -> (PathBuf, String) {
    let repo = f.p("commits-src");
    let c1 = sha(&repo, "多行中文");
    let c2 = sha(&repo, "C2 rename delete emoji");
    let c3 = sha(&repo, "C3 merge");
    let copied = copy(&repo, commits(&repo, &c3, &[&c3, &c2, &c1]), &cli()).unwrap();
    assert_eq!(copied.mode, "commits");
    assert_eq!(copied.commits, 3);
    assert!(copied.text.starts_with("// snip-sync commits v1\n"));
    (repo, copied.text)
}

#[test]
fn t18_t23_t30_replay_over_existing_files_needs_consent_and_keeps_local_state() {
    let f = Fix::new();
    let (_, text) = c1_to_c3(&f);
    let dst = f.p("commits-dst-overwrite");
    let before = git(&dst, &["rev-parse", "HEAD"]);

    let p = paste_preview(&dst, &text, false, &[], &cli()).unwrap();
    assert_eq!(p.commits.len(), 3);
    let files: usize = p.commits.iter().map(|c| c.files.len()).sum();
    // snip-sync previews 8 rows: its rename takes two (old and new path); here it is one file.
    assert_eq!(files, 7, "{:?}", p.commits);
    let overwrites: Vec<_> =
        p.commits.iter().flat_map(|c| c.files.iter().filter(|f| f.overwrites).map(|f| f.path.clone())).collect();
    assert_eq!(overwrites, ["common.txt", "common.txt"]);
    // T30: without consent nothing is committed.
    assert!(paste_apply(ClipPasteApply { id: p.id, ..Default::default() }).is_err());
    assert_eq!(git(&dst, &["rev-list", "--count", &format!("{before}..HEAD")]), "0");

    let p = paste_preview(&dst, &text, false, &[], &cli()).unwrap();
    let r = apply(&p, ClipPasteApply { overwrite_existing: true, ..Default::default() });
    assert_eq!(r.commits.len(), 3, "{r:?}");
    assert_eq!(git(&dst, &["rev-list", "--count", &format!("{before}..HEAD")]), "3");
    // T23: the staged and the untracked file are left alone.
    let status = git(&dst, &["status", "--porcelain"]);
    assert!(status.contains("A  staged-keep.txt"), "{status}");
    assert!(status.contains("?? local-only.txt"), "{status}");
}

#[test]
fn t19_t20_t21_t22_replay_keeps_metadata_merges_and_renames() {
    let f = Fix::new();
    let (src, text) = c1_to_c3(&f);
    let dst = f.p("commits-dst-clean");
    let before = git(&dst, &["rev-parse", "HEAD"]);

    let p = paste_preview(&dst, &text, false, &[], &cli()).unwrap();
    // T22: the rename's old path and gone.txt do not exist here: skipped, not deleted.
    let c2 = &p.commits[1];
    let old = c2.files.iter().find(|f| f.old_path.as_deref() == Some("old.txt")).unwrap();
    assert_eq!((old.path.as_str(), old.change.as_str()), ("new.txt", "RENAMED"));
    let gone = c2.files.iter().find(|f| f.path == "gone.txt").unwrap();
    assert_eq!((gone.action.as_str(), gone.reason.as_deref()), ("SKIP", Some("ALREADY_ABSENT")), "{gone:?}");

    let r = apply(&p, ClipPasteApply::default());
    assert_eq!(r.commits.len(), 3, "{r:?}");
    let created: Vec<&str> = git(&dst, &["rev-list", "--reverse", &format!("{before}..HEAD")]).leak().lines().collect();
    assert_eq!(created.len(), 3);
    // T19: C1's common.txt is an addition here.
    assert_eq!(git(&dst, &["show", "--name-status", "--format=", created[0]]), "A\tcommon.txt");
    // T20: author, email, date and message equal the source's.
    let meta = |repo: &Path, rev: &str| git(repo, &["log", "-1", "-z", "--format=%an%x00%ae%x00%aI%x00%B", rev]);
    for (subject, made) in ["多行中文", "C2 rename delete emoji", "C3 merge"].iter().zip(&created) {
        assert_eq!(meta(&dst, made), meta(&src, &sha(&src, subject)), "{subject}");
    }
    assert!(meta(&dst, created[0]).contains("多行中文\n\n第二段"));
    assert!(meta(&dst, created[0]).contains("2026-03-02T09:00:00+08:00"));
    // T21: the merge became one parent adding side.txt.
    assert_eq!(git(&dst, &["rev-list", "--parents", "-1", created[2]]).split(' ').count(), 2);
    assert_eq!(git(&dst, &["show", "--name-only", "--format=", created[2]]), "side.txt");
    assert_eq!(read(dst.join("side.txt")), "from-side\n");
    // T22: the results.
    assert_eq!(read(dst.join("new.txt")), "old\n");
    assert_eq!(read(dst.join("emoji.txt")), "你好 ✨\n");
    assert!(!dst.join("old.txt").exists() && !dst.join("gone.txt").exists());
}

#[test]
fn t24_replay_runs_no_hooks() {
    let f = Fix::new();
    let repo = f.p("commits-src");
    let c4 = sha(&repo, "C4 text and binary");
    let copied = copy(&repo, commits(&repo, &c4, &[&c4]), &cli()).unwrap();
    let dst = f.p("commits-dst-hooks");
    let p = paste_preview(&dst, &copied.text, false, &[], &cli()).unwrap();
    let r = apply(&p, ClipPasteApply::default());
    assert_eq!(r.commits.len(), 1, "{r:?}");
    assert!(!f.p("hook-marker.txt").exists(), "a hook ran");
}

#[test]
fn t25_binary_changes_are_not_copied_and_deletions_replay() {
    let f = Fix::new();
    let repo = f.p("commits-src");
    let c2 = sha(&repo, "C2 rename delete emoji");
    let copied = copy(&repo, commits(&repo, &c2, &[&c2]), &cli()).unwrap();
    assert_eq!((copied.commits, copied.files, copied.skipped), (1, 5, 1), "{copied:?}");
    let dst = f.p("commits-dst-present");
    let p = paste_preview(&dst, &copied.text, false, &[], &cli()).unwrap();
    let bin = p.commits[0].files.iter().find(|f| f.path == "binary.dat").unwrap();
    assert_eq!((bin.action.as_str(), bin.reason.as_deref()), ("SKIP", Some("BINARY")), "{bin:?}");
    let r = apply(&p, ClipPasteApply::default());
    assert_eq!(r.commits.len(), 1, "{r:?}");
    assert_eq!(fs::read(dst.join("binary.dat")).unwrap(), b"a\0b\n");
    assert!(!dst.join("gone.txt").exists() && !dst.join("old.txt").exists());
    assert_eq!(read(dst.join("new.txt")), "old\n");
    assert_eq!(read(dst.join("dir/gone.txt")), "folder-gone\n");
}

#[test]
fn t26_t27_t28_binary_additions_repeat_replays_and_empty_commits() {
    let f = Fix::new();
    let repo = f.p("commits-src");
    let c4 = sha(&repo, "C4 text and binary");
    let copied = copy(&repo, commits(&repo, &c4, &[&c4]), &cli()).unwrap();
    let dst = f.p("commits-dst-clean");

    // T26
    let p = paste_preview(&dst, &copied.text, false, &[], &cli()).unwrap();
    let actions: Vec<_> = p.commits[0].files.iter().map(|f| (f.path.as_str(), f.action.as_str())).collect();
    assert_eq!(actions, [("new-binary.bin", "SKIP"), ("newdir/content.txt", "WRITE")]);
    let first = apply(&p, ClipPasteApply::default()).commits;
    assert_eq!(first.len(), 1);
    assert_eq!(git(&dst, &["show", "--name-only", "--format=", &first[0]]), "newdir/content.txt");

    // T27: the same commit again overwrites with consent: a new commit, the same tree.
    let p = paste_preview(&dst, &copied.text, false, &[], &cli()).unwrap();
    assert!(p.commits[0].files.iter().any(|f| f.path == "newdir/content.txt" && f.overwrites));
    let second = apply(&p, ClipPasteApply { overwrite_existing: true, ..Default::default() }).commits;
    assert_eq!(second.len(), 1);
    assert_ne!(first[0], second[0]);
    let tree = |rev: &str| git(&dst, &["rev-parse", &format!("{rev}^{{tree}}")]);
    assert_eq!(tree(&first[0]), tree(&second[0]));

    // T28: an empty commit is still created.
    let empty = sha(&repo, "empty replay");
    let copied = copy(&repo, commits(&repo, &empty, &[&empty]), &cli()).unwrap();
    let head_tree = tree("HEAD");
    let p = paste_preview(&dst, &copied.text, false, &[], &cli()).unwrap();
    assert!(p.commits[0].files.is_empty());
    assert_eq!(apply(&p, ClipPasteApply::default()).commits.len(), 1);
    assert_eq!(tree("HEAD"), head_tree);
}

#[test]
fn t13b_a_moved_head_refuses_the_replay() {
    let f = Fix::new();
    let (_, text) = c1_to_c3(&f);
    let dst = f.p("commits-dst-clean");
    let p = paste_preview(&dst, &text, false, &[], &cli()).unwrap();
    git(&dst, &["commit", "--allow-empty", "-q", "-m", "qa-head-moved"]);
    let moved = git(&dst, &["rev-parse", "HEAD"]);
    assert!(paste_apply(ClipPasteApply { id: p.id, ..Default::default() }).is_err());
    assert_eq!(git(&dst, &["rev-parse", "HEAD"]), moved);
}

#[test]
fn t32_b42_commit_files_carry_deletions_with_their_old_content() {
    let f = Fix::new();
    // T32: one deleted file of C2.
    let repo = f.p("commits-src");
    let c2 = sha(&repo, "C2 rename delete emoji");
    let copied = copy(
        &repo,
        ClipCopySource::CommitFiles { repo: repo.clone(), rev: c2, paths: vec![repo.join("gone.txt")] },
        &cli(),
    )
    .unwrap();
    assert!(copied.text.contains("// file: [DELETED] gone.txt\ngone"), "{}", copied.text);
    let dst = f.p("commits-dst-present");
    let p = paste_preview(&dst, &copied.text, false, &[], &cli()).unwrap();
    apply(&p, ClipPasteApply::default());
    assert!(!dst.join("gone.txt").exists());
    assert_eq!(fs::read(dst.join("binary.dat")).unwrap(), b"a\0b\n");
    assert_eq!(read(dst.join("dir/gone.txt")), "folder-gone\n");

    // B42: a folder of a commit: the modified file and the deleted one.
    let basket = f.p("basket-src");
    let rev = sha(&basket, "basket folder and delete");
    let copied = copy(
        &basket,
        ClipCopySource::CommitFiles { repo: basket.clone(), rev, paths: vec![basket.join("dir")] },
        &cli(),
    )
    .unwrap();
    assert!(copied.text.contains("[DELETED] dir/gone.txt\nfolder-gone"), "{}", copied.text);
    assert!(copied.text.contains("dir/keep.txt\nkeep-2"), "{}", copied.text);
    let p = paste_preview(&dst, &copied.text, false, &[], &cli()).unwrap();
    let overwrite = overwrite_all(&p);
    apply(&p, ClipPasteApply { overwrite, ..Default::default() });
    assert!(!dst.join("dir/gone.txt").exists());
    assert_eq!(read(dst.join("dir/keep.txt")), "keep-2");
    assert_eq!(read(dst.join("old.txt")), "old\n");
}

#[test]
fn c_nonutf8_non_utf8_files_are_neither_written_nor_deleted() {
    let f = Fix::new();
    let src = f.p("nonutf8-src");
    let n1 = sha(&src, "N1 modify latin1 add ok");
    let n2 = sha(&src, "N2 delete latin1");
    let copied = copy(&src, commits(&src, &n2, &[&n2, &n1]), &cli()).unwrap();
    assert_eq!(copied.skipped, 2, "{copied:?}");
    let dst = f.p("nonutf8-dst");
    let p = paste_preview(&dst, &copied.text, false, &[], &cli()).unwrap();
    let latin: Vec<_> =
        p.commits.iter().flat_map(|c| &c.files).filter(|f| f.path == "latin1.txt").map(|f| f.reason.clone()).collect();
    assert_eq!(latin, [Some("NON_UTF8".into()), Some("NON_UTF8".into())]);
    assert_eq!(apply(&p, ClipPasteApply::default()).commits.len(), 2);
    assert_eq!(fs::read(dst.join("latin1.txt")).unwrap(), b"caf\xe9\n");
    assert_eq!(read(dst.join("ok.txt")), "ok\n");

    // A non-UTF-8 file in the destination is not overwritten.
    let repo = f.p("commits-src");
    let c1 = sha(&repo, "多行中文");
    let copied = copy(&repo, commits(&repo, &c1, &[&c1]), &cli()).unwrap();
    let p = paste_preview(&dst, &copied.text, false, &[], &cli()).unwrap();
    let common = p.commits[0].files.iter().find(|f| f.path == "common.txt").unwrap();
    assert_eq!((common.action.as_str(), common.reason.as_deref()), ("SKIP", Some("NON_UTF8_TARGET")), "{common:?}");
}

#[test]
fn c_blocked_a_layout_conflict_refuses_the_whole_commit() {
    let f = Fix::new();
    let src = f.p("blocked-src");
    let b1 = sha(&src, "B1 blocked dir and fresh");
    let copied = copy(&src, commits(&src, &b1, &[&b1]), &cli()).unwrap();
    let dst = f.p("ws-dst/repo04");
    let head = git(&dst, &["rev-parse", "HEAD"]);
    let p = paste_preview(&dst, &copied.text, false, &[], &cli()).unwrap();
    assert!(p.commits[0].refused.is_some(), "{:?}", p.commits[0]);
    let r = paste_apply(ClipPasteApply { id: p.id, ..Default::default() });
    assert!(r.as_ref().map(|r| r.commits.is_empty() && !r.errors.is_empty()).unwrap_or(true), "{r:?}");
    assert!(!dst.join("fresh.txt").exists());
    assert_eq!(git(&dst, &["rev-parse", "HEAD"]), head);
}

/// With `SNIP_CLI` pointing at a snip-sync `snip` binary: both produce the same bytes
/// for the same selection, and each restores the other's payload.
mod against_snip_cli {
    use super::*;

    fn snip() -> Option<PathBuf> {
        std::env::var_os("SNIP_CLI").map(PathBuf::from)
    }

    fn run(snip: &Path, cwd: &Path, args: &[&str], stdin: Option<&str>) -> String {
        use std::io::Write;
        let mut child = Command::new(snip)
            .args(args)
            .current_dir(cwd)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        if let Some(text) = stdin {
            child.stdin.take().unwrap().write_all(text.as_bytes()).unwrap();
        }
        drop(child.stdin.take());
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success(), "snip {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).unwrap()
    }

    #[test]
    fn copies_are_byte_identical() {
        let Some(snip) = snip() else { return };
        let f = Fix::new();
        let files = f.p("files-src");
        let repo = f.p("commits-src");
        let base = sha(&repo, "commit base");
        let c1 = sha(&repo, "多行中文");
        let c2 = sha(&repo, "C2 rename delete emoji");
        let c3 = sha(&repo, "C3 merge");
        let cases: Vec<(&str, String, ClipCopySource)> = vec![
            (
                "staged",
                run(&snip, &files, &["copy", "--staged", "--stdout"], None),
                ClipCopySource::Changes { paths: vec![files.clone()], side: ClipChangeSide::Staged },
            ),
            (
                "working",
                run(&snip, &files, &["copy", "--working", "--stdout"], None),
                ClipCopySource::Changes { paths: vec![files.clone()], side: ClipChangeSide::Working },
            ),
            (
                "folder",
                run(&snip, &files, &["copy", "folder", "--stdout"], None),
                ClipCopySource::Files { paths: vec![files.join("folder")] },
            ),
            (
                "unicode and crlf",
                run(&snip, &files, &["copy", "路徑 有空白/檔案.txt", "crlf.txt", "--stdout"], None),
                ClipCopySource::Files {
                    paths: vec![files.join("路徑 有空白/檔案.txt"), files.join("crlf.txt")]
                },
            ),
            (
                "commit",
                run(&snip, &repo, &["copy", "--commit", &c2, "--stdout"], None),
                ClipCopySource::CommitFiles { repo: repo.clone(), rev: c2.clone(), paths: vec![] },
            ),
            (
                "range",
                run(&snip, &repo, &["copy", "--range", &format!("{base}..{c3}"), "--stdout"], None),
                ClipCopySource::Range { repo: repo.clone(), base: base.clone(), tip: c3.clone(), paths: vec![] },
            ),
            (
                "commits",
                run(&snip, &repo, &["copy", "--commits", &format!("{base}..{c3}"), "--stdout"], None),
                commits(&repo, &c3, &[&c3, &c2, &c1]),
            ),
        ];
        for (name, theirs, source) in cases {
            let ours = copy(&files, source, &cli()).unwrap().text;
            assert_eq!(ours, theirs, "{name}: OpenIDEA and snip differ");
        }
    }

    #[test]
    fn each_restores_the_others_payload() {
        let Some(snip) = snip() else { return };
        let f = Fix::new();
        let repo = f.p("commits-src");
        let c1 = sha(&repo, "多行中文");
        let c2 = sha(&repo, "C2 rename delete emoji");
        let c3 = sha(&repo, "C3 merge");

        // OpenIDEA's commit payload replayed by snip.
        let ours = copy(&repo, commits(&repo, &c3, &[&c3, &c2, &c1]), &cli()).unwrap().text;
        let dst = f.p("commits-dst-clean");
        run(&snip, &dst, &["paste", "--apply", "--stdin"], Some(&ours));
        assert_eq!(git(&dst, &["log", "-3", "--format=%s"]), "C3 merge\nC2 rename delete emoji\n多行中文");

        // snip's file payload restored by OpenIDEA.
        let files = f.p("files-src");
        let theirs = run(&snip, &files, &["copy", "--staged", "--stdout"], None);
        let target = f.p("files-dst");
        let p = paste_preview(&target, &theirs, false, &[], &cli()).unwrap();
        let (_, both) = row(&p, "both.txt");
        let r = apply(&p, ClipPasteApply { overwrite: vec![both], ..Default::default() });
        assert_eq!((r.created, r.overwritten, r.deleted), (2, 1, 1), "{r:?}");
        assert_eq!(read(target.join("both.txt")), "index-body");
    }
}
