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

/// Version Control › ClipCode as the payload engine reads it (the plugins' keys).
pub fn clip_settings(s: &ide_core::settings::ClipCodeSettings) -> Settings {
    ide_clip::settings::normalize(&serde_json::to_value(s).unwrap_or_default())
}

/// The batch a copy expands folders in: the file limit, or (no limit) a large one.
fn file_limit(settings: &Settings) -> usize {
    if settings.set_max_file_count { settings.file_count_limit as usize } else { 100_000 }
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
    /// The files changed between a root commit's empty base and `tip`, at `tip`
    /// (a range whose oldest commit has no parent).
    RootRange { repo: PathBuf, tip: String, paths: Vec<PathBuf> },
    /// The union of the files each of `revs` (newest first) changed, each read as of
    /// the newest listed commit that touches it (`[DELETED]` when deleted there).
    CommitList { repo: PathBuf, revs: Vec<String>, paths: Vec<PathBuf> },
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
    pub words: u32,
    pub tokens: u32,
    /// Files left out: unreadable, not UTF-8, over the size limit, or (commit
    /// mode) binary / symlink files whose change the replay cannot carry.
    pub skipped: u32,
    /// Of `skipped`: over the size limit (copied as a placeholder).
    pub skipped_size: u32,
    /// Of `skipped`: binary, not UTF-8 or unreadable.
    pub skipped_unreadable: u32,
    /// The file limit cut the copy short.
    pub truncated: bool,
    /// The file limit in force (`truncated` names it).
    pub file_limit: u32,
    /// Settings › ClipCode › "Show notification after copying".
    pub notify: bool,
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

fn file_copy(sel: ExportSelection, primary_skipped: usize, settings: &Settings) -> IdeResult<ClipCopyResult> {
    let report =
        copy_selection_detailed(sel, settings, file_limit(settings), &RunOptions::default(), |_| {}).map_err(|e| {
            match e {
                TransferError::EmptySelection => IdeError::invalid("Nothing to copy: every selected file was skipped"),
                e => err(e),
            }
        })?;
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
        words: n(o.words),
        tokens: n(o.tokens),
        skipped: n(o.skipped + primary_skipped),
        skipped_size: n(report.skipped_file_size),
        skipped_unreadable: n(report.skipped_unreadable + primary_skipped),
        truncated: o.truncated,
        file_limit: n(file_limit(settings)),
        notify: settings.show_copy_notification,
        text: o.payload,
    })
}

/// A selection of git items (rooted at their repositories, which the export
/// reads) whose headers and `clipcode-root` line are anchored on `project`,
/// as ClipCode's `ClipboardPathResolver.fromProject` spells every copy.
fn git_selection(project: &Path, items: Vec<ExportItem>) -> IdeResult<ExportSelection> {
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
    ExportSelection::anchored(roots, project, items).map_err(err)
}

fn commit_result(export: commits::CommitExport, settings: &Settings) -> ClipCopyResult {
    let summary = commits::copy_summary(&export.payload, &export.text);
    let stats = ide_clip::stats::payload_stats(&export.text);
    ClipCopyResult {
        mode: "commits".into(),
        files: n(summary.file_count),
        commits: n(summary.commit_count),
        chars: n(summary.chars),
        lines: n(stats.lines),
        words: n(stats.words),
        tokens: n(stats.tokens),
        skipped: n(summary.not_copied_count),
        skipped_size: 0,
        skipped_unreadable: n(summary.not_copied_count),
        truncated: false,
        file_limit: 0,
        notify: settings.show_copy_notification,
        text: export.text,
    }
}

/// Builds the clipboard text for `source`. Every file copy is anchored on
/// `project`, git-sourced ones included: headers are relative to it (a nested
/// repository's files read `repo/…`) and its name is the `clipcode-root` line,
/// as in ClipCode for IntelliJ, VS Code and Orca.
pub fn copy(project: &Path, source: ClipCopySource, settings: &Settings) -> IdeResult<ClipCopyResult> {
    let opts = RunOptions::default();
    match source {
        ClipCopySource::Files { paths } => {
            let mut sel: Option<ExportSelection> = None;
            let mut skipped = 0;
            // Files of one root plan together; several roots join one selection.
            let mut groups: Vec<(PathBuf, Vec<PathBuf>)> = Vec::new();
            // Roots of files that no repository covers: their headers are absolute paths.
            let mut absolute: Vec<PathBuf> = Vec::new();
            for p in &paths {
                let root = if p.starts_with(project) {
                    project.to_path_buf()
                } else {
                    repo_root(p).unwrap_or_else(|_| {
                        let dir = if p.is_dir() { p.clone() } else { p.parent().unwrap_or(p).to_path_buf() };
                        if !absolute.contains(&dir) {
                            absolute.push(dir.clone());
                        }
                        dir
                    })
                };
                match groups.iter_mut().find(|(r, _)| *r == root) {
                    Some((_, list)) => list.push(p.clone()),
                    None => groups.push((root, vec![p.clone()])),
                }
            }
            // The project is the primary root (relative headers) wherever it sits in the batch.
            let primary = groups
                .iter()
                .map(|(r, _)| r)
                .find(|r| *r == project)
                .or_else(|| groups.iter().map(|(r, _)| r).find(|r| !absolute.contains(r)))
                .cloned();
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
                        ExportSelection::new(
                            roots,
                            primary.clone().or(prev.primary_root.map(|r| r.path().to_path_buf())),
                            items,
                        )
                        .map_err(err)?
                        .with_source_root(prev.source_root)
                        .with_spelled_root(prev.spelled_root)
                    }
                });
            }
            let sel = sel.ok_or_else(|| IdeError::invalid("Nothing to copy"))?;
            let sel = if absolute.is_empty() { sel } else { sel.with_absolute_roots(&absolute).map_err(err)? };
            file_copy(sel, skipped, settings)
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
            file_copy(git_selection(project, items)?, skipped, settings)
        }
        ClipCopySource::CommitFiles { repo, rev, paths } => {
            let root = repo_root(&repo)?;
            let no_filter = paths.is_empty();
            let (items, skipped) = git_items(&[(root.clone(), paths)], || GitSource::Commit(rev.clone()))?;
            if items.is_empty() && no_filter {
                return Err(IdeError::no_net_changes());
            }
            file_copy(git_selection(project, items)?, skipped, settings)
        }
        ClipCopySource::Range { repo, base, tip, paths } => {
            let root = repo_root(&repo)?;
            let no_filter = paths.is_empty();
            let (items, skipped) = git_items(&[(root.clone(), paths)], || GitSource::Range(base.clone(), tip.clone()))?;
            if items.is_empty() && no_filter {
                return Err(IdeError::no_net_changes());
            }
            file_copy(git_selection(project, items)?, skipped, settings)
        }
        ClipCopySource::RootRange { repo, tip, paths } => {
            let root = repo_root(&repo)?;
            let no_filter = paths.is_empty();
            let empty = Git::open(&root).map_err(err)?.empty_tree_with(&opts).map_err(err)?;
            let (items, skipped) =
                git_items(&[(root.clone(), paths)], || GitSource::Range(empty.clone(), tip.clone()))?;
            if items.is_empty() && no_filter {
                return Err(IdeError::no_net_changes());
            }
            file_copy(git_selection(project, items)?, skipped, settings)
        }
        ClipCopySource::CommitList { repo, revs, paths } => {
            let root = repo_root(&repo)?;
            let no_filter = paths.is_empty();
            let mut items: Vec<ExportItem> = Vec::new();
            let mut skipped = 0;
            // Newest first: a path keeps the item of the newest selected commit touching it.
            for rev in &revs {
                let (found, s) = git_items(&[(root.clone(), paths.clone())], || GitSource::Commit(rev.clone()))?;
                skipped += s;
                for item in found {
                    if !items.iter().any(|i| i.relative_path == item.relative_path) {
                        items.push(item);
                    }
                }
            }
            if items.is_empty() && no_filter {
                return Err(IdeError::no_net_changes());
            }
            file_copy(git_selection(project, items)?, skipped, settings)
        }
        ClipCopySource::Commits { repo, tip, selected } => {
            let git = Git::open(&repo).map_err(err)?;
            let export = transfer::plan_commit_export_exact_with(&git, &tip, &selected, &opts, CLIPBOARD_PAYLOAD_MAX)
                .map_err(err)?;
            Ok(commit_result(export, settings))
        }
        ClipCopySource::CommitRange { repo, base, tip } => {
            let git = Git::open(&repo).map_err(err)?;
            let export =
                transfer::plan_commit_export_with(&git, Some((&base, &tip)), None, &opts, CLIPBOARD_PAYLOAD_MAX)
                    .map_err(err)?;
            Ok(commit_result(export, settings))
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
pub fn paste_preview(
    dest: &Path,
    text: &str,
    adjust_paths: bool,
    repos: &[PathBuf],
    settings: &Settings,
) -> IdeResult<ClipPastePreview> {
    paste_preview_into(dest, None, text, adjust_paths, repos, settings)
}

/// Plans pasting `text`: files restore under `dest` (the project root, as
/// ClipCode's Paste and Restore Files always resolves from the project), while
/// commits replay into the repository of `repo` (the selected repository; `dest`'s
/// when `None`). Nothing is written.
///
/// A payload copied from several repositories names the others' files `<repo>/…`
/// (it has no `clipcode-root` line). Such a prefix lands in the repository of
/// `repos` with that folder name, as snip-sync's prefix mapping would put it.
pub fn paste_preview_into(
    dest: &Path,
    repo: Option<&Path>,
    text: &str,
    adjust_paths: bool,
    repos: &[PathBuf],
    settings: &Settings,
) -> IdeResult<ClipPastePreview> {
    let opts = RunOptions::default();
    if text.len() > CLIPBOARD_PAYLOAD_MAX {
        return Err(IdeError::invalid("The clipboard holds more than 32 MiB"));
    }
    if commits::is_commit_payload(text) {
        let payload: CommitsPayload = commits::parse_commit_payload(text).map_err(err)?;
        let root = repo_root(repo.unwrap_or(dest))?;
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
    // The configured header format, as the plugins parse; else any `file:` header.
    let configured = settings.header_format.as_str();
    let header = if ide_clip::format::parse_clipboard(text, configured).is_empty() { "" } else { configured };
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
    paste_apply_with_paths(req).map(|(result, _)| result)
}

/// Like [`paste_apply`], also returning the files the restore wrote (created
/// or overwritten), so open documents can be reloaded from disk.
pub fn paste_apply_with_paths(req: ClipPasteApply) -> IdeResult<(ClipPasteResult, Vec<PathBuf>)> {
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
            let written: Vec<PathBuf> = restore
                .create_operations
                .iter()
                .enumerate()
                .filter(|(i, _)| !unchecked.contains(i))
                .map(|(_, op)| op.absolute_path.clone())
                .collect();
            let selection = RestoreSelection {
                overwrite_existing: true,
                skip_existing: false,
                unchecked_creates: unchecked,
                unchecked_deletes: req.unchecked_deletes.iter().map(|&i| i as usize).collect(),
            };
            let r = plan.apply(&selection).map_err(|e| IdeError::invalid(e.paste_message()))?;
            let result = ClipPasteResult {
                created: n(r.created_count),
                overwritten: n(r.overwritten_count),
                deleted: n(r.deleted_count),
                skipped: n(r.total_skipped()),
                commits: Vec::new(),
                errors: r.errors,
            };
            Ok((result, written))
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
            Ok((ClipPasteResult { commits: r.created, errors, ..Default::default() }, Vec::new()))
        }
    }
}

// ---------------------------------------------------------------------------
// Branch series (ClipCode for VS Code: "Copy Branch Commits" / "Paste Branch Commits")

/// A branch's commits as a `git format-patch` mbox.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClipBranchSeries {
    pub text: String,
    pub commits: u32,
    /// The fork point the patches apply onto; `None`: the entire history (self-contained).
    pub base: Option<String>,
}

fn git_out(repo: &Path, args: &[&str], stdin: Option<&str>) -> IdeResult<String> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let mut child = Command::new("git")
        .args(args)
        .current_dir(repo)
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(err)?;
    if let Some(text) = stdin {
        child.stdin.take().expect("piped").write_all(text.as_bytes()).map_err(err)?;
    }
    let out = child.wait_with_output().map_err(err)?;
    if !out.status.success() {
        return Err(IdeError::invalid(String::from_utf8_lossy(&out.stderr).trim().to_string()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The first local branch of main / master / develop / dev / trunk other than `branch`.
fn default_base(repo: &Path, branch: &str) -> Option<String> {
    ["main", "master", "develop", "dev", "trunk"].into_iter().find_map(|b| {
        (b != branch && git_out(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{b}")], None).is_ok())
            .then(|| b.to_string())
    })
}

/// Copies `branch`'s commits since its fork point from `base` (default: main / master /
/// develop / dev / trunk), or its entire history (`full`).
pub fn copy_branch_series(repo: &Path, branch: &str, base: Option<&str>, full: bool) -> IdeResult<ClipBranchSeries> {
    if full {
        let text = git_out(repo, &["format-patch", "--stdout", "--root", branch], None)?;
        let commits = git_out(repo, &["rev-list", "--count", branch], None)?.trim().parse().unwrap_or(0);
        return Ok(ClipBranchSeries { text, commits, base: None });
    }
    let base = base
        .map(str::to_string)
        .or_else(|| default_base(repo, branch))
        .ok_or_else(|| IdeError::invalid("No main, master, develop, dev or trunk branch to copy the commits since"))?;
    let mb = git_out(repo, &["merge-base", &base, branch], None)?.trim().to_string();
    let commits: u32 =
        git_out(repo, &["rev-list", "--count", &format!("{mb}..{branch}")], None)?.trim().parse().unwrap_or(0);
    if commits == 0 {
        return Err(IdeError::invalid(format!("{branch} has no commits that {base} does not have (already merged)")));
    }
    let text = git_out(repo, &["format-patch", "--stdout", &format!("--base={mb}"), &format!("{mb}..{branch}")], None)?;
    Ok(ClipBranchSeries { text, commits, base: Some(mb) })
}

/// Whether `text` is a `git format-patch` mbox (a branch series).
pub fn is_branch_series(text: &str) -> bool {
    text.strip_prefix("From ")
        .and_then(|rest| rest.split_once(' '))
        .is_some_and(|(sha, _)| (7..=64).contains(&sha.len()) && sha.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// The `base-commit:` trailer of a branch series.
fn series_base(text: &str) -> Option<String> {
    text.lines().find_map(|l| l.strip_prefix("base-commit: ").map(|s| s.trim().to_string()))
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClipBranchRestore {
    pub branch: String,
    pub commits: u32,
}

/// Restores a branch series as the new branch `name`: at its base commit (or the current
/// HEAD with `on_head`, or an orphan branch for an entire history), then `git am --3way`.
/// A failed apply is aborted and the previous branch checked out again.
pub fn paste_branch_series(repo: &Path, text: &str, name: &str, on_head: bool) -> IdeResult<ClipBranchRestore> {
    if !is_branch_series(text) {
        return Err(IdeError::invalid("The clipboard holds no branch commits (git format-patch)"));
    }
    if !git_out(repo, &["status", "--porcelain", "--untracked-files=no"], None)?.trim().is_empty() {
        return Err(IdeError::invalid("Commit or stash your changes before restoring branch commits"));
    }
    git_out(repo, &["check-ref-format", "--branch", name], None)?;
    let previous = git_out(repo, &["rev-parse", "--abbrev-ref", "HEAD"], None)?.trim().to_string();
    match series_base(text) {
        _ if on_head => git_out(repo, &["checkout", "-q", "-b", name], None)?,
        Some(base) => {
            if git_out(repo, &["cat-file", "-e", &format!("{base}^{{commit}}")], None).is_err() {
                return Err(IdeError::invalid(format!(
                    "Base commit {} is not in this repository; fetch it, or restore on the current HEAD",
                    &base[..base.len().min(8)]
                )));
            }
            git_out(repo, &["checkout", "-q", "-b", name, &base], None)?
        }
        None => {
            git_out(repo, &["checkout", "-q", "--orphan", name], None)?;
            git_out(repo, &["rm", "-r", "-f", "-q", "--ignore-unmatch", "."], None)?
        }
    };
    // Where the restored commits start (none on an orphan branch).
    let start = git_out(repo, &["rev-parse", "--verify", "--quiet", "HEAD"], None).ok().map(|s| s.trim().to_string());
    if let Err(e) = git_out(repo, &["am", "--3way", "--quiet"], Some(text)) {
        let _ = git_out(repo, &["am", "--abort"], None);
        let _ = git_out(repo, &["checkout", "-q", "-f", &previous], None);
        let _ = git_out(repo, &["branch", "-D", name], None);
        return Err(IdeError::invalid(format!("The commits did not apply; nothing was restored: {}", e.message)));
    }
    let range = start.map_or_else(|| "HEAD".to_string(), |s| format!("{s}..HEAD"));
    let commits = git_out(repo, &["rev-list", "--count", &range], None)?.trim().parse().unwrap_or(0);
    Ok(ClipBranchRestore { branch: name.to_string(), commits })
}

// ---------------------------------------------------------------------------
// Commands

pub async fn clip_copy(host: &Host, window: &str, source: ClipCopySource) -> IdeResult<ClipCopyResult> {
    let project = host.project(window)?;
    let settings = clip_settings(&project.settings.effective().vcs.clip_code);
    blocking(move || copy(&project.root, source, &settings)).await
}

/// `dest` defaults to the project root; `repo` (the selected repository) is where
/// a commit payload replays.
pub async fn clip_paste_preview(
    host: &Host,
    window: &str,
    text: String,
    dest: Option<PathBuf>,
    repo: Option<PathBuf>,
    adjust_paths: bool,
    repos: Vec<PathBuf>,
) -> IdeResult<ClipPastePreview> {
    let project = host.project(window)?;
    let settings = clip_settings(&project.settings.effective().vcs.clip_code);
    blocking(move || {
        let dest = dest.as_deref().unwrap_or(&project.root);
        paste_preview_into(dest, repo.as_deref(), &text, adjust_paths, &repos, &settings)
    })
    .await
}

pub async fn clip_paste_apply(host: &Host, window: &str, apply: ClipPasteApply) -> IdeResult<ClipPasteResult> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let (result, written) = blocking(move || paste_apply_with_paths(apply)).await?;
    // The user confirmed the overwrite: open editors show the restored content, not their unsaved buffer.
    project.documents.reload_from_disk(&written);
    project.sink.emit(ide_core::IdeEvent::VcsChanged { root: project.root.clone().into() });
    Ok(result)
}

pub async fn clip_copy_branch_series(
    host: &Host,
    window: &str,
    repo: PathBuf,
    branch: String,
    base: Option<String>,
    full: bool,
) -> IdeResult<ClipBranchSeries> {
    host.project(window)?;
    blocking(move || copy_branch_series(&repo, &branch, base.as_deref(), full)).await
}

pub async fn clip_paste_branch_series(
    host: &Host,
    window: &str,
    repo: PathBuf,
    text: String,
    name: String,
    on_head: bool,
) -> IdeResult<ClipBranchRestore> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let result = blocking(move || paste_branch_series(&repo, &text, &name, on_head)).await?;
    project.sink.emit(ide_core::IdeEvent::VcsChanged { root: project.root.clone().into() });
    Ok(result)
}

pub(crate) fn register(d: &mut Dispatcher) {
    d.add("clip_copy_branch_series", |c| async move {
        clip_copy_branch_series(&c.host, &c.window, c.arg("repo")?, c.arg("branch")?, c.arg("base")?, c.arg("full")?)
            .await
    });
    d.add("clip_paste_branch_series", |c| async move {
        clip_paste_branch_series(&c.host, &c.window, c.arg("repo")?, c.arg("text")?, c.arg("name")?, c.arg("onHead")?)
            .await
    });
    d.add("clip_copy", |c| async move { clip_copy(&c.host, &c.window, c.arg("source")?).await });
    d.add("clip_paste_preview", |c| async move {
        clip_paste_preview(
            &c.host,
            &c.window,
            c.arg("text")?,
            c.arg("dest")?,
            c.arg("repo")?,
            c.arg("adjustPaths")?,
            c.arg("repos")?,
        )
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

    /// Project `M` (a plain folder with `src/x.txt`) holding the repository `M/repo`,
    /// whose `src/a.ts` is added by `c1` and changed by `c2`. Returns (M, repo, c1, c2).
    fn monorepo(tmp: &Path) -> (PathBuf, PathBuf, String, String) {
        fs::create_dir_all(tmp).unwrap();
        let m = std::fs::canonicalize(tmp).unwrap().join("M");
        fs::create_dir_all(m.join("src")).unwrap();
        fs::write(m.join("src/x.txt"), "x\n").unwrap();
        let r = repo(&m.join("repo"));
        fs::create_dir_all(r.join("src")).unwrap();
        let c1 = commit_file(&r, "src/a.ts", Some("a1\n"), "add a");
        let c2 = commit_file(&r, "src/a.ts", Some("a2\n"), "change a");
        (m, r, c1, c2)
    }

    fn copied(project: &Path, source: ClipCopySource) -> String {
        copy(project, source, &Settings::default()).unwrap().text
    }

    #[test]
    fn git_copies_are_anchored_on_the_project_not_the_nested_repository() {
        let tmp = tempfile::tempdir().unwrap();
        let (m, r, c1, c2) = monorepo(tmp.path());
        let file = r.join("src/a.ts");
        let modified = "// file: [MODIFIED] repo/src/a.ts\n";
        let cases = [
            (ClipCopySource::CommitFiles { repo: r.clone(), rev: c2.clone(), paths: vec![] }, modified),
            (ClipCopySource::Range { repo: r.clone(), base: c1.clone(), tip: c2.clone(), paths: vec![] }, modified),
            (
                ClipCopySource::RootRange { repo: r.clone(), tip: c2.clone(), paths: vec![] },
                "// file: [NEW] repo/src/a.ts\n",
            ),
            (
                ClipCopySource::CommitList { repo: r.clone(), revs: vec![c2.clone(), c1.clone()], paths: vec![] },
                modified,
            ),
        ];
        for (source, header) in cases {
            let text = copied(&m, source.clone());
            assert!(text.starts_with("// clipcode-root: M\n"), "{source:?}:\n{text}");
            assert!(text.contains(header), "{source:?}:\n{text}");
        }
        // The root range carries the repository's other files under its folder too.
        let text = copied(&m, ClipCopySource::RootRange { repo: r.clone(), tip: c2, paths: vec![] });
        assert!(text.contains("// file: [NEW] repo/README.md\n"), "{text}");

        fs::write(&file, "a3\n").unwrap();
        for side in [ClipChangeSide::Working, ClipChangeSide::Unstaged] {
            let text = copied(&m, ClipCopySource::Changes { paths: vec![file.clone()], side });
            assert!(text.starts_with("// clipcode-root: M\n"), "{side:?}:\n{text}");
            assert!(text.contains(modified), "{side:?}:\n{text}");
            assert!(text.contains("a3"), "{text}");
        }
        git(&r, &["add", "-A"]);
        let text = copied(&m, ClipCopySource::Changes { paths: vec![r.clone()], side: ClipChangeSide::Staged });
        assert!(text.starts_with("// clipcode-root: M\n"), "{text}");
        assert!(text.contains(modified), "{text}");
    }

    #[test]
    fn git_copy_filters_match_the_project_relative_path() {
        let tmp = tempfile::tempdir().unwrap();
        let (m, r, _, _) = monorepo(tmp.path());
        fs::write(r.join("src/a.ts"), "a3\n").unwrap();
        fs::write(r.join("README.md"), "changed\n").unwrap();
        use ide_clip::settings::{FilterAction, FilterRule, FilterType};
        let settings = Settings {
            use_filters: true,
            use_exclude_filters: true,
            filter_rules: vec![FilterRule {
                kind: FilterType::Path,
                action: FilterAction::Exclude,
                value: "repo/src/a.ts".into(),
                enabled: true,
            }],
            ..Settings::default()
        };
        let source = ClipCopySource::Changes { paths: vec![r.clone()], side: ClipChangeSide::Working };
        let text = copy(&m, source, &settings).unwrap().text;
        assert!(text.contains("// file: [MODIFIED] repo/README.md\n"), "{text}");
        assert!(!text.contains("a.ts"), "{text}");
    }

    #[test]
    fn several_nested_repositories_share_the_project_root_line() {
        let tmp = tempfile::tempdir().unwrap();
        let m = std::fs::canonicalize(tmp.path()).unwrap().join("M");
        let a = repo(&m.join("a"));
        let b = repo(&m.join("b"));
        fs::write(a.join("README.md"), "from a\n").unwrap();
        fs::write(b.join("README.md"), "from b\n").unwrap();
        let text =
            copied(&m, ClipCopySource::Changes { paths: vec![a.clone(), b.clone()], side: ClipChangeSide::Working });
        assert!(text.starts_with("// clipcode-root: M\n"), "{text}");
        assert_eq!(text.matches("// clipcode-root:").count(), 1, "{text}");
        assert!(text.contains("// file: [MODIFIED] a/README.md\n"), "{text}");
        assert!(text.contains("// file: [MODIFIED] b/README.md\n"), "{text}");

        // `a/b/README.md` and `b/README.md` differ once anchored on the project, though
        // spelled against repository `a` they would both read `b/README.md`.
        fs::create_dir_all(a.join("b")).unwrap();
        fs::write(a.join("b/README.md"), "nested\n").unwrap();
        let text =
            copied(&m, ClipCopySource::Changes { paths: vec![a.clone(), b.clone()], side: ClipChangeSide::Working });
        assert!(text.contains("// file: [NEW] a/b/README.md\n"), "{text}");
        assert!(text.contains("// file: [MODIFIED] b/README.md\n"), "{text}");
    }

    #[test]
    fn a_project_inside_a_repository_spells_outside_files_absolute() {
        let tmp = tempfile::tempdir().unwrap();
        let r = repo(&tmp.path().join("repo"));
        let sub = r.join("sub");
        fs::create_dir_all(&sub).unwrap();
        commit_file(&r, "sub/s.txt", Some("s\n"), "add s");
        fs::write(sub.join("s.txt"), "s2\n").unwrap();
        fs::write(r.join("README.md"), "changed\n").unwrap();
        let text = copied(&sub, ClipCopySource::Changes { paths: vec![r.clone()], side: ClipChangeSide::Working });
        assert!(text.starts_with("// clipcode-root: sub\n"), "{text}");
        assert!(text.contains("// file: [MODIFIED] s.txt\n"), "{text}");
        let abs = format!("{}/README.md", r.to_string_lossy());
        assert!(text.contains(&format!("// file: [MODIFIED] {abs}\n")), "{text}");

        // A repository beside the project keeps its folder label, as Files copies do.
        let ext = repo(&tmp.path().join("ext"));
        fs::write(ext.join("README.md"), "ext\n").unwrap();
        let text = copied(&sub, ClipCopySource::Changes { paths: vec![ext], side: ClipChangeSide::Working });
        assert!(text.contains("// file: [MODIFIED] ext/README.md\n"), "{text}");
    }

    #[test]
    fn a_monorepo_copy_restores_into_the_project_without_adjustment() {
        let tmp = tempfile::tempdir().unwrap();
        let (m, r, _, _) = monorepo(tmp.path());
        fs::write(r.join("src/a.ts"), "a3\n").unwrap();
        let text = copied(&m, ClipCopySource::Changes { paths: vec![r.clone()], side: ClipChangeSide::Working });
        fs::write(r.join("src/a.ts"), "a2\n").unwrap();
        let preview = paste_preview(&m, &text, false, &[], &Settings::default()).unwrap();
        assert_eq!(preview.suggestion, None);
        assert_eq!(preview.files.len(), 1, "{:?}", preview.files);
        let target = r.join("src/a.ts").to_string_lossy().into_owned();
        assert_eq!(preview.files[0].target.as_deref(), Some(target.as_str()));
        assert_eq!(preview.files[0].action, "overwrite");
    }

    #[test]
    fn commits_pasted_from_the_project_replay_into_the_selected_repository() {
        let tmp = tempfile::tempdir().unwrap();
        let (_, src, _, c2) = monorepo(&tmp.path().join("src"));
        let commits = copied(&src, ClipCopySource::Commits { repo: src.clone(), tip: c2.clone(), selected: vec![c2] });
        let dst = std::fs::canonicalize(tmp.path()).unwrap().join("dst");
        let target = repo(&dst.join("repo"));
        fs::create_dir_all(target.join("src")).unwrap();
        commit_file(&target, "src/a.ts", Some("a1\n"), "add a");

        // The project root is a plain folder: the files destination, never the replay's.
        assert!(paste_preview(&dst, &commits, false, &[], &Settings::default()).is_err());
        let preview = paste_preview_into(&dst, Some(&target), &commits, false, &[], &Settings::default()).unwrap();
        assert_eq!(preview.mode, "commits");
        assert_eq!(preview.destination, target.to_string_lossy());
        let result =
            paste_apply(ClipPasteApply { id: preview.id, overwrite_existing: true, ..Default::default() }).unwrap();
        assert_eq!(result.commits.len(), 1, "{:?}", result.errors);
        assert_eq!(fs::read_to_string(target.join("src/a.ts")).unwrap(), "a2\n");
    }

    #[test]
    fn files_outside_the_project_and_any_repo_copy_with_absolute_headers() {
        let tmp = tempfile::tempdir().unwrap();
        let a = repo(&tmp.path().join("a"));
        fs::write(a.join("main.kt"), "fun main() {}\n").unwrap();
        let outside = std::fs::canonicalize(tmp.path()).unwrap().join("loose");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join(".zshrc"), "export A=1\n").unwrap();
        let abs = format!("{}/.zshrc", outside.to_string_lossy());

        // The external file first: the project file keeps its relative header.
        for paths in [vec![outside.join(".zshrc"), a.join("main.kt")], vec![a.join("main.kt"), outside.join(".zshrc")]]
        {
            let copied = copy(&a, ClipCopySource::Files { paths }, &Settings::default()).unwrap();
            assert_eq!(copied.files, 2, "{}", copied.text);
            assert!(copied.text.contains("// file: main.kt"), "{}", copied.text);
            assert!(copied.text.contains(&format!("// file: {abs}")), "{}", copied.text);
        }

        // Only the external file: still copies, with the absolute header.
        let copied =
            copy(&a, ClipCopySource::Files { paths: vec![outside.join(".zshrc")] }, &Settings::default()).unwrap();
        assert_eq!(copied.files, 1);
        assert!(copied.text.contains(&format!("// file: {abs}")), "{}", copied.text);
    }

    #[test]
    fn apply_reports_only_the_files_it_wrote() {
        let tmp = tempfile::tempdir().unwrap();
        let a = repo(&tmp.path().join("a"));
        fs::write(a.join("README.md"), "from a\n").unwrap();
        let copied =
            copy(&a, ClipCopySource::Files { paths: vec![a.join("README.md")] }, &Settings::default()).unwrap();
        let b = repo(&tmp.path().join("b"));

        // An existing file not chosen for overwrite is left alone and not reported.
        let preview = paste_preview(&b, &copied.text, false, &[], &Settings::default()).unwrap();
        let (_, kept) = paste_apply_with_paths(ClipPasteApply { id: preview.id, ..Default::default() }).unwrap();
        assert!(kept.is_empty());

        let preview = paste_preview(&b, &copied.text, false, &[], &Settings::default()).unwrap();
        let (_, written) =
            paste_apply_with_paths(ClipPasteApply { id: preview.id, overwrite: vec![0], ..Default::default() })
                .unwrap();
        assert_eq!(written.len(), 1);
        assert!(written[0].ends_with("README.md"));
    }

    #[test]
    fn files_round_trip_through_the_clipcode_format() {
        let tmp = tempfile::tempdir().unwrap();
        let a = repo(&tmp.path().join("a"));
        fs::create_dir_all(a.join("src")).unwrap();
        fs::write(a.join("src/App.kt"), "fun main() = println(\"hi\")\n").unwrap();
        let copied = copy(&a, ClipCopySource::Files { paths: vec![a.join("src")] }, &Settings::default()).unwrap();
        assert_eq!(copied.mode, "files");
        assert_eq!(copied.files, 1);
        assert!(copied.text.contains("// file: src/App.kt"), "{}", copied.text);

        let b = repo(&tmp.path().join("b"));
        let preview = paste_preview(&b, &copied.text, false, &[], &Settings::default()).unwrap();
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
        let copied =
            copy(&a, ClipCopySource::Files { paths: vec![a.join("README.md")] }, &Settings::default()).unwrap();
        let b = repo(&tmp.path().join("b"));

        let preview = paste_preview(&b, &copied.text, false, &[], &Settings::default()).unwrap();
        assert_eq!(preview.files[0].action, "overwrite");
        let kept = paste_apply(ClipPasteApply { id: preview.id, ..Default::default() }).unwrap();
        assert_eq!(kept.overwritten, 0);
        assert_eq!(fs::read_to_string(b.join("README.md")).unwrap(), "base\n");

        let preview = paste_preview(&b, &copied.text, false, &[], &Settings::default()).unwrap();
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
        let copied = copy(
            &a,
            ClipCopySource::Changes { paths: vec![a.clone()], side: ClipChangeSide::Staged },
            &Settings::default(),
        )
        .unwrap();
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

        let copied = copy(
            &a,
            ClipCopySource::Commits { repo: a.clone(), tip: tip.clone(), selected: vec![tip, first] },
            &Settings::default(),
        )
        .unwrap();
        assert_eq!(copied.mode, "commits");
        assert_eq!(copied.commits, 2);
        assert!(copied.text.starts_with("// snip-sync commits v1\n"));

        let b = repo(&tmp.path().join("b"));
        let preview = paste_preview(&b, &copied.text, false, &[], &Settings::default()).unwrap();
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
        let files = copy(
            &a,
            ClipCopySource::Range { repo: a.clone(), base: base.clone(), tip: tip.clone(), paths: vec![] },
            &Settings::default(),
        )
        .unwrap();
        assert!(files.text.contains("// file: [NEW] feature.txt"), "{}", files.text);
        let commits =
            copy(&a, ClipCopySource::CommitRange { repo: a.clone(), base, tip }, &Settings::default()).unwrap();
        assert_eq!(commits.commits, 1);
    }

    fn commit_file(dir: &Path, name: &str, body: Option<&str>, msg: &str) -> String {
        match body {
            Some(b) => fs::write(dir.join(name), b).unwrap(),
            None => fs::remove_file(dir.join(name)).unwrap(),
        }
        git(dir, &["add", "-A"]);
        git(dir, &["commit", "-q", "-m", msg]);
        git(dir, &["rev-parse", "HEAD"])
    }

    #[test]
    fn a_commit_list_copies_only_the_selected_commits_files_at_the_newest_one() {
        let tmp = tempfile::tempdir().unwrap();
        let a = repo(&tmp.path().join("a"));
        let c1 = commit_file(&a, "one.txt", Some("1\n"), "one");
        commit_file(&a, "between.txt", Some("skipped\n"), "between");
        let c3 = commit_file(&a, "one.txt", Some("1 changed\n"), "three");
        commit_file(&a, "gone.txt", Some("g\n"), "add gone");
        let c5 = commit_file(&a, "gone.txt", None, "remove gone");
        let c6 = commit_file(&a, "six.txt", Some("6\n"), "six");

        // c1, c3, c5, c6 are not one chain: `between.txt` and the "add gone" commit sit between them.
        let out = copy(
            &a,
            ClipCopySource::CommitList { repo: a.clone(), revs: vec![c6, c5, c3, c1], paths: vec![] },
            &Settings::default(),
        )
        .unwrap();
        assert!(!out.text.contains("between.txt"), "{}", out.text);
        assert!(out.text.contains("six.txt"), "{}", out.text);
        // one.txt appears once, with the newest selected commit's content.
        assert_eq!(out.text.matches("] one.txt").count(), 1, "{}", out.text);
        assert!(out.text.contains("1 changed"), "{}", out.text);
        assert!(out.text.contains("[DELETED] gone.txt"), "{}", out.text);
        assert_eq!(out.files, 3);
    }

    #[test]
    fn a_root_range_copies_everything_from_the_root_commit_through_the_tip() {
        let tmp = tempfile::tempdir().unwrap();
        let a = repo(&tmp.path().join("a"));
        let root = git(&a, &["rev-parse", "HEAD"]);
        assert!(git(&a, &["rev-list", "--parents", "-n1", &root]).split(' ').count() == 1);
        let tip = commit_file(&a, "two.txt", Some("2\n"), "two");
        let out =
            copy(&a, ClipCopySource::RootRange { repo: a.clone(), tip, paths: vec![] }, &Settings::default()).unwrap();
        assert!(out.text.contains("README.md"), "{}", out.text);
        assert!(out.text.contains("two.txt"), "{}", out.text);
        assert_eq!(out.files, 2);
    }

    #[test]
    fn a_commit_without_net_changes_is_a_typed_no_net_changes_error() {
        let tmp = tempfile::tempdir().unwrap();
        let a = repo(&tmp.path().join("a"));
        git(&a, &["commit", "-q", "--allow-empty", "-m", "empty"]);
        let tip = git(&a, &["rev-parse", "HEAD"]);
        let e =
            copy(&a, ClipCopySource::CommitFiles { repo: a.clone(), rev: tip, paths: vec![] }, &Settings::default())
                .unwrap_err();
        assert_eq!(e.data, Some(ide_core::error::ErrorData::NoNetChanges));
        assert_eq!(e.message, "Selected commit introduces no net file changes. Clipboard unchanged.");
    }

    #[test]
    fn a_stale_preview_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let a = repo(&tmp.path().join("a"));
        fs::write(a.join("x.txt"), "x\n").unwrap();
        let copied = copy(&a, ClipCopySource::Files { paths: vec![a.join("x.txt")] }, &Settings::default()).unwrap();
        let b = repo(&tmp.path().join("b"));
        let preview = paste_preview(&b, &copied.text, false, &[], &Settings::default()).unwrap();
        fs::write(b.join("x.txt"), "appeared meanwhile\n").unwrap();
        assert!(paste_apply(ClipPasteApply { id: preview.id, ..Default::default() }).is_err());
        assert_eq!(fs::read_to_string(b.join("x.txt")).unwrap(), "appeared meanwhile\n");
    }

    #[test]
    fn a_branch_series_restores_as_a_new_branch() {
        let tmp = tempfile::tempdir().unwrap();
        let a = repo(&tmp.path().join("a"));
        git(&a, &["checkout", "-q", "-b", "topic"]);
        fs::write(a.join("one.txt"), "1\n").unwrap();
        git(&a, &["add", "-A"]);
        git(&a, &["commit", "-q", "-m", "one"]);
        fs::write(a.join("two.txt"), "2\n").unwrap();
        git(&a, &["add", "-A"]);
        git(&a, &["commit", "-q", "-m", "two"]);
        let series = copy_branch_series(&a, "topic", None, false).unwrap();
        assert_eq!(series.commits, 2);
        assert!(is_branch_series(&series.text));
        assert!(series.text.contains("base-commit: "));

        // The other side has the base commit (a clone of main).
        let b = tmp.path().join("b");
        git(tmp.path(), &["clone", "-q", "-b", "main", a.to_str().unwrap(), b.to_str().unwrap()]);
        git(&b, &["config", "user.name", "Tester"]);
        git(&b, &["config", "user.email", "t@example.com"]);
        let r = paste_branch_series(&b, &series.text, "restored", false).unwrap();
        assert_eq!(r.commits, 2);
        assert_eq!(git(&b, &["log", "-2", "--format=%s", "restored"]), "two\none");

        // Entire history into an unrelated repository: an orphan branch.
        let full = copy_branch_series(&a, "topic", None, true).unwrap();
        assert_eq!(full.base, None);
        let c = repo(&tmp.path().join("c"));
        let r = paste_branch_series(&c, &full.text, "imported", false).unwrap();
        assert_eq!(r.commits, 3);
        assert_eq!(git(&c, &["log", "--format=%s", "imported"]), "two\none\ninit");

        // A series that does not apply is aborted and the branch removed.
        git(&c, &["checkout", "-q", "main"]);
        fs::write(c.join("one.txt"), "conflict\n").unwrap();
        git(&c, &["add", "-A"]);
        git(&c, &["commit", "-q", "-m", "conflict"]);
        assert!(paste_branch_series(&c, &series.text, "clash", true).is_err());
        assert_eq!(git(&c, &["rev-parse", "--abbrev-ref", "HEAD"]), "main");
        assert!(git(&c, &["branch", "--list", "clash"]).is_empty());
    }
}
