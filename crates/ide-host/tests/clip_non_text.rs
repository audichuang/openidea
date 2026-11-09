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

/// A folder with one readable file and three entries the export refuses (a mode-000 file, a dangling
/// symlink, a mode-000 directory). Returns None when the user can read mode-000 files (root).
#[cfg(unix)]
fn refused_entries() -> Option<(tempfile::TempDir, PathBuf)> {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let (tmp, root) = dir();
    let d = root.join("mix");
    fs::create_dir_all(d.join("locked_dir")).unwrap();
    fs::write(d.join("a.txt"), "hello\n").unwrap();
    fs::write(d.join("locked.txt"), "secret\n").unwrap();
    symlink(d.join("nowhere"), d.join("dangling")).unwrap();
    fs::set_permissions(d.join("locked.txt"), fs::Permissions::from_mode(0o000)).unwrap();
    fs::set_permissions(d.join("locked_dir"), fs::Permissions::from_mode(0o000)).unwrap();
    if fs::File::open(d.join("locked.txt")).is_ok() {
        return None;
    }
    Some((tmp, root))
}

#[cfg(unix)]
fn restore_modes(root: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let d = root.join("mix");
    let _ = fs::set_permissions(d.join("locked.txt"), fs::Permissions::from_mode(0o644));
    let _ = fs::set_permissions(d.join("locked_dir"), fs::Permissions::from_mode(0o755));
}

#[cfg(unix)]
#[test]
fn unreadable_entries_are_named_in_the_copy_result() {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let Some((_tmp, root)) = refused_entries() else { return };
    let mix = root.join("mix");
    let settings = Settings::default();

    let folder = copy(&root, ClipCopySource::Files { paths: vec![mix.clone()] }, &settings);
    let direct = copy(
        &root,
        ClipCopySource::Files { paths: vec![mix.join("a.txt"), mix.join("locked.txt"), mix.join("dangling")] },
        &settings,
    );
    restore_modes(&root);

    let folder = folder.unwrap();
    assert_eq!((folder.files, folder.skipped_unreadable), (1, 3), "{folder:?}");
    let mut named = folder.skipped_unreadable_paths.clone();
    named.sort();
    assert_eq!(named, ["mix/dangling", "mix/locked.txt", "mix/locked_dir"]);

    let direct = direct.unwrap();
    assert_eq!((direct.files, direct.skipped_unreadable), (1, 2), "{direct:?}");
    let mut named = direct.skipped_unreadable_paths.clone();
    named.sort();
    assert_eq!(named, ["mix/dangling", "mix/locked.txt"]);
}

/// A selected unreadable folder next to a readable file: the file is copied, the folder is named.
#[cfg(unix)]
#[test]
fn a_selected_unreadable_folder_is_skipped_and_named() {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let Some((_tmp, root)) = refused_entries() else { return };
    init_repo(&root);
    let mix = root.join("mix");
    let settings = Settings::default();
    let a = copy(&root, ClipCopySource::Files { paths: vec![mix.join("a.txt"), mix.join("locked_dir")] }, &settings);
    let b = copy(&root, ClipCopySource::Files { paths: vec![mix.join("locked_dir"), mix.join("a.txt")] }, &settings);
    // The same selection while the project is somewhere else.
    let (_other_tmp, other) = dir();
    let c = copy(&other, ClipCopySource::Files { paths: vec![mix.join("a.txt"), mix.join("locked_dir")] }, &settings);
    restore_modes(&root);
    for r in [a, b, c] {
        let r = r.unwrap();
        assert_eq!((r.files, r.skipped_unreadable), (1, 1), "{r:?}");
        assert_eq!(r.skipped_unreadable_paths.len(), 1);
        assert!(r.skipped_unreadable_paths[0].ends_with("locked_dir"), "{r:?}");
        assert!(r.text.contains("hello"));
    }
}

/// Names the payload cannot carry are reported as such, with their real names; a symlinked folder inside a
/// copied folder is named too.
#[cfg(unix)]
#[test]
fn unportable_names_and_symlinked_folders_are_named() {
    use std::os::unix::fs::symlink;
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (_tmp, root) = dir();
    let d = root.join("odd");
    fs::create_dir_all(d.join("real")).unwrap();
    fs::write(d.join("real/x.txt"), "x\n").unwrap();
    fs::write(d.join("a.txt"), "hello\n").unwrap();
    fs::write(d.join("back\\slash.txt"), "b\n").unwrap();
    fs::write(d.join("q\"uote.txt"), "q\n").unwrap();
    fs::write(d.join("tab\tname.txt"), "t\n").unwrap();
    symlink(d.join("real"), d.join("linkdir")).unwrap();
    let settings = Settings::default();

    let folder = copy(&root, ClipCopySource::Files { paths: vec![d.clone()] }, &settings).unwrap();
    assert_eq!(folder.files, 2, "{folder:?}");
    assert_eq!((folder.skipped, folder.skipped_unreadable), (4, 0), "{folder:?}");
    let mut named = folder.skipped_unportable_paths.clone();
    named.sort();
    assert_eq!(named, ["odd/back\\slash.txt", "odd/q\"uote.txt", "odd/tab\tname.txt"]);
    assert_eq!((folder.skipped_unportable, folder.skipped_symlink_dirs), (3, 1));
    assert_eq!(folder.skipped_symlink_dir_paths, ["odd/linkdir"]);
    assert!(folder.skipped_unreadable_paths.is_empty());

    // Picked directly, the same names are not "unreadable" either.
    let direct = copy(
        &root,
        ClipCopySource::Files { paths: vec![d.join("a.txt"), d.join("back\\slash.txt"), d.join("tab\tname.txt")] },
        &settings,
    )
    .unwrap();
    assert_eq!((direct.files, direct.skipped_unportable, direct.skipped_unreadable), (1, 2, 0), "{direct:?}");
    let mut named = direct.skipped_unportable_paths.clone();
    named.sort();
    assert_eq!(named, ["odd/back\\slash.txt", "odd/tab\tname.txt"]);
}

/// A symlink to a folder selected directly, alone or next to a file, is not followed and is named as a
/// symlinked folder (required case 22). A project tree that shows the link as a folder changes nothing.
#[cfg(unix)]
#[test]
fn a_directly_selected_symlinked_folder_is_not_followed() {
    use std::os::unix::fs::symlink;
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (_tmp, root) = dir();
    let d = root.join("d14");
    fs::create_dir_all(d.join("real")).unwrap();
    fs::write(d.join("real/secret.txt"), "SECRET-CONTENT\n").unwrap();
    fs::write(d.join("ok.png"), png()).unwrap();
    fs::write(d.join("note.txt"), "plain\n").unwrap();
    symlink(d.join("real"), d.join("linkdir")).unwrap();
    let settings = Settings::default();

    // Alone: nothing is copied and the reason names the link.
    // It is a normal empty result (the UI says "Nothing to copy"), not an error with a raw code.
    let alone =
        copy_with(&root, ClipCopySource::Files { paths: vec![d.join("linkdir")] }, &settings, ClipNonTextMode::Include)
            .expect("a lone symlinked folder is an empty result, not an error");
    assert_eq!((alone.files, alone.skipped, alone.skipped_symlink_dirs), (0, 1, 1), "{alone:?}");
    assert_eq!(alone.skipped_symlink_dir_paths, ["d14/linkdir"]);
    assert!(alone.text.is_empty());

    // Multi-selection: the other entries are copied, the link is skipped and named, its contents are absent.
    for order in [vec!["linkdir", "note.txt", "ok.png"], vec!["note.txt", "ok.png", "linkdir"]] {
        let paths = order.iter().map(|n| d.join(n)).collect();
        let r = copy_with(&root, ClipCopySource::Files { paths }, &settings, ClipNonTextMode::Include).unwrap();
        assert!(!r.text.contains("SECRET-CONTENT") && !r.text.contains("secret.txt"), "{}", r.text);
        assert_eq!(r.files, 2, "{r:?}");
        assert_eq!((r.skipped, r.skipped_symlink_dirs, r.skipped_unreadable), (1, 1, 0), "{r:?}");
        assert_eq!(r.skipped_symlink_dir_paths, ["d14/linkdir"]);
    }
}

fn limit_settings(n: f64) -> Settings {
    Settings { set_max_file_count: true, file_count_limit: n, ..Settings::default() }
}

/// Folder `d2` (2 carried non-text files, 1 text file, 4 size placeholders) and folder `d4` (40 images)
/// under a limit of 30, as the testers copied them.
fn d2_d4() -> (tempfile::TempDir, PathBuf) {
    let (tmp, root) = dir();
    let d2 = root.join("d2");
    fs::create_dir_all(&d2).unwrap();
    fs::write(d2.join("a1.png"), png()).unwrap();
    fs::write(d2.join("a2.png"), png()).unwrap();
    fs::write(d2.join("a3.txt"), "text\n").unwrap();
    // Over both limits: never read.
    fs::write(d2.join("b1.bin"), vec![0u8; 3 * 1024 * 1024]).unwrap();
    fs::write(d2.join("b2.bin"), vec![0u8; 3 * 1024 * 1024]).unwrap();
    // Read, then over their own limit: text over 500 KB, a PNG-like file is within 2 MB so use text twice.
    fs::write(d2.join("c1.json"), "x".repeat(700 * 1024)).unwrap();
    fs::write(d2.join("c2.json"), "y".repeat(700 * 1024)).unwrap();
    let d4 = root.join("d4");
    fs::create_dir_all(&d4).unwrap();
    for i in 0..40 {
        let mut b = png();
        b.push(i as u8);
        fs::write(d4.join(format!("i{i:02}.png")), b).unwrap();
    }
    (tmp, root)
}

/// The dialog (Exclude result) describes exactly what Include carries and what its notice reports, also
/// when size placeholders sit inside the file-count window (required case 15).
#[test]
fn the_dialog_numbers_equal_the_include_payload_with_size_placeholders() {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (_tmp, root) = d2_d4();
    let settings = limit_settings(30.0);
    let src = || ClipCopySource::Files { paths: vec![root.join("d2"), root.join("d4")] };
    let exclude = copy_with(&root, src(), &settings, ClipNonTextMode::Exclude).unwrap();
    let include = copy_with(&root, src(), &settings, ClipNonTextMode::Include).unwrap();
    let (e, i) = (&exclude.non_text, &include.non_text);
    assert_eq!(e.count, include.non_text_copied, "dialog count vs Include payload: {e:?} / {include:?}");
    assert_eq!(e.count, i.count);
    assert_eq!(e.limit_left_out, i.limit_left_out, "left out: dialog vs Include notice");
    assert_eq!(e.files.len(), 10);
    assert_eq!(
        e.files.iter().map(|f| &f.path).collect::<Vec<_>>(),
        i.files.iter().map(|f| &f.path).collect::<Vec<_>>()
    );
    assert_eq!(e.estimated_include_bytes as usize, include.text.len(), "estimate vs Include payload");
    assert_eq!(e.total_bytes, i.total_bytes);
    assert_eq!(e.over_limit_count, i.over_limit_count);
    assert_eq!(e.unread_over_limit_count, i.unread_over_limit_count);
}

/// A row that fails while writing counts as skipped in the notice title, not only in its body (a read-only
/// parent folder), and the other rows are still restored.
#[cfg(unix)]
#[test]
fn a_row_that_fails_while_writing_counts_as_skipped() {
    use std::os::unix::fs::PermissionsExt;
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (_tmp, dst) = dir();
    fs::create_dir_all(dst.join("locked")).unwrap();
    fs::set_permissions(dst.join("locked"), fs::Permissions::from_mode(0o555)).unwrap();
    // As root the write succeeds and there is nothing to observe.
    let writable = fs::write(dst.join("locked/probe"), b"x").is_ok();
    let settings = Settings::default();
    let text = "// file: locked/a.txt\nhello\n// file: ok.txt\nfine\n";
    let preview = paste_preview_into(&dst, None, &[], text, false, &[], &settings).unwrap();
    let result = paste_apply(ClipPasteApply { id: preview.id, ..Default::default() });
    fs::set_permissions(dst.join("locked"), fs::Permissions::from_mode(0o755)).unwrap();
    if writable {
        return;
    }
    let result = result.unwrap();
    assert_eq!((result.created, result.skipped), (1, 1), "{result:?}");
    assert_eq!(result.errors.len(), 1, "{result:?}");
    assert!(dst.join("ok.txt").exists());
}

/// Entries that map to the same file skip every colliding row with a collision reason and restore the
/// others; the paste is never aborted (required case 23; a symlinked folder stands in for a case-insensitive
/// file system, which this host may not have).
#[cfg(unix)]
#[test]
fn colliding_entries_skip_their_rows_and_the_rest_restores() {
    use std::os::unix::fs::symlink;
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (_tmp, dst) = dir();
    fs::create_dir_all(dst.join("real")).unwrap();
    symlink("real", dst.join("alias")).unwrap();
    let settings = Settings::default();
    let text = "// file: real/img.png\none\n// file: alias/img.png\ntwo\n// file: ok.txt\nfine\n";
    let preview = paste_preview_into(&dst, None, &[], text, false, &[], &settings).unwrap();
    let skipped: Vec<_> = preview.files.iter().filter(|f| f.action == "skip").collect();
    assert_eq!(skipped.len(), 2, "{:?}", preview.files);
    assert!(skipped.iter().all(|f| f.reason.as_deref() == Some("TARGET_COLLISION")), "{skipped:?}");
    let result = paste_apply(ClipPasteApply { id: preview.id, ..Default::default() }).unwrap();
    assert_eq!((result.created, result.skipped), (1, 2), "{result:?}");
    assert!(dst.join("ok.txt").exists());
    assert!(!dst.join("real/img.png").exists());
}

/// Required case 27: a parent path of an entry is an existing file (`d3/a`). Only the rows under it are
/// skipped, with a user reason; `d3/ok.txt` restores; nothing aborts the paste.
#[test]
fn a_parent_path_that_is_a_file_skips_only_its_rows() {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let bytes = png();
    let line = nontext::placeholder_line(bytes.len() as u64, &nontext::sha256_hex(&bytes));
    let body = nontext::encode_wrapped(&bytes);
    let text = format!(
        "// file: d3/a/deep.png\n{line}\n{body}\n\n// file: d3/a/b/deep.png\n{line}\n{body}\n\n\
         // file: d3/a/text.txt\nhello\n// file: d3/ok.txt\nfine\n"
    );
    let (_tmp, dst) = dir();
    fs::create_dir_all(dst.join("d3")).unwrap();
    fs::write(dst.join("d3/a"), "a file").unwrap();
    let preview = paste_preview_into(&dst, None, &[], &text, false, &[], &Settings::default()).unwrap();
    let mut skipped: Vec<_> = preview
        .files
        .iter()
        .filter(|f| f.action == "skip")
        .map(|f| (f.path.clone(), f.reason.clone().unwrap()))
        .collect();
    skipped.sort();
    assert_eq!(
        skipped,
        [
            ("d3/a/b/deep.png".to_string(), "PARENT_NOT_FOLDER".to_string()),
            ("d3/a/deep.png".to_string(), "PARENT_NOT_FOLDER".to_string()),
            ("d3/a/text.txt".to_string(), "PARENT_NOT_FOLDER".to_string()),
        ]
    );
    let result = paste_apply(ClipPasteApply { id: preview.id, ..Default::default() }).unwrap();
    assert_eq!((result.created, result.skipped), (1, 3), "{result:?}");
    assert_eq!(fs::read_to_string(dst.join("d3/a")).unwrap(), "a file");
    assert_eq!(fs::read_to_string(dst.join("d3/ok.txt")).unwrap().trim_end(), "fine");
}

/// Required case 24: a replayed commit whose only change the non-UTF-8 guard refuses shows the reason in
/// the preview, is not created as an empty commit and is named in the result; the next commit still applies.
#[test]
fn a_commit_refused_by_the_non_utf8_guard_is_not_created_and_named() {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (_src_tmp, src) = dir();
    init_repo(&src);
    fs::write(src.join("legacy.txt"), "plain\n").unwrap();
    git(&src, &["add", "-A"]);
    git(&src, &["commit", "-q", "-m", "base"]);
    fs::write(src.join("legacy.txt"), "中文\n").unwrap();
    git(&src, &["add", "-A"]);
    git(&src, &["commit", "-q", "-m", "rewrite legacy"]);
    let first = git(&src, &["rev-parse", "HEAD"]);
    fs::write(src.join("b.txt"), "b\n").unwrap();
    git(&src, &["add", "-A"]);
    git(&src, &["commit", "-q", "-m", "add b"]);
    let tip = git(&src, &["rev-parse", "HEAD"]);
    let source = ClipCopySource::Commits { repo: src.clone(), tip: tip.clone(), selected: vec![first, tip] };
    let settings = Settings::default();
    let copied = copy_with(&src, source, &settings, ClipNonTextMode::Include).unwrap();

    let (_dst_tmp, dst) = dir();
    init_repo(&dst);
    fs::write(dst.join("legacy.txt"), BIG5).unwrap();
    git(&dst, &["add", "-A"]);
    git(&dst, &["commit", "-q", "-m", "base"]);
    let before: usize = git(&dst, &["rev-list", "--count", "HEAD"]).parse().unwrap();

    let preview = paste_preview_into(&dst, None, &[], &copied.text, false, &[], &settings).unwrap();
    let row = &preview.commits[0].files[0];
    assert_eq!((row.action.as_str(), row.reason.as_deref()), ("SKIP", Some("NON_UTF8_TARGET")), "{row:?}");
    let result =
        paste_apply(ClipPasteApply { id: preview.id, overwrite_existing: true, ..Default::default() }).unwrap();
    assert_eq!(result.commits.len(), 1, "{result:?}");
    // Structured, not an English sentence: the UI words it through the text catalog.
    assert!(result.errors.is_empty(), "{result:?}");
    assert_eq!(result.not_created.len(), 1, "{result:?}");
    let nc = &result.not_created[0];
    assert_eq!((nc.number, nc.subject.as_str(), nc.reason.as_str()), (1, "rewrite legacy", "NON_UTF8_TARGET"));
    let after: usize = git(&dst, &["rev-list", "--count", "HEAD"]).parse().unwrap();
    assert_eq!(after, before + 1);
    assert_eq!(fs::read(dst.join("legacy.txt")).unwrap(), BIG5);
    assert_eq!(fs::read_to_string(dst.join("b.txt")).unwrap(), "b\n");
}

/// Required case 25: a `headerFormat` that escaping cannot keep away from the placeholder or Base64 lines
/// (`$FILE_PATH`, `//$FILE_PATH` matches the placeholder, `$FILE_PATH==` matches `AA==`); the summary says so (the
/// dialog then disables Include) and Exclude still copies.
#[test]
fn an_unescapable_header_format_is_reported_in_the_summary() {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (_tmp, src) = source();
    for format in ["$FILE_PATH", "//$FILE_PATH", "$FILE_PATH=="] {
        let loose = Settings { header_format: format.into(), ..Settings::default() };
        let r = copy_with(&src, all(&src), &loose, ClipNonTextMode::Exclude).unwrap();
        assert_eq!(r.non_text.count, 2, "{format}");
        assert!(r.non_text.header_cannot_be_escaped, "{format}");
        assert_eq!(r.files, 1, "{format}");
    }
    let normal = copy_with(&src, all(&src), &Settings::default(), ClipNonTextMode::Exclude).unwrap();
    assert!(!normal.non_text.header_cannot_be_escaped);
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

/// X1: a Git copy (working changes, a commit) skips a changed file whose name a header cannot carry and names it
/// under "Name not portable"; the other files are copied and the name never reaches a header. When that file is
/// the only change, the result is empty and names it (the UI says "Nothing to copy" and leaves the clipboard).
#[cfg(unix)]
#[test]
fn git_copies_skip_and_name_unportable_names() {
    use ide_host::ops::clip::ClipChangeSide;
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (_tmp, root) = dir();
    init_repo(&root);
    fs::write(root.join("a.txt"), "hello\n").unwrap();
    fs::write(root.join("q\"uote.txt"), "q\n").unwrap();
    fs::write(root.join("tab\tname.txt"), "t\n").unwrap();
    let settings = Settings::default();
    let working = || ClipCopySource::Changes { paths: vec![root.clone()], side: ClipChangeSide::Working };
    let check = |r: ide_host::ops::clip::ClipCopyResult| {
        assert_eq!((r.files, r.skipped_unportable, r.skipped_unreadable), (1, 2, 0), "{r:?}");
        assert_eq!(sorted(r.skipped_unportable_paths), ["q\"uote.txt", "tab\tname.txt"]);
        assert!(r.text.contains("hello") && !r.text.contains("uote") && !r.text.contains("name.txt"), "{}", r.text);
    };
    check(copy_with(&root, working(), &settings, ClipNonTextMode::Exclude).expect("working copy"));
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-q", "-m", "c"]);
    let rev = git(&root, &["rev-parse", "HEAD"]);
    let commit = ClipCopySource::CommitFiles { repo: root.clone(), rev, paths: vec![] };
    check(copy_with(&root, commit, &settings, ClipNonTextMode::Exclude).expect("commit copy"));

    // The only change has a name that is not portable: an empty result that names it, not an error.
    fs::write(root.join("q\"uote.txt"), "changed\n").unwrap();
    let only = copy_with(&root, working(), &settings, ClipNonTextMode::Exclude).expect("an empty result");
    assert_eq!((only.files, only.skipped_unportable), (0, 1), "{only:?}");
    assert_eq!(only.skipped_unportable_paths, ["q\"uote.txt"]);
}

/// X1 in a repository nested in the project: the skipped name is spelled as the payload would spell it.
#[cfg(unix)]
#[test]
fn a_nested_repository_names_an_unportable_change_relative_to_the_project() {
    use ide_host::ops::clip::ClipChangeSide;
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (_tmp, project) = dir();
    let repo = project.join("sub");
    fs::create_dir_all(&repo).unwrap();
    init_repo(&repo);
    fs::write(repo.join("a.txt"), "hello\n").unwrap();
    fs::write(repo.join("q\"uote.txt"), "q\n").unwrap();
    let source = ClipCopySource::Changes { paths: vec![repo.clone()], side: ClipChangeSide::Working };
    let r = copy_with(&project, source, &Settings::default(), ClipNonTextMode::Exclude).unwrap();
    assert_eq!((r.files, r.skipped_unportable), (1, 1), "{r:?}");
    assert_eq!(r.skipped_unportable_paths, ["sub/q\"uote.txt"]);
    assert!(r.text.contains("sub/a.txt"), "{}", r.text);
}

/// X1 on a file system that takes non-UTF-8 names (Linux): such a changed file is named (lossily) under
/// "Name not portable", not counted as unreadable.
#[cfg(target_os = "linux")]
#[test]
fn a_git_copy_names_a_non_utf8_name_as_not_portable() {
    use ide_host::ops::clip::ClipChangeSide;
    use std::os::unix::ffi::OsStrExt;
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (_tmp, root) = dir();
    init_repo(&root);
    fs::write(root.join("a.txt"), "hello\n").unwrap();
    fs::write(root.join(std::ffi::OsStr::from_bytes(b"bad\xff.txt")), "x\n").unwrap();
    let source = ClipCopySource::Changes { paths: vec![root.clone()], side: ClipChangeSide::Working };
    let r = copy_with(&root, source, &Settings::default(), ClipNonTextMode::Exclude).unwrap();
    assert_eq!((r.files, r.skipped_unportable, r.skipped_unreadable), (1, 1, 0), "{r:?}");
    assert_eq!(r.skipped_unportable_paths, ["bad\u{FFFD}.txt"]);
}

/// X3 (#198): a selection whose every file is skipped is an empty result that names each skipped file in its
/// category, never a bare "Nothing to copy" error: a selected folder holding only an unreadable file, one holding
/// only names that are not portable, and a lone unreadable folder.
#[cfg(unix)]
#[test]
fn an_all_skipped_selection_names_what_was_skipped() {
    use std::os::unix::fs::PermissionsExt;
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (_tmp, root) = dir();
    fs::create_dir_all(root.join("locked")).unwrap();
    fs::write(root.join("locked/secret.txt"), "s\n").unwrap();
    fs::set_permissions(root.join("locked/secret.txt"), fs::Permissions::from_mode(0o000)).unwrap();
    fs::create_dir_all(root.join("closed")).unwrap();
    fs::set_permissions(root.join("closed"), fs::Permissions::from_mode(0o000)).unwrap();
    fs::create_dir_all(root.join("odd")).unwrap();
    fs::write(root.join("odd/q\"uote.txt"), "q\n").unwrap();
    let readable_as_root = fs::File::open(root.join("locked/secret.txt")).is_ok();
    let settings = Settings::default();
    let copy_of = |p: &str| {
        copy_with(&root, ClipCopySource::Files { paths: vec![root.join(p)] }, &settings, ClipNonTextMode::Exclude)
    };
    let (locked, closed, odd) = (copy_of("locked"), copy_of("closed"), copy_of("odd"));
    let _ = fs::set_permissions(root.join("locked/secret.txt"), fs::Permissions::from_mode(0o644));
    let _ = fs::set_permissions(root.join("closed"), fs::Permissions::from_mode(0o755));

    let odd = odd.expect("an empty result, not an error");
    assert_eq!((odd.files, odd.skipped_unportable), (0, 1), "{odd:?}");
    assert_eq!(odd.skipped_unportable_paths, ["odd/q\"uote.txt"]);
    if readable_as_root {
        return;
    }
    let locked = locked.expect("an empty result, not an error");
    assert_eq!((locked.files, locked.skipped_unreadable), (0, 1), "{locked:?}");
    assert_eq!(locked.skipped_unreadable_paths, ["locked/secret.txt"]);
    let closed = closed.expect("an empty result, not an error");
    assert_eq!((closed.files, closed.skipped_unreadable), (0, 1), "{closed:?}");
    assert_eq!(closed.skipped_unreadable_paths, ["closed"]);
}

/// X4: on macOS the NFC and NFD spellings of one name are the same file, so both rows are skipped as a collision
/// and the rest restores (only the macOS CI job runs this).
#[cfg(target_os = "macos")]
#[test]
fn nfc_and_nfd_spellings_collide_on_macos() {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (_tmp, dst) = dir();
    let settings = Settings::default();
    let text = "// file: caf\u{e9}.png\none\n// file: cafe\u{301}.png\ntwo\n// file: ok.txt\nfine\n";
    let preview = paste_preview_into(&dst, None, &[], text, false, &[], &settings).unwrap();
    let skipped: Vec<_> = preview.files.iter().filter(|f| f.action == "skip").collect();
    assert_eq!(skipped.len(), 2, "{:?}", preview.files);
    assert!(skipped.iter().all(|f| f.reason.as_deref() == Some("TARGET_COLLISION")), "{skipped:?}");
    let result = paste_apply(ClipPasteApply { id: preview.id, ..Default::default() }).unwrap();
    assert_eq!((result.created, result.skipped), (1, 2), "{result:?}");
}
