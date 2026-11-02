#![cfg(unix)]
//! A content root opened through a symlink whose name differs from its target's.

use ide_clip::settings::Settings;
use ide_host::ops::clip::{ClipCopySource, ClipPasteApply, copy_in, paste_apply, paste_preview_into};
use std::fs;

#[test]
fn a_symlinked_content_root_restores_its_own_copy_into_itself() {
    let tmp = tempfile::tempdir().unwrap();
    let base = fs::canonicalize(tmp.path()).unwrap();
    let w = base.join("W");
    fs::create_dir_all(&w).unwrap();
    fs::write(w.join("notes.txt"), "w\n").unwrap();
    let real = base.join("real/bar");
    fs::create_dir_all(&real).unwrap();
    fs::write(real.join("x.txt"), "x\n").unwrap();
    fs::create_dir_all(base.join("links")).unwrap();
    let link = base.join("links/foo");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let roots = vec![link.clone()];

    let text = copy_in(&w, &roots, ClipCopySource::Files { paths: vec![link.join("x.txt")] }, &Settings::default())
        .unwrap()
        .text;
    assert!(text.contains("// file: bar/x.txt\n"), "{text}");

    fs::write(real.join("x.txt"), "old\n").unwrap();
    let preview = paste_preview_into(&w, None, &roots, &text, false, &[], &Settings::default()).unwrap();
    assert_eq!(preview.files.len(), 1, "{:?}", preview.files);
    assert_eq!(preview.files[0].target.as_deref(), Some(real.join("x.txt").to_string_lossy().as_ref()));
    assert_eq!(preview.files[0].action, "overwrite");
    paste_apply(ClipPasteApply { id: preview.id, overwrite: vec![0], ..Default::default() }).unwrap();
    assert_eq!(fs::read_to_string(real.join("x.txt")).unwrap().trim_end(), "x");
    assert!(!w.join("bar").exists());
}

#[test]
fn an_absolute_header_through_the_symlink_restores_into_the_content_root() {
    let tmp = tempfile::tempdir().unwrap();
    let base = fs::canonicalize(tmp.path()).unwrap();
    let w = base.join("W");
    fs::create_dir_all(&w).unwrap();
    let real = base.join("real/bar");
    fs::create_dir_all(&real).unwrap();
    fs::write(real.join("x.txt"), "old\n").unwrap();
    fs::create_dir_all(base.join("links")).unwrap();
    let link = base.join("links/foo");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let roots = vec![link.clone()];

    let text = format!("// file: {}/x.txt\nnew\n", link.to_string_lossy());
    let preview = paste_preview_into(&w, None, &roots, &text, false, &[], &Settings::default()).unwrap();
    assert_eq!(preview.files.len(), 1, "{:?}", preview.files);
    assert!(preview.files[0].target.is_some(), "{:?}", preview.files);
    assert_eq!(preview.files[0].action, "overwrite");
}
