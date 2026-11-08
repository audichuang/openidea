//! ClipCode / snip-sync clipboard copy and paste (`ide_host::ops::clip`).

use crate::state::AppState;
use ide_core::IdeResult;
use ide_host::ops::clip::{
    ClipBranchRestore, ClipBranchSeries, ClipCopyResult, ClipCopySource, ClipNonTextMode, ClipPasteApply,
    ClipPasteFileContent, ClipPastePreview, ClipPasteResult,
};
use std::path::PathBuf;
use tauri::{State, Window};

/// The clipboard text for `source` (file or commit payload); the UI writes it. `non_text`
/// `Exclude` still reports the non-text files found, for the dialog that asks before `Include`.
#[tauri::command]
#[specta::specta]
pub async fn clip_copy(
    window: Window,
    state: State<'_, AppState>,
    source: ClipCopySource,
    non_text: ClipNonTextMode,
) -> IdeResult<ClipCopyResult> {
    ide_host::ops::clip::clip_copy(&state.host, window.label(), source, non_text).await
}

/// Plans pasting `text`: files restore under `dest` (default: the project root),
/// commits replay into `repo` (the selected repository; default: `dest`'s). Nothing
/// is written; `repos` take the `<repo>/` prefixes of a payload copied from several
/// repositories.
#[tauri::command]
#[specta::specta]
pub async fn clip_paste_preview(
    window: Window,
    state: State<'_, AppState>,
    text: String,
    dest: Option<PathBuf>,
    repo: Option<PathBuf>,
    adjust_paths: bool,
    repos: Vec<PathBuf>,
) -> IdeResult<ClipPastePreview> {
    ide_host::ops::clip::clip_paste_preview(&state.host, window.label(), text, dest, repo, adjust_paths, repos).await
}

/// What the open preview `id`'s file `index` (of kind `action`) writes and what the
/// destination holds now, for the dialog's content pane.
#[tauri::command]
#[specta::specta]
pub async fn clip_paste_preview_file(
    window: Window,
    state: State<'_, AppState>,
    id: u32,
    action: String,
    index: u32,
) -> IdeResult<ClipPasteFileContent> {
    ide_host::ops::clip::clip_paste_preview_file(&state.host, window.label(), id, action, index).await
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

/// ClipCode for VS Code's Copy Branch Commits: `branch` since its fork point (or `full` history) as an mbox.
#[tauri::command]
#[specta::specta]
pub async fn clip_copy_branch_series(
    window: Window,
    state: State<'_, AppState>,
    repo: PathBuf,
    branch: String,
    base: Option<String>,
    full: bool,
) -> IdeResult<ClipBranchSeries> {
    ide_host::ops::clip::clip_copy_branch_series(&state.host, window.label(), repo, branch, base, full).await
}

/// Paste Branch Commits: restores an mbox as the new branch `name` (`git am --3way`).
#[tauri::command]
#[specta::specta]
pub async fn clip_paste_branch_series(
    window: Window,
    state: State<'_, AppState>,
    repo: PathBuf,
    text: String,
    name: String,
    on_head: bool,
) -> IdeResult<ClipBranchRestore> {
    ide_host::ops::clip::clip_paste_branch_series(&state.host, window.label(), repo, text, name, on_head).await
}
