#[allow(dead_code)]
#[path = "../build.rs"]
mod build_script;

use std::path::Path;

const FILES: &[(&str, &str)] = &[
    ("Cargo.toml", "[workspace.package]\nversion = \"1.0.0\"\n"),
    (
        "Cargo.lock",
        "[[package]]\nname = \"tree-sitter\"\nversion = \"0.25.0\"\n\n[[package]]\nname = \"serde\"\nversion = \"1.0.0\"\n",
    ),
    ("languages/rust.toml", "extensions = [\"rs\"]\ntree-sitter = \"rust\"\n"),
    ("crates/ide-language/src/registry.rs", "fn detect() {}\n"),
    ("crates/ide-language/src/lib.rs", "struct LanguageConfig {}\n"),
    ("crates/ide-core/src/text.rs", "fn utf16_column() {}\n"),
    ("crates/ide-language/src/syntax/mod.rs", "fn tags() {}\n"),
    ("crates/ide-language/src/syntax/tests.rs", "fn test_tags() {}\n"),
    ("crates/ide-language/queries/rust/tags.scm", "(function_item) @definition.function\n"),
];

fn write(root: &Path, path: &str, contents: &str) {
    let path = root.join(path);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, contents).unwrap();
}

fn fixture() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for (path, contents) in FILES {
        write(dir.path(), path, contents);
    }
    dir
}

#[test]
fn extraction_inputs_invalidate_hash() {
    for (path, from, to) in [
        ("languages/rust.toml", "rs", "rust"),
        ("languages/rust.toml", "\"rust\"", "\"typescript\""),
        ("crates/ide-language/src/registry.rs", "detect", "detect_updated"),
        ("crates/ide-language/src/lib.rs", "LanguageConfig", "UpdatedLanguageConfig"),
        ("crates/ide-core/src/text.rs", "utf16_column", "updated_utf16_column"),
        ("crates/ide-language/src/syntax/mod.rs", "tags", "updated_tags"),
        ("crates/ide-language/queries/rust/tags.scm", "function_item", "struct_item"),
        ("Cargo.lock", "0.25.0", "0.26.0"),
    ] {
        let dir = fixture();
        let before = build_script::extractor_hash(dir.path());
        let contents = std::fs::read_to_string(dir.path().join(path)).unwrap();
        write(dir.path(), path, &contents.replace(from, to));
        assert_ne!(before, build_script::extractor_hash(dir.path()), "{path}: {from} -> {to}");
    }
}

#[test]
fn language_file_addition_and_removal_invalidate_hash() {
    let dir = fixture();
    let before = build_script::extractor_hash(dir.path());
    write(dir.path(), "languages/new.toml", "extensions = [\"new\"]\n");
    let added = build_script::extractor_hash(dir.path());
    assert_ne!(before, added);
    std::fs::remove_file(dir.path().join("languages/new.toml")).unwrap();
    assert_eq!(before, build_script::extractor_hash(dir.path()));
    std::fs::remove_file(dir.path().join("languages/rust.toml")).unwrap();
    assert_ne!(before, build_script::extractor_hash(dir.path()));
}

#[test]
fn unrelated_changes_preserve_hash() {
    for (path, from, to) in [
        ("Cargo.toml", "1.0.0", "2.0.0"),
        ("Cargo.lock", "1.0.0", "2.0.0"),
        ("crates/ide-language/src/syntax/tests.rs", "test_tags", "updated_test_tags"),
    ] {
        let dir = fixture();
        let before = build_script::extractor_hash(dir.path());
        let contents = std::fs::read_to_string(dir.path().join(path)).unwrap();
        write(dir.path(), path, &contents.replace(from, to));
        assert_eq!(before, build_script::extractor_hash(dir.path()), "{path}");
    }
}

#[test]
fn checkout_root_and_line_endings_preserve_hash() {
    let lf = fixture();
    let crlf = fixture();
    assert_eq!(build_script::extractor_hash(lf.path()), build_script::extractor_hash(crlf.path()));
    for (path, contents) in FILES {
        write(crlf.path(), path, &contents.replace('\n', "\r\n"));
    }
    assert_eq!(build_script::extractor_hash(lf.path()), build_script::extractor_hash(crlf.path()));
}
