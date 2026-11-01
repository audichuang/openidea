//! ClipCode / snip-sync clipboard copy and paste (`ide_host::ops::clip`).

use crate::state::AppState;
use ide_core::IdeResult;
use ide_host::ops::clip::{ClipCopyResult, ClipCopySource, ClipPasteApply, ClipPastePreview, ClipPasteResult};
use std::path::PathBuf;
use tauri::{State, Window};

/// The clipboard text for `source` (file or commit payload); the UI writes it.
#[tauri::command]
#[specta::specta]
pub async fn clip_copy(
    window: Window,
    state: State<'_, AppState>,
    source: ClipCopySource,
) -> IdeResult<ClipCopyResult> {
    ide_host::ops::clip::clip_copy(&state.host, window.label(), source).await
}

/// Plans pasting `text` into `dest` (default: the project root). Nothing is written;
/// `repos` take the `<repo>/` prefixes of a payload copied from several repositories.
#[tauri::command]
#[specta::specta]
pub async fn clip_paste_preview(
    window: Window,
    state: State<'_, AppState>,
    text: String,
    dest: Option<PathBuf>,
    adjust_paths: bool,
    repos: Vec<PathBuf>,
) -> IdeResult<ClipPastePreview> {
    ide_host::ops::clip::clip_paste_preview(&state.host, window.label(), text, dest, adjust_paths, repos).await
}

/// Writes the preview `apply.id` as confirmed.
#[tauri::command]
#[specta::specta]
pub async fn clip_paste_apply(
    window: Window,
    state: State<'_, AppState>,
    apply: ClipPasteApply,
) -> IdeResult<ClipPasteResult> {
    ide_host::ops::clip::clip_paste_apply(&state.host, window.label(), apply).await
}
