//! Records file watcher batches into Local History on a worker thread.
//!
//! Snapshotting is slow for a large batch: a checkout that touches thousands of
//! files writes hundreds of blobs. Done on the watcher thread, it held back the
//! next batches, so open documents kept showing the previous revision (and
//! Annotate blamed it) for half a minute or more after a `git checkout`.

use crate::history::LocalHistory;
use parking_lot::{Condvar, Mutex};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread::JoinHandle;

type Batch = (Vec<PathBuf>, Vec<PathBuf>);

/// Batches waiting for the worker. Past this, the two oldest are merged, so a
/// backlog cannot grow without bound while the watcher thread never blocks.
const MAX_PENDING_BATCHES: usize = 64;

#[derive(Default)]
struct Pending {
    batches: VecDeque<Batch>,
    /// Batches merged into a newer one because the queue was full.
    coalesced: u64,
    closed: bool,
}

impl Pending {
    /// Queues a batch. `changed` is cut to `limit` here, as the worker would do
    /// anyway, so a huge checkout does not keep every path alive while queued.
    /// `removed` is kept whole: dropping it would lose the "Deleted" markers.
    fn push(&mut self, mut changed: Vec<PathBuf>, removed: Vec<PathBuf>, limit: usize) {
        changed.truncate(limit);
        if self.batches.len() >= MAX_PENDING_BATCHES
            && let Some((old_changed, old_removed)) = self.batches.pop_front()
        {
            // Merge the oldest into the next one: the order is kept and only
            // changed files beyond `limit` are given up (they stay unrecorded).
            if let Some((next_changed, next_removed)) = self.batches.front_mut() {
                let mut merged = old_changed;
                merged.append(next_changed);
                merged.truncate(limit);
                *next_changed = merged;
                let mut gone = old_removed;
                gone.append(next_removed);
                *next_removed = gone;
            }
            self.coalesced += 1;
            tracing::debug!("local history: queue full, {} batches merged so far", self.coalesced);
        }
        self.batches.push_back((changed, removed));
    }
}

#[derive(Default)]
struct Shared {
    pending: Mutex<Pending>,
    wake: Condvar,
}

/// Queues watcher batches for [`LocalHistory::record_external_changes`], one at a
/// time and in order. Dropping it waits for the batch being recorded and skips
/// the queued ones, so nothing writes into the history after the project closed.
pub struct ExternalChangeRecorder {
    shared: Option<Arc<Shared>>,
    limit: usize,
    worker: Option<JoinHandle<()>>,
}

impl ExternalChangeRecorder {
    /// `limit`: files snapshotted per batch, as in `record_external_changes`.
    pub fn new(history: Arc<LocalHistory>, limit: usize) -> Self {
        let shared = Arc::new(Shared::default());
        let worker_shared = shared.clone();
        let worker = std::thread::Builder::new()
            .name("openidea-history".into())
            .spawn(move || {
                loop {
                    let (changed, removed) = {
                        let mut pending = worker_shared.pending.lock();
                        loop {
                            if pending.closed {
                                return;
                            }
                            if let Some(batch) = pending.batches.pop_front() {
                                break batch;
                            }
                            worker_shared.wake.wait(&mut pending);
                        }
                    };
                    history.record_external_changes(&changed, &removed, limit);
                }
            })
            .map_err(|e| tracing::warn!("local history worker: {e}"))
            .ok();
        Self { shared: worker.as_ref().map(|_| shared), limit, worker }
    }

    /// Returns at once; the batch is recorded after the ones queued before it.
    pub fn record(&self, changed: &[PathBuf], removed: &[PathBuf]) {
        if changed.is_empty() && removed.is_empty() {
            return;
        }
        if let Some(shared) = &self.shared {
            let keep = &changed[..changed.len().min(self.limit)];
            shared.pending.lock().push(keep.to_vec(), removed.to_vec(), self.limit);
            shared.wake.notify_one();
        }
    }
}

impl Drop for ExternalChangeRecorder {
    fn drop(&mut self) {
        if let Some(shared) = &self.shared {
            let mut pending = shared.pending.lock();
            pending.closed = true;
            pending.batches.clear();
            shared.wake.notify_one();
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Documents;
    use ide_core::LanguageId;
    use ide_vfs::Watcher;
    use std::fs;
    use std::path::Path;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    /// A batch whose history recording is still waiting (here on an IDE move)
    /// must not hold back the next batch's document reload.
    #[test]
    fn open_documents_reload_while_history_is_busy() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("project");
        fs::create_dir(&root).unwrap();
        let root = dunce::canonicalize(&root).unwrap();
        let busy = root.join("busy.txt");
        let open = root.join("open.txt");
        fs::write(&busy, "busy").unwrap();
        fs::write(&open, "before").unwrap();
        let history = Arc::new(LocalHistory::open(&tmp.path().join("history"), &root).unwrap());
        let docs = Arc::new(Documents::new(
            Arc::new(|_| {}),
            Box::new(|_: &Path, _: Option<&str>| LanguageId::new("plaintext")),
        ));
        let doc = docs.open(&open).unwrap().id;
        let recorder = ExternalChangeRecorder::new(history.clone(), 500);
        let (seen, batches) = mpsc::channel();
        let callback_docs = docs.clone();
        // Same order as the project's watcher callback: documents, then history.
        let watcher = Watcher::start(
            &root,
            Vec::new(),
            Arc::new(|_| {}),
            Box::new(move |batch| {
                let changed: Vec<_> = batch.created.iter().chain(&batch.modified).cloned().collect();
                callback_docs.on_disk_changed(&changed);
                recorder.record(&changed, &batch.removed);
                let _ = seen.send(changed);
            }),
        )
        .unwrap();
        assert!(watcher.polling().is_none(), "requires real native watcher");

        let moving = history.file_move_guard();
        fs::write(&busy, "busy, changed").unwrap();
        let first = batches.recv_timeout(Duration::from_secs(5)).expect("first batch");
        assert!(first.contains(&busy), "{first:?}");
        fs::write(&open, "after").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while docs.snapshot(doc).unwrap().text != "after" {
            assert!(Instant::now() < deadline, "the open document did not reload while history was busy");
            std::thread::sleep(Duration::from_millis(20));
        }
        drop(moving);
        drop(watcher);
        let labels: Vec<_> = history.list(&busy).unwrap().into_iter().map(|e| e.label).collect();
        assert_eq!(labels, vec!["External change"]);
    }

    #[test]
    fn queues_at_most_the_limit_of_changed_paths() {
        let paths: Vec<PathBuf> = (0..23_000).map(|i| PathBuf::from(format!("/p/{i}"))).collect();
        let mut pending = Pending::default();
        pending.push(paths.clone(), vec![PathBuf::from("/gone")], 500);
        let (changed, removed) = &pending.batches[0];
        assert_eq!(changed, &paths[..500]);
        assert_eq!(removed, &[PathBuf::from("/gone")]);
    }

    #[test]
    fn full_queue_merges_oldest_batches_in_order() {
        let mut pending = Pending::default();
        for i in 0..MAX_PENDING_BATCHES + 10 {
            pending.push(vec![PathBuf::from(format!("/c{i}"))], vec![PathBuf::from(format!("/r{i}"))], 500);
        }
        assert_eq!(pending.batches.len(), MAX_PENDING_BATCHES);
        assert_eq!(pending.coalesced, 10);
        let (changed, removed) = &pending.batches[0];
        let want = |p: &str| (0..=10).map(|i| PathBuf::from(format!("/{p}{i}"))).collect::<Vec<_>>();
        assert_eq!(changed, &want("c"));
        assert_eq!(removed, &want("r"));
        let last = pending.batches.back().unwrap();
        assert_eq!(last.0, vec![PathBuf::from(format!("/c{}", MAX_PENDING_BATCHES + 9))]);
    }

    #[test]
    fn records_batches_in_order() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        let file = root.join("a.txt");
        let history = Arc::new(LocalHistory::open(&root.join(".history"), &root).unwrap());
        let recorder = ExternalChangeRecorder::new(history.clone(), 500);
        let moving = history.file_move_guard();
        fs::write(&file, "one").unwrap();
        recorder.record(std::slice::from_ref(&file), &[]);
        drop(moving);
        // Wait for the first batch so the second one reads new content.
        let deadline = Instant::now() + Duration::from_secs(5);
        while history.list(&file).unwrap().is_empty() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        fs::write(&file, "two").unwrap();
        recorder.record(std::slice::from_ref(&file), &[]);
        while history.list(&file).unwrap().len() < 2 {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        let entries = history.list(&file).unwrap();
        let texts: Vec<_> = entries.iter().map(|e| history.content(&e.id).unwrap()).collect();
        assert!(entries.iter().all(|e| e.label == "External change"), "{entries:?}");
        // Newest first.
        assert_eq!(texts, ["two", "one"]);
    }
}
