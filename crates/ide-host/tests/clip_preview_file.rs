//! The paste preview dialog's content pane reads one file of the open preview at a time.
//! One test: the preview store holds a single preview per process.

use ide_clip::settings::Settings;
use ide_host::ops::clip::{ClipPasteApply, paste_apply, paste_preview_file, paste_preview_into};
use std::fs;

#[test]
fn each_file_shows_what_the_paste_writes_and_what_the_destination_holds() {
    let tmp = tempfile::tempdir().unwrap();
    let w = fs::canonicalize(tmp.path()).unwrap();
    fs::write(w.join("old.txt"), "before\n").unwrap();
    fs::write(w.join("gone.txt"), "going\n").unwrap();
    fs::write(w.join("bin.dat"), [0xff, 0xfe, 0x00, 0x80]).unwrap();
    let text = "// file: old.txt\nafter\n// file: src/new.txt\nfresh\n// file: bin.dat\ntext now\n\
                // file: [DELETED] gone.txt\n// This file has been deleted in this change\n";
    let preview = paste_preview_into(&w, None, &[], text, false, &[], &Settings::default()).unwrap();
    let file = |path: &str| preview.files.iter().find(|f| f.path == path).unwrap_or_else(|| panic!("{path}"));

    let old = file("old.txt");
    assert_eq!(old.action, "overwrite");
    let content = paste_preview_file(preview.id, &old.action, old.index).unwrap();
    assert_eq!(content.incoming.as_deref().map(str::trim_end), Some("after"));
    assert_eq!(content.current.as_deref(), Some("before\n"));
    assert_eq!(content.note, None);

    let new = file("src/new.txt");
    assert_eq!(new.action, "create");
    let content = paste_preview_file(preview.id, &new.action, new.index).unwrap();
    assert_eq!(content.incoming.as_deref().map(str::trim_end), Some("fresh"));
    assert_eq!(content.current, None);

    let bin = file("bin.dat");
    // A binary target is skipped before it is written: its pane shows the reason only.
    assert_eq!((bin.action.as_str(), bin.reason.as_deref()), ("skip", Some("NON_UTF8_TARGET")));
    let content = paste_preview_file(preview.id, &bin.action, bin.index).unwrap();
    assert_eq!((content.incoming, content.current, content.note), (None, None, None));

    let gone = file("gone.txt");
    assert_eq!(gone.action, "delete");
    let content = paste_preview_file(preview.id, &gone.action, gone.index).unwrap();
    assert_eq!(content.incoming, None);
    assert_eq!(content.current.as_deref(), Some("going\n"));

    assert!(paste_preview_file(preview.id + 1, "create", 0).is_err());
    assert!(paste_preview_file(preview.id, "create", 99).is_err());

    // Reading does not consume the preview: Apply still writes it.
    paste_apply(ClipPasteApply { id: preview.id, overwrite: vec![old.index], ..Default::default() }).unwrap();
    assert_eq!(fs::read_to_string(w.join("old.txt")).unwrap().trim_end(), "after");
    assert_eq!(fs::read_to_string(w.join("src/new.txt")).unwrap().trim_end(), "fresh");
}
