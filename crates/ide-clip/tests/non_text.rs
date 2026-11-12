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
        // Repo-local, so the product's own git (no GIT_CONFIG_GLOBAL) sees it too. Written directly instead
        // of four `git config` processes: the fuzz test builds 120 repos, and spawns are slow on Windows.
        let mut local = fs::OpenOptions::new().append(true).open(repo.root.join(".git").join("config")).unwrap();
        std::io::Write::write_all(
            &mut local,
            b"[user]\n\tname = T\n\temail = t@example.com\n[core]\n\tautocrlf = false\n[commit]\n\tgpgsign = false\n",
        )
        .unwrap();
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
    repo.write("nul0.bin", &[0]);
    repo.write("mid.json", "x".repeat(1500).as_bytes());
    repo.write("img/mid.png", &png(1500));
    repo.write("img/huge.png", &png(3000));
    let items: Vec<_> =
        ["a.ts", "img/logo.png", "legacy/big5.txt", "nul0.bin", "mid.json", "img/mid.png", "img/huge.png"]
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
        [found("img/logo.png", 300), found("legacy/big5.txt", 5), found("nul0.bin", 1), found("img/mid.png", 1500)]
    );
    assert_eq!(summary.count(), 4);
    assert_eq!(summary.total_bytes, 300 + 5 + 1 + 1500);
    // `img/huge.png` was never read: over both limits it stays a size placeholder.
    assert_eq!(summary.over_limit_count, 0);
    assert_eq!((summary.unread_over_limit_count, summary.unread_limit_bytes), (1, 2048));

    let include = export(&sel, &settings, NonTextMode::Include);
    assert_eq!(summary.estimated_include_payload_bytes, include.payload.len());
    assert_eq!(include.non_text.files, summary.files);
    assert_eq!(include.non_text.estimated_include_payload_bytes, include.payload.len());
}

fn limited(n: f64) -> Settings {
    Settings { set_max_file_count: true, file_count_limit: n, ..small_limits() }
}

/// Test 15: the dialog describes what Include copies after the file-count limit.
#[test]
fn the_summary_describes_the_include_payload_after_the_file_count_limit() {
    let settings = limited(30.0);
    // 40 images, limit 30.
    let repo = Repo::new();
    let files: Vec<(String, Vec<u8>)> = (0..40).map(|i| (format!("img/i{i:02}.png"), png(100 + i))).collect();
    for (p, b) in &files {
        repo.write(p, b);
    }
    let items: Vec<(&str, SourceKind, Option<ChangeType>)> =
        files.iter().map(|(p, _)| (p.as_str(), SourceKind::File, None)).collect();
    let sel = repo.selection(&items);
    let exclude = export(&sel, &settings, NonTextMode::Exclude);
    let include = export(&sel, &settings, NonTextMode::Include);
    assert_eq!(include.non_text_file_count, 30);
    assert_eq!(exclude.non_text.count(), 30);
    assert_eq!(exclude.non_text.files, include.non_text.files);
    assert_eq!(exclude.non_text.total_bytes, include.non_text.total_bytes);
    assert_eq!(exclude.non_text.estimated_include_payload_bytes, include.payload.len());
    assert_eq!((exclude.non_text.limit_left_out, include.non_text.limit_left_out), (10, 10));

    // 28 text files, 5 images, 2 text files: Include carries the first two images.
    let repo = Repo::new();
    let mut items: Vec<String> = (0..28).map(|i| format!("a{i:02}.txt")).collect();
    items.extend((0..5).map(|i| format!("img/i{i}.png")));
    items.extend((0..2).map(|i| format!("z{i}.txt")));
    for p in &items {
        repo.write(p, &if p.ends_with(".png") { png(200) } else { b"text\n".to_vec() });
    }
    let list: Vec<(&str, SourceKind, Option<ChangeType>)> =
        items.iter().map(|p| (p.as_str(), SourceKind::File, None)).collect();
    let sel = repo.selection(&list);
    let exclude = export(&sel, &settings, NonTextMode::Exclude);
    let include = export(&sel, &settings, NonTextMode::Include);
    assert_eq!(exclude.non_text.count(), 2);
    assert_eq!(exclude.non_text.estimated_include_payload_bytes, include.payload.len());
    assert_eq!(exclude.non_text.limit_left_out, 5);
    assert_eq!(include.non_text.files, exclude.non_text.files);
    // Exclude's own payload is today's: all 30 text files.
    assert_eq!(exclude.copied_file_count, 30);

    // 30 text files then 5 images: neither mode reaches the images.
    let repo = Repo::new();
    let mut items: Vec<String> = (0..30).map(|i| format!("a{i:02}.txt")).collect();
    items.extend((0..5).map(|i| format!("img/i{i}.png")));
    for p in &items {
        repo.write(p, &if p.ends_with(".png") { png(200) } else { b"text\n".to_vec() });
    }
    let list: Vec<(&str, SourceKind, Option<ChangeType>)> =
        items.iter().map(|p| (p.as_str(), SourceKind::File, None)).collect();
    let sel = repo.selection(&list);
    let exclude = export(&sel, &settings, NonTextMode::Exclude);
    let include = export(&sel, &settings, NonTextMode::Include);
    assert_eq!(exclude.non_text.count(), 0);
    assert_eq!(exclude.non_text.limit_left_out, 5);
    assert_eq!(exclude.payload, include.payload);
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
            non_text("nul0.bin"),
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
    for rel in ["img/logo.png", "legacy/big5.txt", "nul0.bin", "img/mid.png"] {
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
    // It was read to be classified: over its own limit, not unread.
    assert_eq!(exclude.non_text.unread_over_limit_count, 0);
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
    // An excluded staged non-text file is not named as unreadable.
    assert!(exclude.skipped_unreadable_paths.is_empty(), "{:?}", exclude.skipped_unreadable_paths);

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

/// Test 12: a text file whose first line looks like a non-text placeholder restores as that text.
#[test]
fn placeholder_shaped_text_round_trips_through_the_app_import_path() {
    let fake = "// File skipped: non-text file, 3 bytes, sha256 039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81; base64 follows\nAQID\n";
    let settings = small_limits();
    let repo = Repo::new();
    repo.write("fake.txt", fake.as_bytes());
    let sel = repo.selection(&[("fake.txt", SourceKind::File, None)]);
    let plan = export(&sel, &settings, NonTextMode::Include);
    assert!(plan.payload.contains("//clipcode-esc: // File skipped: non-text file, 3 bytes"), "{}", plan.payload);
    assert_eq!(plan.non_text.count(), 0);

    let dest_dir = tempfile::tempdir().unwrap();
    let dest = dunce::canonicalize(dest_dir.path()).unwrap();
    let import = plan_import(
        &plan.payload,
        &settings.header_format,
        std::slice::from_ref(&dest),
        &ImportMapping::with_primary(CanonicalRootId::new(&dest).unwrap()),
    )
    .unwrap();
    assert_eq!(import.create_operations().len(), 1);
    assert!(import.create_operations()[0].non_text_size().is_none());
    import.apply(&RestoreSelection::default()).unwrap();
    assert_eq!(fs::read_to_string(dest.join("fake.txt")).unwrap().trim_end(), fake.trim_end());
}

/// The same with a whitespace-only first line that the header format matches (so it is escaped and kept): the
/// placeholder-shaped line after it still restores as written, not with a stray escape and not skipped.
#[test]
fn placeholder_shaped_text_after_an_escaped_blank_line_round_trips() {
    let fake = "   \n// File skipped: non-text file, 3 bytes, sha256 039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81; base64 follows\nAQID\n";
    let settings = Settings { header_format: " $FILE_PATH".into(), ..small_limits() };
    let repo = Repo::new();
    repo.write("fake.txt", fake.as_bytes());
    let sel = repo.selection(&[("fake.txt", SourceKind::File, None)]);
    let plan = export(&sel, &settings, NonTextMode::Include);
    assert_eq!(plan.non_text.count(), 0);

    let dest_dir = tempfile::tempdir().unwrap();
    let dest = dunce::canonicalize(dest_dir.path()).unwrap();
    let import = plan_import(
        &plan.payload,
        &settings.header_format,
        std::slice::from_ref(&dest),
        &ImportMapping::with_primary(CanonicalRootId::new(&dest).unwrap()),
    )
    .unwrap();
    assert_eq!(import.create_operations().len(), 1, "{}", plan.payload);
    assert!(import.create_operations()[0].non_text_size().is_none());
    import.apply(&RestoreSelection::default()).unwrap();
    assert_eq!(fs::read_to_string(dest.join("fake.txt")).unwrap().trim_end(), fake.trim_end());
}

/// The unescapable-`headerFormat` check guards exactly what Include writes: for every format it lets through, a
/// payload of non-text files whose placeholder and Base64 lines take every shape (`AA==`, `////`, `+/8=`, full
/// 76-character lines) parses back to the same entries and bytes. Before the fix, `//$FILE_PATH` turned the
/// placeholder into a header and `$FILE_PATH==` turned `AA==` into one, while the check said both were fine.
#[test]
fn every_header_format_include_allows_round_trips_non_text_lines() {
    use ide_clip::format::{header_format_unescapable, parse_clipboard};
    let blobs: Vec<(String, Vec<u8>)> = [
        vec![0x00],
        vec![0xFF; 3],
        vec![0xFB, 0xFF],
        vec![0xFF; 57],
        (0..=255u8).cycle().take(300).collect(),
        png(200),
    ]
    .into_iter()
    .enumerate()
    .map(|(i, b)| (format!("d/b{i}.bin"), b))
    .collect();
    let formats = [
        "// file: $FILE_PATH",
        "// $FILE_PATH",
        "A$FILE_PATH",
        "#$FILE_PATH",
        "### $FILE_PATH",
        "$FILE_PATH.md",
        "-- $FILE_PATH --",
        "$FILE_PATH",
        "$FILE_PATH=",
        "$FILE_PATH==",
        "$FILE_PATH/",
        "$FILE_PATHQ",
        "$FILE_PATH follows",
        "/$FILE_PATH",
        "//$FILE_PATH",
        "//c$FILE_PATH",
        "//clipcode-esc$FILE_PATH",
        "$FILE_PATH$FILE_PATH",
        "/$FILE_PATH/$FILE_PATH",
    ];
    let mut allowed = 0;
    for format in formats {
        if header_format_unescapable(format) {
            continue;
        }
        allowed += 1;
        for extra in [false, true] {
            let mut files: Vec<PayloadFile> = blobs
                .iter()
                .map(|(p, b)| PayloadFile { path: p.clone(), non_text: Some(b.clone()), ..Default::default() })
                .collect();
            files.push(text("d/z.txt", "last\n"));
            let payload = build_payload(&BuildPayloadOptions {
                header_format: format.into(),
                add_extra_line_between_files: extra,
                files,
                ..Default::default()
            });
            let entries = parse_clipboard(&payload, format);
            let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
            let mut want: Vec<&str> = blobs.iter().map(|(p, _)| p.as_str()).collect();
            want.push("d/z.txt");
            assert_eq!(paths, want, "{format:?} (extra line {extra}):\n{payload}");
            for (entry, (path, bytes)) in entries.iter().zip(&blobs) {
                assert_eq!(nontext::parse_body(&entry.content), Some(Ok(bytes.clone())), "{format:?}: {path}");
            }
            assert_eq!(entries.last().unwrap().content, "last", "{format:?}");
        }
    }
    assert!(allowed >= 7, "the corpus must keep formats Include allows");
}

/// Test 20: a target that is a directory skips only its row.
#[test]
fn a_directory_at_a_target_path_skips_only_that_row() {
    let repo = Repo::new();
    let settings = small_limits();
    repo.write("ok.txt", b"ok\n");
    repo.write("dir/x.png", &png(100));
    repo.write("img.png", &png(120));
    let sel = repo.selection(&[
        ("ok.txt", SourceKind::File, None),
        ("img.png", SourceKind::File, None),
        ("dir/x.png", SourceKind::File, None),
    ]);
    let plan = export(&sel, &settings, NonTextMode::Include);

    let dest_dir = tempfile::tempdir().unwrap();
    let dest = dunce::canonicalize(dest_dir.path()).unwrap();
    fs::create_dir_all(dest.join("dir/x.png")).unwrap();
    fs::create_dir_all(dest.join("img.png")).unwrap();
    let import = plan_import(
        &plan.payload,
        &settings.header_format,
        std::slice::from_ref(&dest),
        &ImportMapping::with_primary(CanonicalRootId::new(&dest).unwrap()),
    )
    .unwrap();
    let created: Vec<_> = import.create_operations().iter().map(|o| o.relative_path.as_str()).collect();
    assert_eq!(created, ["ok.txt"]);
    let skipped: Vec<_> = import
        .restore_plan()
        .skipped_operations
        .iter()
        .map(|s| (s.relative_path.clone().unwrap(), s.reason.as_str()))
        .collect();
    assert_eq!(skipped, [("img.png".to_string(), "TARGET_NOT_FILE"), ("dir/x.png".to_string(), "TARGET_NOT_FILE")]);
    import.apply(&RestoreSelection::default()).unwrap();
    assert_eq!(fs::read_to_string(dest.join("ok.txt")).unwrap().trim_end(), "ok");
    assert!(dest.join("img.png").is_dir());
}

// ---- commits mode (test 10) ----

mod commits_mode {
    use super::*;
    use ide_clip::commits::{
        CommitNonTextOptions, CommitsPayload, NotCopiedReason, ReplayAction, ReplaySkipReason, parse_commit_payload,
        to_clipboard_text,
    };
    use ide_clip::gitrun::RunOptions;
    use ide_clip::gitsrc::Git;
    use ide_clip::transfer::{
        CommitReplayPreview, ReplayFileSide, plan_commit_export_with, plan_commit_export_with_non_text,
        read_replay_preview_with,
    };
    use serde::Deserialize;

    fn options(mode: NonTextMode) -> CommitNonTextOptions {
        CommitNonTextOptions { mode, max_file_bytes: 2048 }
    }

    /// A repository whose last commit adds an image, a text file and an
    /// image over the 2 KB non-text limit.
    fn source() -> Repo {
        let repo = Repo::new();
        repo.write("base.txt", b"base\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-q", "-m", "base"]);
        repo.write("img/logo.png", &png(300));
        repo.write("a.txt", b"a\n");
        repo.write("img/huge.png", &png(5000));
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-q", "-m", "add images"]);
        repo
    }

    fn export(repo: &Repo, mode: NonTextMode) -> ide_clip::commits::CommitExport {
        let git = Git::open(&repo.root).unwrap();
        plan_commit_export_with_non_text(
            &git,
            None,
            Some(1),
            &RunOptions::default(),
            CLIPBOARD_PAYLOAD_MAX,
            options(mode),
        )
        .unwrap()
    }

    fn file<'a>(payload: &'a CommitsPayload, path: &str) -> &'a ide_clip::commits::CommitFile {
        payload.commits[0].files.iter().find(|f| f.path == path).unwrap()
    }

    #[test]
    fn exclude_is_todays_payload_and_reports_the_image() {
        let repo = source();
        let git = Git::open(&repo.root).unwrap();
        let today =
            plan_commit_export_with(&git, None, Some(1), &RunOptions::default(), CLIPBOARD_PAYLOAD_MAX).unwrap();
        let exclude = export(&repo, NonTextMode::Exclude);
        assert_eq!(exclude.text, today.text);
        assert!(!exclude.text.contains("nonText"));
        assert_eq!(exclude.non_text.files, [found("img/logo.png", 300)]);
        assert_eq!(exclude.non_text.over_limit_count, 1);

        let include = export(&repo, NonTextMode::Include);
        assert_eq!(exclude.non_text.estimated_include_payload_bytes, include.text.len());
        let logo = file(&include.payload, "img/logo.png");
        assert_eq!((logo.content.as_deref(), logo.not_copied), (None, Some(NotCopiedReason::Binary)));
        let nt = logo.non_text.as_ref().unwrap();
        assert_eq!((nt.size, nt.sha256.as_str()), (300, nontext::sha256_hex(&png(300)).as_str()));
        assert_eq!(nt.base64, nontext::encode(&png(300)));
        assert!(include.text.contains(r#""notCopied":"BINARY","nonText":{"size":300,"sha256":""#));
        // Over the limit: not copied, exactly as today.
        let huge = file(&include.payload, "img/huge.png");
        assert_eq!((huge.not_copied, huge.non_text.is_none()), (Some(NotCopiedReason::Binary), true));
        assert_eq!(include.text, to_clipboard_text(&include.payload));
    }

    #[test]
    fn replay_writes_and_commits_the_image() {
        let src = source();
        let include = export(&src, NonTextMode::Include);
        let payload = parse_commit_payload(&include.text).unwrap();

        let dest = Repo::new();
        dest.write("base.txt", b"base\n");
        dest.git(&["add", "-A"]);
        dest.git(&["commit", "-q", "-m", "base"]);
        let preview = CommitReplayPreview::capture(&dest.root, &payload).unwrap();
        let rows = &preview.plan().commits[0].files;
        let logo = rows.iter().position(|f| f.path == "img/logo.png").unwrap();
        assert_eq!(
            (rows[logo].action, rows[logo].non_text_size, rows[logo].not_copied),
            (ReplayAction::Write, Some(300), None)
        );
        let shown = preview
            .file_preview_with(0, logo, ReplayFileSide::Target, 1 << 20, &RunOptions::default(), |p, o| {
                read_replay_preview_with(p, 1 << 20, o)
            })
            .unwrap();
        assert_eq!(shown.unavailable, Some(ide_clip::commits::ReplayPreviewUnavailable::Binary));
        assert!(shown.after.is_empty());

        let result = preview.apply().unwrap();
        assert!(result.failure.is_none(), "{:?}", result.failure);
        assert_eq!(result.created.len(), 1);
        assert_eq!(fs::read(dest.root.join("img/logo.png")).unwrap(), png(300));
        assert!(!dest.root.join("img/huge.png").exists());
        let committed = Command::new("git")
            .args(["cat-file", "blob", "HEAD:img/logo.png"])
            .current_dir(&dest.root)
            .output()
            .unwrap()
            .stdout;
        assert_eq!(committed, png(300));
    }

    /// An older OpenIDEA ignores `nonText` (no `deny_unknown_fields`) and skips
    /// the file as not copied.
    #[test]
    fn an_older_reader_ignores_the_field_and_skips_the_file() {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        #[allow(dead_code)]
        struct OldFile {
            path: String,
            old_path: Option<String>,
            change: String,
            content: Option<String>,
            not_copied: Option<String>,
        }
        #[derive(Deserialize)]
        struct OldCommit {
            files: Vec<OldFile>,
        }
        #[derive(Deserialize)]
        struct OldPayload {
            commits: Vec<OldCommit>,
        }
        let src = source();
        let include = export(&src, NonTextMode::Include);
        let json = include.text.split_once('\n').unwrap().1;
        let old: OldPayload = serde_json::from_str(json).unwrap();
        let logo = old.commits[0].files.iter().find(|f| f.path == "img/logo.png").unwrap();
        assert_eq!((logo.content.as_deref(), logo.not_copied.as_deref()), (None, Some("BINARY")));

        // The same payload without the field is what an older reader holds.
        let mut payload = include.payload.clone();
        for f in &mut payload.commits[0].files {
            f.non_text = None;
        }
        let dest = Repo::new();
        let preview = CommitReplayPreview::capture(&dest.root, &payload).unwrap();
        let row = preview.plan().commits[0].files.iter().find(|f| f.path == "img/logo.png").unwrap();
        assert_eq!((row.action, row.skip_reason), (ReplayAction::Skip, Some(ReplaySkipReason::NotCopied)));
    }

    #[test]
    fn a_corrupt_non_text_field_skips_only_that_file() {
        let src = source();
        let mut payload = export(&src, NonTextMode::Include).payload;
        let logo = payload.commits[0].files.iter_mut().find(|f| f.path == "img/logo.png").unwrap();
        logo.non_text.as_mut().unwrap().sha256 = "0".repeat(64);
        let dest = Repo::new();
        dest.write("base.txt", b"base\n");
        dest.git(&["add", "-A"]);
        dest.git(&["commit", "-q", "-m", "base"]);
        let preview = CommitReplayPreview::capture(&dest.root, &payload).unwrap();
        let rows = &preview.plan().commits[0].files;
        let row = |p: &str| rows.iter().find(|f| f.path == p).unwrap();
        assert_eq!(row("img/logo.png").skip_reason, Some(ReplaySkipReason::CorruptNonText));
        assert_eq!(row("a.txt").action, ReplayAction::Write);
        let result = preview.apply().unwrap();
        assert!(result.failure.is_none(), "{:?}", result.failure);
        assert!(!dest.root.join("img/logo.png").exists());
        assert_eq!(fs::read(dest.root.join("a.txt")).unwrap(), b"a\n");
    }

    fn tree(repo: &Repo) -> String {
        repo.git(&["ls-tree", "-r", "HEAD"])
    }

    fn export_last(repo: &Repo, n: usize, mode: NonTextMode) -> ide_clip::commits::CommitExport {
        let git = Git::open(&repo.root).unwrap();
        plan_commit_export_with_non_text(
            &git,
            None,
            Some(n),
            &RunOptions::default(),
            CLIPBOARD_PAYLOAD_MAX,
            options(mode),
        )
        .unwrap()
    }

    /// Deleting a non-text file replays whatever the mode: the file must not stay behind.
    #[test]
    fn a_deleted_image_replays_as_a_deletion_in_either_mode() {
        for mode in [NonTextMode::Include, NonTextMode::Exclude] {
            let src = Repo::new();
            src.write("base.txt", b"base\n");
            src.git(&["add", "-A"]);
            src.git(&["commit", "-q", "-m", "base"]);
            let dest = Repo::new();
            dest.git(&["pull", "-q", src.root.to_str().unwrap(), "main"]);
            src.write("pics/x.png", &png(300));
            src.write("img/del.gif", &png(40));
            src.git(&["add", "-A"]);
            src.git(&["commit", "-q", "-m", "b1"]);
            src.write("pics/x.png", &png(310));
            src.git(&["add", "-A"]);
            src.git(&["commit", "-q", "-m", "b2"]);
            src.git(&["rm", "-q", "pics/x.png", "img/del.gif"]);
            src.git(&["commit", "-q", "-m", "b3"]);

            let export = export_last(&src, 3, mode);
            let deleted = &export.payload.commits[2].files;
            assert!(deleted.iter().all(|f| f.not_copied.is_none()), "{deleted:?}");
            assert_eq!(export.clone().outcome().not_copied.iter().filter(|(n, _)| *n == 2).count(), 0);
            let payload = parse_commit_payload(&export.text).unwrap();
            let preview = CommitReplayPreview::capture(&dest.root, &payload).unwrap();
            let result = preview.apply().unwrap();
            assert!(result.failure.is_none(), "{:?}", result.failure);
            // Excluded, the two commits that only add and change images have nothing to apply: they are not
            // created as empty commits and the deletion still replays.
            let (created, not_created) = if mode == NonTextMode::Include { (3, 0) } else { (1, 2) };
            assert_eq!((result.created.len(), result.not_created.len()), (created, not_created), "{mode:?}");
            assert_eq!(tree(&dest), tree(&src), "{mode:?}");
            assert!(!dest.root.join("pics/x.png").exists());
            assert!(!dest.root.join("img/del.gif").exists());
        }
    }

    /// A rename of an image moves it whatever the mode.
    #[test]
    fn a_renamed_image_moves_in_either_mode() {
        for mode in [NonTextMode::Include, NonTextMode::Exclude] {
            let src = Repo::new();
            src.write("pics/x.png", &png(300));
            src.write("keep.txt", b"k\n");
            src.git(&["add", "-A"]);
            src.git(&["commit", "-q", "-m", "base"]);
            let dest = Repo::new();
            dest.git(&["pull", "-q", src.root.to_str().unwrap(), "main"]);
            src.git(&["mv", "pics/x.png", "pics/y.png"]);
            src.git(&["commit", "-q", "-m", "rename"]);

            let export = export_last(&src, 1, mode);
            let payload = parse_commit_payload(&export.text).unwrap();
            let preview = CommitReplayPreview::capture(&dest.root, &payload).unwrap();
            let result = preview.apply().unwrap();
            assert!(result.failure.is_none(), "{:?}", result.failure);
            assert_eq!(tree(&dest), tree(&src), "{mode:?}");
            assert!(!dest.root.join("pics/x.png").exists());
            assert_eq!(fs::read(dest.root.join("pics/y.png")).unwrap(), png(300));
        }
    }

    /// A payload copied before this rule marks a deleted image as not copied; it is still deleted.
    #[test]
    fn a_deletion_marked_not_copied_by_an_older_copy_is_still_replayed() {
        let src = Repo::new();
        src.write("img/old.png", &png(30));
        src.git(&["add", "-A"]);
        src.git(&["commit", "-q", "-m", "base"]);
        src.git(&["rm", "-q", "img/old.png"]);
        src.git(&["commit", "-q", "-m", "del"]);
        let mut payload = export_last(&src, 1, NonTextMode::Exclude).payload;
        payload.commits[0].files[0].not_copied = Some(NotCopiedReason::Binary);
        let dest = Repo::new();
        dest.write("img/old.png", &png(30));
        dest.git(&["add", "-A"]);
        dest.git(&["commit", "-q", "-m", "base"]);
        let preview = CommitReplayPreview::capture(&dest.root, &payload).unwrap();
        assert_eq!(preview.plan().commits[0].files[0].action, ReplayAction::Delete);
        let result = preview.apply().unwrap();
        assert!(result.failure.is_none(), "{:?}", result.failure);
        assert!(!dest.root.join("img/old.png").exists());
    }
}

/// Mixed selections under a file-count limit: the Exclude summary equals what Include carries and reports.
#[test]
fn fuzz_the_summary_equals_the_include_result_with_placeholders_in_the_window() {
    for (text_kb, non_text_kb) in [(1.0, 2.0), (2.0, 1.0)] {
        let mut seed = 12345u64;
        let mut next = move |n: u64| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 33) % n
        };
        for round in 0..60 {
            let repo = Repo::new();
            let total = 5 + next(30) as usize;
            let mut items = Vec::new();
            for i in 0..total {
                let kind = next(7);
                let (name, bytes): (String, Vec<u8>) = match kind {
                    0 => (format!("f{i:03}.png"), png(300 + i)),
                    1 => (format!("f{i:03}.txt"), b"text\n".to_vec()),
                    2 => (format!("f{i:03}.json"), "x".repeat(1500).into_bytes()),
                    3 => (format!("f{i:03}.big.png"), png(1500)),
                    4 => (format!("f{i:03}.huge.png"), png(3000)),
                    5 => (format!("f{i:03}.nul"), vec![0]),
                    _ => (format!("f{i:03}.big5"), BIG5.to_vec()),
                };
                repo.write(&name, &bytes);
                items.push(name);
            }
            let list: Vec<(&str, SourceKind, Option<ChangeType>)> =
                items.iter().map(|p| (p.as_str(), SourceKind::File, None)).collect();
            let sel = repo.selection(&list);
            let limit = (1 + next(total as u64)) as f64;
            let settings = Settings {
                max_file_size_kb: text_kb,
                max_non_text_file_size_kb: non_text_kb,
                set_max_file_count: true,
                file_count_limit: limit,
                ..Settings::default()
            };
            let exclude = export(&sel, &settings, NonTextMode::Exclude);
            let include = export(&sel, &settings, NonTextMode::Include);
            let ctx = format!("limits {text_kb}/{non_text_kb} round {round} limit {limit} items {items:?}");
            assert_eq!(exclude.non_text.files.len(), include.non_text_file_count, "count: {ctx}");
            assert_eq!(exclude.non_text.limit_left_out, include.non_text.limit_left_out, "left out: {ctx}");
            assert_eq!(exclude.non_text.estimated_include_payload_bytes, include.payload.len(), "estimate: {ctx}");
            assert_eq!(exclude.non_text.files, include.non_text.files, "list: {ctx}");
            assert_eq!(exclude.non_text.over_limit_count, include.non_text.over_limit_count, "over: {ctx}");
        }
    }
}

/// Test 15, round 3: size placeholders and non-text files over the text limit inside the file-count window.
/// The dialog (Exclude summary) equals the Include payload and its notice numbers.
#[test]
fn the_dialog_equals_include_with_size_placeholders_before_the_images() {
    let settings = limited(30.0);
    let repo = Repo::new();
    let mut items: Vec<String> = Vec::new();
    let mut put = |name: String, bytes: Vec<u8>| {
        repo.write(&name, &bytes);
        items.push(name);
    };
    put("d2/a1.png".into(), png(300));
    put("d2/a2.png".into(), png(301));
    put("d2/a3.txt".into(), b"text\n".to_vec());
    // Over both limits: never read.
    put("d2/b1.png".into(), png(3000));
    put("d2/b2.png".into(), png(3001));
    // Read, over the text limit: a text placeholder, and a non-text file that Include carries.
    put("d2/c1.json".into(), "x".repeat(1500).into_bytes());
    put("d2/c2.png".into(), png(1500));
    for i in 0..40 {
        put(format!("d4/i{i:02}.png"), png(100 + i));
    }
    let list: Vec<(&str, SourceKind, Option<ChangeType>)> =
        items.iter().map(|p| (p.as_str(), SourceKind::File, None)).collect();
    let sel = repo.selection(&list);
    let exclude = export(&sel, &settings, NonTextMode::Exclude);
    let include = export(&sel, &settings, NonTextMode::Include);
    assert_eq!(exclude.non_text.count(), include.non_text_file_count);
    assert_eq!(exclude.non_text.files, include.non_text.files);
    assert_eq!(exclude.non_text.limit_left_out, include.non_text.limit_left_out);
    assert_eq!(exclude.non_text.estimated_include_payload_bytes, include.payload.len());
    assert_eq!(exclude.non_text.total_bytes, include.non_text.total_bytes);
    assert_eq!(
        (exclude.non_text.over_limit_count, exclude.non_text.unread_over_limit_count),
        (include.non_text.over_limit_count, include.non_text.unread_over_limit_count)
    );
    // The window held 30 carried files: a1, a2, a3 and c2 of d2 plus 26 images.
    assert_eq!((include.non_text_file_count, include.copied_file_count), (29, 30));
}

/// Required case 26: over the whole-payload limit the dialog never shows an estimate below the raw total.
#[test]
fn over_the_payload_limit_the_estimate_is_never_below_the_raw_total() {
    let repo = Repo::new();
    let settings = Settings { max_non_text_file_size_kb: 10.0, ..small_limits() };
    let names: Vec<String> = (0..6).map(|i| format!("img/p{i}.png")).collect();
    for name in &names {
        repo.write(name, &png(9000));
    }
    let items: Vec<_> = names.iter().map(|n| (n.as_str(), SourceKind::File, None)).collect();
    let sel = repo.selection(&items);
    let real = plan_export(&sel.clone().with_non_text(NonTextMode::Include), &settings, None).unwrap().payload.len();
    let cap = 20_000;
    assert!(real > cap);
    let plan = plan_export(&sel.with_non_text(NonTextMode::Exclude), &settings, Some(cap)).unwrap();
    let s = &plan.non_text;
    assert_eq!((s.count(), s.total_bytes), (6, 54_000));
    assert!(s.estimated_include_payload_bytes > cap, "{}", s.estimated_include_payload_bytes);
    assert!(s.estimated_include_payload_bytes as u64 >= s.total_bytes, "{}", s.estimated_include_payload_bytes);
    // A real estimate of the full Include size, not the size where planning stopped.
    assert!(
        s.estimated_include_payload_bytes.abs_diff(real) * 100 <= real,
        "{} vs {real}",
        s.estimated_include_payload_bytes
    );
}
