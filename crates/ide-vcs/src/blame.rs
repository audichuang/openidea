//! `git blame --porcelain` parsing, the per-revision blame cache and the mapping of a
//! revision's blame onto edited text.

use crate::BlameLine;
use ide_core::{CancellationToken, IdeResult};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};

#[derive(Default, Clone)]
struct CommitMeta {
    author: String,
    time_ms: f64,
    summary: String,
}

/// Parses `git blame --porcelain` output into one entry per final line.
pub(crate) fn parse_porcelain(out: &str) -> Vec<BlameLine> {
    let mut metas: HashMap<String, CommitMeta> = HashMap::new();
    let mut lines: Vec<(u32, String)> = Vec::new();
    let mut current: Option<String> = None;
    for line in out.split('\n') {
        if let Some(_content) = line.strip_prefix('\t') {
            current = None;
            continue;
        }
        if let Some(id) = current.as_ref() {
            let meta = metas.entry(id.clone()).or_default();
            if let Some(v) = line.strip_prefix("author ") {
                meta.author = v.to_string();
            } else if let Some(v) = line.strip_prefix("author-time ") {
                meta.time_ms = v.trim().parse::<f64>().unwrap_or(0.0) * 1000.0;
            } else if let Some(v) = line.strip_prefix("summary ") {
                meta.summary = v.to_string();
            }
            continue;
        }
        // Header: <sha> <orig-line> <final-line> [<group-count>]
        let mut parts = line.split(' ');
        let (Some(sha), Some(_orig), Some(final_line)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        if sha.len() < 40 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        let Ok(final_line) = final_line.parse::<u32>() else { continue };
        metas.entry(sha.to_string()).or_default();
        lines.push((final_line, sha.to_string()));
        current = Some(sha.to_string());
    }
    lines.sort_by_key(|(n, _)| *n);
    lines
        .into_iter()
        .map(|(_, sha)| {
            let meta = metas.get(&sha).cloned().unwrap_or_default();
            BlameLine { commit: sha, author: meta.author, time_ms: meta.time_ms, summary: meta.summary }
        })
        .collect()
}

/// Carries a revision's blame (`base_lines`, one per line of `base`) over to `current`:
/// lines the diff keeps get their blame, inserted or changed lines get `uncommitted`.
/// Both texts are compared with line endings normalised, like the editor's change markers.
pub(crate) fn map_onto_text(
    base_lines: &[BlameLine],
    base: &str,
    current: &str,
    uncommitted: &BlameLine,
) -> Vec<BlameLine> {
    let mut lines = base_lines.to_vec();
    for hunk in crate::diff::line_hunks(base, current).into_iter().rev() {
        let start = (hunk.old_start as usize).min(lines.len());
        let end = (start + hunk.old_lines as usize).min(lines.len());
        lines.splice(start..end, std::iter::repeat_n(uncommitted.clone(), hunk.lines as usize));
    }
    lines
}

const CACHED_FILES: usize = 16;

type Shared = Arc<OnceLock<IdeResult<Arc<Vec<BlameLine>>>>>;

#[derive(PartialEq, Eq)]
struct SlotKey {
    rel: String,
    revision: String,
    textconv: bool,
}

/// What a revision name resolved to, plus stamps of the other inputs that change `git blame`
/// output for the same commit (shallow depth, replace refs, config, mailmap, ignore-revs).
#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) struct BlameVersion {
    pub(crate) commit: gix::ObjectId,
    pub(crate) inputs: Vec<Option<(std::time::SystemTime, u64)>>,
}

struct Slot {
    key: SlotKey,
    version: BlameVersion,
    blame: Shared,
    cancel: CancellationToken,
}

/// Blame of committed revisions, one slot per (file, revision name, textconv), so the
/// author hints, Annotate and inline blame share one `git blame` per file and commit
/// instead of each re-running it after every edit.
#[derive(Default)]
pub(crate) struct BlameCache {
    slots: Mutex<VecDeque<Slot>>,
}

impl BlameCache {
    /// The blame of `rel` at `revision` (resolved to `version`), running `run` only when
    /// no caller has: concurrent callers wait for the one run. A revision name that now
    /// resolves to another version (HEAD moved, history deepened) cancels the run still
    /// going for the old one.
    pub(crate) fn get_or_run(
        &self,
        rel: &str,
        revision: &str,
        version: BlameVersion,
        textconv: bool,
        run: impl FnOnce(&CancellationToken) -> IdeResult<Vec<BlameLine>>,
    ) -> IdeResult<Arc<Vec<BlameLine>>> {
        let key = SlotKey { rel: rel.to_owned(), revision: revision.to_owned(), textconv };
        let (blame, cancel) = {
            let mut slots = self.slots.lock().unwrap_or_else(|e| e.into_inner());
            let slot = match slots.iter().position(|s| s.key == key) {
                Some(i) if slots[i].version == version => slots.remove(i).expect("index in range"),
                found => {
                    if let Some(old) = found.and_then(|i| slots.remove(i)) {
                        old.cancel.cancel();
                    }
                    if slots.len() >= CACHED_FILES {
                        slots.pop_front();
                    }
                    Slot { key, version, blame: Shared::default(), cancel: CancellationToken::new() }
                }
            };
            let handles = (slot.blame.clone(), slot.cancel.clone());
            slots.push_back(slot);
            handles
        };
        let result = blame.get_or_init(|| run(&cancel).map(Arc::new)).clone();
        if result.is_err() {
            // Failures (cancelled, git error) are not remembered: the next call runs again.
            self.slots.lock().unwrap_or_else(|e| e.into_inner()).retain(|s| !Arc::ptr_eq(&s.blame, &blame));
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_groups_and_repeats() {
        let sha_a = "a".repeat(40);
        let sha_z = "0".repeat(40);
        let out = format!(
            "{sha_a} 1 1 2\nauthor Ann\nauthor-mail <a@x>\nauthor-time 100\nauthor-tz +0000\nsummary first\nfilename f\n\tl1\n\
             {sha_a} 2 2\n\tl2\n\
             {sha_z} 3 3 1\nauthor Not Committed Yet\nauthor-time 200\nsummary Version of f from f\nfilename f\n\tl3\n"
        );
        let lines = parse_porcelain(&out);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[1].author, "Ann");
        assert_eq!(lines[1].time_ms, 100_000.0);
        assert_eq!(lines[2].author, "Not Committed Yet");
    }

    fn line(commit: &str) -> BlameLine {
        BlameLine { commit: commit.to_owned(), author: commit.to_owned(), time_ms: 0.0, summary: String::new() }
    }

    /// Blame of `base` where line i was committed as `c<i>`, mapped onto `current`;
    /// returns each line's commit, `-` for uncommitted.
    fn mapped(base: &str, current: &str) -> Vec<String> {
        let base_lines: Vec<_> = (0..base.split_inclusive('\n').count()).map(|i| line(&format!("c{i}"))).collect();
        map_onto_text(&base_lines, base, current, &line("-")).into_iter().map(|l| l.commit).collect()
    }

    #[test]
    fn maps_unchanged_text_line_for_line() {
        assert_eq!(mapped("a\nb\nc\n", "a\nb\nc\n"), ["c0", "c1", "c2"]);
        assert_eq!(mapped("a\nb\nc", "a\nb\nc"), ["c0", "c1", "c2"]);
    }

    #[test]
    fn maps_insertions_and_deletions() {
        assert_eq!(mapped("a\nb\nc\n", "new\na\nb\nc\n"), ["-", "c0", "c1", "c2"]);
        assert_eq!(mapped("a\nb\nc\n", "a\nb\nnew\nc\n"), ["c0", "c1", "-", "c2"]);
        assert_eq!(mapped("a\nb\nc\n", "a\nb\nc\nnew\n"), ["c0", "c1", "c2", "-"]);
        assert_eq!(mapped("a\nb\nc\n", "b\nc\n"), ["c1", "c2"]);
        assert_eq!(mapped("a\nb\nc\n", "a\nc\n"), ["c0", "c2"]);
        assert_eq!(mapped("a\nb\nc\n", "a\nb\n"), ["c0", "c1"]);
        assert_eq!(mapped("a\nb\nc\n", ""), Vec::<String>::new());
        assert_eq!(mapped("", "x\ny\n"), ["-", "-"]);
    }

    #[test]
    fn maps_edits_at_start_middle_and_end() {
        assert_eq!(mapped("a\nb\nc\n", "A\nb\nc\n"), ["-", "c1", "c2"]);
        assert_eq!(mapped("a\nb\nc\n", "a\nB\nc\n"), ["c0", "-", "c2"]);
        assert_eq!(mapped("a\nb\nc\n", "a\nb\nC\n"), ["c0", "c1", "-"]);
        // Typing on a last line without a newline changes that line only.
        assert_eq!(mapped("a\nb\nc", "a\nb\ncd"), ["c0", "c1", "-"]);
        // Adding the final newline and a new line after it.
        assert_eq!(mapped("a\nb", "a\nb\nc"), ["c0", "-", "-"]);
        // One line split in two, two joined into one.
        assert_eq!(mapped("a\nbc\nd\n", "a\nb\nc\nd\n"), ["c0", "-", "-", "c2"]);
        assert_eq!(mapped("a\nb\nc\nd\n", "a\nbc\nd\n"), ["c0", "-", "c3"]);
    }

    #[test]
    fn ignores_line_ending_differences() {
        assert_eq!(mapped("a\r\nb\r\nc\r\n", "a\nb\nc\n"), ["c0", "c1", "c2"]);
        assert_eq!(mapped("a\nb\nc\n", "a\r\nB\r\nc\r\n"), ["c0", "-", "c2"]);
    }

    #[test]
    fn maps_non_ascii_text() {
        assert_eq!(mapped("// 中文\nlet a = 1;\n", "// 中文\nlet a = 2;\n"), ["c0", "-"]);
    }

    fn version(byte: u8) -> BlameVersion {
        BlameVersion { commit: gix::ObjectId::from_bytes_or_panic(&[byte; 20]), inputs: Vec::new() }
    }

    #[test]
    fn cache_runs_git_once_per_file_and_commit() {
        let cache = BlameCache::default();
        let runs = std::sync::atomic::AtomicUsize::new(0);
        let run = |_: &CancellationToken| {
            runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(vec![line("c")])
        };
        cache.get_or_run("a.py", "HEAD", version(1), true, run).unwrap();
        cache.get_or_run("a.py", "HEAD", version(1), true, run).unwrap();
        assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 1);
        // Another file, revision name or textconv mode is its own entry.
        cache.get_or_run("b.py", "HEAD", version(1), true, run).unwrap();
        cache.get_or_run("a.py", "MERGE_HEAD", version(1), true, run).unwrap();
        cache.get_or_run("a.py", "HEAD", version(1), false, run).unwrap();
        assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 4);
        // HEAD moved: blamed again.
        cache.get_or_run("a.py", "HEAD", version(2), true, run).unwrap();
        assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 5);
        // Same commit, another shallow depth or config: blamed again.
        let mut deepened = version(2);
        deepened.inputs.push(None);
        cache.get_or_run("a.py", "HEAD", deepened, true, run).unwrap();
        assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 6);
    }

    #[test]
    fn cache_does_not_remember_failures() {
        let cache = BlameCache::default();
        let failed = cache.get_or_run("a.py", "HEAD", version(1), true, |_| Err(ide_core::IdeError::cancelled()));
        assert!(failed.is_err());
        let lines = cache.get_or_run("a.py", "HEAD", version(1), true, |_| Ok(vec![line("c")])).unwrap();
        assert_eq!(lines[0].commit, "c");
    }

    #[test]
    fn concurrent_callers_share_one_run_and_a_moved_head_cancels_it() {
        let cache = Arc::new(BlameCache::default());
        let runs = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let first = {
            let (cache, runs) = (cache.clone(), runs.clone());
            std::thread::spawn(move || {
                cache.get_or_run("a.py", "HEAD", version(1), true, |cancel| {
                    runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    started_tx.send(()).unwrap();
                    // Stands in for a long git blame that is killed on cancellation.
                    while !cancel.is_cancelled() {
                        std::thread::sleep(std::time::Duration::from_millis(5));
                    }
                    Err(ide_core::IdeError::cancelled())
                })
            })
        };
        started_rx.recv().unwrap();
        let waiter = {
            let (cache, runs) = (cache.clone(), runs.clone());
            std::thread::spawn(move || {
                cache.get_or_run("a.py", "HEAD", version(1), true, |_| {
                    runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Ok(vec![])
                })
            })
        };
        // Wait until the waiter holds the shared run (the slot, the first caller and it).
        while Arc::strong_count(&cache.slots.lock().unwrap()[0].blame) < 3 {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let moved = cache.get_or_run("a.py", "HEAD", version(2), true, |_| Ok(vec![line("new")])).unwrap();
        assert_eq!(moved[0].commit, "new");
        assert!(first.join().unwrap().is_err());
        // The waiter joined the cancelled run instead of starting its own.
        assert!(waiter.join().unwrap().is_err());
        assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
}
