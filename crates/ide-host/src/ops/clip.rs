//! Clipboard copy / paste in the snip-sync / ClipCode format (`ide-clip`): the
//! file payload ClipCode (IntelliJ, VS Code) restores, and the commit payload
//! that replays commits in another repository. The frontend owns the system
//! clipboard; these commands build the text and plan / apply a paste of it.

use crate::Host;
use crate::rpc::Dispatcher;
use ide_clip::commits::CommitNonTextOptions;
use ide_clip::commits::{self, CommitsPayload, FilePlan, ReplaySkipReason};
use ide_clip::gitrun::RunOptions;
use ide_clip::gitsrc::{Git, GitSource};
use ide_clip::nontext::NonTextSummary;
use ide_clip::restore::{FsProbe, RestoreBase, RestoreSelection, SkipReason, suggest_restore_base};
use ide_clip::settings::{NonTextMode, Settings};
use ide_clip::transfer::{
    self, CLIPBOARD_PAYLOAD_MAX, CanonicalRootId, CommitReplayPreview, ExportItem, ExportSelection, ImportMapping,
    SKIPPED_PATHS_SHOWN, TransferError, TransferImportPlan, WalkRefusals, changed_items, copy_selection_detailed,
    selection_from_paths_or_refused,
};
use ide_core::{IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{BTreeSet, HashMap, HashSet};
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

/// Whether a copy carries non-text files as Base64 (`docs/clipcode/non-text-files.md`).
/// A copy that finds some reports them in [`ClipCopyResult::non_text`]; the UI asks, then
/// copies again with `Include`. Never stored.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ClipNonTextMode {
    /// Today's payload: non-text files are left out.
    #[default]
    Exclude,
    Include,
}

impl From<ClipNonTextMode> for NonTextMode {
    fn from(m: ClipNonTextMode) -> Self {
        match m {
            ClipNonTextMode::Exclude => NonTextMode::Exclude,
            ClipNonTextMode::Include => NonTextMode::Include,
        }
    }
}

/// How many non-text files (and unreadable paths) a copy result lists by name.
const LISTED_FILES: usize = 10;

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClipNonTextFile {
    /// The path as the payload spells it.
    pub path: String,
    /// Raw bytes.
    pub size: f64,
}

/// What the copy dialog shows. Under `Exclude` it is what `Include` would add.
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClipNonTextSummary {
    /// Non-text files within the non-text limit.
    pub count: u32,
    /// Σ raw size of those files.
    pub total_bytes: f64,
    /// The payload size with them included.
    pub estimated_include_bytes: f64,
    /// The first 10, in payload order.
    pub files: Vec<ClipNonTextFile>,
    /// Non-text files over the non-text limit: not copied either way.
    pub over_limit_count: u32,
    /// Files over both per-file limits: never read, copied as size placeholders.
    pub unread_over_limit_count: u32,
    /// The larger per-file limit in bytes, which those files exceed.
    pub unread_limit_bytes: f64,
    /// The estimate is over the whole-payload limit: `Include` would fail.
    pub exceeds_payload_cap: bool,
    /// Files the file-count limit leaves out of what `Include` copies.
    pub limit_left_out: u32,
    /// `limit_left_out` is a lower bound (a folder walk stopped at the limit, or more than 1000 were left out).
    pub limit_left_out_at_least: bool,
    /// The `headerFormat` cannot be escaped: `Include` would write Base64 lines that read as file headers.
    pub header_cannot_be_escaped: bool,
}

fn non_text_summary(s: &NonTextSummary) -> ClipNonTextSummary {
    ClipNonTextSummary {
        count: n(s.count()),
        total_bytes: s.total_bytes as f64,
        estimated_include_bytes: s.estimated_include_payload_bytes as f64,
        files: s
            .files
            .iter()
            .take(LISTED_FILES)
            .map(|f| ClipNonTextFile { path: f.path.clone(), size: f.size as f64 })
            .collect(),
        over_limit_count: n(s.over_limit_count),
        unread_over_limit_count: n(s.unread_over_limit_count),
        unread_limit_bytes: s.unread_limit_bytes as f64,
        exceeds_payload_cap: s.estimated_include_payload_bytes > CLIPBOARD_PAYLOAD_MAX,
        limit_left_out: n(s.limit_left_out),
        limit_left_out_at_least: s.limit_left_out_lower_bound,
        header_cannot_be_escaped: s.header_cannot_be_escaped,
    }
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
    /// Non-text files found (see [`ClipNonTextSummary`]).
    pub non_text: ClipNonTextSummary,
    /// Of `files`: non-text files carried as Base64 (`Include` only).
    pub non_text_copied: u32,
    /// The first 10 files counted in `skippedUnreadable` that were unreadable, by payload path
    /// (files mode; commits mode names none).
    pub skipped_unreadable_paths: Vec<String>,
    /// Of `skipped`: files whose name the payload cannot carry portably (a backslash, a double quote, a tab
    /// or another refused character), not unreadable ones.
    pub skipped_unportable: u32,
    /// The first 10 of them by their real names (files mode).
    pub skipped_unportable_paths: Vec<String>,
    /// Of `skipped`: symlinks to a folder inside a copied folder, which are not followed.
    pub skipped_symlink_dirs: u32,
    /// The first 10 of them (files mode).
    pub skipped_symlink_dir_paths: Vec<String>,
}

impl ClipCopyResult {
    /// A files result that copied nothing, for a selection that was refused whole.
    fn empty() -> Self {
        Self {
            text: String::new(),
            mode: "files".into(),
            files: 0,
            commits: 0,
            chars: 0,
            lines: 0,
            words: 0,
            tokens: 0,
            skipped: 0,
            skipped_size: 0,
            skipped_unreadable: 0,
            truncated: false,
            file_limit: 0,
            notify: true,
            non_text: ClipNonTextSummary::default(),
            non_text_copied: 0,
            skipped_unreadable_paths: Vec::new(),
            skipped_unportable: 0,
            skipped_unportable_paths: Vec::new(),
            skipped_symlink_dirs: 0,
            skipped_symlink_dir_paths: Vec::new(),
        }
    }
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

/// The changes a Git copy found: every listed item (portable or not) and the paths dropped because their name
/// is not UTF-8, spelled lossily and relative to the repository root.
struct GitItems {
    items: Vec<ExportItem>,
    /// (repository root, lossy path relative to it).
    non_utf8: Vec<(PathBuf, String)>,
}

/// The labelled changes of `source` in each repository of `paths` (or `repo`), narrowed to `paths`.
fn git_items(repos: &[(PathBuf, Vec<PathBuf>)], source: impl Fn() -> GitSource) -> IdeResult<GitItems> {
    let (found, _) = git_items_with_renames(repos, source)?;
    Ok(found)
}

/// [`git_items`], plus the source paths of the renames (repo-relative, unfiltered by `paths`).
fn git_items_with_renames(
    repos: &[(PathBuf, Vec<PathBuf>)],
    source: impl Fn() -> GitSource,
) -> IdeResult<(GitItems, Vec<String>)> {
    let opts = RunOptions::default();
    let mut items = Vec::new();
    let mut renamed_from = Vec::new();
    let mut non_utf8 = Vec::new();
    for (root, paths) in repos {
        let git = Git::open(root).map_err(err)?;
        let id = CanonicalRootId::new(git.root()).map_err(err)?;
        let changed = changed_items(&id, &git, &source(), &opts).map_err(err)?;
        renamed_from.extend(changed.renamed_from);
        let wanted = rel_set(git.root(), paths);
        let selected = |rel: &str| {
            // "" is the repository itself (its root was selected).
            wanted.is_empty()
                || wanted.contains("")
                || wanted.iter().any(|w| rel == w || rel.starts_with(&format!("{w}/")))
        };
        non_utf8
            .extend(changed.non_utf8_paths.into_iter().filter(|p| selected(p)).map(|p| (id.path().to_path_buf(), p)));
        items.extend(changed.items.into_iter().filter(|i| selected(&i.relative_path)));
    }
    Ok((GitItems { items, non_utf8 }, renamed_from))
}

/// A Git copy (changes, a commit, a range, a commit list) of `found`. A changed path whose name a header cannot
/// carry (`is_exportable_relative_path`, not UTF-8 included) is skipped and named under "Name not portable"; the
/// rest is copied. When nothing is left the result is empty and names them (the UI says "Nothing to copy").
fn git_copy(
    project: &Path,
    content_roots: &[PathBuf],
    found: GitItems,
    settings: &Settings,
    mode: ClipNonTextMode,
) -> IdeResult<ClipCopyResult> {
    // Named as the payload would spell them: relative to the project when the repository is inside it.
    let project_canon = dunce::canonicalize(project).unwrap_or_else(|_| project.to_path_buf());
    let shown = |root: &Path, rel: String| match root.strip_prefix(&project_canon) {
        Ok(sub) if !sub.as_os_str().is_empty() => format!("{}/{rel}", sub.to_string_lossy().replace('\\', "/")),
        _ => rel,
    };
    let mut refusals = WalkRefusals::default();
    for (root, name) in found.non_utf8 {
        refusals.unportable(shown(&root, name));
    }
    let (items, unportable): (Vec<_>, Vec<_>) =
        found.items.into_iter().partition(|i| ide_clip::paths::is_exportable_relative_path(&i.relative_path));
    for item in unportable {
        refusals.unportable(shown(item.root.path(), item.relative_path));
    }
    let skipped = refusals.unportable;
    if items.is_empty() && skipped > 0 {
        return Ok(refused_result(skipped, Vec::new(), refusals, settings));
    }
    file_copy(git_selection(project, content_roots, items)?, skipped, Vec::new(), refusals, settings, mode)
}

/// A files result that copied nothing because every selected path was skipped: it names what was skipped, which
/// the UI reports as "Nothing to copy" (an error would reach the user as a raw `IpcError`).
fn refused_result(
    skipped: usize,
    skipped_paths: Vec<String>,
    refusals: WalkRefusals,
    settings: &Settings,
) -> ClipCopyResult {
    let unreadable = skipped.saturating_sub(refusals.unportable + refusals.symlink_dirs);
    ClipCopyResult {
        mode: "files".into(),
        skipped: n(skipped),
        skipped_unreadable: n(unreadable),
        skipped_unreadable_paths: skipped_paths.into_iter().take(SKIPPED_PATHS_SHOWN).collect(),
        skipped_unportable: n(refusals.unportable),
        skipped_unportable_paths: refusals.unportable_paths,
        skipped_symlink_dirs: n(refusals.symlink_dirs),
        skipped_symlink_dir_paths: refusals.symlink_dir_paths,
        file_limit: n(file_limit(settings)),
        notify: settings.show_copy_notification,
        ..ClipCopyResult::empty()
    }
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

/// The root a selected path outside every project root is read under: its repository, else its folder (a
/// file's parent). A folder that cannot be listed is not a root: it is read from its parent, where the copy
/// skips and names it instead of failing.
fn outside_root(p: &Path) -> PathBuf {
    let at = if p.is_dir() && std::fs::read_dir(p).is_err() { p.parent().unwrap_or(p) } else { p };
    repo_root(at)
        .unwrap_or_else(|_| if at.is_dir() { at.to_path_buf() } else { at.parent().unwrap_or(at).to_path_buf() })
}

fn file_copy(
    sel: ExportSelection,
    primary_skipped: usize,
    primary_skipped_paths: Vec<String>,
    primary_refusals: WalkRefusals,
    settings: &Settings,
    mode: ClipNonTextMode,
) -> IdeResult<ClipCopyResult> {
    let sel = sel.with_non_text(mode.into());
    let report =
        copy_selection_detailed(sel, settings, file_limit(settings), &RunOptions::default(), |_| {}).map_err(|e| {
            match e {
                TransferError::EmptySelection => IdeError::invalid("Nothing to copy: every selected file was skipped"),
                e => err(e),
            }
        })?;
    let o = report.outcome;
    let mut refusals = report.skip_detail;
    let primary_refusals_count = primary_refusals.unportable + primary_refusals.symlink_dirs;
    refusals.merge(primary_refusals);
    // A result that copied no file (every file skipped, only size placeholders, or only non-text
    // files that Exclude left out) is still a result: it names what was skipped and carries the
    // non-text summary, so the UI can ask first or say "Nothing to copy" without touching the
    // clipboard.
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
        // `primary_skipped` counts the selection's refusals, unportable names included.
        skipped_unreadable: n((report.skipped_unreadable + primary_skipped).saturating_sub(primary_refusals_count)),
        truncated: o.truncated,
        file_limit: n(file_limit(settings)),
        notify: settings.show_copy_notification,
        non_text: non_text_summary(&o.non_text),
        non_text_copied: n(o.non_text_files),
        skipped_unreadable_paths: report
            .skipped_unreadable_paths
            .into_iter()
            .chain(primary_skipped_paths)
            .take(SKIPPED_PATHS_SHOWN)
            .collect(),
        skipped_unportable: n(refusals.unportable),
        skipped_unportable_paths: refusals.unportable_paths,
        skipped_symlink_dirs: n(refusals.symlink_dirs),
        skipped_symlink_dir_paths: refusals.symlink_dir_paths,
        text: o.payload,
    })
}

/// A selection of git items (rooted at their repositories, which the export
/// reads) whose headers and `clipcode-root` line are anchored on `project` and
/// its `content_roots`, as ClipCode's `ClipboardPathResolver.fromProject`
/// spells every copy.
fn git_selection(project: &Path, content_roots: &[PathBuf], items: Vec<ExportItem>) -> IdeResult<ExportSelection> {
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
    ExportSelection::anchored(roots, None, project, content_roots, &[], items).map_err(err)
}

fn commit_result(export: commits::CommitExport, settings: &Settings) -> ClipCopyResult {
    let summary = commits::copy_summary(&export.payload, &export.text);
    // Carried non-text files keep their `notCopied` reason on the wire: not skipped.
    let carried = export.payload.commits.iter().flat_map(|c| &c.files).filter(|f| f.non_text.is_some()).count();
    let not_copied = summary.not_copied_count.saturating_sub(carried);
    let stats = ide_clip::stats::payload_stats(&export.text);
    ClipCopyResult {
        mode: "commits".into(),
        files: n(summary.file_count),
        commits: n(summary.commit_count),
        chars: n(summary.chars),
        lines: n(stats.lines),
        words: n(stats.words),
        tokens: n(stats.tokens),
        skipped: n(not_copied),
        skipped_size: 0,
        skipped_unreadable: n(not_copied),
        truncated: false,
        file_limit: 0,
        notify: settings.show_copy_notification,
        non_text: non_text_summary(&export.non_text),
        non_text_copied: n(carried),
        skipped_unreadable_paths: Vec::new(),
        skipped_unportable: 0,
        skipped_unportable_paths: Vec::new(),
        skipped_symlink_dirs: 0,
        skipped_symlink_dir_paths: Vec::new(),
        text: export.text,
    }
}

/// Builds the clipboard text for `source`. Every file copy is anchored on
/// `project`, git-sourced ones included: headers are relative to it (a nested
/// repository's files read `repo/…`) and its name is the `clipcode-root` line,
/// as in ClipCode for IntelliJ, VS Code and Orca.
pub fn copy(project: &Path, source: ClipCopySource, settings: &Settings) -> IdeResult<ClipCopyResult> {
    copy_in(project, &[], source, settings)
}

/// [`copy`] with the non-text choice.
pub fn copy_with(
    project: &Path,
    source: ClipCopySource,
    settings: &Settings,
    non_text: ClipNonTextMode,
) -> IdeResult<ClipCopyResult> {
    copy_in_with(project, &[], source, settings, non_text)
}

/// [`copy`] for a project whose roots also include `content_roots` (workspace
/// members or Project Structure content roots).
pub fn copy_in(
    project: &Path,
    content_roots: &[PathBuf],
    source: ClipCopySource,
    settings: &Settings,
) -> IdeResult<ClipCopyResult> {
    let result = copy_in_with(project, content_roots, source, settings, ClipNonTextMode::Exclude)?;
    // Today's contract: no copied file is nothing to copy, even when a size placeholder or the
    // non-text files found make the payload text non-empty (`copy_in_with` reports them instead).
    if result.files == 0 && (result.mode == "files" || result.text.is_empty()) {
        return Err(IdeError::invalid("Nothing to copy"));
    }
    Ok(result)
}

/// [`copy_in`] with the non-text choice: `Include` carries non-text files within
/// `maxNonTextFileSizeKB` as Base64; `Exclude` is today's payload plus the summary. When only
/// non-text files are found and `Exclude` leaves them out, this returns an empty `text` with the
/// summary (the dialog still has to ask) instead of failing with "Nothing to copy".
pub fn copy_in_with(
    project: &Path,
    content_roots: &[PathBuf],
    source: ClipCopySource,
    settings: &Settings,
    non_text: ClipNonTextMode,
) -> IdeResult<ClipCopyResult> {
    let opts = RunOptions::default();
    match source {
        ClipCopySource::Files { paths } => {
            let mut skipped = 0;
            let mut skipped_paths: Vec<String> = Vec::new();
            let mut refusals = WalkRefusals::default();
            // Files of one root plan together; several roots join one selection,
            // anchored on the project like the git sources.
            let mut groups: Vec<(PathBuf, Vec<PathBuf>)> = Vec::new();
            // Roots of selected paths that no project root covers, grouped by their repository
            // (else their folder) only to be read together. Each file's header is still resolved
            // on its own: absolute under none of the project's roots, as ClipCode spells it, but
            // labelled when a selected folder holds a content root.
            let mut absolute: Vec<PathBuf> = Vec::new();
            for p in &paths {
                let root = if p.starts_with(project) {
                    project.to_path_buf()
                } else if let Some(r) = content_roots.iter().find(|r| p.starts_with(r)) {
                    r.clone()
                } else {
                    let dir = outside_root(p);
                    if !absolute.contains(&dir) {
                        absolute.push(dir.clone());
                    }
                    dir
                };
                match groups.iter_mut().find(|(r, _)| *r == root) {
                    Some((_, list)) => list.push(p.clone()),
                    None => groups.push((root, vec![p.clone()])),
                }
            }
            // Plan every group first, then validate the merged selection once: the primary,
            // the roots and the absolute spelling must all be known before validation. A group
            // refused whole leaves no part, so parts keep their group's root and every lookup
            // below goes by root, never by the group's index.
            let mut parts = Vec::with_capacity(groups.len());
            for (root, list) in &groups {
                match selection_from_paths_or_refused(root, root, list).map_err(err)? {
                    Ok(part) => {
                        skipped += part.skipped;
                        skipped_paths.extend(part.skipped_paths);
                        refusals.merge(part.detail);
                        parts.push((root.clone(), part.sel));
                    }
                    Err(refused) => {
                        skipped += refused.skipped;
                        skipped_paths.extend(refused.skipped_paths);
                        refusals.merge(refused.detail);
                    }
                }
            }
            if parts.is_empty() {
                // Every selected path was refused: an empty result that names what was refused.
                return Ok(refused_result(skipped, skipped_paths, refusals, settings));
            }
            // A refused group's root was never declared to the selection.
            absolute.retain(|r| parts.iter().any(|(root, _)| root == r));
            // The `clipcode-root` name is the project's own spelling, never another root's.
            let source_root = parts.iter().find(|(r, _)| r == project).and_then(|(_, part)| part.source_root.clone());
            // The project is the primary root (relative headers) wherever it sits in the batch;
            // without one, the first content root, else the first root.
            let primary_idx = parts
                .iter()
                .position(|(r, _)| r == project)
                .or_else(|| parts.iter().position(|(r, _)| !absolute.contains(r)))
                .unwrap_or(0);
            let spelled_root = parts[primary_idx].1.spelled_root.clone();
            let primary = parts[primary_idx].1.primary_root.as_ref().map(|r| r.path().to_path_buf());
            let mut roots: Vec<PathBuf> = Vec::new();
            let mut items = Vec::new();
            for (_, part) in parts {
                roots.extend(part.roots.iter().map(|r| r.path().to_path_buf()));
                items.extend(part.items);
            }
            let sel = ExportSelection::anchored(roots, primary, project, content_roots, &absolute, items)
                .map_err(err)?
                .with_source_root(source_root)
                .with_spelled_root(spelled_root);
            file_copy(sel, skipped, skipped_paths, refusals, settings, non_text)
        }
        ClipCopySource::Changes { paths, side } => {
            let repos = by_repo(&paths)?;
            let mut found = match side {
                ClipChangeSide::Staged => git_items(&repos, || GitSource::Staged)?,
                ClipChangeSide::Working | ClipChangeSide::Unstaged => git_items(&repos, || GitSource::Working)?,
            };
            if matches!(side, ClipChangeSide::Unstaged) {
                for item in &mut found.items {
                    item.source = transfer::SourceKind::Unstaged;
                }
            }
            git_copy(project, content_roots, found, settings, non_text)
        }
        ClipCopySource::CommitFiles { repo, rev, paths } => {
            let root = repo_root(&repo)?;
            let no_filter = paths.is_empty();
            let found = git_items(&[(root.clone(), paths)], || GitSource::Commit(rev.clone()))?;
            if found.items.is_empty() && found.non_utf8.is_empty() && no_filter {
                return Err(IdeError::no_net_changes());
            }
            git_copy(project, content_roots, found, settings, non_text)
        }
        ClipCopySource::Range { repo, base, tip, paths } => {
            let root = repo_root(&repo)?;
            let no_filter = paths.is_empty();
            let found = git_items(&[(root.clone(), paths)], || GitSource::Range(base.clone(), tip.clone()))?;
            if found.items.is_empty() && found.non_utf8.is_empty() && no_filter {
                return Err(IdeError::no_net_changes());
            }
            git_copy(project, content_roots, found, settings, non_text)
        }
        ClipCopySource::RootRange { repo, tip, paths } => {
            let root = repo_root(&repo)?;
            let no_filter = paths.is_empty();
            let empty = Git::open(&root).map_err(err)?.empty_tree_with(&opts).map_err(err)?;
            let found = git_items(&[(root.clone(), paths)], || GitSource::Range(empty.clone(), tip.clone()))?;
            if found.items.is_empty() && found.non_utf8.is_empty() && no_filter {
                return Err(IdeError::no_net_changes());
            }
            git_copy(project, content_roots, found, settings, non_text)
        }
        ClipCopySource::CommitList { repo, revs, paths } => {
            let root = repo_root(&repo)?;
            let no_filter = paths.is_empty();
            let mut picked = GitItems { items: Vec::new(), non_utf8: Vec::new() };
            // Paths a newer selected commit renamed away: they no longer exist there.
            let mut renamed_away: HashSet<String> = HashSet::new();
            // Newest first: a path keeps the item of the newest selected commit touching it.
            for rev in &revs {
                let (found, renamed_from) =
                    git_items_with_renames(&[(root.clone(), paths.clone())], || GitSource::Commit(rev.clone()))?;
                for name in found.non_utf8 {
                    if !picked.non_utf8.contains(&name) {
                        picked.non_utf8.push(name);
                    }
                }
                for item in found.items {
                    if renamed_away.contains(&item.relative_path) {
                        continue;
                    }
                    if !picked.items.iter().any(|i| i.relative_path == item.relative_path) {
                        picked.items.push(item);
                    }
                }
                renamed_away.extend(renamed_from);
            }
            if picked.items.is_empty() && picked.non_utf8.is_empty() && no_filter {
                return Err(IdeError::no_net_changes());
            }
            git_copy(project, content_roots, picked, settings, non_text)
        }
        ClipCopySource::Commits { repo, tip, selected } => {
            let git = Git::open(&repo).map_err(err)?;
            let options = CommitNonTextOptions::from_settings(settings, non_text.into());
            let export = transfer::plan_commit_export_exact_with_non_text(
                &git,
                &tip,
                &selected,
                &opts,
                CLIPBOARD_PAYLOAD_MAX,
                options,
            )
            .map_err(err)?;
            Ok(commit_result(export, settings))
        }
        ClipCopySource::CommitRange { repo, base, tip } => {
            let git = Git::open(&repo).map_err(err)?;
            let options = CommitNonTextOptions::from_settings(settings, non_text.into());
            let export = transfer::plan_commit_export_with_non_text(
                &git,
                Some((&base, &tip)),
                None,
                &opts,
                CLIPBOARD_PAYLOAD_MAX,
                options,
            )
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
    /// A non-text file (`create` / `overwrite`): shown as "non-text file · size", never as text.
    pub non_text: Option<ClipPasteNonText>,
}

/// A non-text entry of a paste preview. Its Base64 is never exposed.
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClipPasteNonText {
    /// Raw bytes the paste writes.
    pub size: f64,
    /// The target exists and already holds exactly these bytes: left unchanged, no overwrite needed.
    pub identical: bool,
}

fn paste_non_text(op: &ide_clip::restore::CreateOperation) -> Option<ClipPasteNonText> {
    op.non_text_size().map(|size| ClipPasteNonText { size: size as f64, identical: op.is_identical() })
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
    /// Raw size of a non-text file this row writes (shown as "non-text file", never as a diff).
    pub non_text_size: Option<f64>,
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
    /// Commits the replay did not create, each with its reason as a code the UI words (never English text).
    pub not_created: Vec<ClipNotCreated>,
    /// Non-text targets that already held the pasted bytes: not written.
    pub unchanged: u32,
    /// Non-text entries skipped because their Base64, size or SHA-256 did not verify (counted in
    /// `skipped`), by payload path.
    pub corrupt_non_text: Vec<String>,
}

/// A replayed commit that was not created because every file change of it was refused or skipped.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClipNotCreated {
    /// 1-based position among the replayed commits.
    pub number: u32,
    /// The commit message's first line.
    pub subject: String,
    /// A skip reason code, as in the preview rows (`NON_UTF8_TARGET`, ...).
    pub reason: String,
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
        non_text_size: f.non_text_size.map(|size| size as f64),
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
    paste_preview_into(dest, None, &[], text, adjust_paths, repos, settings)
}

/// Plans pasting `text`: files restore under `dest` (the project root, as
/// ClipCode's Paste and Restore Files always resolves from the project), while
/// commits replay into the repository of `repo` (the selected repository; `dest`'s
/// when `None`). Nothing is written.
///
/// `content_roots` are the project's other roots (when `dest` is the project):
/// as in ClipCode's `ClipboardPathResolver.fromProject`, a `<label>/…` path of a
/// root outside `dest` restores into that root, whatever `clipcode-root` says,
/// and only a project without other roots is offered a restore base. Only
/// these roots resolve labels; repositories are not roots.
///
/// The one exception is snip-sync's legacy multi-repository payload, which
/// names each repository's files `<repo>/…` and has no `clipcode-root` line:
/// in a project without other roots, a prefix that is no root label and no
/// entry of `dest` lands in the repository of `repos` with that folder name.
pub fn paste_preview_into(
    dest: &Path,
    repo: Option<&Path>,
    content_roots: &[PathBuf],
    text: &str,
    adjust_paths: bool,
    repos: &[PathBuf],
    settings: &Settings,
) -> IdeResult<ClipPastePreview> {
    let opts = RunOptions::default();
    // The copy side caps the LF length; a CRLF pipe adds a byte per line (about 1.3% on wrapped
    // Base64) that must not push a payload that fit over the cap.
    let lf_len = text.len() - text.as_bytes().windows(2).filter(|w| w == b"\r\n").count();
    if lf_len > CLIPBOARD_PAYLOAD_MAX {
        return Err(IdeError::invalid("The clipboard holds more than 50 MiB"));
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
    let others: Vec<PathBuf> = content_roots.iter().filter(|r| !same_dir(r, dest)).cloned().collect();
    // Missing roots only block their labels: like ClipCode's content roots, the
    // single-root guesses below count only the roots that exist.
    let single_root = !others.iter().any(|r| r.is_dir());
    // ClipCode detects a restore base for a single-root project only.
    let suggestion = if single_root {
        suggest_restore_base(
            &dest.to_string_lossy(),
            &paths,
            &FsProbe,
            ide_clip::format::extract_source_root(text).as_deref(),
        )
    } else {
        None
    };
    let primary = CanonicalRootId::new(dest).map_err(err)?;
    // A repository at or under the project root is the project's own folder.
    let project_root = primary.path().to_path_buf();
    let in_project = |r: &Path| {
        CanonicalRootId::new(r).map_or_else(|_| r.starts_with(dest), |id| id.path().starts_with(&project_root))
    };
    let mut mapping = match suggestion.as_ref().filter(|_| adjust_paths) {
        Some(s) => ImportMapping::from_restore_base(s, primary),
        None => ImportMapping::with_primary(primary),
    };
    let mut roots = vec![dest.to_path_buf()];
    roots.extend(mapping.map_root_labels(dest, &others).map_err(err)?);
    // A missing root's label stays blocked whatever the restore base says, so a base
    // stripping it would only skip those files: don't offer it.
    let suggestion = suggestion
        .filter(|s| !matches!(&s.base, RestoreBase::Strip { segment } if mapping.blocked_prefixes.contains(segment)));
    // Like the restore base, the repository guess is for a single-root project only: with
    // other roots, as in ClipCode, only their labels route a prefix, and the payload's other
    // `<dir>/…` paths are the primary's own (a namesake repository must not take them).
    if single_root && ide_clip::format::extract_source_root(text).is_none() {
        for prefix in transfer::detect_clipboard_prefixes(text, header) {
            // A project root's label is already routed (or ambiguous).
            if mapping.prefix_destinations.contains_key(&prefix) || mapping.blocked_prefixes.contains(&prefix) {
                continue;
            }
            // A folder or file the project holds is the project's own path, whatever repository shares its name.
            if std::fs::symlink_metadata(dest.join(&prefix)).is_ok() {
                continue;
            }
            // Only a repository outside the project: one inside is a folder the path
            // already resolves to from the project root, as ClipCode and VS Code do.
            let mut named: Vec<&PathBuf> = Vec::new();
            for r in repos
                .iter()
                .filter(|r| r.file_name().is_some_and(|n| n.to_string_lossy() == prefix.as_str()))
                .filter(|r| !in_project(r))
            {
                if !named.iter().any(|n| same_dir(n, r)) {
                    named.push(r);
                }
            }
            // Several repositories share the name: ambiguous like a shared root label, restored nowhere.
            if named.len() > 1 {
                mapping.block_prefix(prefix);
                continue;
            }
            let Some(repo) = named.pop() else {
                continue;
            };
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
            non_text: paste_non_text(op),
        });
    }
    for (i, op) in restore.delete_operations.iter().enumerate() {
        files.push(ClipPasteFile {
            index: n(i),
            path: op.relative_path.clone(),
            target: Some(op.absolute_path.to_string_lossy().into_owned()),
            action: "delete".into(),
            reason: None,
            non_text: None,
        });
    }
    for (i, op) in restore.skipped_operations.iter().enumerate() {
        files.push(ClipPasteFile {
            index: n(i),
            path: op.relative_path.clone().unwrap_or_else(|| op.raw_path.clone()),
            target: None,
            action: "skip".into(),
            reason: Some(op.reason.as_str().to_string()),
            non_text: None,
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

/// One file of the open paste preview, for the dialog's content pane: what the
/// paste writes and what the destination holds now.
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClipPasteFileContent {
    /// The content the paste writes (`create` and `overwrite`).
    pub incoming: Option<String>,
    /// The destination's text now (`overwrite` and `delete`).
    pub current: Option<String>,
    /// Why `current` is missing although the file exists: binary, too large, unreadable.
    pub note: Option<String>,
    /// Set for a non-text entry: the pane shows "non-text file · size" and whether the target is
    /// identical, with no content and no diff (`incoming` and `current` stay empty).
    pub non_text: Option<ClipPasteNonText>,
}

/// Larger destination files are not shown: the pane is a preview, not an editor.
const PREVIEW_FILE_MAX: u64 = 2 * 1024 * 1024;

/// The content pane of the preview `id`'s file `index` of kind `action` (as in
/// [`ClipPasteFile`]). Reads without consuming the preview, which Apply still needs.
pub fn paste_preview_file(id: u32, action: &str, index: u32) -> IdeResult<ClipPasteFileContent> {
    let i = index as usize;
    let (incoming, existing) = {
        let guard = PENDING.lock().unwrap_or_else(|e| e.into_inner());
        let Some(Pending::Files(plan)) = guard.as_ref().and_then(|m| m.get(&id)) else {
            return Err(IdeError::invalid("The paste preview is gone; paste again"));
        };
        let restore = plan.restore_plan();
        match action {
            "create" | "overwrite" => {
                let op = restore.create_operations.get(i).ok_or_else(|| IdeError::invalid("No such file"))?;
                if let Some(non_text) = paste_non_text(op) {
                    return Ok(ClipPasteFileContent { non_text: Some(non_text), ..Default::default() });
                }
                (Some(op.content.clone()), op.existed.then(|| op.absolute_path.clone()))
            }
            "delete" => {
                let op = restore.delete_operations.get(i).ok_or_else(|| IdeError::invalid("No such file"))?;
                (None, Some(op.absolute_path.clone()))
            }
            _ => return Ok(ClipPasteFileContent::default()),
        }
    };
    let (current, note) = match existing {
        None => (None, None),
        Some(path) => match std::fs::metadata(&path) {
            Ok(meta) if meta.len() > PREVIEW_FILE_MAX => (None, Some("The file is too large to preview".to_string())),
            Ok(_) => match std::fs::read(&path).map(String::from_utf8) {
                Ok(Ok(text)) => (Some(text), None),
                Ok(Err(_)) => (None, Some("The file is binary".to_string())),
                Err(error) => (None, Some(error.to_string())),
            },
            Err(error) => (None, Some(error.to_string())),
        },
    };
    Ok(ClipPasteFileContent { incoming, current, note, non_text: None })
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
                // An identical non-text target needs no permission: it runs and is reported unchanged.
                if op.existed && !op.is_identical() && !overwrite.contains(&i) {
                    unchecked.insert(i);
                }
            }
            let selection = RestoreSelection {
                overwrite_existing: true,
                skip_existing: false,
                unchecked_creates: unchecked,
                unchecked_deletes: req.unchecked_deletes.iter().map(|&i| i as usize).collect(),
            };
            // Only writes that actually committed are reported: a failed write
            // keeps its open buffer (and the user's unsaved edits).
            let mut written: Vec<PathBuf> = Vec::new();
            let corrupt_non_text: Vec<String> = restore
                .skipped_operations
                .iter()
                .filter(|op| op.reason == SkipReason::CorruptNonText)
                .map(|op| op.relative_path.clone().unwrap_or_else(|| op.raw_path.clone()))
                .collect();
            let r = plan
                .apply_observed(&selection, &mut |op, _| written.push(op.absolute_path.clone()))
                .map_err(|e| IdeError::invalid(e.paste_message()))?;
            let result = ClipPasteResult {
                created: n(r.created_count),
                overwritten: n(r.overwritten_count),
                deleted: n(r.deleted_count),
                skipped: n(r.total_skipped()),
                commits: Vec::new(),
                errors: r.errors,
                not_created: Vec::new(),
                unchanged: n(r.unchanged_count),
                corrupt_non_text,
            };
            Ok((result, written))
        }
        Pending::Commits(preview) => {
            preview.revalidate().map_err(|e| IdeError::invalid(e.paste_message()))?;
            if !req.overwrite_existing && !preview.plan().existing_writes().is_empty() {
                return Err(IdeError::invalid("Files of the commits exist in the destination; allow overwriting"));
            }
            let corrupt_non_text: Vec<String> = preview
                .plan()
                .commits
                .iter()
                .flat_map(|c| &c.files)
                .filter(|f| f.skip_reason == Some(ReplaySkipReason::CorruptNonText))
                .map(|f| f.path.clone())
                .collect();
            let r = preview.apply().map_err(|e| IdeError::invalid(e.paste_message()))?;
            let not_created: Vec<ClipNotCreated> = r
                .not_created
                .iter()
                .map(|c| ClipNotCreated {
                    number: n(c.index + 1),
                    subject: c.message.lines().next().unwrap_or("").to_string(),
                    reason: tag(&c.reason),
                })
                .collect();
            let mut errors: Vec<String> = Vec::new();
            if let Some(f) = &r.failure {
                errors.push(format!(
                    "Commit {} ({}) failed: {}",
                    f.index + 1,
                    f.message.lines().next().unwrap_or(""),
                    f.error
                ));
            }
            Ok((
                ClipPasteResult { commits: r.created, errors, not_created, corrupt_non_text, ..Default::default() },
                Vec::new(),
            ))
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

pub async fn clip_copy(
    host: &Host,
    window: &str,
    source: ClipCopySource,
    non_text: ClipNonTextMode,
) -> IdeResult<ClipCopyResult> {
    let project = host.project(window)?;
    let settings = clip_settings(&project.settings.effective().vcs.clip_code);
    blocking(move || copy_in_with(&project.root, &project.content_roots(), source, &settings, non_text)).await
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
        // The project's other roots resolve their labels only when restoring into the project itself.
        // Missing ones too: their labels must not fall through to `dest`.
        let content_roots = if same_dir(dest, &project.root) { project.declared_content_roots() } else { Vec::new() };
        paste_preview_into(dest, repo.as_deref(), &content_roots, &text, adjust_paths, &repos, &settings)
    })
    .await
}

pub async fn clip_paste_apply(host: &Host, window: &str, apply: ClipPasteApply) -> IdeResult<ClipPasteResult> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let (result, written) = blocking(move || paste_apply_with_paths(apply)).await?;
    // The user confirmed the overwrite: open editors in every project and window show the restored
    // content, not their unsaved buffer (a stale one could save over it). Projects that do not have
    // a path open skip it.
    for open in host.projects() {
        open.documents.reload_from_disk(&written);
    }
    project.sink.emit(ide_core::IdeEvent::VcsChanged { root: project.root.clone().into() });
    Ok(result)
}

pub async fn clip_paste_preview_file(
    host: &Host,
    window: &str,
    id: u32,
    action: String,
    index: u32,
) -> IdeResult<ClipPasteFileContent> {
    host.project(window)?;
    blocking(move || paste_preview_file(id, &action, index)).await
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
    d.add("clip_copy", |c| async move {
        let non_text: Option<ClipNonTextMode> = c.arg("nonText")?;
        clip_copy(&c.host, &c.window, c.arg("source")?, non_text.unwrap_or_default()).await
    });
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
    d.add("clip_paste_preview_file", |c| async move {
        clip_paste_preview_file(&c.host, &c.window, c.arg("id")?, c.arg("action")?, c.arg("index")?).await
    });
    d.add("clip_paste_apply", |c| async move { clip_paste_apply(&c.host, &c.window, c.arg("apply")?).await });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;
    use std::process::Command;

    /// A path as ClipCode headers spell it: `/` on every OS (`C:/x` on Windows).
    fn slash(path: &Path) -> String {
        path.to_string_lossy().replace('\\', "/")
    }

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
        fs::OpenOptions::new()
            .append(true)
            .open(dir.join(".git/config"))
            .unwrap()
            .write_all(b"[user]\n\tname = Tester\n\temail = t@example.com\n[commit]\n\tgpgsign = false\n")
            .unwrap();
        fs::write(dir.join("README.md"), "base\n").unwrap();
        git(dir, &["add", "-A"]);
        git(dir, &["commit", "-q", "-m", "init"]);
        dunce::canonicalize(dir).unwrap()
    }

    /// Project `M` (a plain folder with `src/x.txt`) holding the repository `M/repo`,
    /// whose `src/a.ts` is added by `c1` and changed by `c2`. Returns (M, repo, c1, c2).
    fn monorepo(tmp: &Path) -> (PathBuf, PathBuf, String, String) {
        fs::create_dir_all(tmp).unwrap();
        let m = dunce::canonicalize(tmp).unwrap().join("M");
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
            if matches!(source, ClipCopySource::RootRange { .. }) {
                // The root range carries the repository's other files under its folder too.
                assert!(text.contains("// file: [NEW] repo/README.md\n"), "{text}");
            }
        }

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
        let m = dunce::canonicalize(tmp.path()).unwrap().join("M");
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
        let abs = format!("{}/README.md", slash(&r));
        assert!(text.contains(&format!("// file: [MODIFIED] {abs}\n")), "{text}");

        // A repository beside the project is no project root either: absolute, as Files copies spell it.
        let ext = repo(&tmp.path().join("ext"));
        fs::write(ext.join("README.md"), "ext\n").unwrap();
        let text = copied(&sub, ClipCopySource::Changes { paths: vec![ext.clone()], side: ClipChangeSide::Working });
        let abs = format!("{}/README.md", slash(&ext));
        assert!(text.contains(&format!("// file: [MODIFIED] {abs}\n")), "{text}");
    }

    /// Project `M` holding a plain `ext/a.txt`, beside the repository `ext` whose
    /// committed `a.txt` shares that label. Returns (M, ext).
    fn colliding_external_label(tmp: &Path) -> (PathBuf, PathBuf) {
        let base = dunce::canonicalize(tmp).unwrap();
        let m = base.join("M");
        fs::create_dir_all(m.join("ext")).unwrap();
        fs::write(m.join("ext/a.txt"), "project\n").unwrap();
        let ext = repo(&base.join("other/ext"));
        commit_file(&ext, "a.txt", Some("external\n"), "add a");
        (m, ext)
    }

    fn targets_of(preview: &ClipPastePreview) -> Vec<String> {
        preview.files.iter().filter_map(|f| f.target.as_deref().map(|t| slash(Path::new(t)))).collect()
    }

    #[test]
    fn an_external_label_taken_in_the_project_is_spelled_absolute_so_a_delete_cannot_hit_the_project() {
        let tmp = tempfile::tempdir().unwrap();
        let (m, ext) = colliding_external_label(tmp.path());
        fs::remove_file(ext.join("a.txt")).unwrap();
        let text = copied(&m, ClipCopySource::Changes { paths: vec![ext.clone()], side: ClipChangeSide::Working });
        let abs = format!("{}/a.txt", slash(&ext));
        assert!(text.contains(&format!("// file: [DELETED] {abs}\n")), "{text}");
        let preview = paste_preview(&m, &text, false, &[], &Settings::default()).unwrap();
        let project_file = slash(&m.join("ext/a.txt"));
        assert!(!targets_of(&preview).contains(&project_file), "{:?}", preview.files);
        assert!(preview.files.iter().all(|f| f.action != "delete"), "{:?}", preview.files);
    }

    #[test]
    fn an_external_label_taken_in_the_project_is_spelled_absolute_so_a_write_cannot_hit_the_project() {
        let tmp = tempfile::tempdir().unwrap();
        let (m, ext) = colliding_external_label(tmp.path());
        fs::write(ext.join("a.txt"), "external changed\n").unwrap();
        let text = copied(&m, ClipCopySource::Changes { paths: vec![ext.clone()], side: ClipChangeSide::Working });
        let abs = format!("{}/a.txt", slash(&ext));
        assert!(text.contains(&format!("// file: [MODIFIED] {abs}\n")), "{text}");
        let preview = paste_preview(&m, &text, false, &[], &Settings::default()).unwrap();
        let project_file = slash(&m.join("ext/a.txt"));
        assert!(!targets_of(&preview).contains(&project_file), "{:?}", preview.files);
    }

    /// Repository `W` with a committed `ext/a.txt`, the plain content root `C`, and
    /// the repository `other/a/ext` (not a project root) sharing that folder name.
    /// Returns (W, C, ext).
    fn multi_root_with_a_namesake_repository(tmp: &Path) -> (PathBuf, PathBuf, PathBuf) {
        let base = dunce::canonicalize(tmp).unwrap();
        let w = repo(&base.join("W"));
        fs::create_dir_all(w.join("ext")).unwrap();
        commit_file(&w, "ext/a.txt", Some("project\n"), "add ext/a");
        let c = base.join("C");
        fs::create_dir_all(&c).unwrap();
        fs::write(c.join("c.txt"), "c\n").unwrap();
        let ext = repo(&base.join("other/a/ext"));
        commit_file(&ext, "a.txt", Some("external\n"), "add a");
        (w, c, ext)
    }

    #[test]
    fn a_multi_root_paste_keeps_primary_relative_paths_out_of_a_namesake_repository() {
        let tmp = tempfile::tempdir().unwrap();
        let (w, c, ext) = multi_root_with_a_namesake_repository(tmp.path());
        let roots = vec![c.clone()];
        let repos = vec![w.clone(), ext.clone()];
        let project_file = slash(&w.join("ext/a.txt"));
        let external_file = slash(&ext.join("a.txt"));
        let copy_w = || {
            let source = ClipCopySource::Changes { paths: vec![w.clone()], side: ClipChangeSide::Working };
            copy_in(&w, &roots, source, &Settings::default()).unwrap().text
        };

        // A write: the modified project file restores into the project.
        fs::write(w.join("ext/a.txt"), "changed\n").unwrap();
        let text = copy_w();
        assert!(!text.contains("// clipcode-root:"), "{text}");
        assert!(text.contains("// file: [MODIFIED] ext/a.txt\n"), "{text}");
        fs::write(w.join("ext/a.txt"), "project\n").unwrap();
        let preview = paste_preview_into(&w, None, &roots, &text, false, &repos, &Settings::default()).unwrap();
        assert_eq!(targets_of(&preview), vec![project_file.clone()], "{:?}", preview.files);
        assert_eq!(preview.files[0].action, "overwrite");

        // A delete, also once the project's folder is gone with its last file.
        fs::remove_file(w.join("ext/a.txt")).unwrap();
        let text = copy_w();
        assert!(text.contains("// file: [DELETED] ext/a.txt\n"), "{text}");
        for remove_dir in [false, true] {
            if remove_dir {
                fs::remove_dir(w.join("ext")).unwrap();
            }
            let preview = paste_preview_into(&w, None, &roots, &text, false, &repos, &Settings::default()).unwrap();
            assert!(!targets_of(&preview).contains(&external_file), "{:?}", preview.files);
        }
        assert_eq!(fs::read_to_string(ext.join("a.txt")).unwrap(), "external\n");
    }

    /// Workspace `W` (a plain folder) whose content root `repos/ext/subdir` lies inside the
    /// repository `repos/ext` (committed `a.txt` and `subdir/b.txt`). Returns (W, ext).
    fn content_root_inside_a_repository(tmp: &Path) -> (PathBuf, PathBuf) {
        let base = dunce::canonicalize(tmp).unwrap();
        let w = base.join("W");
        fs::create_dir_all(&w).unwrap();
        fs::write(w.join("notes.txt"), "w\n").unwrap();
        let ext = repo(&base.join("repos/ext"));
        fs::create_dir_all(ext.join("subdir")).unwrap();
        commit_file(&ext, "a.txt", Some("a1\n"), "add a");
        commit_file(&ext, "subdir/b.txt", Some("b1\n"), "add b");
        (w, ext)
    }

    #[test]
    fn a_repository_file_outside_every_project_root_is_spelled_absolute_and_never_lands_in_the_project() {
        let tmp = tempfile::tempdir().unwrap();
        let (w, ext) = content_root_inside_a_repository(tmp.path());
        let roots = vec![ext.join("subdir")];
        fs::write(ext.join("a.txt"), "a2\n").unwrap();
        fs::write(ext.join("subdir/b.txt"), "b2\n").unwrap();
        let abs = format!("{}/a.txt", slash(&ext));
        let sources = [
            ClipCopySource::Files { paths: vec![ext.join("a.txt"), ext.join("subdir/b.txt")] },
            ClipCopySource::Changes { paths: vec![ext.clone()], side: ClipChangeSide::Working },
        ];
        for source in sources {
            let text = copy_in(&w, &roots, source.clone(), &Settings::default()).unwrap().text;
            assert!(!text.contains("// clipcode-root:"), "{source:?}:\n{text}");
            let (_, headers) = spelling(&text);
            assert!(headers.contains(&abs), "{source:?}:\n{text}");
            assert!(headers.contains(&"subdir/b.txt".to_string()), "{source:?}:\n{text}");
            assert!(!headers.contains(&"ext/a.txt".to_string()), "{source:?}:\n{text}");

            fs::write(ext.join("a.txt"), "a1\n").unwrap();
            fs::write(ext.join("subdir/b.txt"), "b1\n").unwrap();
            let repos = vec![ext.clone()];
            let preview = paste_preview_into(&w, None, &roots, &text, false, &repos, &Settings::default()).unwrap();
            let project_file = slash(&w.join("ext/a.txt"));
            assert!(!targets_of(&preview).contains(&project_file), "{:?}", preview.files);
            let overwrite = preview.files.iter().filter(|f| f.action == "overwrite").map(|f| f.index).collect();
            paste_apply(ClipPasteApply { id: preview.id, overwrite, ..Default::default() }).unwrap();
            assert!(!w.join("ext").exists());
            assert_eq!(fs::read_to_string(ext.join("subdir/b.txt")).unwrap().trim_end(), "b2");
            fs::write(ext.join("a.txt"), "a2\n").unwrap();
        }
    }

    #[test]
    fn a_selected_folder_spanning_a_content_root_labels_and_filters_each_file_by_its_own_root() {
        let tmp = tempfile::tempdir().unwrap();
        let (w, ext) = content_root_inside_a_repository(tmp.path());
        fs::write(ext.join("subdir/secrets.env"), "TOKEN=hunter2\n").unwrap();
        let roots = vec![ext.join("subdir")];
        use ide_clip::settings::{FilterAction, FilterRule, FilterType};
        let settings = Settings {
            use_filters: true,
            use_exclude_filters: true,
            filter_rules: vec![FilterRule {
                kind: FilterType::Path,
                action: FilterAction::Exclude,
                value: "subdir/secrets.env".into(),
                enabled: true,
            }],
            ..Settings::default()
        };
        let source = ClipCopySource::Files { paths: vec![ext.clone()] };
        let text = copy_in(&w, &roots, source, &settings).unwrap().text;
        let (_, headers) = spelling(&text);
        assert!(headers.contains(&"subdir/b.txt".to_string()), "{text}");
        assert!(!text.contains("secrets.env") && !text.contains("hunter2"), "{text}");
        assert!(headers.contains(&format!("{}/a.txt", slash(&ext))), "{text}");

        // The content root's file restores into the content root.
        fs::write(ext.join("subdir/b.txt"), "b2\n").unwrap();
        let preview = paste_preview_into(&w, None, &roots, &text, false, &[], &Settings::default()).unwrap();
        let b = slash(&ext.join("subdir/b.txt"));
        assert!(targets_of(&preview).contains(&b), "{:?}", preview.files);
        let overwrite = preview.files.iter().filter(|f| f.action == "overwrite").map(|f| f.index).collect();
        paste_apply(ClipPasteApply { id: preview.id, overwrite, ..Default::default() }).unwrap();
        assert_eq!(fs::read_to_string(ext.join("subdir/b.txt")).unwrap().trim_end(), "b1");
        assert!(!w.join("subdir").exists());
    }

    #[test]
    fn a_legacy_repository_prefix_never_takes_a_folder_the_project_holds() {
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        let w = base.join("W");
        fs::create_dir_all(w.join("ext")).unwrap();
        fs::write(w.join("ext/a.txt"), "project\n").unwrap();
        let ext = repo(&base.join("other/a/ext"));
        commit_file(&ext, "a.txt", Some("external\n"), "add a");
        let text = "// file: ext/a.txt\nnew\n";
        let preview = paste_preview(&w, text, false, std::slice::from_ref(&ext), &Settings::default()).unwrap();
        assert_eq!(targets_of(&preview), vec![slash(&w.join("ext/a.txt"))]);
    }

    #[test]
    fn a_legacy_multi_repository_payload_restores_into_the_named_repository() {
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        let w = base.join("W");
        fs::create_dir_all(&w).unwrap();
        let lib = repo(&base.join("lib"));
        let text = "// file: lib/x.txt\nnew\n";
        let preview = paste_preview(&w, text, false, std::slice::from_ref(&lib), &Settings::default()).unwrap();
        assert_eq!(targets_of(&preview), vec![slash(&lib.join("x.txt"))]);
        paste_apply(ClipPasteApply { id: preview.id, ..Default::default() }).unwrap();
        assert_eq!(fs::read_to_string(lib.join("x.txt")).unwrap().trim_end(), "new");
        assert!(!w.join("lib").exists());

        // Spelled `./lib/…` or `lib\…`, it is the same repository prefix.
        for text in ["// file: ./lib/y.txt\ny\n", "// file: lib\\y.txt\ny\n"] {
            let preview = paste_preview(&w, text, false, std::slice::from_ref(&lib), &Settings::default()).unwrap();
            assert_eq!(targets_of(&preview), vec![slash(&lib.join("y.txt"))], "{text:?}");
        }
    }

    /// A content root that no longer exists blocks its own label, but is not one of
    /// the project's roots: the single-root restore base and repository guess still apply.
    #[test]
    fn a_missing_content_root_keeps_the_single_root_guesses() {
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        let w = base.join("W");
        fs::create_dir_all(w.join("app/src")).unwrap();
        fs::create_dir_all(w.join("app/test")).unwrap();
        let lib = repo(&base.join("lib"));
        let roots = vec![base.join("gone/ext")];

        let text = "// file: lib/x.txt\nnew\n";
        let preview =
            paste_preview_into(&w, None, &roots, text, false, std::slice::from_ref(&lib), &Settings::default())
                .unwrap();
        assert_eq!(targets_of(&preview), vec![slash(&lib.join("x.txt"))]);

        let text = "// file: src/a.txt\na\n// file: test/b.txt\nb\n";
        let preview = paste_preview_into(&w, None, &roots, text, false, &[], &Settings::default()).unwrap();
        assert_eq!(preview.suggestion.as_deref(), Some("place everything under \"app/\""));

        // The missing root's label still restores nowhere.
        let preview =
            paste_preview_into(&w, None, &roots, "// file: ext/y.txt\ny\n", false, &[], &Settings::default()).unwrap();
        assert!(targets_of(&preview).is_empty(), "{:?}", preview.files);
    }

    /// A missing root named like the project: stripping its label as a restore base
    /// would land its files (and deletes) in the project, so they restore nowhere.
    #[test]
    fn a_restore_base_does_not_route_a_missing_roots_label_into_the_project() {
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        let w = base.join("W");
        fs::create_dir_all(w.join("src")).unwrap();
        fs::create_dir_all(w.join("test")).unwrap();
        fs::write(w.join("src/a.txt"), "keep\n").unwrap();
        let roots = vec![base.join("missing/W")];

        for text in [
            "// file: W/src/a.txt\nnew\n// file: W/test/b.txt\nb\n",
            "// file: [DELETED] W/src/a.txt\n// file: W/test/b.txt\nb\n",
        ] {
            let preview = paste_preview_into(&w, None, &roots, text, true, &[], &Settings::default()).unwrap();
            assert!(targets_of(&preview).is_empty(), "{text:?} {:?}", preview.files);
            assert!(preview.files.iter().all(|f| f.action == "skip"), "{text:?} {:?}", preview.files);
            assert_eq!(preview.suggestion, None, "{text:?}");
        }
        assert_eq!(fs::read_to_string(w.join("src/a.txt")).unwrap(), "keep\n");
        assert!(!w.join("test/b.txt").exists());
    }

    #[test]
    fn a_legacy_repository_prefix_shared_by_two_repositories_restores_nowhere() {
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        let m = base.join("M");
        fs::create_dir_all(&m).unwrap();
        let (a, b) = (repo(&base.join("a/lib")), repo(&base.join("b/lib")));
        let text = "// file: lib/x.txt\nnew\n";
        let preview = paste_preview(&m, text, false, &[a.clone(), b.clone()], &Settings::default()).unwrap();
        assert!(targets_of(&preview).is_empty(), "{:?}", preview.files);
        assert_eq!(preview.files.len(), 1, "{:?}", preview.files);
        assert_eq!(preview.files[0].action, "skip");
        assert!(!a.join("x.txt").exists() && !b.join("x.txt").exists() && !m.join("lib").exists());
    }

    /// A repository inside the project is the project's own folder, not a legacy
    /// `<repo>/…` target: the path resolves from the project root, as in ClipCode.
    #[test]
    fn a_legacy_repository_prefix_never_routes_into_a_repository_inside_the_project() {
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        let p = base.join("P");
        let inside = repo(&p.join("libs/a"));
        let text = "// file: a/src/f.ts\nnew\n";
        let preview = paste_preview(&p, text, false, std::slice::from_ref(&inside), &Settings::default()).unwrap();
        assert_eq!(targets_of(&preview), vec![slash(&p.join("a/src/f.ts"))]);

        // Beside a same-named repository outside the project, only the outside one counts.
        let outside = repo(&base.join("a"));
        let repos = [inside.clone(), outside.clone()];
        let preview = paste_preview(&p, text, false, &repos, &Settings::default()).unwrap();
        assert_eq!(targets_of(&preview), vec![slash(&outside.join("src/f.ts"))]);
    }

    /// As ClipCode's `ClipboardPathResolver`: an unlabelled path the primary lacks
    /// resolves to the content root that holds it; held by both, it is ambiguous.
    #[test]
    fn an_unlabelled_path_restores_into_the_content_root_that_holds_it() {
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        let w = base.join("W");
        fs::create_dir_all(&w).unwrap();
        let c = base.join("C");
        fs::create_dir_all(c.join("src")).unwrap();
        fs::write(c.join("src/x.ts"), "c\n").unwrap();
        let roots = vec![c.clone()];
        let c_file = slash(&c.join("src/x.ts"));
        let preview_of =
            |text: &str| paste_preview_into(&w, None, &roots, text, false, &[], &Settings::default()).unwrap();

        let preview = preview_of("// file: src/x.ts\nnew\n");
        assert_eq!(targets_of(&preview), vec![c_file.clone()], "{:?}", preview.files);
        assert_eq!(preview.files[0].action, "overwrite");
        paste_apply(ClipPasteApply { id: preview.id, overwrite: vec![0], ..Default::default() }).unwrap();
        assert_eq!(fs::read_to_string(c.join("src/x.ts")).unwrap().trim_end(), "new");
        assert!(!w.join("src").exists());

        let preview = preview_of("// file: [DELETED] src/x.ts\n");
        assert_eq!(targets_of(&preview), vec![c_file.clone()], "{:?}", preview.files);
        assert_eq!(preview.files[0].action, "delete");

        fs::create_dir_all(w.join("src")).unwrap();
        fs::write(w.join("src/x.ts"), "w\n").unwrap();
        let preview = preview_of("// file: src/x.ts\nnew\n");
        assert!(targets_of(&preview).is_empty(), "{:?}", preview.files);
        assert_eq!(preview.files[0].reason.as_deref(), Some("AMBIGUOUS_PATH"), "{:?}", preview.files);
    }

    /// Workspace `W` (a plain folder) with the content root `x/a`, a repository
    /// whose committed `src/f.ts` is modified. Returns (W, a).
    fn workspace_with_external_root(tmp: &Path) -> (PathBuf, PathBuf) {
        let base = dunce::canonicalize(tmp).unwrap();
        let w = base.join("W");
        fs::create_dir_all(&w).unwrap();
        fs::write(w.join("notes.txt"), "w\n").unwrap();
        let a = repo(&base.join("x/a"));
        fs::create_dir_all(a.join("src")).unwrap();
        commit_file(&a, "src/f.ts", Some("f1\n"), "add f");
        fs::write(a.join("src/f.ts"), "f2\n").unwrap();
        (w, a)
    }

    #[test]
    fn a_project_with_several_roots_names_none_and_restores_a_root_label_into_that_root() {
        let tmp = tempfile::tempdir().unwrap();
        let (w, a) = workspace_with_external_root(tmp.path());
        let roots = vec![a.clone()];
        let source = ClipCopySource::Changes { paths: vec![a.clone()], side: ClipChangeSide::Working };
        let text = copy_in(&w, &roots, source, &Settings::default()).unwrap().text;
        assert!(!text.contains("// clipcode-root:"), "{text}");
        assert!(text.contains("// file: [MODIFIED] a/src/f.ts\n"), "{text}");

        fs::write(a.join("src/f.ts"), "f1\n").unwrap();
        let preview = paste_preview_into(&w, None, &roots, &text, false, &[], &Settings::default()).unwrap();
        assert_eq!(preview.suggestion, None);
        assert_eq!(preview.files.len(), 1, "{:?}", preview.files);
        assert_eq!(preview.files[0].target.as_deref().map(|t| slash(Path::new(t))), Some(slash(&a.join("src/f.ts"))));
        assert_eq!(preview.files[0].action, "overwrite");
        paste_apply(ClipPasteApply { id: preview.id, overwrite: vec![0], ..Default::default() }).unwrap();
        assert_eq!(fs::read_to_string(a.join("src/f.ts")).unwrap().trim_end(), "f2");
        assert!(!w.join("a").exists());
    }

    #[test]
    fn a_root_label_restores_into_its_root_even_under_a_clipcode_root_line() {
        let tmp = tempfile::tempdir().unwrap();
        let (w, a) = workspace_with_external_root(tmp.path());
        let roots = vec![a.clone()];
        let text = "// clipcode-root: W\n// file: a/src/f.ts\nf3\n";
        let preview = paste_preview_into(&w, None, &roots, text, false, &[], &Settings::default()).unwrap();
        assert_eq!(preview.files.len(), 1, "{:?}", preview.files);
        assert_eq!(preview.files[0].target.as_deref().map(|t| slash(Path::new(t))), Some(slash(&a.join("src/f.ts"))));

        // A label the project also holds as a folder is ambiguous: nothing is written to either.
        fs::create_dir_all(w.join("a/src")).unwrap();
        let preview = paste_preview_into(&w, None, &roots, text, false, &[], &Settings::default()).unwrap();
        assert!(preview.files.iter().all(|f| f.target.is_none()), "{:?}", preview.files);
    }

    #[test]
    fn a_single_root_project_still_names_itself() {
        let tmp = tempfile::tempdir().unwrap();
        let (w, a) = workspace_with_external_root(tmp.path());
        let source = ClipCopySource::Changes { paths: vec![a.clone()], side: ClipChangeSide::Working };
        let text = copy_in(&w, &[], source, &Settings::default()).unwrap().text;
        assert!(text.starts_with("// clipcode-root: W\n"), "{text}");
        let text = copy_in(&w, &[], ClipCopySource::Files { paths: vec![w.join("notes.txt")] }, &Settings::default())
            .unwrap()
            .text;
        assert!(text.starts_with("// clipcode-root: W\n"), "{text}");
    }

    /// The first line and the header paths (change labels dropped) of a payload.
    fn spelling(text: &str) -> (String, Vec<String>) {
        let headers = text
            .lines()
            .filter_map(|l| l.strip_prefix("// file: "))
            .map(|p| p.split_once("] ").filter(|_| p.starts_with('[')).map_or(p, |(_, rest)| rest).to_string())
            .collect();
        (text.lines().next().unwrap_or("").to_string(), headers)
    }

    #[test]
    fn files_and_changes_spell_the_same_files_alike() {
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        let m = repo(&base.join("M"));
        let ext = repo(&base.join("ext"));
        fs::write(m.join("README.md"), "m\n").unwrap();
        fs::write(ext.join("README.md"), "ext\n").unwrap();
        let same = |content_roots: &[PathBuf], files: Vec<PathBuf>, repos: Vec<PathBuf>| {
            let f = copy_in(&m, content_roots, ClipCopySource::Files { paths: files }, &Settings::default()).unwrap();
            let changes = ClipCopySource::Changes { paths: repos, side: ClipChangeSide::Working };
            let c = copy_in(&m, content_roots, changes, &Settings::default()).unwrap();
            assert_eq!(spelling(&f.text), spelling(&c.text), "Files:\n{}\nChanges:\n{}", f.text, c.text);
            spelling(&f.text)
        };
        // Only a file of a repository beside the project: no project root covers it, so it is absolute.
        let abs = format!("{}/README.md", slash(&ext));
        let (first, headers) = same(&[], vec![ext.join("README.md")], vec![ext.clone()]);
        assert_eq!(first, "// clipcode-root: M");
        assert_eq!(headers, vec![abs.clone()]);
        // A project file and the external one, in either order.
        for (files, repos) in [
            (vec![m.join("README.md"), ext.join("README.md")], vec![m.clone(), ext.clone()]),
            (vec![ext.join("README.md"), m.join("README.md")], vec![ext.clone(), m.clone()]),
        ] {
            let (first, mut headers) = same(&[], files, repos);
            headers.sort();
            assert_eq!(first, "// clipcode-root: M");
            assert_eq!(headers, vec![abs.clone(), "README.md".to_string()]);
        }
        // The repository as a content root of the project: no root line, labelled alike.
        let (first, headers) = same(std::slice::from_ref(&ext), vec![ext.join("README.md")], vec![ext.clone()]);
        assert!(!first.starts_with("// clipcode-root:"), "{first}");
        assert_eq!(headers, vec!["ext/README.md"]);
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
        let target = slash(&r.join("src/a.ts"));
        assert_eq!(preview.files[0].target.as_deref().map(|t| slash(Path::new(t))), Some(target));
        assert_eq!(preview.files[0].action, "overwrite");
    }

    #[test]
    fn commits_pasted_from_the_project_replay_into_the_selected_repository() {
        let tmp = tempfile::tempdir().unwrap();
        let (_, src, _, c2) = monorepo(&tmp.path().join("src"));
        let commits = copied(&src, ClipCopySource::Commits { repo: src.clone(), tip: c2.clone(), selected: vec![c2] });
        let dst = dunce::canonicalize(tmp.path()).unwrap().join("dst");
        let target = repo(&dst.join("repo"));
        fs::create_dir_all(target.join("src")).unwrap();
        commit_file(&target, "src/a.ts", Some("a1\n"), "add a");

        // The project root is a plain folder: the files destination, never the replay's.
        assert!(paste_preview(&dst, &commits, false, &[], &Settings::default()).is_err());
        let preview = paste_preview_into(&dst, Some(&target), &[], &commits, false, &[], &Settings::default()).unwrap();
        assert_eq!(preview.mode, "commits");
        assert_eq!(slash(Path::new(&preview.destination)), slash(&target));
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
        let outside = dunce::canonicalize(tmp.path()).unwrap().join("loose");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join(".zshrc"), "export A=1\n").unwrap();
        let abs = format!("{}/.zshrc", slash(&outside));

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
    fn several_external_roots_and_a_project_file_copy_in_any_order() {
        let tmp = tempfile::tempdir().unwrap();
        let a = repo(&tmp.path().join("a"));
        fs::write(a.join("main.kt"), "fun main() {}\n").unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        // Two roots no repository covers, with the same basename and file name.
        let x = base.join("x/loose");
        let y = base.join("y/loose");
        for d in [&x, &y] {
            fs::create_dir_all(d).unwrap();
            fs::write(d.join(".zshrc"), "export A=1\n").unwrap();
        }
        let orders = [
            vec![x.join(".zshrc"), y.join(".zshrc"), a.join("main.kt")],
            vec![a.join("main.kt"), x.join(".zshrc"), y.join(".zshrc")],
            vec![x.join(".zshrc"), a.join("main.kt"), y.join(".zshrc")],
        ];
        for paths in orders {
            let copied = copy(&a, ClipCopySource::Files { paths }, &Settings::default()).unwrap();
            assert_eq!(copied.files, 3, "{}", copied.text);
            assert!(copied.text.contains("// file: main.kt"), "{}", copied.text);
            for d in [&x, &y] {
                assert!(copied.text.contains(&format!("// file: {}/.zshrc", slash(d))), "{}", copied.text);
            }
        }
    }

    #[test]
    fn filter_rules_still_match_project_files_when_an_external_file_is_selected_first() {
        use ide_clip::settings::{FilterAction, FilterRule, FilterType};
        let tmp = tempfile::tempdir().unwrap();
        let a = repo(&tmp.path().join("a"));
        fs::write(a.join("main.kt"), "fun main() {}\n").unwrap();
        fs::write(a.join("secret.txt"), "s\n").unwrap();
        let outside = dunce::canonicalize(tmp.path()).unwrap().join("loose");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join(".zshrc"), "export A=1\n").unwrap();
        let settings = Settings {
            use_filters: true,
            use_exclude_filters: true,
            filter_rules: vec![FilterRule {
                kind: FilterType::Path,
                action: FilterAction::Exclude,
                value: a.join("secret.txt").to_string_lossy().into_owned(),
                enabled: true,
            }],
            ..Settings::default()
        };
        let paths = vec![outside.join(".zshrc"), a.join("main.kt"), a.join("secret.txt")];
        let copied = copy(&a, ClipCopySource::Files { paths }, &settings).unwrap();
        assert!(copied.text.contains("// file: main.kt"), "{}", copied.text);
        assert!(!copied.text.contains("secret.txt"), "{}", copied.text);
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

    #[cfg(unix)]
    #[test]
    fn a_failed_write_is_not_reported_as_written() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let a = repo(&tmp.path().join("a"));
        fs::create_dir_all(a.join("locked")).unwrap();
        fs::write(a.join("locked/f.txt"), "from a\n").unwrap();
        fs::write(a.join("ok.txt"), "from a\n").unwrap();
        let copied = copy(
            &a,
            ClipCopySource::Files { paths: vec![a.join("locked/f.txt"), a.join("ok.txt")] },
            &Settings::default(),
        )
        .unwrap();
        let b = repo(&tmp.path().join("b"));
        fs::create_dir_all(b.join("locked")).unwrap();
        fs::write(b.join("locked/f.txt"), "mine\n").unwrap();
        fs::set_permissions(b.join("locked"), fs::Permissions::from_mode(0o555)).unwrap();

        let preview = paste_preview(&b, &copied.text, false, &[], &Settings::default()).unwrap();
        let all: Vec<u32> = (0..preview.files.len() as u32).collect();
        let outcome = paste_apply_with_paths(ClipPasteApply { id: preview.id, overwrite: all, ..Default::default() });
        fs::set_permissions(b.join("locked"), fs::Permissions::from_mode(0o755)).unwrap();
        let (result, written) = outcome.unwrap();
        assert!(!result.errors.is_empty(), "the locked write must fail: {result:?}");
        assert!(written.iter().all(|p| !p.ends_with("locked/f.txt")), "{written:?}");
        assert!(written.iter().any(|p| p.ends_with("ok.txt")), "{written:?}");
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
    fn a_commit_list_does_not_resurrect_a_path_a_newer_selected_commit_renamed_away() {
        let tmp = tempfile::tempdir().unwrap();
        let a = repo(&tmp.path().join("a"));
        commit_file(&a, "a.txt", Some("base content line one\nline two\nline three\n"), "add a");
        let c1 = commit_file(&a, "a.txt", Some("base content line one\nline two\nline three\nold edit\n"), "edit a");
        commit_file(&a, "other.txt", Some("unrelated\n"), "unrelated");
        git(&a, &["mv", "a.txt", "b.txt"]);
        git(&a, &["commit", "-q", "-m", "rename a to b"]);
        let c3 = git(&a, &["rev-parse", "HEAD"]);

        let out = copy(
            &a,
            ClipCopySource::CommitList { repo: a.clone(), revs: vec![c3, c1], paths: vec![] },
            &Settings::default(),
        )
        .unwrap();
        assert!(out.text.contains("b.txt"), "{}", out.text);
        assert!(!out.text.contains("a.txt"), "{}", out.text);
        assert_eq!(out.files, 1, "{}", out.text);

        // An older commit that only touches other files is unaffected.
        let out = copy(
            &a,
            ClipCopySource::CommitList { repo: a.clone(), revs: vec![git(&a, &["rev-parse", "HEAD"])], paths: vec![] },
            &Settings::default(),
        )
        .unwrap();
        assert_eq!(out.files, 1, "{}", out.text);
    }

    /// A merge whose first parent renamed `a.txt` to `b.txt` lists `M b.txt` against that parent
    /// and `R a.txt -> b.txt` against the second: the rename source must still count as renamed
    /// away, or an older selected commit on the second parent's side resurrects `a.txt`.
    #[test]
    fn a_commit_list_does_not_resurrect_a_path_a_selected_merge_renamed_away_on_one_side() {
        let tmp = tempfile::tempdir().unwrap();
        let a = repo(&tmp.path().join("a"));
        let body: String = (1..=20).map(|i| format!("shared line {i}\n")).collect();
        commit_file(&a, "a.txt", Some(&body), "add a");
        git(&a, &["checkout", "-q", "-b", "feature"]);
        let edit = commit_file(&a, "a.txt", Some(&format!("{body}feature edit\n")), "edit a on feature");
        git(&a, &["checkout", "-q", "main"]);
        git(&a, &["mv", "a.txt", "b.txt"]);
        git(&a, &["commit", "-q", "-m", "rename a to b"]);
        git(&a, &["merge", "-q", "--no-ff", "-m", "merge feature", "feature"]);
        let merge = git(&a, &["rev-parse", "HEAD"]);
        // The shape under test: one parent lists the target as modified, the other as a rename.
        let first = git(&a, &["diff-tree", "-r", "--name-status", "--no-commit-id", "-M", "HEAD^1", "HEAD"]);
        let second = git(&a, &["diff-tree", "-r", "--name-status", "--no-commit-id", "-M", "HEAD^2", "HEAD"]);
        assert_eq!(first, "M\tb.txt");
        assert!(second.starts_with('R') && second.ends_with("a.txt\tb.txt"), "{second}");

        let out = copy(
            &a,
            ClipCopySource::CommitList { repo: a.clone(), revs: vec![merge, edit], paths: vec![] },
            &Settings::default(),
        )
        .unwrap();
        assert!(out.text.contains("b.txt"), "{}", out.text);
        assert!(!out.text.contains("a.txt"), "{}", out.text);
        assert_eq!(out.files, 1, "{}", out.text);
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

    /// A group refused whole (here: a non-portable name outside the project) leaves no part, so the groups after
    /// it must not be looked up by the group's index.
    #[cfg(unix)]
    #[test]
    fn a_group_refused_whole_does_not_break_the_groups_after_it() {
        let tmp = tempfile::tempdir().unwrap();
        let a = repo(&tmp.path().join("proj"));
        fs::write(a.join("ok.txt"), "ok\n").unwrap();
        let outside = dunce::canonicalize(tmp.path()).unwrap().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("bad\".txt"), "bad\n").unwrap();
        for paths in
            [vec![outside.join("bad\".txt"), a.join("ok.txt")], vec![a.join("ok.txt"), outside.join("bad\".txt")]]
        {
            let copied =
                copy_in_with(&a, &[], ClipCopySource::Files { paths }, &Settings::default(), ClipNonTextMode::Exclude)
                    .unwrap();
            assert_eq!(copied.files, 1, "{}", copied.text);
            assert!(copied.text.contains("// file: ok.txt"), "{}", copied.text);
        }
    }
}
