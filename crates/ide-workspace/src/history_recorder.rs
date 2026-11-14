//! Records file watcher batches into Local History on a worker thread.
//!
//! Snapshotting is slow for a large batch: a checkout that touches thousands of
//! files writes hundreds of blobs. Done on the watcher thread, it held back the
//! next batches, so open documents kept showing the previous revision (and
//! Annotate blamed it) for half a minute or more after a `git checkout`.

use crate::history::LocalHistory;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::thread::JoinHandle;

type Batch = (Vec<PathBuf>, Vec<PathBuf>);

/// Queues watcher batches for [`LocalHistory::record_external_changes`], one at a
/// time and in order. Dropping it waits for the batch being recorded and skips
/// the queued ones, so nothing writes into the history after the project closed.
pub struct ExternalChangeRecorder {
    queue: Option<Sender<Batch>>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl ExternalChangeRecorder {
    /// `limit`: files snapshotted per batch, as in `record_external_changes`.
    pub fn new(history: Arc<LocalHistory>, limit: usize) -> Self {
        let (tx, rx) = channel::<Batch>();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let worker = std::thread::Builder::new()
            .name("openidea-history".into())
            .spawn(move || {
                for (changed, removed) in rx {
                    if stopping.load(Ordering::Acquire) {
                        break;
                    }
                    history.record_external_changes(&changed, &removed, limit);
                }
            })
            .map_err(|e| tracing::warn!("local history worker: {e}"))
            .ok();
        Self { queue: worker.as_ref().map(|_| tx), stop, worker }
    }

    /// Returns at once; the batch is recorded after the ones queued before it.
    pub fn record(&self, changed: &[PathBuf], removed: &[PathBuf]) {
        if changed.is_empty() && removed.is_empty() {
            return;
        }
        if let Some(queue) = &self.queue {
            let _ = queue.send((changed.to_vec(), removed.to_vec()));
        }
    }
}

impl Drop for ExternalChangeRecorder {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.queue.take();
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
    }
}
