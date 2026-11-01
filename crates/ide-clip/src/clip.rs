//! Payload mode detection. Clipboard I/O is the host's (the OpenIDEA frontend).

/// First line of a commit-mode payload (spec 4.4). `commits` refers to this constant.
pub const COMMIT_MARKER: &str = "// snip-sync commits v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Commits,
    Files,
}

/// Commit mode iff the first line is the marker (tolerating CRLF from Windows clipboards).
pub fn detect_mode(text: &str) -> Mode {
    let first = text.split('\n').next().unwrap_or("");
    if first.trim_end_matches('\r') == COMMIT_MARKER { Mode::Commits } else { Mode::Files }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_mode_commits_marker() {
        assert_eq!(detect_mode("// snip-sync commits v1\n{}"), Mode::Commits);
        assert_eq!(detect_mode("// snip-sync commits v1\r\n{}"), Mode::Commits);
        assert_eq!(detect_mode(COMMIT_MARKER), Mode::Commits);
    }

    #[test]
    fn detect_mode_files() {
        assert_eq!(detect_mode(""), Mode::Files);
        assert_eq!(detect_mode("// src/a.rs\nfn main() {}"), Mode::Files);
        // Marker must be the whole first line, not a prefix or a later line.
        assert_eq!(detect_mode("// snip-sync commits v12\n{}"), Mode::Files);
        assert_eq!(detect_mode("x\n// snip-sync commits v1\n{}"), Mode::Files);
        assert_eq!(detect_mode(" // snip-sync commits v1\n{}"), Mode::Files);
    }
}
