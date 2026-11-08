//! Non-text files carried as Base64 through the export and import engines
//! (`docs/clipcode/non-text-files.md`, required test cases 7, 9, 10 and 11).

use std::fs;
use std::path::PathBuf;
use std::process::Command;

use ide_clip::format::{BuildPayloadOptions, ChangeType, PayloadFile, build_git_payload, build_payload};
use ide_clip::gitsrc::UNREADABLE_FILE_MARKER;
use ide_clip::nontext::{self, NonTextFound};
use ide_clip::restore::RestoreSelection;
use ide_clip::settings::{NonTextMode, Settings};
use ide_clip::transfer::{
    CLIPBOARD_PAYLOAD_MAX, CanonicalRootId, ExportItem, ExportPlan, ExportSelection, ImportMapping, SourceKind,
    plan_export, plan_import,
};

struct Repo {
    _dir: tempfile::TempDir,
    root: PathBuf,
    cfg: PathBuf,
}

impl Repo {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let cfg = dir.path().join("empty.gitconfig");
        fs::write(&cfg, "").unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap().join("repo");
        fs::create_dir_all(&root).unwrap();
        let repo = Self { _dir: dir, root, cfg };
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.name", "T"]);
        repo.git(&["config", "user.email", "t@example.com"]);
        repo.git(&["config", "core.autocrlf", "false"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        repo
    }

    fn git(&self, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(args)
            .current_dir(&self.root)
            .env("GIT_CONFIG_GLOBAL", &self.cfg)
            .env("LC_ALL", "C")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn write(&self, rel: &str, bytes: &[u8]) {
        let p = self.root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, bytes).unwrap();
    }

    fn id(&self) -> CanonicalRootId {
        CanonicalRootId::new(&self.root).unwrap()
    }

    fn selection(&self, items: &[(&str, SourceKind, Option<ChangeType>)]) -> ExportSelection {
        let items = items
            .iter()
            .map(|(rel, source, change_type)| ExportItem {
                root: self.id(),
                relative_path: (*rel).into(),
                source: source.clone(),
                change_type: *change_type,
                gitlink: false,
            })
            .collect();
        ExportSelection::new(vec![self.root.clone()], Some(self.root.clone()), items).unwrap()
    }
}

fn png(len: usize) -> Vec<u8> {
    let mut b = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00];
    b.extend((0..len.saturating_sub(b.len())).map(|i| (i * 13 % 256) as u8));
    b.truncate(len);
    b
}

const BIG5: &[u8] = &[0xa4, 0xe9, 0xa5, 0xbb, 0x0a];

/// 1 KB text limit, 2 KB non-text limit.
fn small_limits() -> Settings {
    Settings { max_file_size_kb: 1.0, max_non_text_file_size_kb: 2.0, set_max_file_count: false, ..Settings::default() }
}

fn export(sel: &ExportSelection, settings: &Settings, mode: NonTextMode) -> ExportPlan {
    plan_export(&sel.clone().with_non_text(mode), settings, Some(CLIPBOARD_PAYLOAD_MAX)).unwrap()
}

fn text(path: &str, content: &str) -> PayloadFile {
    PayloadFile { path: path.into(), content: Some(content.into()), ..Default::default() }
}

fn size_skip(path: &str, size: usize) -> PayloadFile {
    PayloadFile {
        path: path.into(),
        skipped_reason: Some(format!("size exceeds limit ({size} bytes)")),
        ..Default::default()
    }
}

fn payload(settings: &Settings, source_root: &str, files: Vec<PayloadFile>) -> String {
    build_payload(&BuildPayloadOptions {
        header_format: settings.header_format.clone(),
        pre_text: settings.pre_text.clone(),
        post_text: settings.post_text.clone(),
        add_extra_line_between_files: settings.add_extra_line_between_files,
        files,
        source_root: Some(source_root.into()),
    })
}

fn found(path: &str, size: usize) -> NonTextFound {
    NonTextFound { path: path.into(), size: size as u64 }
}

/// Picked files: text, in-limit non-text, a 1-byte NUL file, text and
/// non-text between the two limits, and a file over both.
fn picked_files(repo: &Repo) -> ExportSelection {
    repo.write("a.ts", b"export const a = 1;\n");
    repo.write("img/logo.png", &png(300));
    repo.write("legacy/big5.txt", BIG5);
    repo.write("nul.bin", &[0]);
    repo.write("mid.json", "x".repeat(1500).as_bytes());
    repo.write("img/mid.png", &png(1500));
    repo.write("img/huge.png", &png(3000));
    let items: Vec<_> =
        ["a.ts", "img/logo.png", "legacy/big5.txt", "nul.bin", "mid.json", "img/mid.png", "img/huge.png"]
            .into_iter()
            .map(|p| (p, SourceKind::File, None))
            .collect();
    repo.selection(&items)
}

/// Test 11: Exclude is today's payload byte for byte.
#[test]
fn exclude_writes_todays_payload_and_reports_what_include_adds() {
    let repo = Repo::new();
    let settings = small_limits();
    let sel = picked_files(&repo);
    let default_plan = plan_export(&sel, &settings, Some(CLIPBOARD_PAYLOAD_MAX)).unwrap();
    let exclude = export(&sel, &settings, NonTextMode::Exclude);
    // Today: non-text files within the text limit are dropped, everything
    // over it is a size placeholder, read or not.
    let today = payload(
        &settings,
        "repo",
        vec![
            text("a.ts", "export const a = 1;\n"),
            size_skip("mid.json", 1500),
            size_skip("img/mid.png", 1500),
            size_skip("img/huge.png", 3000),
        ],
    );
    assert_eq!(exclude.payload, today);
    assert_eq!(default_plan.payload, today);
    assert_eq!(default_plan.non_text, exclude.non_text);
    assert_eq!(
        (exclude.copied_file_count, exclude.skipped_file_size_count, exclude.skipped_unreadable_count),
        (1, 3, 3)
    );
    assert_eq!(exclude.non_text_file_count, 0);
    assert!(exclude.files.iter().all(|f| f.non_text.is_none()));

    let summary = &exclude.non_text;
    assert_eq!(
        summary.files,
        [found("img/logo.png", 300), found("legacy/big5.txt", 5), found("nul.bin", 1), found("img/mid.png", 1500)]
    );
    assert_eq!(summary.count(), 4);
    assert_eq!(summary.total_bytes, 300 + 5 + 1 + 1500);
    // `img/huge.png` was never read: over both limits it stays a size placeholder.
    assert_eq!(summary.over_limit_count, 0);

    let include = export(&sel, &settings, NonTextMode::Include);
    assert_eq!(summary.estimated_include_payload_bytes, include.payload.len());
    assert_eq!(include.non_text.files, summary.files);
    assert_eq!(include.non_text.estimated_include_payload_bytes, include.payload.len());
}

/// Test 7: each file is held to its own limit after classification.
#[test]
fn include_carries_non_text_within_its_limit_and_round_trips() {
    let repo = Repo::new();
    let settings = small_limits();
    let sel = picked_files(&repo);
    let plan = export(&sel, &settings, NonTextMode::Include);
    let bytes = |rel: &str| fs::read(repo.root.join(rel)).unwrap();
    let non_text = |path: &str| PayloadFile { path: path.into(), non_text: Some(bytes(path)), ..Default::default() };
    let expected = payload(
        &settings,
        "repo",
        vec![
            text("a.ts", "export const a = 1;\n"),
            non_text("img/logo.png"),
            non_text("legacy/big5.txt"),
            non_text("nul.bin"),
            // 1500 B of text is over the 1 KB text limit; 1500 B of PNG fits the 2 KB one.
            size_skip("mid.json", 1500),
            non_text("img/mid.png"),
            size_skip("img/huge.png", 3000),
        ],
    );
    assert_eq!(plan.payload, expected);
    assert_eq!((plan.copied_file_count, plan.non_text_file_count, plan.skipped_file_size_count), (5, 4, 2));
    assert_eq!(plan.skipped_unreadable_count, 0);
    assert!(plan.payload.contains(&nontext::placeholder_line(1500, &nontext::sha256_hex(&bytes("img/mid.png")))));

    // Paste it into an empty folder: every non-text file lands byte for byte.
    let dest_dir = tempfile::tempdir().unwrap();
    let dest = dunce::canonicalize(dest_dir.path()).unwrap();
    let import = plan_import(
        &plan.payload,
        &settings.header_format,
        std::slice::from_ref(&dest),
        &ImportMapping::with_primary(CanonicalRootId::new(&dest).unwrap()),
    )
    .unwrap();
    let r = import.apply(&RestoreSelection::default()).unwrap();
    assert_eq!(r.created_count, 5);
    // (A text body loses its trailing newline on paste, as it always has.)
    for rel in ["img/logo.png", "legacy/big5.txt", "nul.bin", "img/mid.png"] {
        assert_eq!(fs::read(dest.join(rel)).unwrap(), bytes(rel), "{rel}");
    }
    assert!(!dest.join("mid.json").exists() && !dest.join("img/huge.png").exists());
}

#[test]
fn non_text_over_its_own_limit_is_a_size_placeholder() {
    let repo = Repo::new();
    // A non-text limit below the text one.
    let settings = Settings { max_file_size_kb: 4.0, max_non_text_file_size_kb: 1.0, ..small_limits() };
    repo.write("a.ts", b"a\n");
    repo.write("img/two.png", &png(2000));
    let sel = repo.selection(&[("a.ts", SourceKind::File, None), ("img/two.png", SourceKind::File, None)]);

    let include = export(&sel, &settings, NonTextMode::Include);
    assert_eq!(include.payload, payload(&settings, "repo", vec![text("a.ts", "a\n"), size_skip("img/two.png", 2000)]));
    assert_eq!(include.skipped_file_size_count, 1);

    let exclude = export(&sel, &settings, NonTextMode::Exclude);
    assert_eq!(exclude.payload, payload(&settings, "repo", vec![text("a.ts", "a\n")]));
    assert_eq!(exclude.non_text.count(), 0);
    assert_eq!(exclude.non_text.over_limit_count, 1);
    assert_eq!(exclude.non_text.estimated_include_payload_bytes, include.payload.len());
}

/// Staged, committed and working-tree changes read through Git blobs or the
/// disk get the same rules as picked files.
#[test]
fn git_sources_carry_non_text_under_include_only() {
    let repo = Repo::new();
    let settings = small_limits();
    repo.write("base.txt", b"base\n");
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "-m", "base"]);
    repo.write("img/commit.png", &png(400));
    repo.write("img/commit-over.png", &png(5000));
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "-m", "images"]);
    let head = repo.git(&["rev-parse", "HEAD"]);
    repo.write("img/staged.png", &png(200));
    repo.git(&["add", "img/staged.png"]);
    repo.write("img/work.png", &png(1500));
    repo.write("notes.txt", b"note\n");

    let new = Some(ChangeType::New);
    let commit = SourceKind::Commit { rev: head };
    let items = [
        ("img/commit.png", commit.clone(), new),
        ("img/commit-over.png", commit, new),
        ("img/staged.png", SourceKind::Staged, new),
        ("img/work.png", SourceKind::Working, new),
        ("notes.txt", SourceKind::Working, new),
    ];
    let sel = repo.selection(&items);

    let exclude = export(&sel, &settings, NonTextMode::Exclude);
    let labelled = |mut f: PayloadFile| {
        f.change_type = new;
        f
    };
    // Today: committed and working non-text files are dropped; a staged one
    // is the unreadable marker.
    let today = build_git_payload(&BuildPayloadOptions {
        header_format: settings.header_format.clone(),
        add_extra_line_between_files: true,
        files: vec![labelled(text("img/staged.png", UNREADABLE_FILE_MARKER)), labelled(text("notes.txt", "note\n"))],
        source_root: Some("repo".into()),
        ..Default::default()
    });
    assert_eq!(exclude.payload, today);
    assert_eq!(
        exclude.non_text.files,
        [found("img/commit.png", 400), found("img/staged.png", 200), found("img/work.png", 1500)]
    );
    assert_eq!(exclude.non_text.over_limit_count, 1);

    let include = export(&sel, &settings, NonTextMode::Include);
    let bytes = |rel: &str| fs::read(repo.root.join(rel)).unwrap();
    let non_text =
        |path: &str| labelled(PayloadFile { path: path.into(), non_text: Some(bytes(path)), ..Default::default() });
    let expected = build_git_payload(&BuildPayloadOptions {
        header_format: settings.header_format.clone(),
        add_extra_line_between_files: true,
        files: vec![
            non_text("img/commit.png"),
            labelled(size_skip("img/commit-over.png", 5000)),
            non_text("img/staged.png"),
            non_text("img/work.png"),
            labelled(text("notes.txt", "note\n")),
        ],
        source_root: Some("repo".into()),
        ..Default::default()
    });
    assert_eq!(include.payload, expected);
    assert_eq!(include.non_text_file_count, 3);
    assert_eq!(exclude.non_text.estimated_include_payload_bytes, include.payload.len());
}

/// Test 9 through the import engine: identical target unchanged, different
/// target follows the overwrite option.
#[test]
fn import_reports_identical_targets_unchanged() {
    let repo = Repo::new();
    let settings = small_limits();
    repo.write("same.png", &png(100));
    repo.write("diff.png", &png(120));
    let sel = repo.selection(&[("same.png", SourceKind::File, None), ("diff.png", SourceKind::File, None)]);
    let plan = export(&sel, &settings, NonTextMode::Include);

    let run = |overwrite: bool| {
        let dest_dir = tempfile::tempdir().unwrap();
        let dest = dunce::canonicalize(dest_dir.path()).unwrap();
        fs::write(dest.join("same.png"), png(100)).unwrap();
        fs::write(dest.join("diff.png"), b"old").unwrap();
        let import = plan_import(
            &plan.payload,
            &settings.header_format,
            std::slice::from_ref(&dest),
            &ImportMapping::with_primary(CanonicalRootId::new(&dest).unwrap()),
        )
        .unwrap();
        let identical: Vec<_> = import.create_operations().iter().map(|o| o.is_identical()).collect();
        assert_eq!(identical, [true, false]);
        assert_eq!(import.restore_plan().existing_targets(), 1);
        let r = import.apply(&RestoreSelection { overwrite_existing: overwrite, ..Default::default() }).unwrap();
        (r.unchanged_count, r.overwritten_count, r.skipped_existing_count, fs::read(dest.join("diff.png")).unwrap())
    };
    assert_eq!(run(false), (1, 0, 1, b"old".to_vec()));
    assert_eq!(run(true), (1, 1, 0, png(120)));
}
