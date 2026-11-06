//! `EXTRACTOR_HASH`: what decides the symbols `Syntax::tags` extracts (the syntax module, the
//! queries, the tree-sitter crates in `Cargo.lock`), so persistent caches survive a version bump
//! that leaves extraction unchanged.

use std::path::{Path, PathBuf};

fn main() {
    let dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let lock = dir.join("../../Cargo.lock");
    let mut files = Vec::new();
    for sub in ["src/syntax", "queries"] {
        let path = dir.join(sub);
        println!("cargo:rerun-if-changed={}", path.display());
        collect(&path, &mut files);
    }
    files.sort();
    let mut h = blake3::Hasher::new();
    for file in &files {
        h.update(file.strip_prefix(&dir).unwrap_or(file).to_string_lossy().replace('\\', "/").as_bytes());
        h.update(b"\0");
        // Line endings depend on the checkout, not on what is extracted.
        h.update(&std::fs::read(file).unwrap_or_default().into_iter().filter(|b| *b != b'\r').collect::<Vec<_>>());
        h.update(b"\0");
    }
    println!("cargo:rerun-if-changed={}", lock.display());
    if let Ok(text) = std::fs::read_to_string(&lock) {
        for package in tree_sitter_packages(&text) {
            h.update(package.as_bytes());
            h.update(b"\0");
        }
    }
    println!("cargo:rustc-env=EXTRACTOR_HASH={}", &h.finalize().to_hex()[..16]);
}

fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect(&path, out);
        } else if path.file_name().is_some_and(|n| n != "tests.rs") {
            out.push(path);
        }
    }
}

/// `name version` of each `tree-sitter*` package in a `Cargo.lock`.
fn tree_sitter_packages(lock: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut name: Option<&str> = None;
    for line in lock.lines() {
        if line == "[[package]]" {
            name = None;
        } else if let Some(v) = line.strip_prefix("name = ") {
            name = Some(v.trim_matches('"'));
        } else if let (Some(n), Some(v)) = (name, line.strip_prefix("version = "))
            && n.starts_with("tree-sitter")
        {
            out.push(format!("{n} {}", v.trim_matches('"')));
        }
    }
    out.sort();
    out
}
