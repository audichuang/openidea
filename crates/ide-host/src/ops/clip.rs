//! Clipboard copy / paste in the snip-sync / ClipCode format (`ide-clip`): the
//! file payload ClipCode (IntelliJ, VS Code) restores, and the commit payload
//! that replays commits in another repository. The frontend owns the system
//! clipboard; these commands build the text and plan / apply a paste of it.

use crate::Host;
use crate::rpc::Dispatcher;
use ide_clip::commits::{self, CommitsPayload, FilePlan};
use ide_clip::gitrun::RunOptions;
use ide_clip::gitsrc::{Git, GitSource};
use ide_clip::restore::{FsProbe, RestoreSelection, suggest_restore_base};
use ide_clip::settings::Settings;
use ide_clip::transfer::{
    self, CLIPBOARD_PAYLOAD_MAX, CanonicalRootId, CommitReplayPreview, ExportItem, ExportSelection, ImportMapping,
    TransferError, TransferImportPlan, changed_items, copy_selection_detailed, selection_from_paths,
};
use ide_core::{IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};

use super::coverage::blocking;

/// Files one copy may carry (snip-sync's desktop limit; bytes are capped at 32 MiB).
const FILE_COUNT_LIMIT: usize = 10_000;

fn settings() -> Settings {
    Settings { file_count_limit: FILE_COUNT_LIMIT as f64, ..Settings::default() }
}

fn err(e: impl std::fmt::Display) -> IdeError {
    IdeError::invalid(e.to_string())
}

/// Which uncommitted side a Commit tool window copy reads.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ClipChangeSide {
    /// Working tree and index together, as the change list shows them.
    Working,
    Staged,
    Unstaged,
}

/// What a copy takes. Paths are absolute; `paths` of a git source narrow it to
/// those files (empty: all of them).
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ClipCopySource {
    /// Files and folders as they are on disk (Project tool window).
    Files { paths: Vec<PathBuf> },
    /// Uncommitted changes, labelled `[NEW]` / `[MODIFIED]` / `[DELETED]` / `[MOVED]`.
    Changes { paths: Vec<PathBuf>, side: ClipChangeSide },
    /// The files a commit changed, at that commit.
    CommitFiles { repo: PathBuf, rev: String, paths: Vec<PathBuf> },
    /// The files changed between two revisions (`base`..`tip` endpoints), at `tip`.
    Range { repo: PathBuf, base: String, tip: String, paths: Vec<PathBuf> },
    /// Commits for replay: `selected` must be one first-parent chain ending at `tip`.
    Commits { repo: PathBuf, tip: String, selected: Vec<String> },
    /// The first-parent commits of `base`..`tip`, for replay (a pull request's commits).
    CommitRange { repo: PathBuf, base: String, tip: String },
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClipCopyResult {
    /// The clipboard text.
    pub text: String,
    /// `files` or `commits`.
    pub mode: String,
    pub files: u32,
    pub commits: u32,
    /// UTF-16 code units, as ClipCode counts them.
    pub chars: u32,
    pub lines: u32,
    pub tokens: u32,
    /// Files left out: unreadable, not UTF-8, over the size limit, or (commit
    /// mode) binary / symlink files whose change the replay cannot carry.
    pub skipped: u32,
    /// The file limit cut the copy short.
    pub truncated: bool,
}

fn n(v: usize) -> u32 {
    u32::try_from(v).unwrap_or(u32::MAX)
}

fn repo_root(path: &Path) -> IdeResult<PathBuf> {
    let dir = if path.is_dir() { path } else { path.parent().unwrap_or(path) };
    let git = Git::open(dir).map_err(err)?;
    Ok(git.root().to_path_buf())
}

/// Relative paths (to `root`, `/`-separated) of `paths` under it.
fn rel_set(root: &Path, paths: &[PathBuf]) -> BTreeSet<String> {
    let canon = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    paths
        .iter()
        .filter_map(|p| {
            let rel = p.strip_prefix(root).or_else(|_| p.strip_prefix(&canon)).ok()?;
            Some(rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/"))
        })
        .collect()
}

/// The labelled changes of `source` in each repository of `paths` (or `repo`), narrowed to `paths`.
fn git_items(repos: &[(PathBuf, Vec<PathBuf>)], source: impl Fn() -> GitSource) -> IdeResult<(Vec<ExportItem>, usize)> {
    let opts = RunOptions::default();
    let mut items = Vec::new();
    let mut skipped = 0;
    for (root, paths) in repos {
        let git = Git::open(root).map_err(err)?;
        let id = CanonicalRootId::new(git.root()).map_err(err)?;
        let changed = changed_items(&id, &git, &source(), &opts).map_err(err)?;
        skipped += changed.skipped_non_utf8;
        let wanted = rel_set(git.root(), paths);
        items.extend(changed.items.into_iter().filter(|i| {
            // "" is the repository itself (its root was selected).
            wanted.is_empty()
                || wanted.contains("")
                || wanted.iter().any(|w| i.relative_path == *w || i.relative_path.starts_with(&format!("{w}/")))
        }));
    }
    Ok((items, skipped))
}

/// `paths` grouped by repository, in first-seen order.
fn by_repo(paths: &[PathBuf]) -> IdeResult<Vec<(PathBuf, Vec<PathBuf>)>> {
    let mut out: Vec<(PathBuf, Vec<PathBuf>)> = Vec::new();
    for p in paths {
        let root = repo_root(p)?;
        match out.iter_mut().find(|(r, _)| *r == root) {
            Some((_, list)) => list.push(p.clone()),
            None => out.push((root, vec![p.clone()])),
        }
    }
    Ok(out)
}

fn file_copy(sel: ExportSelection, primary_skipped: usize) -> IdeResult<ClipCopyResult> {
    let report = copy_selection_detailed(sel, &settings(), FILE_COUNT_LIMIT, &RunOptions::default(), |_| {}).map_err(
        |e| match e {
            TransferError::EmptySelection => IdeError::invalid("Nothing to copy: every selected file was skipped"),
            e => err(e),
        },
    )?;
    let o = report.outcome;
    if o.copied == 0 {
        return Err(IdeError::invalid("Nothing to copy"));
    }
    Ok(ClipCopyResult {
        mode: "files".into(),
        files: n(o.copied),
        commits: 0,
        chars: n(o.chars),
        lines: n(o.lines),
        tokens: n(o.tokens),
        skipped: n(o.skipped + primary_skipped),
        truncated: o.truncated,
        text: o.payload,
    })
}

fn selection(items: Vec<ExportItem>, primary: Option<PathBuf>) -> IdeResult<ExportSelection> {
    if items.is_empty() {
        return Err(IdeError::invalid("Nothing to copy"));
    }
    let mut roots: Vec<PathBuf> = Vec::new();
    for item in &items {
        let root = item.root.path().to_path_buf();
        if !roots.contains(&root) {
            roots.push(root);
        }
    }
    let primary = primary.filter(|p| roots.contains(p)).unwrap_or_else(|| roots[0].clone());
    ExportSelection::new(roots, Some(primary), items).map_err(err)
}

fn commit_result(export: commits::CommitExport) -> ClipCopyResult {
    let summary = commits::copy_summary(&export.payload, &export.text);
    ClipCopyResult {
        mode: "commits".into(),
        files: n(summary.file_count),
        commits: n(summary.commit_count),
        chars: n(summary.chars),
        lines: n(export.text.lines().count()),
        tokens: 0,
        skipped: n(summary.not_copied_count),
        truncated: false,
        text: export.text,
    }
}

/// Builds the clipboard text for `source`. `project` is the primary root (its
/// name goes in the `clipcode-root` line when the copy has one root).
pub fn copy(project: &Path, source: ClipCopySource) -> IdeResult<ClipCopyResult> {
    let opts = RunOptions::default();
    match source {
        ClipCopySource::Files { paths } => {
            let mut sel: Option<ExportSelection> = None;
            let mut skipped = 0;
            // Files of one root plan together; several roots join one selection.
            let mut groups: Vec<(PathBuf, Vec<PathBuf>)> = Vec::new();
            for p in &paths {
                let root = if p.starts_with(project) { project.to_path_buf() } else { repo_root(p)? };
                match groups.iter_mut().find(|(r, _)| *r == root) {
                    Some((_, list)) => list.push(p.clone()),
                    None => groups.push((root, vec![p.clone()])),
                }
            }
            for (root, list) in groups {
                let part = selection_from_paths(&root, &root, &list).map_err(err)?;
                skipped += part.skipped;
                sel = Some(match sel {
                    None => part.sel,
                    Some(prev) => {
                        let mut items = prev.items.clone();
                        items.extend(part.sel.items);
                        let mut roots: Vec<PathBuf> = prev.roots.iter().map(|r| r.path().to_path_buf()).collect();
                        roots.extend(part.sel.roots.iter().map(|r| r.path().to_path_buf()));
                        ExportSelection::new(roots, prev.primary_root.map(|r| r.path().to_path_buf()), items)
                            .map_err(err)?
                            .with_source_root(prev.source_root)
                            .with_spelled_root(prev.spelled_root)
                    }
                });
            }
            file_copy(sel.ok_or_else(|| IdeError::invalid("Nothing to copy"))?, skipped)
        }
        ClipCopySource::Changes { paths, side } => {
            let repos = by_repo(&paths)?;
            let (mut items, skipped) = match side {
                ClipChangeSide::Staged => git_items(&repos, || GitSource::Staged)?,
                ClipChangeSide::Working | ClipChangeSide::Unstaged => git_items(&repos, || GitSource::Working)?,
            };
            if matches!(side, ClipChangeSide::Unstaged) {
                for item in &mut items {
                    item.source = transfer::SourceKind::Unstaged;
                }
            }
            file_copy(selection(items, Some(project.to_path_buf()))?, skipped)
        }
        ClipCopySource::CommitFiles { repo, rev, paths } => {
            let root = repo_root(&repo)?;
            let (items, skipped) = git_items(&[(root.clone(), paths)], || GitSource::Commit(rev.clone()))?;
            file_copy(selection(items, Some(root))?, skipped)
        }
        ClipCopySource::Range { repo, base, tip, paths } => {
            let root = repo_root(&repo)?;
            let (items, skipped) = git_items(&[(root.clone(), paths)], || GitSource::Range(base.clone(), tip.clone()))?;
            file_copy(selection(items, Some(root))?, skipped)
        }
        ClipCopySource::Commits { repo, tip, selected } => {
            let git = Git::open(&repo).map_err(err)?;
            let export = transfer::plan_commit_export_exact_with(&git, &tip, &selected, &opts, CLIPBOARD_PAYLOAD_MAX)
                .map_err(err)?;
            Ok(commit_result(export))
        }
        ClipCopySource::CommitRange { repo, base, tip } => {
            let git = Git::open(&repo).map_err(err)?;
            let export =
                transfer::plan_commit_export_with(&git, Some((&base, &tip)), None, &opts, CLIPBOARD_PAYLOAD_MAX)
                    .map_err(err)?;
            Ok(commit_result(export))
        }
    }
}

// ---------------------------------------------------------------------------
// Paste

/// One file a file-mode paste would touch.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClipPasteFile {
    /// Index within its kind (creates / deletes), used to leave it out.
    pub index: u32,
    /// The path in the payload.
    pub path: String,
    /// Absolute target, when it resolves.
    pub target: Option<String>,
    /// `create`, `overwrite`, `delete` or `skip`.
    pub action: String,
    /// Why it is skipped (`skip` only).
    pub reason: Option<String>,
}

/// One file of a replayed commit.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClipReplayFile {
    pub path: String,
    pub old_path: Option<String>,
    /// `ADDED`, `MODIFIED`, `DELETED` or `RENAMED`.
    pub change: String,
    /// `WRITE`, `DELETE` or `SKIP`.
    pub action: String,
    /// The write replaces a file that exists in the destination.
    pub overwrites: bool,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClipReplayCommit {
    pub message: String,
    pub author_name: String,
    pub author_email: String,
    pub author_date: String,
    pub files: Vec<ClipReplayFile>,
    /// Why the replay stops at this commit, if it would.
    pub refused: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClipPastePreview {
    /// Hand back to `clip_paste_apply`.
    pub id: u32,
    /// `files` or `commits`.
    pub mode: String,
    /// Where the paste lands (the repository for commits).
    pub destination: String,
    pub files: Vec<ClipPasteFile>,
    pub commits: Vec<ClipReplayCommit>,
    /// A restore base the files would better land under (`adjustPaths`).
    pub suggestion: Option<String>,
    pub adjusted: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClipPasteApply {
    pub id: u32,
    /// Creates (by index) whose target exists and may be overwritten.
    pub overwrite: Vec<u32>,
    /// Creates / deletes (by index) left out.
    pub unchecked_creates: Vec<u32>,
    pub unchecked_deletes: Vec<u32>,
    /// Commit mode: replace files that exist in the destination.
    pub overwrite_existing: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClipPasteResult {
    pub created: u32,
    pub overwritten: u32,
    pub deleted: u32,
    pub skipped: u32,
    /// Commit ids the replay created, oldest first.
    pub commits: Vec<String>,
    pub errors: Vec<String>,
}

enum Pending {
    Files(Box<TransferImportPlan>),
    Commits(Box<CommitReplayPreview>),
}

static NEXT: AtomicU32 = AtomicU32::new(1);
/// The last preview per window: an Apply writes exactly what was shown.
static PENDING: Mutex<Option<HashMap<u32, Pending>>> = Mutex::new(None);

fn keep(p: Pending) -> u32 {
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let mut guard = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    // One open preview at a time is all the UI shows; older ones are dropped.
    map.clear();
    map.insert(id, p);
    id
}

fn same_dir(a: &Path, b: &Path) -> bool {
    a == b || std::fs::canonicalize(a).ok().zip(std::fs::canonicalize(b).ok()).is_some_and(|(a, b)| a == b)
}

fn tag<T: Serialize>(v: &T) -> String {
    serde_json::to_value(v).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
}

fn replay_file(f: &FilePlan) -> ClipReplayFile {
    let action = tag(&f.action);
    // A deletion whose target is not in the destination writes nothing (snip-sync shows
    // it as skipped, "already absent", never as a deletion).
    let absent = action == "DELETE" && !f.existed && f.layout_conflict.is_none();
    ClipReplayFile {
        path: f.path.clone(),
        old_path: f.old_path.clone(),
        change: tag(&f.change),
        action: if absent { "SKIP".into() } else { action },
        overwrites: f.overwrites_existing(),
        reason: f
            .layout_conflict
            .map(|c| c.describe().to_string())
            .or_else(|| f.not_copied.map(|r| tag(&r)))
            .or_else(|| f.skip_reason.map(|r| tag(&r)))
            .or_else(|| absent.then(|| "ALREADY_ABSENT".into())),
    }
}

/// Plans pasting `text` into `dest` (a folder; commits replay into its repository). Nothing is written.
///
/// A payload copied from several repositories names the others' files `<repo>/…`
/// (it has no `clipcode-root` line). Such a prefix lands in the repository of
/// `repos` with that folder name, as snip-sync's prefix mapping would put it.
pub fn paste_preview(dest: &Path, text: &str, adjust_paths: bool, repos: &[PathBuf]) -> IdeResult<ClipPastePreview> {
    let opts = RunOptions::default();
    if text.len() > CLIPBOARD_PAYLOAD_MAX {
        return Err(IdeError::invalid("The clipboard holds more than 32 MiB"));
    }
    if commits::is_commit_payload(text) {
        let payload: CommitsPayload = commits::parse_commit_payload(text).map_err(err)?;
        let root = repo_root(dest)?;
        let preview = CommitReplayPreview::capture_in(&root, &root, &payload, &opts).map_err(err)?;
        let plan = preview.plan();
        let commits = plan
            .commits
            .iter()
            .map(|c| ClipReplayCommit {
                message: c.message.clone(),
                author_name: c.author_name.clone(),
                author_email: c.author_email.clone(),
                author_date: c.author_date.clone(),
                files: c.files.iter().map(replay_file).collect(),
                refused: c.refused_by().map(|r| r.describe().to_string()),
            })
            .collect();
        let destination = root.to_string_lossy().into_owned();
        let id = keep(Pending::Commits(Box::new(preview)));
        return Ok(ClipPastePreview {
            id,
            mode: "commits".into(),
            destination,
            files: Vec::new(),
            commits,
            suggestion: None,
            adjusted: false,
        });
    }
    let header = "";
    let entries = ide_clip::format::parse_clipboard(text, header);
    if entries.is_empty() {
        return Err(IdeError::invalid("The clipboard holds no ClipCode / snip-sync files"));
    }
    let paths: Vec<String> = entries.into_iter().map(|e| e.path).collect();
    let suggestion = suggest_restore_base(
        &dest.to_string_lossy(),
        &paths,
        &FsProbe,
        ide_clip::format::extract_source_root(text).as_deref(),
    );
    let primary = CanonicalRootId::new(dest).map_err(err)?;
    let mut mapping = match suggestion.as_ref().filter(|_| adjust_paths) {
        Some(s) => ImportMapping::from_restore_base(s, primary),
        None => ImportMapping::with_primary(primary),
    };
    let mut roots = vec![dest.to_path_buf()];
    if ide_clip::format::extract_source_root(text).is_none() {
        for prefix in transfer::detect_clipboard_prefixes(text, header) {
            let Some(repo) =
                repos.iter().find(|r| r.file_name().is_some_and(|n| n.to_string_lossy() == prefix.as_str()))
            else {
                continue;
            };
            if same_dir(repo, dest) {
                continue;
            }
            mapping.map_prefix(prefix, CanonicalRootId::new(repo).map_err(err)?);
            roots.push(repo.clone());
        }
    }
    let plan = transfer::plan_import_with(text, header, &roots, &mapping, &opts).map_err(err)?;
    let restore = plan.restore_plan();
    let mut files = Vec::new();
    for (i, op) in restore.create_operations.iter().enumerate() {
        files.push(ClipPasteFile {
            index: n(i),
            path: op.relative_path.clone(),
            target: Some(op.absolute_path.to_string_lossy().into_owned()),
            action: if op.existed { "overwrite" } else { "create" }.into(),
            reason: None,
        });
    }
    for (i, op) in restore.delete_operations.iter().enumerate() {
        files.push(ClipPasteFile {
            index: n(i),
            path: op.relative_path.clone(),
            target: Some(op.absolute_path.to_string_lossy().into_owned()),
            action: "delete".into(),
            reason: None,
        });
    }
    for (i, op) in restore.skipped_operations.iter().enumerate() {
        files.push(ClipPasteFile {
            index: n(i),
            path: op.relative_path.clone().unwrap_or_else(|| op.raw_path.clone()),
            target: None,
            action: "skip".into(),
            reason: Some(op.reason.as_str().to_string()),
        });
    }
    let id = keep(Pending::Files(Box::new(plan)));
    Ok(ClipPastePreview {
        id,
        mode: "files".into(),
        destination: dest.to_string_lossy().into_owned(),
        files,
        commits: Vec::new(),
        suggestion: suggestion.map(|s| s.label),
        adjusted: adjust_paths,
    })
}

/// Writes the preview `req.id` as confirmed. Refuses when the destination changed since.
pub fn paste_apply(req: ClipPasteApply) -> IdeResult<ClipPasteResult> {
    let pending = {
        let mut guard = PENDING.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_mut().and_then(|m| m.remove(&req.id))
    }
    .ok_or_else(|| IdeError::invalid("The paste preview is gone; paste again"))?;
    match pending {
        Pending::Files(plan) => {
            let restore = plan.restore_plan();
            let overwrite: BTreeSet<usize> = req.overwrite.iter().map(|&i| i as usize).collect();
            let mut unchecked: BTreeSet<usize> = req.unchecked_creates.iter().map(|&i| i as usize).collect();
            // An existing target not chosen for overwrite stays as it is.
            for (i, op) in restore.create_operations.iter().enumerate() {
                if op.existed && !overwrite.contains(&i) {
                    unchecked.insert(i);
                }
            }
            let selection = RestoreSelection {
                overwrite_existing: true,
                skip_existing: false,
                unchecked_creates: unchecked,
                unchecked_deletes: req.unchecked_deletes.iter().map(|&i| i as usize).collect(),
            };
            let r = plan.apply(&selection).map_err(|e| IdeError::invalid(e.paste_message()))?;
            Ok(ClipPasteResult {
                created: n(r.created_count),
                overwritten: n(r.overwritten_count),
                deleted: n(r.deleted_count),
                skipped: n(r.total_skipped()),
                commits: Vec::new(),
                errors: r.errors,
            })
        }
        Pending::Commits(preview) => {
            preview.revalidate().map_err(|e| IdeError::invalid(e.paste_message()))?;
            if !req.overwrite_existing && !preview.plan().existing_writes().is_empty() {
                return Err(IdeError::invalid("Files of the commits exist in the destination; allow overwriting"));
            }
            let r = preview.apply().map_err(|e| IdeError::invalid(e.paste_message()))?;
            let mut errors = Vec::new();
            if let Some(f) = &r.failure {
                errors.push(format!(
                    "Commit {} ({}) failed: {}",
                    f.index + 1,
                    f.message.lines().next().unwrap_or(""),
                    f.error
                ));
            }
            Ok(ClipPasteResult { commits: r.created, errors, ..Default::default() })
        }
    }
}

// ---------------------------------------------------------------------------
// Commands

pub async fn clip_copy(host: &Host, window: &str, source: ClipCopySource) -> IdeResult<ClipCopyResult> {
    let project = host.project(window)?;
    blocking(move || copy(&project.root, source)).await
}

pub async fn clip_paste_preview(
    host: &Host,
    window: &str,
    text: String,
    dest: Option<PathBuf>,
    adjust_paths: bool,
    repos: Vec<PathBuf>,
) -> IdeResult<ClipPastePreview> {
    let project = host.project(window)?;
    blocking(move || paste_preview(dest.as_deref().unwrap_or(&project.root), &text, adjust_paths, &repos)).await
}

pub async fn clip_paste_apply(host: &Host, window: &str, apply: ClipPasteApply) -> IdeResult<ClipPasteResult> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let result = blocking(move || paste_apply(apply)).await?;
    project.sink.emit(ide_core::IdeEvent::VcsChanged { root: project.root.clone().into() });
    Ok(result)
}

pub(crate) fn register(d: &mut Dispatcher) {
    d.add("clip_copy", |c| async move { clip_copy(&c.host, &c.window, c.arg("source")?).await });
    d.add("clip_paste_preview", |c| async move {
        clip_paste_preview(&c.host, &c.window, c.arg("text")?, c.arg("dest")?, c.arg("adjustPaths")?, c.arg("repos")?)
            .await
    });
    d.add("clip_paste_apply", |c| async move { clip_paste_apply(&c.host, &c.window, c.arg("apply")?).await });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    }

    fn repo(dir: &Path) -> PathBuf {
        fs::create_dir_all(dir).unwrap();
        git(dir, &["init", "-q", "-b", "main"]);
        git(dir, &["config", "user.name", "Tester"]);
        git(dir, &["config", "user.email", "t@example.com"]);
        git(dir, &["config", "commit.gpgsign", "false"]);
        fs::write(dir.join("README.md"), "base\n").unwrap();
        git(dir, &["add", "-A"]);
        git(dir, &["commit", "-q", "-m", "init"]);
        std::fs::canonicalize(dir).unwrap()
    }

    #[test]
    fn files_round_trip_through_the_clipcode_format() {
        let tmp = tempfile::tempdir().unwrap();
        let a = repo(&tmp.path().join("a"));
        fs::create_dir_all(a.join("src")).unwrap();
        fs::write(a.join("src/App.kt"), "fun main() = println(\"hi\")\n").unwrap();
        let copied = copy(&a, ClipCopySource::Files { paths: vec![a.join("src")] }).unwrap();
        assert_eq!(copied.mode, "files");
        assert_eq!(copied.files, 1);
        assert!(copied.text.contains("// file: src/App.kt"), "{}", copied.text);

        let b = repo(&tmp.path().join("b"));
        let preview = paste_preview(&b, &copied.text, false, &[]).unwrap();
        assert_eq!(preview.mode, "files");
        assert_eq!(
            preview.files.iter().map(|f| (f.path.as_str(), f.action.as_str())).collect::<Vec<_>>(),
            [("src/App.kt", "create")]
        );
        let result = paste_apply(ClipPasteApply { id: preview.id, ..Default::default() }).unwrap();
        assert_eq!(result.created, 1);
        assert_eq!(fs::read_to_string(b.join("src/App.kt")).unwrap(), "fun main() = println(\"hi\")");
    }

    #[test]
    fn an_existing_file_is_overwritten_only_when_chosen() {
        let tmp = tempfile::tempdir().unwrap();
        let a = repo(&tmp.path().join("a"));
        fs::write(a.join("README.md"), "from a\n").unwrap();
        let copied = copy(&a, ClipCopySource::Files { paths: vec![a.join("README.md")] }).unwrap();
        let b = repo(&tmp.path().join("b"));

        let preview = paste_preview(&b, &copied.text, false, &[]).unwrap();
        assert_eq!(preview.files[0].action, "overwrite");
        let kept = paste_apply(ClipPasteApply { id: preview.id, ..Default::default() }).unwrap();
        assert_eq!(kept.overwritten, 0);
        assert_eq!(fs::read_to_string(b.join("README.md")).unwrap(), "base\n");

        let preview = paste_preview(&b, &copied.text, false, &[]).unwrap();
        let written = paste_apply(ClipPasteApply { id: preview.id, overwrite: vec![0], ..Default::default() }).unwrap();
        assert_eq!(written.overwritten, 1);
        assert_eq!(fs::read_to_string(b.join("README.md")).unwrap(), "from a");
    }

    #[test]
    fn staged_changes_carry_their_labels() {
        let tmp = tempfile::tempdir().unwrap();
        let a = repo(&tmp.path().join("a"));
        fs::write(a.join("README.md"), "changed\n").unwrap();
        fs::write(a.join("new.txt"), "new\n").unwrap();
        git(&a, &["add", "-A"]);
        fs::write(a.join("README.md"), "changed again, unstaged\n").unwrap();
        let copied =
            copy(&a, ClipCopySource::Changes { paths: vec![a.clone()], side: ClipChangeSide::Staged }).unwrap();
        assert!(copied.text.contains("// file: [MODIFIED] README.md"), "{}", copied.text);
        assert!(copied.text.contains("// file: [NEW] new.txt"), "{}", copied.text);
        // The index's content, not the working tree's.
        assert!(copied.text.contains("changed\n") && !copied.text.contains("unstaged"), "{}", copied.text);
    }

    #[test]
    fn commits_replay_with_their_message_and_author() {
        let tmp = tempfile::tempdir().unwrap();
        let a = repo(&tmp.path().join("a"));
        fs::write(a.join("one.txt"), "1\n").unwrap();
        git(&a, &["add", "-A"]);
        git(&a, &["commit", "-q", "-m", "feat: one", "--author", "Alice <alice@example.com>"]);
        let first = git(&a, &["rev-parse", "HEAD"]);
        fs::write(a.join("two.txt"), "2\n").unwrap();
        git(&a, &["add", "-A"]);
        git(&a, &["commit", "-q", "-m", "feat: two"]);
        let tip = git(&a, &["rev-parse", "HEAD"]);

        let copied =
            copy(&a, ClipCopySource::Commits { repo: a.clone(), tip: tip.clone(), selected: vec![tip, first] })
                .unwrap();
        assert_eq!(copied.mode, "commits");
        assert_eq!(copied.commits, 2);
        assert!(copied.text.starts_with("// snip-sync commits v1\n"));

        let b = repo(&tmp.path().join("b"));
        let preview = paste_preview(&b, &copied.text, false, &[]).unwrap();
        assert_eq!(preview.mode, "commits");
        assert_eq!(preview.commits.len(), 2);
        let result = paste_apply(ClipPasteApply { id: preview.id, ..Default::default() }).unwrap();
        assert_eq!(result.commits.len(), 2, "{:?}", result.errors);
        assert_eq!(git(&b, &["log", "-2", "--format=%s|%an"]), "feat: two|Tester\nfeat: one|Alice");
        assert_eq!(fs::read_to_string(b.join("two.txt")).unwrap(), "2\n");
    }

    #[test]
    fn a_range_copies_the_files_changed_between_two_revisions() {
        let tmp = tempfile::tempdir().unwrap();
        let a = repo(&tmp.path().join("a"));
        let base = git(&a, &["rev-parse", "HEAD"]);
        git(&a, &["checkout", "-q", "-b", "topic"]);
        fs::write(a.join("feature.txt"), "f\n").unwrap();
        git(&a, &["add", "-A"]);
        git(&a, &["commit", "-q", "-m", "topic"]);
        let tip = git(&a, &["rev-parse", "HEAD"]);
        let files =
            copy(&a, ClipCopySource::Range { repo: a.clone(), base: base.clone(), tip: tip.clone(), paths: vec![] })
                .unwrap();
        assert!(files.text.contains("// file: [NEW] feature.txt"), "{}", files.text);
        let commits = copy(&a, ClipCopySource::CommitRange { repo: a.clone(), base, tip }).unwrap();
        assert_eq!(commits.commits, 1);
    }

    #[test]
    fn a_stale_preview_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let a = repo(&tmp.path().join("a"));
        fs::write(a.join("x.txt"), "x\n").unwrap();
        let copied = copy(&a, ClipCopySource::Files { paths: vec![a.join("x.txt")] }).unwrap();
        let b = repo(&tmp.path().join("b"));
        let preview = paste_preview(&b, &copied.text, false, &[]).unwrap();
        fs::write(b.join("x.txt"), "appeared meanwhile\n").unwrap();
        assert!(paste_apply(ClipPasteApply { id: preview.id, ..Default::default() }).is_err());
        assert_eq!(fs::read_to_string(b.join("x.txt")).unwrap(), "appeared meanwhile\n");
    }
}
