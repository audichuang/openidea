//! History for Selection: the commits that changed a block of lines
//! (`git log -L`), each with the block as it was before and after.

use crate::text_encoding::{TextEncoding, decode};
use crate::{
    BlockHistory, BlockHistoryAnchor, BlockHistorySummary, BlockRevision, BlockRevisionSpot, BlockRevisionSummary,
    BlockSpotRange, LineHunk, Repo, cli,
};
use ide_core::{CancellationToken, IdeError, IdeResult};
use std::path::Path;

/// Separates commits in the log output; fields of the header are separated by `\x1f`.
const RECORD: u8 = 0x1e;
const DIFF_BATCH: usize = 4;
const FORMAT: &str = "--format=%x1e%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s";

pub(crate) fn block_history(
    r: &Repo,
    path: &Path,
    current_text: Option<&str>,
    lines: (u32, u32),
    encoding: TextEncoding,
    cancel: &CancellationToken,
) -> IdeResult<BlockHistory> {
    let rel = r.rel_path(path)?;
    let Some(anchor) = anchor(r, &rel, current_text, lines, encoding, cancel)? else {
        return Ok(BlockHistory { head_lines: None, revisions: Vec::new() });
    };
    let out = run(r, &rel, &anchor, &[], cancel)?;
    Ok(BlockHistory { head_lines: Some(anchor.lines), revisions: parse_log(&out.stdout, encoding) })
}

fn anchor(
    r: &Repo,
    rel: &str,
    current_text: Option<&str>,
    lines: (u32, u32),
    encoding: TextEncoding,
    cancel: &CancellationToken,
) -> IdeResult<Option<BlockHistoryAnchor>> {
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    let repo = r.gix()?;
    let Some(id) = repo.head().map_err(crate::repo::gx)?.id() else { return Ok(None) };
    let commit = id.to_string();
    let Some(bytes) = crate::repo::blob_at(&repo, rel, &commit)? else { return Ok(None) };
    let head = decode(&bytes, encoding);
    let current = match current_text {
        Some(text) => std::borrow::Cow::Borrowed(text),
        None => decode(&std::fs::read(r.abs_path(rel))?, encoding).into_owned().into(),
    };
    let hunks = if head == current { Vec::new() } else { crate::diff::line_hunks(&head, &current) };
    Ok(head_range(&hunks, lines).map(|lines| BlockHistoryAnchor { commit, lines }))
}

fn run(
    r: &Repo,
    rel: &str,
    anchor: &BlockHistoryAnchor,
    options: &[&str],
    cancel: &CancellationToken,
) -> IdeResult<cli::Output> {
    let range = anchor_range(rel, anchor);
    cli::run_cancellable(r.root(), &log_args(options, &[range], &anchor.commit), cancel)
}

fn anchor_range(rel: &str, anchor: &BlockHistoryAnchor) -> String {
    let (start, end) = anchor.lines;
    format!("-L{},{}:{rel}", u64::from(start) + 1, u64::from(end) + 1)
}

fn log_args<'a>(options: &[&'a str], ranges: &'a [String], commit: &'a str) -> Vec<&'a str> {
    let mut args = vec!["log", "--no-color", "--no-ext-diff", "--no-textconv", FORMAT];
    args.extend_from_slice(options);
    args.extend(ranges.iter().map(String::as_str));
    args.extend(["--end-of-options", commit]);
    args
}

pub(crate) fn summary(
    r: &Repo,
    path: &Path,
    current_text: Option<&str>,
    lines: (u32, u32),
    encoding: TextEncoding,
    cancel: &CancellationToken,
) -> IdeResult<BlockHistorySummary> {
    let rel = r.rel_path(path)?;
    let Some(anchor) = anchor(r, &rel, current_text, lines, encoding, cancel)? else {
        return Ok(BlockHistorySummary { anchor: None, revisions: Vec::new(), diffs: Vec::new() });
    };
    let mut diffs = Vec::new();
    let revisions = walk(r, &rel, &anchor, encoding, cancel, |first| diffs = first)?;
    Ok(BlockHistorySummary { anchor: Some(anchor), revisions, diffs })
}

/// [`summary`] in two steps: `on_first` gets the anchor and the first few revisions
/// with their diffs as soon as Git has them, and the full revision list is returned
/// when the slower query that lists every revision ends.
pub(crate) fn summary_streamed(
    r: &Repo,
    path: &Path,
    current_text: Option<&str>,
    lines: (u32, u32),
    encoding: TextEncoding,
    cancel: &CancellationToken,
    on_first: impl FnOnce(BlockHistorySummary) + Send,
) -> IdeResult<Vec<BlockRevisionSummary>> {
    let rel = r.rel_path(path)?;
    let Some(anchor) = anchor(r, &rel, current_text, lines, encoding, cancel)? else {
        on_first(BlockHistorySummary { anchor: None, revisions: Vec::new(), diffs: Vec::new() });
        return Ok(Vec::new());
    };
    walk(r, &rel, &anchor, encoding, cancel, |diffs| {
        let revisions = diffs.iter().map(summary_of).collect();
        on_first(BlockHistorySummary { anchor: Some(anchor.clone()), revisions, diffs });
    })
}

/// Every revision of the block, newest first; `on_diffs` gets the first few with
/// their diffs as soon as their query ends.
fn walk(
    r: &Repo,
    rel: &str,
    anchor: &BlockHistoryAnchor,
    encoding: TextEncoding,
    cancel: &CancellationToken,
    on_diffs: impl FnOnce(Vec<BlockRevision>) + Send,
) -> IdeResult<Vec<BlockRevisionSummary>> {
    // Git can emit the list without patches while another process prepares
    // the first few diffs. Neither query depends on the other's output.
    let limit = format!("-n{DIFF_BATCH}");
    let allowed = crate::execution_allowed();
    let (out, first) = std::thread::scope(|scope| {
        let patches = scope.spawn(|| {
            let _execution = crate::ExecutionScope::enter(allowed);
            let out = run(r, rel, anchor, &[&limit], cancel)?;
            let diffs = parse_log(&out.stdout, encoding);
            let ids: Vec<_> = diffs.iter().map(|diff| diff.id.clone()).collect();
            on_diffs(diffs);
            Ok::<_, IdeError>(ids)
        });
        let out = run(r, rel, anchor, &["--no-patch"], cancel);
        let first = patches.join().map_err(|_| IdeError::internal("selection history diff query panicked"))?;
        Ok::<_, IdeError>((out?, first?))
    })?;
    let revisions: Vec<_> = records(&out.stdout).filter_map(|record| parse_summary(split_header(record).0)).collect();
    if revisions.iter().take(DIFF_BATCH).map(|row| row.id.as_str()).ne(first.iter().map(String::as_str)) {
        return Err(IdeError::not_found("selection history revisions no longer match"));
    }
    Ok(revisions)
}

pub(crate) fn revisions(
    r: &Repo,
    path: &Path,
    anchor: &BlockHistoryAnchor,
    index: u32,
    commits: &[String],
    encoding: TextEncoding,
    cancel: &CancellationToken,
) -> IdeResult<Vec<BlockRevision>> {
    gix::ObjectId::from_hex(anchor.commit.as_bytes())
        .map_err(|_| IdeError::invalid("invalid selection history anchor"))?;
    if commits.is_empty() || commits.len() > DIFF_BATCH {
        return Err(IdeError::invalid("invalid selection history batch size"));
    }
    let ids: Vec<_> = commits.iter().map(String::as_str).collect();
    read_diffs(r, &r.rel_path(path)?, anchor, index, &ids, encoding, cancel)
}

fn read_diffs(
    r: &Repo,
    rel: &str,
    anchor: &BlockHistoryAnchor,
    index: u32,
    ids: &[&str],
    encoding: TextEncoding,
    cancel: &CancellationToken,
) -> IdeResult<Vec<BlockRevision>> {
    let skip = format!("--skip={index}");
    let limit = format!("-n{}", ids.len());
    let out = run(r, rel, anchor, &[&limit, &skip], cancel)?;
    let diffs = parse_log(&out.stdout, encoding);
    check_diffs(&diffs, ids.iter().copied())?;
    Ok(diffs)
}

fn check_diffs<'a>(diffs: &[BlockRevision], ids: impl Iterator<Item = &'a str>) -> IdeResult<()> {
    if diffs.iter().map(|diff| diff.id.as_str()).ne(ids) {
        return Err(IdeError::not_found("selection history revisions no longer match"));
    }
    Ok(())
}

/// Spots sent per chunk while the walk goes on.
const SPOT_CHUNK: usize = 256;

/// Every revision's spot, in the order of the revision list (the same walk, with patches).
/// Only the diff headers are kept: the patches of a large block add up to gigabytes.
pub(crate) fn spots(
    r: &Repo,
    path: &Path,
    anchor: &BlockHistoryAnchor,
    cancel: &CancellationToken,
    mut on_spots: impl FnMut(Vec<BlockRevisionSpot>) + Send,
) -> IdeResult<()> {
    gix::ObjectId::from_hex(anchor.commit.as_bytes())
        .map_err(|_| IdeError::invalid("invalid selection history anchor"))?;
    let range = anchor_range(&r.rel_path(path)?, anchor);
    let args = log_args(&[], std::slice::from_ref(&range), &anchor.commit);
    let mut reader = SpotReader::default();
    let mut chunk = Vec::new();
    cli::run_cancellable_lines(r.root(), &args, cancel, &mut |line| {
        if let Some(spot) = reader.line(line) {
            chunk.push(spot);
            if chunk.len() == SPOT_CHUNK {
                on_spots(std::mem::take(&mut chunk));
            }
        }
    })?;
    chunk.extend(reader.finish());
    on_spots(chunk);
    Ok(())
}

/// Reads spots from `git log -L` output line by line.
#[derive(Default)]
struct SpotReader {
    spot: Option<BlockRevisionSpot>,
    section: Section,
}

/// Where the reader is in a commit's diff.
#[derive(Default)]
enum Section {
    /// The commit header, before any file.
    #[default]
    Header,
    /// A file's header lines, with its `+++` path once read (None: not readable).
    File(Option<Option<String>>),
    /// A file's hunks.
    Hunks(Option<String>),
}

impl SpotReader {
    /// Feeds one line; returns the previous commit's spot when `line` starts the next one.
    fn line(&mut self, line: &[u8]) -> Option<BlockRevisionSpot> {
        let line = line.strip_suffix(b"\n").unwrap_or(line);
        if let Some(header) = line.strip_prefix(&[RECORD]) {
            let id = header.split(|b| *b == 0x1f).next().unwrap_or_default();
            let next = BlockRevisionSpot { id: String::from_utf8_lossy(id).into_owned(), ranges: Some(Vec::new()) };
            self.section = Section::Header;
            return self.spot.replace(next);
        }
        let spot = self.spot.as_mut()?;
        // Patch lines start with ' ', '+', '-' or '\\', so these prefixes only match headers.
        if line.starts_with(b"diff --git ") {
            self.section = Section::File(None);
        } else if let (Section::File(path @ None), Some(name)) = (&mut self.section, line.strip_prefix(b"+++ ")) {
            *path = Some(unquote_path(name));
        } else if let Some(hunk) = line.strip_prefix(b"@@ ") {
            let path = match std::mem::take(&mut self.section) {
                Section::File(path) => path.flatten(),
                Section::Hunks(path) => path,
                Section::Header => None,
            };
            match (&mut spot.ranges, path.clone().zip(post_image(hunk))) {
                (Some(ranges), Some((path, (start, end)))) => ranges.push(BlockSpotRange { path, start, end }),
                (ranges, _) => *ranges = None,
            }
            self.section = Section::Hunks(path);
        }
        None
    }

    fn finish(&mut self) -> Option<BlockRevisionSpot> {
        self.spot.take()
    }
}

/// The new side of a hunk header (`-12,3 +14,5 @@ …` → lines 14..=18); None for an empty side.
fn post_image(hunk: &[u8]) -> Option<(u32, u32)> {
    let hunk = std::str::from_utf8(hunk.split(|b| *b == b'@').next()?).ok()?;
    let side = hunk.split_whitespace().find_map(|part| part.strip_prefix('+'))?;
    let (start, count) = side.split_once(',').unwrap_or((side, "1"));
    let (start, count) = (start.parse::<u32>().ok()?, count.parse::<u32>().ok()?);
    (start > 0 && count > 0).then(|| (start, start + (count - 1)))
}

/// The repository path of a `+++ b/…` line, C-quoted or not; None when it is not UTF-8
/// (or not a `b/` path), as it then could not be passed back to Git.
fn unquote_path(path: &[u8]) -> Option<String> {
    // Git ends a name containing a space with a tab; a name with a tab of its own is quoted.
    let path = path.strip_suffix(b"\t").unwrap_or(path);
    let bytes = match path.strip_prefix(b"\"").and_then(|p| p.strip_suffix(b"\"")) {
        None => path.to_vec(),
        Some(inner) => {
            let mut out = Vec::new();
            let mut i = 0;
            while i < inner.len() {
                let c = inner[i];
                i += 1;
                if c != b'\\' {
                    out.push(c);
                    continue;
                }
                let escaped = *inner.get(i)?;
                i += 1;
                out.push(match escaped {
                    b'a' => 0x07,
                    b'b' => 0x08,
                    b't' => b'\t',
                    b'n' => b'\n',
                    b'v' => 0x0b,
                    b'f' => 0x0c,
                    b'r' => b'\r',
                    b'0'..=b'3' => {
                        let digits = inner.get(i..i + 2)?;
                        i += 2;
                        let octal = std::str::from_utf8(&[escaped, digits[0], digits[1]]).ok()?.to_owned();
                        u8::from_str_radix(&octal, 8).ok()?
                    }
                    other => other,
                });
            }
            out
        }
    };
    String::from_utf8(bytes).ok()?.strip_prefix("b/").map(str::to_owned)
}

/// Reads each revision's diff starting at its own commit, with the ranges the full walk
/// followed there; the output equals that commit's record in the full walk.
pub(crate) fn revisions_at(
    r: &Repo,
    spots: &[BlockRevisionSpot],
    encoding: TextEncoding,
    cancel: &CancellationToken,
) -> IdeResult<Vec<BlockRevision>> {
    if spots.is_empty() || spots.len() > DIFF_BATCH {
        return Err(IdeError::invalid("invalid selection history batch size"));
    }
    let mut runs = Vec::new();
    for spot in spots {
        gix::ObjectId::from_hex(spot.id.as_bytes()).map_err(|_| IdeError::invalid("invalid selection history spot"))?;
        let ranges = spot.ranges.as_deref().ok_or_else(|| IdeError::invalid("invalid selection history spot"))?;
        let valid = |range: &&BlockSpotRange| {
            range.start > 0
                && range.end >= range.start
                && !range.path.is_empty()
                && !range.path.contains('\0')
                && !Path::new(&range.path).is_absolute()
        };
        if ranges.len() > 64 || !ranges.iter().all(|range| valid(&range)) {
            return Err(IdeError::invalid("invalid selection history spot"));
        }
        let ranges: Vec<_> =
            ranges.iter().map(|range| format!("-L{},{}:{}", range.start, range.end, range.path)).collect();
        runs.push((spot.id.as_str(), ranges));
    }
    let allowed = crate::execution_allowed();
    std::thread::scope(|scope| {
        let runs: Vec<_> = runs
            .iter()
            .map(|(id, ranges)| {
                scope.spawn(move || {
                    let _execution = crate::ExecutionScope::enter(allowed);
                    // A commit shown without a diff (a merge) is just its header.
                    let options: &[&str] = if ranges.is_empty() { &["-n1", "--no-patch"] } else { &["-n1"] };
                    let out = cli::run_cancellable(r.root(), &log_args(options, ranges, id), cancel)?;
                    let diffs = parse_log(&out.stdout, encoding);
                    check_diffs(&diffs, std::iter::once(*id))?;
                    Ok(diffs.into_iter().next().expect("checked above"))
                })
            })
            .collect();
        runs.into_iter()
            .map(|run| run.join().map_err(|_| IdeError::internal("selection history diff query panicked"))?)
            .collect()
    })
}

/// The HEAD lines (0-based, inclusive) of `lines` in the current text, given the
/// hunks between HEAD and it. A selection end inside a changed region takes the
/// whole region; None when every selected line is new.
pub(crate) fn head_range(hunks: &[LineHunk], (start, end): (u32, u32)) -> Option<(u32, u32)> {
    let (start, end) = (start.min(end), start.max(end));
    let to_head = |line: u32, at_end: bool| -> i64 {
        let mut shift = 0i64;
        for h in hunks {
            if line < h.start {
                break;
            }
            if line < h.start + h.lines {
                return if at_end {
                    i64::from(h.old_start) + i64::from(h.old_lines) - 1
                } else {
                    i64::from(h.old_start)
                };
            }
            shift += i64::from(h.lines) - i64::from(h.old_lines);
        }
        i64::from(line) - shift
    };
    let (from, to) = (to_head(start, false), to_head(end, true));
    (from >= 0 && from <= to).then_some((from as u32, to as u32))
}

/// Commits of `git log -L` output, newest first.
pub(crate) fn parse_log(stdout: &[u8], encoding: TextEncoding) -> Vec<BlockRevision> {
    records(stdout).filter_map(|record| parse_record(record, encoding)).collect()
}

fn records(stdout: &[u8]) -> impl Iterator<Item = &[u8]> {
    stdout.split(|b| *b == RECORD).filter(|r| !r.is_empty())
}

fn split_header(record: &[u8]) -> (&[u8], &[u8]) {
    let newline = record.iter().position(|b| *b == b'\n').unwrap_or(record.len());
    (&record[..newline], record.get(newline + 1..).unwrap_or_default())
}

fn parse_summary(header: &[u8]) -> Option<BlockRevisionSummary> {
    let header = String::from_utf8_lossy(header);
    let mut fields = header.splitn(6, '\x1f');
    Some(BlockRevisionSummary {
        id: fields.next()?.to_owned(),
        short_id: fields.next()?.to_owned(),
        author: fields.next()?.to_owned(),
        email: fields.next()?.to_owned(),
        time_ms: fields.next()?.trim().parse::<f64>().ok()? * 1000.0,
        summary: fields.next().unwrap_or_default().to_owned(),
    })
}

fn summary_of(revision: &BlockRevision) -> BlockRevisionSummary {
    let BlockRevision { id, short_id, author, email, time_ms, summary, .. } = revision;
    BlockRevisionSummary {
        id: id.clone(),
        short_id: short_id.clone(),
        author: author.clone(),
        email: email.clone(),
        time_ms: *time_ms,
        summary: summary.clone(),
    }
}

fn parse_record(record: &[u8], encoding: TextEncoding) -> Option<BlockRevision> {
    let (header, patch) = split_header(record);
    let BlockRevisionSummary { id, short_id, author, email, time_ms, summary } = parse_summary(header)?;
    let patch = decode(patch, encoding);
    let mut revision = BlockRevision {
        id,
        short_id,
        author,
        email,
        time_ms,
        summary,
        path: String::new(),
        before: String::new(),
        after: String::new(),
        before_line: 0,
        after_line: 0,
    };
    let mut in_hunk = false;
    for line in patch.lines() {
        if let Some(path) = line.strip_prefix("+++ ") {
            revision.path = unquote(path).trim_start_matches("b/").to_owned();
        } else if let Some(ranges) = line.strip_prefix("@@ ") {
            in_hunk = true;
            let mut parts = ranges.split_whitespace();
            revision.before_line = hunk_start(parts.next().unwrap_or_default());
            revision.after_line = hunk_start(parts.next().unwrap_or_default());
        } else if in_hunk {
            match line.as_bytes().first() {
                Some(b' ') => {
                    push_line(&mut revision.before, &line[1..]);
                    push_line(&mut revision.after, &line[1..]);
                }
                Some(b'-') => push_line(&mut revision.before, &line[1..]),
                Some(b'+') => push_line(&mut revision.after, &line[1..]),
                _ => {}
            }
        }
    }
    Some(revision)
}

/// 0-based first line of a hunk side (`-12,3` → 11; `+0,0` for a file that did not exist → 0).
fn hunk_start(side: &str) -> u32 {
    let n = side.trim_start_matches(['-', '+']).split(',').next().unwrap_or_default();
    n.parse::<u32>().unwrap_or(0).saturating_sub(1)
}

fn push_line(block: &mut String, line: &str) {
    block.push_str(line);
    block.push('\n');
}

/// A C-quoted path (`"b/a \"b\".txt"`), as git writes unusual names.
fn unquote(path: &str) -> String {
    let Some(inner) = path.strip_prefix('"').and_then(|p| p.strip_suffix('"')) else {
        return path.to_owned();
    };
    let mut out = String::new();
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('t') => out.push('\t'),
            Some('n') => out.push('\n'),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::HunkKind;

    fn hunk(start: u32, lines: u32, old_start: u32, old_lines: u32) -> LineHunk {
        LineHunk { kind: HunkKind::Modified, start, lines, old_start, old_lines, old_text: String::new() }
    }

    #[test]
    fn maps_the_selection_to_head_lines() {
        // Unchanged file.
        assert_eq!(head_range(&[], (3, 5)), Some((3, 5)));
        // Two lines inserted at 1: current 4..=6 were HEAD 2..=4; a reversed selection too.
        let inserted = [hunk(1, 2, 1, 0)];
        assert_eq!(head_range(&inserted, (4, 6)), Some((2, 4)));
        assert_eq!(head_range(&inserted, (6, 4)), Some((2, 4)));
        // Selecting only the inserted lines: nothing committed.
        assert_eq!(head_range(&inserted, (1, 2)), None);
        // From an inserted line on: the HEAD lines after the insertion.
        assert_eq!(head_range(&inserted, (2, 4)), Some((1, 2)));
        // Three HEAD lines (5..=7) replaced by one: a selection ending in it takes all three.
        let replaced = [hunk(5, 1, 5, 3)];
        assert_eq!(head_range(&replaced, (4, 5)), Some((4, 7)));
        assert_eq!(head_range(&replaced, (6, 6)), Some((8, 8)));
        // Two HEAD lines deleted at 2: later lines move down by two.
        let deleted = [hunk(2, 0, 2, 2)];
        assert_eq!(head_range(&deleted, (2, 3)), Some((4, 5)));
    }

    #[test]
    fn parses_git_log_line_ranges() {
        let out = [
            "\x1eaaaa1111\x1faaaa\x1fAda\x1fada@example.com\x1f1700000000\x1fRename greet",
            "",
            "diff --git a/src/a.txt b/src/b.txt",
            "--- a/src/a.txt",
            "+++ b/src/b.txt",
            "@@ -2,2 +2,2 @@",
            " keep",
            "-hello",
            "+hi",
            "\x1ebbbb2222\x1fbbbb\x1fBo\x1fbo@example.com\x1f1600000000\x1fAdd",
            "",
            "diff --git a/src/a.txt b/src/a.txt",
            "--- /dev/null",
            "+++ b/src/a.txt",
            "@@ -0,0 +2,2 @@",
            "+keep",
            "+hello",
        ]
        .join("\n");
        let revisions = parse_log(out.as_bytes(), TextEncoding::from(encoding_rs::UTF_8));
        assert_eq!(revisions.len(), 2);
        let [newer, older] = &revisions[..] else { unreachable!() };
        assert_eq!((newer.id.as_str(), newer.short_id.as_str(), newer.author.as_str()), ("aaaa1111", "aaaa", "Ada"));
        assert_eq!((newer.time_ms, newer.summary.as_str(), newer.path.as_str()), (1.7e12, "Rename greet", "src/b.txt"));
        assert_eq!((newer.before.as_str(), newer.after.as_str()), ("keep\nhello\n", "keep\nhi\n"));
        assert_eq!((newer.before_line, newer.after_line), (1, 1));
        assert_eq!((older.before.as_str(), older.after.as_str()), ("", "keep\nhello\n"));
        assert_eq!((older.before_line, older.after_line), (0, 1));
    }

    #[test]
    fn unquotes_c_quoted_paths() {
        assert_eq!(unquote(r#""b/a \"q\"\tb.txt""#), "b/a \"q\"\tb.txt");
        assert_eq!(unquote("b/plain.txt"), "b/plain.txt");
    }

    #[test]
    fn reads_spot_paths_as_git_writes_them() {
        assert_eq!(unquote_path(b"b/src/a.txt").as_deref(), Some("src/a.txt"));
        // A space makes git end the name with a tab.
        assert_eq!(unquote_path(b"b/\xc3\xbc c.txt\t").as_deref(), Some("\u{fc} c.txt"));
        assert_eq!(unquote_path(br#""b/a\tb \"q\".txt""#).as_deref(), Some("a\tb \"q\".txt"));
        assert_eq!(unquote_path(br#""b/\303\274.txt""#).as_deref(), Some("\u{fc}.txt"));
        assert_eq!(unquote_path(br#""b/\377.txt""#), None);
        assert_eq!(unquote_path(b"/dev/null"), None);
    }
}
