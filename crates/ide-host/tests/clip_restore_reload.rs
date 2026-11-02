//! A confirmed restore reloads the file in every open project, not only the one that ran it.

use ide_core::{ChangeSet, NullSink, TextChange};
use ide_host::ops::clip::{ClipPasteApply, clip_paste_apply, clip_paste_preview};
use ide_host::{Host, HostConfig};
use std::fs;
use std::path::Path;
use std::sync::Arc;

fn host(base: &Path) -> Arc<Host> {
    Arc::new(Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }))
}

fn prefix(text: &str) -> ChangeSet {
    ChangeSet { changes: vec![TextChange { from: 0, to: 0, insert: text.into() }] }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_reloads_the_file_in_other_open_projects() {
    let tmp = tempfile::tempdir().unwrap();
    let base = fs::canonicalize(tmp.path()).unwrap();
    let (a_root, b_root) = (base.join("a"), base.join("b"));
    fs::create_dir_all(&a_root).unwrap();
    fs::create_dir_all(&b_root).unwrap();
    let file = a_root.join("x.txt");
    fs::write(&file, "old\n").unwrap();
    let host = host(&base.join("app"));
    host.trust.decide(&a_root, true, false).unwrap();
    let a = host.open_project("wa", &a_root).unwrap();
    let b = host.open_project("wb", &b_root).unwrap();

    // Both windows hold the file with unsaved edits.
    let ida = a.documents.open(&file).unwrap().id;
    let idb = b.documents.open(&file).unwrap().id;
    a.documents.edit(ida, 0, prefix("// a ")).unwrap();
    b.documents.edit(idb, 0, prefix("// b ")).unwrap();

    let text = "// file: x.txt\nrestored\n".to_string();
    let preview = clip_paste_preview(&host, "wa", text, None, None, false, vec![]).await.unwrap();
    clip_paste_apply(&host, "wa", ClipPasteApply { id: preview.id, overwrite: vec![0], ..Default::default() })
        .await
        .unwrap();
    assert_eq!(fs::read_to_string(&file).unwrap().trim_end(), "restored");

    for (name, project, id) in [("a", &a, ida), ("b", &b, idb)] {
        let snap = project.documents.snapshot(id).unwrap();
        assert_eq!(snap.text.trim_end(), "restored", "project {name}");
        assert!(!snap.dirty, "project {name}");
        // A later save of the now-clean buffer must not bring the old edit back.
        project.documents.save(id).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap().trim_end(), "restored", "project {name}");
    }
}
