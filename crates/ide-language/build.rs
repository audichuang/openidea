//! `EXTRACTOR_HASH` covers built-in language detection/configuration, symbol extraction,
//! coordinate conversion, queries and tree-sitter versions. Persistent caches survive app
//! version bumps that leave these inputs unchanged.

use std::path::{Path, PathBuf};

// Directory inputs are watched as directories so additions and removals also rebuild the hash.
const INPUTS: &[&str] = &[
    "crates/ide-language/src/syntax",
    "crates/ide-language/queries",
    "languages",
    "crates/ide-language/src/registry.rs",
    "crates/ide-language/src/lib.rs",
    "crates/ide-core/src/text.rs",
    "Cargo.lock",
];

fn main() {
    let dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let root = dir.join("../..");
    for input in INPUTS {
        println!("cargo:rerun-if-changed={}", root.join(input).display());
    }
    println!("cargo:rustc-env=EXTRACTOR_HASH={}", extractor_hash(&root));
}

pub fn extractor_hash(workspace_root: &Path) -> String {
    let mut files = Vec::new();
    for input in INPUTS {
        if *input == "Cargo.lock" {
            continue;
        }
        let path = workspace_root.join(input);
        if path.is_dir() {
            let mut collected = Vec::new();
            collect(&path, &mut collected);
            files.extend(
                collected
                    .into_iter()
                    .filter(|file| *input != "languages" || file.extension().is_some_and(|ext| ext == "toml")),
            );
        } else {
            files.push(path);
        }
    }
    files.sort();
    let mut h = blake3::Hasher::new();
    for file in &files {
        h.update(
            file.strip_prefix(workspace_root).expect("workspace input").to_string_lossy().replace('\\', "/").as_bytes(),
        );
        h.update(b"\0");
        // Line endings depend on the checkout, not on what is extracted.
        h.update(&std::fs::read(file).unwrap_or_default().into_iter().filter(|b| *b != b'\r').collect::<Vec<_>>());
        h.update(b"\0");
    }
    if let Ok(text) = std::fs::read_to_string(workspace_root.join("Cargo.lock")) {
        for package in tree_sitter_packages(&text) {
            h.update(package.as_bytes());
            h.update(b"\0");
        }
    }
    h.finalize().to_hex()[..16].to_owned()
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
