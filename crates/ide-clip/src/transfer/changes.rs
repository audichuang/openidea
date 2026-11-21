use std::path::Path;

use crate::gitrun::RunOptions;
use crate::gitsrc::{self, Git, GitSource};
use crate::transfer::{CanonicalRootId, ExportItem, SourceKind, TransferError};

/// Changes discovered in a Git repository for transfer planning.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangedItems {
    pub items: Vec<ExportItem>,
    /// Entries dropped because their path name is not UTF-8 (cannot go in a header).
    pub skipped_non_utf8: usize,
    /// Their lossy spellings, relative to the repository root.
    pub non_utf8_paths: Vec<String>,
    /// Listed paths whose new side is a submodule commit (gitlink).
    pub gitlinks: Vec<String>,
    /// Changes outside `root` when `root` is a subdirectory of the repository.
    pub out_of_scope: Vec<String>,
    /// Source paths of renames, relative to `root`: those paths no longer exist on the new side.
    pub renamed_from: Vec<String>,
}

fn strip_offset(path: &str, offset: &Path) -> Option<String> {
    if offset.as_os_str().is_empty() {
        return Some(path.to_string());
    }
    let offset_components: Vec<&str> = offset
        .components()
        .filter_map(|c| match c {
            std::path::Component::Normal(s) => s.to_str(),
            _ => None,
        })
        .collect();
    if offset_components.is_empty() {
        return Some(path.to_string());
    }
    let path_parts: Vec<&str> = path.split('/').collect();
    if path_parts.len() > offset_components.len() && path_parts[..offset_components.len()] == offset_components[..] {
        Some(path_parts[offset_components.len()..].join("/"))
    } else {
        None
    }
}

/// Lists changed files in `gitsrc` order, converting them to transfer [`ExportItem`]s.
pub fn changed_items(
    root: &CanonicalRootId,
    git: &Git,
    source: &GitSource,
    opts: &RunOptions,
) -> Result<ChangedItems, TransferError> {
    let git_root =
        dunce::canonicalize(git.root()).map_err(|_| TransferError::UnknownRoot(root.path().to_path_buf()))?;
    let root_path =
        dunce::canonicalize(root.path()).map_err(|_| TransferError::UnknownRoot(root.path().to_path_buf()))?;
    let offset =
        root_path.strip_prefix(&git_root).map_err(|_| TransferError::UnknownRoot(root.path().to_path_buf()))?;

    let (changes, non_utf8_paths) = gitsrc::list_changes_named_with(git, source, opts)?;
    let skipped_non_utf8 = non_utf8_paths.len();
    let kind = match source {
        GitSource::Working => SourceKind::Working,
        GitSource::Staged => SourceKind::Staged,
        GitSource::Commit(rev) => {
            let sha = git.resolve_commit_with(rev, opts)?;
            SourceKind::Commit { rev: sha }
        }
        GitSource::Range(a, b) => {
            let base = git.resolve_range_base_with(a, opts)?;
            let tip = git.resolve_commit_with(b, opts)?;
            SourceKind::Range { base, tip }
        }
    };

    let mut items = Vec::new();
    let mut gitlinks = Vec::new();
    let mut out_of_scope = Vec::new();
    let mut renamed_from = Vec::new();

    for change in changes {
        renamed_from.extend(change.renamed_from.iter().filter_map(|p| strip_offset(p, offset)));
        if let Some(rel_path) = strip_offset(&change.path, offset) {
            if change.gitlink {
                gitlinks.push(rel_path.clone());
            }
            items.push(ExportItem {
                root: root.clone(),
                relative_path: rel_path,
                source: kind.clone(),
                change_type: Some(change.change_type),
                gitlink: change.gitlink,
            });
        } else {
            out_of_scope.push(change.path);
        }
    }

    Ok(ChangedItems { items, skipped_non_utf8, non_utf8_paths, gitlinks, out_of_scope, renamed_from })
}
