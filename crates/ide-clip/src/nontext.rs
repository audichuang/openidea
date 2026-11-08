//! Non-text files carried as Base64 (GLOSSARY "non-text file"; spec
//! `docs/clipcode/non-text-files.md`): the placeholder line, encoding,
//! strict verified decoding, size estimates and the copy dialog's summary.

use std::sync::LazyLock;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Base64 characters per line in files mode.
pub const BASE64_LINE_LEN: usize = 76;

const PLACEHOLDER_PREFIX: &str = "// File skipped: ";

// `[0-9]`, never `\d`: the Rust regex `\d` matches every Unicode digit.
static PLACEHOLDER_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^// File skipped: non-text file, ([0-9]+) bytes, sha256 ([0-9a-f]{64}); base64 follows$").unwrap()
});

/// Lowercase hex SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// The skip reason that follows `// File skipped: ` on the placeholder line.
pub(crate) fn placeholder_reason(size: u64, sha256_hex: &str) -> String {
    format!("non-text file, {size} bytes, sha256 {sha256_hex}; base64 follows")
}

/// The first body line of a files-mode non-text entry.
pub fn placeholder_line(size: u64, sha256_hex: &str) -> String {
    format!("{PLACEHOLDER_PREFIX}{}", placeholder_reason(size, sha256_hex))
}

/// Standard Base64 (RFC 4648 §4, padded), one line.
pub fn encode(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

/// Standard Base64 wrapped at [`BASE64_LINE_LEN`], lines joined by `\n`.
pub fn encode_wrapped(bytes: &[u8]) -> String {
    let flat = encode(bytes);
    let mut out = String::with_capacity(flat.len() + flat.len() / BASE64_LINE_LEN);
    for (i, line) in base64_lines(&flat).enumerate() {
        if i > 0 {
            out.push('\n');
        }
        out.push_str(line);
    }
    out
}

/// The wrapped lines of an encoded string (Base64 is ASCII).
pub(crate) fn base64_lines(encoded: &str) -> impl Iterator<Item = &str> {
    encoded.as_bytes().chunks(BASE64_LINE_LEN).map(|c| std::str::from_utf8(c).expect("base64 is ascii"))
}

/// Length of the padded Base64 of `raw` bytes.
pub fn encoded_len(raw: u64) -> u64 {
    raw.div_ceil(3) * 4
}

/// Number of wrapped Base64 lines for `raw` bytes.
pub fn wrapped_line_count(raw: u64) -> u64 {
    encoded_len(raw).div_ceil(BASE64_LINE_LEN as u64)
}

/// Why a non-text entry could not be restored. The entry is skipped and
/// reported as corrupted; the rest of the paste continues.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
pub enum NonTextError {
    #[error("the Base64 is not valid")]
    Base64,
    #[error("the decoded size differs from the recorded size")]
    Size,
    #[error("the decoded SHA-256 differs from the recorded hash")]
    Sha256,
}

/// Size and hash recorded on a placeholder line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NonTextHeader {
    pub size: u64,
    pub sha256: String,
}

/// Recognizes the placeholder line (a trailing `\r` is dropped first).
pub fn parse_placeholder_line(line: &str) -> Option<NonTextHeader> {
    let line = line.strip_suffix('\r').unwrap_or(line);
    let caps = PLACEHOLDER_LINE.captures(line)?;
    let size = caps[1].parse().ok()?;
    Some(NonTextHeader { size, sha256: caps[2].to_string() })
}

/// Strips every ASCII whitespace character, decodes strictly, then checks the
/// length and SHA-256 against `header`.
pub fn decode_verified(base64_text: &str, header: &NonTextHeader) -> Result<Vec<u8>, NonTextError> {
    let compact: Vec<u8> = base64_text.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    let bytes = STANDARD.decode(&compact).map_err(|_| NonTextError::Base64)?;
    if bytes.len() as u64 != header.size {
        return Err(NonTextError::Size);
    }
    if sha256_hex(&bytes) != header.sha256 {
        return Err(NonTextError::Sha256);
    }
    Ok(bytes)
}

/// A parsed (already un-escaped) entry body: `None` when it is not a
/// non-text entry, else its verified bytes or why they are corrupted.
pub fn parse_body(content: &str) -> Option<Result<Vec<u8>, NonTextError>> {
    let (first, rest) = content.split_once('\n').unwrap_or((content, ""));
    let header = parse_placeholder_line(first)?;
    Some(decode_verified(rest, &header))
}

/// One non-text file a copy found within the non-text limit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NonTextFound {
    /// The path as the payload spells it.
    pub path: String,
    /// Raw bytes.
    pub size: u64,
}

/// What the copy dialog shows (spec "Asking the user"). An Exclude copy
/// reports what Include would add; an Include copy reports what it carried.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NonTextSummary {
    /// Every non-text file within its limit, in payload order (the dialog
    /// lists the first 10).
    pub files: Vec<NonTextFound>,
    /// Σ raw size of `files`.
    pub total_bytes: u64,
    /// Non-text files over the non-text limit: not copied either way.
    pub over_limit_count: usize,
    /// Working-tree files over both the text and the non-text limit: never read, so their
    /// kind is unknown; they travel as size placeholders.
    #[serde(default)]
    pub unread_over_limit_count: usize,
    /// The larger of the two per-file limits, in bytes: what `unread_over_limit_count` exceeds.
    #[serde(default)]
    pub unread_limit_bytes: u64,
    /// The payload size with the non-text files included. Exact for an
    /// Include copy; for an Exclude copy it is the Exclude payload plus each
    /// entry's arithmetic size, less what Include's earlier file-count cutoff drops (escape markers a
    /// custom header format may add to Base64 lines are not counted).
    pub estimated_include_payload_bytes: usize,
    /// Files the file-count limit leaves out of what Include would copy: every file from Include's cutoff
    /// on that passes the filters. Non-text files count toward the limit like text files.
    #[serde(default)]
    pub limit_left_out: usize,
    /// `limit_left_out` is a lower bound: a folder walk stopped at the limit before listing the rest.
    #[serde(default)]
    pub limit_left_out_lower_bound: bool,
}

impl NonTextSummary {
    /// The dialog is shown only when this is non-zero.
    pub fn count(&self) -> usize {
        self.files.len()
    }

    pub(crate) fn found(&mut self, path: &str, size: u64) {
        self.files.push(NonTextFound { path: path.to_string(), size });
        self.total_bytes = self.total_bytes.saturating_add(size);
    }
}

/// `Vec<u8>` as one Base64 string on the wire (a remote worker's plan), not a
/// JSON array of numbers.
pub(crate) mod serde_bytes_base64 {
    use super::STANDARD;
    use base64::Engine;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&STANDARD.encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let text = String::deserialize(d)?;
        STANDARD.decode(text.as_bytes()).map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_round_trips_and_is_exact() {
        let bytes = [0x89, b'P', b'N', b'G', 0, 1, 2];
        let sha = sha256_hex(&bytes);
        let line = placeholder_line(7, &sha);
        assert_eq!(line, format!("// File skipped: non-text file, 7 bytes, sha256 {sha}; base64 follows"));
        assert_eq!(parse_placeholder_line(&line), Some(NonTextHeader { size: 7, sha256: sha.clone() }));
        assert!(parse_placeholder_line(&format!("{line}\r")).is_some());
        assert!(parse_placeholder_line(&format!(" {line}")).is_none());
        assert!(parse_placeholder_line(&line.to_uppercase()).is_none());
        // Arabic-Indic digits are digits to `\d`, not to the spec.
        assert!(parse_placeholder_line(&line.replace(" 7 ", " \u{0667} ")).is_none());
        assert!(parse_placeholder_line("// File skipped: size exceeds limit (9 bytes)").is_none());
    }

    #[test]
    fn wrapping_and_lengths_agree() {
        for n in [1u64, 2, 3, 56, 57, 58, 114, 1000] {
            let bytes: Vec<u8> = (0..n).map(|i| (i * 7) as u8).collect();
            let wrapped = encode_wrapped(&bytes);
            assert!(wrapped.split('\n').all(|l| l.len() <= BASE64_LINE_LEN));
            assert_eq!(wrapped.replace('\n', "").len() as u64, encoded_len(n));
            assert_eq!(wrapped.split('\n').count() as u64, wrapped_line_count(n));
        }
    }

    #[test]
    fn decode_is_strict_and_verified() {
        let bytes = vec![0u8, 0xff, 0x10, 0x20];
        let header = NonTextHeader { size: 4, sha256: sha256_hex(&bytes) };
        let b64 = encode(&bytes);
        assert_eq!(decode_verified(&b64, &header), Ok(bytes.clone()));
        assert_eq!(decode_verified(&format!(" {}\r\n{}\t\n", &b64[..3], &b64[3..]), &header), Ok(bytes.clone()));
        assert_eq!(decode_verified(&b64[..b64.len() - 1], &header), Err(NonTextError::Base64));
        assert_eq!(decode_verified(&b64.replace('=', ""), &header), Err(NonTextError::Base64));
        assert_eq!(decode_verified(&encode(&bytes[..3]), &header), Err(NonTextError::Size));
        let wrong = NonTextHeader { sha256: "0".repeat(64), ..header };
        assert_eq!(decode_verified(&b64, &wrong), Err(NonTextError::Sha256));
    }
}
