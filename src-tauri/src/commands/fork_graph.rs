//! Fork-owned: the Git Graph view's extra queries and operations (`ide_host::ops::fork_graph`).

use crate::state::AppState;
use ide_core::IdeResult;
use ide_vcs::fork_graph::{
    GraphAuthorStat, GraphBisectOp, GraphBisectState, GraphRefOp, GraphReflogEntry, GraphStash, GraphTreeEntry,
    GraphWorkingState,
};
use std::path::PathBuf;
use tauri::{State, Window};

/// Stash entries with the commit each records and the commit it was made on.
#[tauri::command]
#[specta::specta]
pub async fn graph_stashes(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
) -> IdeResult<Vec<GraphStash>> {
    ide_host::ops::fork_graph::graph_stashes(&state.host, window.label(), repo).await
}

/// Staged, unstaged, untracked and conflicted counts of `repo`'s working tree.
#[tauri::command]
#[specta::specta]
pub async fn graph_working_state(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
) -> IdeResult<GraphWorkingState> {
    ide_host::ops::fork_graph::graph_working_state(&state.host, window.label(), repo).await
}

#[tauri::command]
#[specta::specta]
pub async fn graph_reflog(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    reference: String,
    limit: u32,
) -> IdeResult<Vec<GraphReflogEntry>> {
    ide_host::ops::fork_graph::graph_reflog(&state.host, window.label(), repo, reference, limit).await
}

#[tauri::command]
#[specta::specta]
pub async fn graph_author_stats(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
) -> IdeResult<Vec<GraphAuthorStat>> {
    ide_host::ops::fork_graph::graph_author_stats(&state.host, window.label(), repo).await
}

/// Every file of `rev` (`git ls-tree -r`).
#[tauri::command]
#[specta::specta]
pub async fn graph_tree(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    rev: String,
) -> IdeResult<Vec<GraphTreeEntry>> {
    ide_host::ops::fork_graph::graph_tree(&state.host, window.label(), repo, rev).await
}

#[tauri::command]
#[specta::specta]
pub async fn graph_bisect_state(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
) -> IdeResult<GraphBisectState> {
    ide_host::ops::fork_graph::graph_bisect_state(&state.host, window.label(), repo).await
}

#[tauri::command]
#[specta::specta]
pub async fn graph_bisect(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    op: GraphBisectOp,
) -> IdeResult<GraphBisectState> {
    ide_host::ops::fork_graph::graph_bisect(&state.host, window.label(), repo, op).await
}

/// Tag deletion and push, and a branch's upstream.
#[tauri::command]
#[specta::specta]
pub async fn graph_ref_op(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    op: GraphRefOp,
) -> IdeResult<()> {
    ide_host::ops::fork_graph::graph_ref_op(&state.host, window.label(), repo, op).await
}
