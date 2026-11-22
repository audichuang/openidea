//! Fork-owned: the Git Graph view's extra queries and operations (`ide_vcs::fork_graph`),
//! as project-host operations so remote development serves them too.

use crate::Host;
use ide_command::command;
use ide_core::IdeResult;
use ide_vcs::fork_graph::{
    GraphAuthorStat, GraphBisectOp, GraphBisectState, GraphRefOp, GraphReflogEntry, GraphRevCounts, GraphStash,
    GraphTreeEntry, GraphWorkingState,
};
use std::path::PathBuf;

use super::coverage::blocking;

/// Stash entries with the commit each records and the commit it was made on.
#[command(trust = trusted)]
pub async fn graph_stashes(host: &Host, window: &str, repo: Option<PathBuf>) -> IdeResult<Vec<GraphStash>> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.graph_stashes())).await
}

/// Staged, unstaged, untracked and conflicted counts of `repo`'s working tree.
#[command(trust = trusted)]
pub async fn graph_working_state(host: &Host, window: &str, repo: Option<PathBuf>) -> IdeResult<GraphWorkingState> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.graph_working_state())).await
}

/// Ahead and behind commit counts of `head` relative to `base`.
#[command(trust = always)]
pub async fn graph_rev_counts(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    base: String,
    head: String,
) -> IdeResult<GraphRevCounts> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.graph_rev_counts(&base, &head))).await
}

#[command(trust = trusted)]
pub async fn graph_reflog(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    reference: String,
    limit: u32,
) -> IdeResult<Vec<GraphReflogEntry>> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.graph_reflog(&reference, limit))).await
}

#[command(trust = trusted)]
pub async fn graph_author_stats(host: &Host, window: &str, repo: Option<PathBuf>) -> IdeResult<Vec<GraphAuthorStat>> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.graph_author_stats())).await
}

/// Every file of `rev` (`git ls-tree -r`).
#[command(trust = trusted)]
pub async fn graph_tree(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    rev: String,
) -> IdeResult<Vec<GraphTreeEntry>> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.graph_tree(&rev))).await
}

#[command(trust = trusted)]
pub async fn graph_bisect_state(host: &Host, window: &str, repo: Option<PathBuf>) -> IdeResult<GraphBisectState> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.graph_bisect_state())).await
}

#[command(trust = trusted)]
pub async fn graph_bisect(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    op: GraphBisectOp,
) -> IdeResult<GraphBisectState> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.graph_bisect(&op))).await
}

/// Tag deletion and push, and a branch's upstream.
#[command(trust = trusted)]
pub async fn graph_ref_op(host: &Host, window: &str, repo: Option<PathBuf>, op: GraphRefOp) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.graph_ref_op(&op))).await
}

ide_command::domain!(
    fork_graph:
    graph_author_stats,
    graph_bisect,
    graph_bisect_state,
    graph_ref_op,
    graph_reflog,
    graph_rev_counts,
    graph_stashes,
    graph_tree,
    graph_working_state,
);
