//! Non-text files through the host ops (docs/clipcode/non-text-files.md): copy with Exclude / Include,
//! paste preview and apply, identical targets, corrupt entries and commits replay.
//! The preview store holds one preview per process, so every case runs under one lock.

use ide_clip::nontext;
use ide_clip::settings::Settings;
use ide_host::ops::clip::{
    ClipCopySource, ClipNonTextMode, ClipPasteApply, clip_settings, copy, copy_with, paste_apply, paste_preview_file,
    paste_preview_into,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

static LOCK: Mutex<()> = Mutex::new(());

fn png() -> Vec<u8> {
    let mut b = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d];
    b.extend((0..288u32).map(|i| (i * 7) as u8));
    b
}

/// Traditional Chinese text in Big5: no NUL, not UTF-8.
const BIG5: &[u8] = &[0xa4, 0xa4, 0xa4, 0xe5, b'\n', 0xb4, 0xfa, 0xb8, 0xd5, b'\n'];

fn dir() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(tmp.path()).unwrap();
    (tmp, root)
}

fn source() -> (tempfile::TempDir, PathBuf) {
    let (tmp, root) = dir();
    fs::create_dir_all(root.join("static")).unwrap();
    fs::write(root.join("static/logo.png"), png()).unwrap();
    fs::write(root.join("static/big5.txt"), BIG5).unwrap();
    fs::write(root.join("a.txt"), "hello\n").unwrap();
    (tmp, root)
}

fn all(root: &Path) -> ClipCopySource {
    ClipCopySource::Files { paths: vec![root.join("a.txt"), root.join("static")] }
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

fn init_repo(root: &Path) {
    git(root, &["init", "-q", "-b", "main"]);
    git(root, &["config", "user.email", "t@example.com"]);
    git(root, &["config", "user.name", "T"]);
}

#[test]
fn settings_carry_the_non_text_limit() {
    let default = ide_core::settings::ClipCodeSettings::default();
    assert_eq!(clip_settings(&default).max_non_text_file_size_kb, 2048.0);
    let small = ide_core::settings::ClipCodeSettings { max_non_text_file_size_kb: 1, ..default };
    assert_eq!(clip_settings(&small).max_non_text_file_size_kb, 1.0);
}

#[test]
fn files_round_trip_through_copy_preview_and_apply() {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (_src_tmp, src) = source();
    let settings = Settings::default();

    // Exclude: today's payload (text only) plus the summary the dialog shows.
    let exclude = copy_with(&src, all(&src), &settings, ClipNonTextMode::Exclude).unwrap();
    assert_eq!(exclude.files, 1);
    assert_eq!(exclude.non_text_copied, 0);
    assert!(!exclude.text.contains("base64 follows"));
    assert_eq!(exclude.non_text.count, 2);
    assert_eq!(exclude.non_text.total_bytes, (png().len() + BIG5.len()) as f64);
    assert_eq!(exclude.non_text.over_limit_count, 0);
    assert!(!exclude.non_text.exceeds_payload_cap);
    let mut listed: Vec<_> = exclude.non_text.files.iter().map(|f| (f.path.as_str(), f.size)).collect();
    listed.sort_by(|a, b| a.0.cmp(b.0));
    assert_eq!(listed, [("static/big5.txt", BIG5.len() as f64), ("static/logo.png", png().len() as f64)]);

    // Only non-text files: the legacy `copy` still fails, `copy_with` reports them so the dialog can ask.
    let only = || ClipCopySource::Files { paths: vec![src.join("static")] };
    assert!(copy(&src, only(), &settings).is_err());
    let none = copy_with(&src, only(), &settings, ClipNonTextMode::Exclude).unwrap();
    assert_eq!((none.files, none.text.as_str(), none.non_text.count), (0, "", 2));
    assert_eq!(copy_with(&src, only(), &settings, ClipNonTextMode::Include).unwrap().non_text_copied, 2);

    // Include: both are carried, and the Exclude estimate was exact.
    let include = copy_with(&src, all(&src), &settings, ClipNonTextMode::Include).unwrap();
    assert_eq!((include.files, include.non_text_copied), (3, 2));
    assert_eq!(include.non_text.count, 2);
    assert_eq!(exclude.non_text.estimated_include_bytes, include.text.len() as f64);

    // Preview into an empty destination: non-text rows carry size, never content.
    let (_dst_tmp, dst) = dir();
    let preview = paste_preview_into(&dst, None, &[], &include.text, false, &[], &settings).unwrap();
    for (path, size) in [("static/logo.png", png().len()), ("static/big5.txt", BIG5.len())] {
        let row = preview.files.iter().find(|f| f.path == path).unwrap_or_else(|| panic!("{path}"));
        assert_eq!(row.action, "create");
        let nt = row.non_text.as_ref().unwrap();
        assert_eq!((nt.size, nt.identical), (size as f64, false));
        let pane = paste_preview_file(preview.id, &row.action, row.index).unwrap();
        assert_eq!((pane.incoming, pane.current, pane.note), (None, None, None));
        assert_eq!(pane.non_text.unwrap().size, size as f64);
    }
    let text_row = preview.files.iter().find(|f| f.path == "a.txt").unwrap();
    assert!(text_row.non_text.is_none());
    assert!(paste_preview_file(preview.id, &text_row.action, text_row.index).unwrap().non_text.is_none());

    let result = paste_apply(ClipPasteApply { id: preview.id, ..Default::default() }).unwrap();
    assert_eq!((result.created, result.unchanged, result.corrupt_non_text.len()), (3, 0, 0));
    assert_eq!(fs::read(dst.join("static/logo.png")).unwrap(), png());
    assert_eq!(fs::read(dst.join("static/big5.txt")).unwrap(), BIG5);

    // Pasting again: identical non-text targets are reported unchanged without any overwrite
    // permission; the existing text file is kept as it is.
    let again = paste_preview_into(&dst, None, &[], &include.text, false, &[], &settings).unwrap();
    for path in ["static/logo.png", "static/big5.txt"] {
        let row = again.files.iter().find(|f| f.path == path).unwrap();
        assert_eq!(row.action, "overwrite");
        assert!(row.non_text.as_ref().unwrap().identical);
    }
    let result = paste_apply(ClipPasteApply { id: again.id, ..Default::default() }).unwrap();
    assert_eq!((result.unchanged, result.overwritten, result.created), (2, 0, 0));

    // A different target follows the overwrite option, like a text entry.
    fs::write(dst.join("static/logo.png"), b"old").unwrap();
    let diff = paste_preview_into(&dst, None, &[], &include.text, false, &[], &settings).unwrap();
    let logo = diff.files.iter().find(|f| f.path == "static/logo.png").unwrap();
    assert!(!logo.non_text.as_ref().unwrap().identical);
    let kept = paste_apply(ClipPasteApply { id: diff.id, ..Default::default() }).unwrap();
    assert_eq!((kept.unchanged, kept.overwritten), (1, 0));
    assert_eq!(fs::read(dst.join("static/logo.png")).unwrap(), b"old");
    let diff = paste_preview_into(&dst, None, &[], &include.text, false, &[], &settings).unwrap();
    let logo = diff.files.iter().find(|f| f.path == "static/logo.png").unwrap().index;
    let done = paste_apply(ClipPasteApply { id: diff.id, overwrite: vec![logo], ..Default::default() }).unwrap();
    assert_eq!((done.unchanged, done.overwritten), (1, 1));
    assert_eq!(fs::read(dst.join("static/logo.png")).unwrap(), png());
}

#[test]
fn corrupt_entries_are_skipped_and_named() {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let bytes = png();
    let header = nontext::NonTextHeader { size: bytes.len() as u64, sha256: nontext::sha256_hex(&bytes) };
    let line = nontext::placeholder_line(header.size, &header.sha256);
    let good = nontext::encode_wrapped(&bytes);
    let truncated = &good[..good.len() - 8];
    let wrong_sha = nontext::placeholder_line(header.size, &"0".repeat(64));
    let text = format!(
        "// file: bad/truncated.png\n{line}\n{truncated}\n\n// file: bad/sha.png\n{wrong_sha}\n{good}\n\n\
         // file: ok.png\n{line}\n{good}\n"
    );
    let (_tmp, dst) = dir();
    let preview = paste_preview_into(&dst, None, &[], &text, false, &[], &Settings::default()).unwrap();
    let skipped: Vec<_> =
        preview.files.iter().filter(|f| f.action == "skip").map(|f| f.reason.clone().unwrap()).collect();
    assert_eq!(skipped, ["CORRUPT_NON_TEXT", "CORRUPT_NON_TEXT"]);
    let result = paste_apply(ClipPasteApply { id: preview.id, ..Default::default() }).unwrap();
    assert_eq!((result.created, result.skipped), (1, 2));
    let mut named = result.corrupt_non_text.clone();
    named.sort();
    assert_eq!(named, ["bad/sha.png", "bad/truncated.png"]);
    assert_eq!(fs::read(dst.join("ok.png")).unwrap(), bytes);
    assert!(!dst.join("bad").exists());
}

#[test]
fn commits_carry_the_image_only_when_included() {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (_src_tmp, src) = dir();
    init_repo(&src);
    fs::write(src.join("a.txt"), "hello\n").unwrap();
    git(&src, &["add", "-A"]);
    git(&src, &["commit", "-q", "-m", "base"]);
    fs::create_dir_all(src.join("img")).unwrap();
    fs::write(src.join("img/logo.png"), png()).unwrap();
    git(&src, &["add", "-A"]);
    git(&src, &["commit", "-q", "-m", "add logo"]);
    let tip = git(&src, &["rev-parse", "HEAD"]);
    let source = ClipCopySource::Commits { repo: src.clone(), tip: tip.clone(), selected: vec![tip] };
    let settings = Settings::default();

    let exclude = copy_with(&src, source.clone(), &settings, ClipNonTextMode::Exclude).unwrap();
    assert!(!exclude.text.contains("nonText"));
    assert_eq!((exclude.non_text.count, exclude.non_text_copied, exclude.skipped), (1, 0, 1));
    assert_eq!(exclude.non_text.files[0].path, "img/logo.png");

    let include = copy_with(&src, source, &settings, ClipNonTextMode::Include).unwrap();
    assert_eq!((include.non_text_copied, include.skipped), (1, 0));
    assert_eq!(exclude.non_text.estimated_include_bytes, include.text.len() as f64);

    let (_dst_tmp, dst) = dir();
    init_repo(&dst);
    fs::write(dst.join("a.txt"), "hello\n").unwrap();
    git(&dst, &["add", "-A"]);
    git(&dst, &["commit", "-q", "-m", "base"]);
    let preview = paste_preview_into(&dst, None, &[], &include.text, false, &[], &settings).unwrap();
    let file = &preview.commits[0].files[0];
    assert_eq!((file.path.as_str(), file.action.as_str(), file.non_text_size), ("img/logo.png", "WRITE", Some(300.0)));
    let result = paste_apply(ClipPasteApply { id: preview.id, ..Default::default() }).unwrap();
    assert_eq!((result.commits.len(), result.errors.len()), (1, 0));
    assert_eq!(fs::read(dst.join("img/logo.png")).unwrap(), png());
}

/// A commit whose non-text entry is corrupt says so in the replay preview, not the raw BINARY reason.
#[test]
fn corrupt_commit_entry_previews_as_corrupt_not_binary() {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (_src_tmp, src) = dir();
    init_repo(&src);
    fs::write(src.join("a.txt"), "hello\n").unwrap();
    git(&src, &["add", "-A"]);
    git(&src, &["commit", "-q", "-m", "base"]);
    fs::write(src.join("logo.png"), png()).unwrap();
    git(&src, &["add", "-A"]);
    git(&src, &["commit", "-q", "-m", "add logo"]);
    let tip = git(&src, &["rev-parse", "HEAD"]);
    let source = ClipCopySource::Commits { repo: src.clone(), tip: tip.clone(), selected: vec![tip] };
    let settings = Settings::default();
    let include = copy_with(&src, source, &settings, ClipNonTextMode::Include).unwrap();

    let at = include.text.find("\"sha256\":\"").expect("sha256 in the payload") + "\"sha256\":\"".len();
    let mut bad = include.text.clone();
    let flipped = if bad.as_bytes()[at] == b'0' { "1" } else { "0" };
    bad.replace_range(at..at + 1, flipped);

    let (_dst_tmp, dst) = dir();
    init_repo(&dst);
    fs::write(dst.join("a.txt"), "hello\n").unwrap();
    git(&dst, &["add", "-A"]);
    git(&dst, &["commit", "-q", "-m", "base"]);
    let preview = paste_preview_into(&dst, None, &[], &bad, false, &[], &settings).unwrap();
    let file = &preview.commits[0].files[0];
    assert_eq!(file.reason.as_deref(), Some("CORRUPT_NON_TEXT"));
    assert_eq!(file.action, "SKIP");
}

/// Exclude is today's copy: a selection whose only text file is a size placeholder copies nothing,
/// whatever non-text files sit next to it.
#[test]
fn exclude_with_only_a_size_placeholder_is_nothing_to_copy() {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (_tmp, root) = dir();
    fs::create_dir_all(root.join("d")).unwrap();
    fs::write(root.join("d/big.txt"), "x".repeat(700 * 1024)).unwrap();
    fs::write(root.join("d/logo.png"), png()).unwrap();
    let source = ClipCopySource::Files { paths: vec![root.join("d")] };
    let settings = Settings::default();

    let err = copy(&root, source, &settings).unwrap_err();
    assert!(err.to_string().contains("Nothing to copy"), "{err}");
}

/// The 50 MiB cap is measured on the LF payload the copy side capped, so CRLF line ends added by a
/// clipboard pipe do not turn a payload that fit into a refusal.
#[test]
fn paste_cap_ignores_crlf_growth() {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (_tmp, root) = dir();
    let cap = ide_clip::transfer::CLIPBOARD_PAYLOAD_MAX;
    let lines = cap / 76;
    let crlf = format!("{}\r\n", "a".repeat(75)).repeat(lines);
    assert!(crlf.len() > cap);
    let settings = Settings::default();

    let res = paste_preview_into(&root, None, &[], &crlf, false, &[], &settings);
    if let Err(e) = res {
        assert!(!e.to_string().contains("more than 50 MiB"), "{e}");
    }
    let lf = "a".repeat(cap + 1);
    let e = paste_preview_into(&root, None, &[], &lf, false, &[], &settings).unwrap_err();
    assert!(e.to_string().contains("more than 50 MiB"), "{e}");
}

/// Only a CR that a parser would drop (one before an LF) is forgiven; lone CRs stay in the content
/// and count in full, so they cannot smuggle an oversized payload past the cap.
#[test]
fn paste_cap_counts_lone_cr() {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (_tmp, root) = dir();
    let cap = ide_clip::transfer::CLIPBOARD_PAYLOAD_MAX;
    let text = format!("// file: a.txt\nx{}\n", "\r".repeat(cap + 1024));
    let e = paste_preview_into(&root, None, &[], &text, false, &[], &Settings::default()).unwrap_err();
    assert!(e.to_string().contains("more than 50 MiB"), "{e}");
}
