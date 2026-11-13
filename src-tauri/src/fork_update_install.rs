//! Windows: a downloaded update installs at the end of the normal restart.
//!
//! On Windows `Update::install` starts the NSIS installer and calls `std::process::exit(0)` at
//! once. Calling it from `app_install_update` skipped the whole quit flow: the unsaved-changes
//! check, the session hand-over and `RunEvent::Exit`'s cleanup, so a dev server started from a
//! run configuration kept its port. The download is staged instead; the UI then calls
//! `app_restart` as on macOS, and `RunEvent::Exit` installs it once its cleanup is done.

use std::sync::Mutex;
use tauri_plugin_updater::Update;

static STAGED: Mutex<Option<(Update, Vec<u8>)>> = Mutex::new(None);

/// Keeps the download for [`install_staged`]; a newer download replaces an older one.
pub(crate) fn stage(update: Update, bytes: Vec<u8>) {
    tracing::info!(version = %update.version, "update downloaded; it installs when OpenIDEA restarts");
    *STAGED.lock().unwrap_or_else(|e| e.into_inner()) = Some((update, bytes));
}

/// Starts the staged installer, which ends this process. Returns when nothing is staged or the
/// installer could not be started (a cancelled elevation prompt), so the caller restarts as usual.
pub(crate) fn install_staged() {
    let Some((update, bytes)) = STAGED.lock().unwrap_or_else(|e| e.into_inner()).take() else {
        return;
    };
    record_now(&format!("INFO starting the installer for OpenIDEA {}", update.version));
    if let Err(error) = update.install(bytes) {
        record_now(&format!("ERROR could not start the update installer: {error}"));
    }
}

/// Writes straight to the log file: the non-blocking writer's guard is never dropped, so a line
/// queued just before `exit(0)` may never reach the file.
fn record_now(line: &str) {
    use std::io::Write as _;
    use tracing_subscriber::fmt::time::{FormatTime, SystemTime};
    let Some(path) = crate::logging::log_dir().and_then(crate::logging::latest_log) else {
        return;
    };
    let mut stamp = String::new();
    let _ = SystemTime.format_time(&mut tracing_subscriber::fmt::format::Writer::new(&mut stamp));
    if let Ok(mut file) = std::fs::OpenOptions::new().append(true).open(path) {
        let _ = writeln!(file, "{stamp} {line}");
    }
}
