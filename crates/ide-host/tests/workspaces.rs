use ide_core::{ChangeSet, NullSink, RequestId, TextChange};
use ide_host::{Host, HostConfig, ops};
use ide_workspace::workspace::Workspace;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn linked_projects_share_navigation_but_keep_files_repositories_and_run_directories() {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let roots = vec![base.join("frontend"), base.join("backend")];
    for (index, root) in roots.iter().enumerate() {
        std::fs::create_dir(root).unwrap();
        assert!(std::process::Command::new("git").args(["init", "-q"]).current_dir(root).status().unwrap().success());
        std::fs::write(root.join("same.txt"), format!("shared needle {index}\n")).unwrap();
        std::fs::write(root.join("package.json"), r#"{"scripts":{"test":"echo test"}}"#).unwrap();
    }
    let root = base.join("workspace");
    Workspace::save(&root, "Full stack", vec![roots[0].clone()], true).unwrap();
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
    std::fs::write(root.join("internal-needle.txt"), "needle").unwrap();
    host.trust.decide(&root, true, false).unwrap();
    let project = host.open_project("main", &root).unwrap();
    assert_eq!(ops::project::info(&project).name, "Full stack");
    assert_eq!(ops::project::attach_workspace(&host, "main", &roots[1]).unwrap().as_ref(), root.as_path());
    ops::project::attach_workspace(&host, "main", &roots[1]).unwrap();
    assert_eq!(project.content_roots(), roots);
    assert!(project.index.wait_idle(Duration::from_secs(10)));
    assert!(project.index.find_files("internal-needle", 100).is_empty());
    assert!(project.index.find_files("workspace.json", 100).is_empty());
    assert_eq!(project.index.find_files("same.txt", 100).len(), 2);
    for _ in 0..500 {
        if project.repos().all().len() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(project.repos().all().len(), 2);
    let configs = ops::run::configs(&host, "main").unwrap();
    for member in &roots {
        assert!(configs.iter().any(|c| c.cwd.as_ref().is_some_and(|cwd| &**cwd == member)));
    }
    let mut ids = configs.iter().map(|c| c.id.clone()).collect::<Vec<_>>();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), configs.len());
    let a = ops::doc::open(&host, "main", roots[0].join("same.txt")).await.unwrap();
    let b = ops::doc::open(&host, "main", roots[1].join("same.txt")).await.unwrap();
    assert_ne!(a.id, b.id);
    ops::doc::edit(
        &host,
        "main",
        a.id,
        a.version,
        ChangeSet { changes: vec![TextChange { from: 0, to: 0, insert: "unsaved ".into() }] },
    )
    .unwrap();
    let hits = Arc::new(Mutex::new(Vec::new()));
    let out = hits.clone();
    let query = serde_json::from_value(serde_json::json!({"pattern":"needle", "isRegex":false, "caseSensitive":false,"wholeWord":false,"include":[],"exclude":[],"scope":{"kind":"project"},"maxMatches":100})).unwrap();
    ops::search::start(
        &host,
        "main",
        RequestId::next(),
        query,
        Arc::new(move |event| {
            if let ops::search::SearchEvent::File { file } = event {
                out.lock().unwrap().push(file);
            }
        }),
    )
    .await
    .unwrap();
    assert_eq!(hits.lock().unwrap().len(), 2);
    let found = hits.lock().unwrap().iter().map(|f| f.rel_path.clone()).collect::<Vec<_>>();
    assert!(found.contains(&"frontend/same.txt".to_owned()));
    assert!(found.contains(&"backend/same.txt".to_owned()));
    let updated = ops::project::save_workspace(&host, "main", "Frontend", vec![roots[0].clone()]).unwrap();
    assert_eq!(updated.workspace.unwrap().projects, vec![roots[0].clone()]);
    assert_eq!(project.content_roots(), vec![roots[0].clone()]);
    assert!(project.documents.text_of(&roots[0].join("same.txt")).unwrap().starts_with("unsaved"));
    assert!(roots[1].join("same.txt").exists());
    assert!(!roots[1].join(".openidea").exists());
    let invalid = base.join("invalid");
    std::fs::create_dir_all(invalid.join(".openidea")).unwrap();
    std::fs::write(invalid.join(ide_workspace::workspace::FILE), "broken").unwrap();
    assert!(host.open_project("main", &invalid).is_err());
    assert!(Arc::ptr_eq(&host.project("main").unwrap(), &project));
    host.open_project("main", &roots[0]).unwrap();
    let automatic = ops::project::attach_workspace(&host, "main", &roots[1]).unwrap();
    assert_eq!(host.project("main").unwrap().root, roots[0]);
    let automatic = host.open_project("main", &automatic).unwrap();
    assert_eq!(automatic.content_roots(), roots);
    assert_eq!(ops::project::info(&automatic).name, "frontend");
    assert!(automatic.root.starts_with(base.join("data/workspaces")));
    assert!(automatic.index.wait_idle(Duration::from_secs(10)));
    assert!(automatic.index.find_files("workspace.json", 100).is_empty());
    let updated = ops::project::save_workspace(&host, "main", "frontend", vec![roots[1].clone()]).unwrap();
    assert_eq!(updated.workspace.unwrap().projects, vec![roots[1].clone()]);
    assert_eq!(automatic.root, updated.root.as_ref());
    assert!(automatic.index.wait_idle(Duration::from_secs(10)));
    assert_eq!(automatic.index.find_files("same.txt", 100).len(), 1);
    host.close_project("main");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn php_language_level_follows_the_member_of_the_file() {
    use ide_sdk::php::{PhpLanguageLevel, PhpLevelSource};
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let (api, legacy) = (base.join("api"), base.join("legacy"));
    for (member, composer) in [
        (&api, r#"{"require": {"php": "^7.4"}}"#),
        (&legacy, r#"{"require": {"php": "^7.4"}, "config": {"platform": {"php": "8.0.5"}}}"#),
    ] {
        std::fs::create_dir(member).unwrap();
        std::fs::write(member.join("composer.json"), composer).unwrap();
    }
    let root = base.join("workspace");
    Workspace::save(&root, "PHP", vec![api.clone(), legacy.clone()], true).unwrap();
    std::fs::write(root.join("composer.json"), r#"{"require": {"php": "^8.2"}}"#).unwrap();
    let config_dir = base.join("config");
    ide_workspace::SettingsStore::load(&config_dir, Some(&legacy))
        .set(ide_workspace::SettingsScope::Project, "languages.php.languageLevel", "8.3".into())
        .unwrap();
    let host = Host::new(HostConfig {
        config_dir,
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    });
    host.trust.decide(&root, true, false).unwrap();
    host.open_project("main", &root).unwrap();
    let found = |version: &str, source| Some(PhpLanguageLevel { version: version.into(), source });
    let level = async |path: std::path::PathBuf| ops::sdk::sdk_php_language_level(&host, "main", path).await.unwrap();

    let level_of_api = level(api.join("src/Invoice.php")).await;
    assert_eq!(level_of_api.effective, found("7.4.0", PhpLevelSource::Require));
    assert_eq!(level_of_api.auto, level_of_api.effective);
    assert_eq!(level_of_api.member.as_deref(), Some(api.as_path()));
    // The member's own settings, not the workspace's.
    let level_of_legacy = level(legacy.join("index.php")).await;
    assert_eq!(level_of_legacy.effective, found("8.3.0", PhpLevelSource::Settings));
    assert_eq!(level_of_legacy.auto, found("8.0.5", PhpLevelSource::Platform));
    // Outside every member: the workspace's own.
    let level_elsewhere = level(base.join("elsewhere.php")).await;
    assert_eq!(level_elsewhere.effective, found("8.2.0", PhpLevelSource::Require));
    assert_eq!(level_elsewhere.member, None);
    host.close_project("main");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn clipcode_still_works_after_a_workspace_member_folder_is_deleted() {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let (a, b) = (base.join("a"), base.join("b"));
    for dir in [&a, &b] {
        std::fs::create_dir(dir).unwrap();
        std::fs::write(dir.join("x.txt"), "x\n").unwrap();
    }
    let root = base.join("workspace");
    Workspace::save(&root, "Pair", vec![a.clone(), b.clone()], true).unwrap();
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
    host.trust.decide(&root, true, false).unwrap();
    host.open_project("main", &root).unwrap();
    std::fs::remove_dir_all(&b).unwrap();

    let copied = ops::clip::clip_copy(&host, "main", ops::clip::ClipCopySource::Files { paths: vec![a.join("x.txt")] })
        .await
        .unwrap();
    assert!(copied.text.contains("x\n"), "{}", copied.text);
    let preview =
        ops::clip::clip_paste_preview(&host, "main", copied.text, None, None, false, Vec::new()).await.unwrap();
    assert_eq!(preview.files.len(), 1, "{:?}", preview.files);
}

/// A payload path labelled for a member that no longer exists must not fall through to the
/// workspace root: `b/x.txt` of the missing sibling member `b` would write or delete
/// `<workspace>/b/x.txt`, an unrelated file. A missing member under the workspace root resolves
/// to the same place either way and keeps working.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_deleted_workspace_members_label_does_not_resolve_into_the_workspace_root() {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let root = base.join("workspace");
    let (a, b, c) = (base.join("a"), base.join("b"), root.join("c"));
    for dir in [&a, &b, &c] {
        std::fs::create_dir_all(dir).unwrap();
    }
    Workspace::save(&root, "Trio", vec![a.clone(), b.clone(), c.clone()], true).unwrap();
    std::fs::create_dir_all(root.join("b")).unwrap();
    let unrelated = root.join("b").join("x.txt");
    std::fs::write(&unrelated, "unrelated\n").unwrap();
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
    host.trust.decide(&root, true, false).unwrap();
    host.open_project("main", &root).unwrap();
    std::fs::remove_dir_all(&b).unwrap();
    std::fs::remove_dir_all(&c).unwrap();

    let unrelated = unrelated.to_string_lossy().into_owned();
    for text in ["// file: b/x.txt\nhacked\n", "// file: [DELETED] b/x.txt\n"] {
        for adjust_paths in [false, true] {
            let preview =
                ops::clip::clip_paste_preview(&host, "main", text.into(), None, None, adjust_paths, Vec::new())
                    .await
                    .unwrap();
            assert_eq!(preview.files.len(), 1, "{:?}", preview.files);
            let file = &preview.files[0];
            assert_ne!(file.target.as_deref(), Some(unrelated.as_str()), "{text:?} adjust={adjust_paths}: {file:?}");
            assert_eq!(file.action, "skip", "{text:?} adjust={adjust_paths}: {file:?}");
        }
    }

    let preview =
        ops::clip::clip_paste_preview(&host, "main", "// file: c/y.txt\ny\n".into(), None, None, false, Vec::new())
            .await
            .unwrap();
    let expected = root.join("c").join("y.txt").to_string_lossy().into_owned();
    assert_eq!(preview.files.len(), 1, "{:?}", preview.files);
    assert_eq!(preview.files[0].target.as_deref(), Some(expected.as_str()), "{:?}", preview.files);
    assert_eq!(preview.files[0].action, "create", "{:?}", preview.files);
    host.close_project("main");
}
