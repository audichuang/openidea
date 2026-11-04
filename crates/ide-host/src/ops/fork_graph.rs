//! Fork-owned: the Git Graph view's extra queries and operations (`ide_vcs::fork_graph`),
//! as project-host operations so remote development serves them too.

use crate::Host;
use crate::rpc::Dispatcher;
use ide_core::IdeResult;
use ide_vcs::fork_graph::{
    GraphAuthorStat, GraphBisectOp, GraphBisectState, GraphRefOp, GraphReflogEntry, GraphStash, GraphTreeEntry,
    GraphWorkingState,
};
use std::path::PathBuf;

use super::coverage::blocking;

pub async fn graph_stashes(host: &Host, window: &str, repo: Option<PathBuf>) -> IdeResult<Vec<GraphStash>> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.graph_stashes())).await
}

pub async fn graph_working_state(host: &Host, window: &str, repo: Option<PathBuf>) -> IdeResult<GraphWorkingState> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.graph_working_state())).await
}

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

pub async fn graph_author_stats(host: &Host, window: &str, repo: Option<PathBuf>) -> IdeResult<Vec<GraphAuthorStat>> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.graph_author_stats())).await
}

pub async fn graph_tree(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    rev: String,
) -> IdeResult<Vec<GraphTreeEntry>> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.graph_tree(&rev))).await
}

pub async fn graph_bisect_state(host: &Host, window: &str, repo: Option<PathBuf>) -> IdeResult<GraphBisectState> {
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.graph_bisect_state())).await
}

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

pub async fn graph_ref_op(host: &Host, window: &str, repo: Option<PathBuf>, op: GraphRefOp) -> IdeResult<()> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    blocking(move || project.with_repo_at(repo.as_deref(), |r| r.graph_ref_op(&op))).await
}

pub(crate) fn register(d: &mut Dispatcher) {
    d.add("graph_stashes", |c| async move { graph_stashes(&c.host, &c.window, c.arg("repo")?).await });
    d.add("graph_working_state", |c| async move { graph_working_state(&c.host, &c.window, c.arg("repo")?).await });
    d.add("graph_reflog", |c| async move {
        graph_reflog(&c.host, &c.window, c.arg("repo")?, c.arg("reference")?, c.arg("limit")?).await
    });
    d.add("graph_author_stats", |c| async move { graph_author_stats(&c.host, &c.window, c.arg("repo")?).await });
    d.add("graph_tree", |c| async move { graph_tree(&c.host, &c.window, c.arg("repo")?, c.arg("rev")?).await });
    d.add("graph_bisect_state", |c| async move { graph_bisect_state(&c.host, &c.window, c.arg("repo")?).await });
    d.add("graph_bisect", |c| async move { graph_bisect(&c.host, &c.window, c.arg("repo")?, c.arg("op")?).await });
    d.add("graph_ref_op", |c| async move { graph_ref_op(&c.host, &c.window, c.arg("repo")?, c.arg("op")?).await });
}
