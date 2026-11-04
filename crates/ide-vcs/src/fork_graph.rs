//! Fork-owned: what the Git Graph view (`src/features/git-graph`) needs beyond upstream's
//! vcs API — stash rows with their commits, the uncommitted-changes row, reflog, bisect,
//! author statistics, the file tree of a revision, and tag / upstream operations.
//!
//! Kept in one module with its own types so an upstream rebase never has to merge into
//! upstream's structs or functions; `lib.rs` only declares the module.

use crate::Repo;
use crate::cli::{run, run_raw};
use ide_core::{IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::atomic::Ordering;

/// A stash entry with the commit it records and the commit it was made on.
#[derive(Clone, Debug, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphStash {
    pub index: u32,
    pub id: String,
    /// The commit HEAD pointed at when the stash was made.
    pub base: String,
    pub message: String,
    pub time_ms: f64,
}

/// Counts for the graph's uncommitted-changes row.
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphWorkingState {
    pub staged: u32,
    pub unstaged: u32,
    pub untracked: u32,
    pub conflicted: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphReflogEntry {
    pub id: String,
    /// `HEAD@{0}`.
    pub selector: String,
    /// `commit: message`, `checkout: moving from a to b`…
    pub action: String,
    pub time_ms: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphAuthorStat {
    pub name: String,
    pub email: String,
    pub commits: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphTreeEntry {
    /// Repository-relative, `/`-separated.
    pub path: String,
    /// `blob`, `commit` (submodule) or `tree`.
    pub kind: String,
    /// Bytes; null for submodules.
    pub size: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "op")]
pub enum GraphBisectOp {
    Start { bad: String, good: String },
    Good { rev: String },
    Bad { rev: String },
    Skip { rev: String },
    Reset,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphBisectState {
    pub active: bool,
    /// The commit git checked out for the next verdict.
    pub current: Option<String>,
    /// Set once git names the first bad commit.
    pub culprit: Option<String>,
    /// git's last message.
    pub output: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "op")]
pub enum GraphRefOp {
    DeleteTag { name: String },
    PushTag { remote: String, name: String },
    DeleteRemoteTag { remote: String, name: String },
    SetUpstream { branch: String, upstream: String },
    UnsetUpstream { branch: String },
}

const NUL: char = '\0';

fn ms(seconds: &str) -> f64 {
    seconds.trim().parse::<f64>().unwrap_or(0.0) * 1000.0
}

/// Refuses option-looking or empty names before they reach git's argument list.
fn name_arg<'a>(what: &str, s: &'a str) -> IdeResult<&'a str> {
    let s = s.trim();
    if s.is_empty() || s.starts_with('-') {
        return Err(IdeError::invalid(format!("'{s}' is not a valid {what}")));
    }
    Ok(s)
}

impl Repo {
    fn fork_scope(&self) -> crate::ExecutionScope {
        crate::ExecutionScope::enter(self.execution_allowed.load(Ordering::Acquire))
    }

    pub fn graph_stashes(&self) -> IdeResult<Vec<GraphStash>> {
        let _scope = self.fork_scope();
        let out = run_raw(self.root(), &["stash", "list", "-z", "--format=%H%x00%P%x00%ct%x00%gs"], None)?;
        if out.code != Some(0) {
            return Ok(Vec::new());
        }
        let text = out.stdout_str();
        let fields: Vec<&str> = text.split(NUL).collect();
        Ok(fields
            .chunks(4)
            .filter(|c| c.len() == 4 && !c[0].trim().is_empty())
            .enumerate()
            .map(|(index, c)| GraphStash {
                index: index as u32,
                id: c[0].trim().to_string(),
                base: c[1].split_whitespace().next().unwrap_or_default().to_string(),
                time_ms: ms(c[2]),
                message: c[3].to_string(),
            })
            .collect())
    }

    pub fn graph_working_state(&self) -> IdeResult<GraphWorkingState> {
        let _scope = self.fork_scope();
        let out = run(self.root(), &["status", "--porcelain=v1", "-z", "--untracked-files=all"], None)?;
        Ok(parse_porcelain(&out.stdout_str()))
    }

    pub fn graph_reflog(&self, reference: &str, limit: u32) -> IdeResult<Vec<GraphReflogEntry>> {
        let _scope = self.fork_scope();
        let reference = name_arg("reference", reference)?;
        let count = format!("-n{}", limit.max(1));
        let out = run_raw(
            self.root(),
            &["reflog", "show", "-z", "--format=%H%x00%gd%x00%ct%x00%gs", &count, reference, "--"],
            None,
        )?;
        if out.code != Some(0) {
            return Ok(Vec::new());
        }
        let text = out.stdout_str();
        let fields: Vec<&str> = text.split(NUL).collect();
        Ok(fields
            .chunks(4)
            .filter(|c| c.len() == 4 && !c[0].trim().is_empty())
            .map(|c| GraphReflogEntry {
                id: c[0].trim().to_string(),
                selector: c[1].to_string(),
                time_ms: ms(c[2]),
                action: c[3].to_string(),
            })
            .collect())
    }

    /// Commits per author over every branch, tag and remote branch, most first. Not `--all`:
    /// that also walks `refs/stash`, counting each stash's internal commits.
    pub fn graph_author_stats(&self) -> IdeResult<Vec<GraphAuthorStat>> {
        let _scope = self.fork_scope();
        let out = run_raw(self.root(), &["shortlog", "-sne", "--branches", "--tags", "--remotes", "HEAD"], Some(b""))?;
        if out.code != Some(0) {
            return Ok(Vec::new());
        }
        Ok(parse_shortlog(&out.stdout_str()))
    }

    pub fn graph_tree(&self, rev: &str) -> IdeResult<Vec<GraphTreeEntry>> {
        let _scope = self.fork_scope();
        let rev = name_arg("revision", rev)?;
        let out = run(self.root(), &["ls-tree", "-r", "-l", "-z", "--full-tree", rev], None)?;
        Ok(parse_ls_tree(&out.stdout_str()))
    }

    pub fn graph_bisect(&self, op: &GraphBisectOp) -> IdeResult<GraphBisectState> {
        let _scope = self.fork_scope();
        let root = self.root();
        let out = match op {
            GraphBisectOp::Start { bad, good } => {
                let (bad, good) = (name_arg("revision", bad)?, name_arg("revision", good)?);
                run(root, &["bisect", "start", bad, good, "--"], None)?
            }
            GraphBisectOp::Good { rev } => run(root, &["bisect", "good", name_arg("revision", rev)?], None)?,
            GraphBisectOp::Bad { rev } => run(root, &["bisect", "bad", name_arg("revision", rev)?], None)?,
            GraphBisectOp::Skip { rev } => run(root, &["bisect", "skip", name_arg("revision", rev)?], None)?,
            GraphBisectOp::Reset => run(root, &["bisect", "reset"], None)?,
        };
        let mut state = self.graph_bisect_state()?;
        state.output = out.stdout_str().trim().to_string();
        state.culprit = state.culprit.or_else(|| first_bad_commit(&state.output));
        Ok(state)
    }

    pub fn graph_bisect_state(&self) -> IdeResult<GraphBisectState> {
        let _scope = self.fork_scope();
        let root = self.root();
        let log = run(root, &["rev-parse", "--git-path", "BISECT_LOG"], None)?.stdout_str();
        let log = root.join(log.trim());
        let active = log.is_file();
        // git records the verdict in the log (`# first bad commit: [<sha>] subject`); its
        // stdout wording changed across versions, the log line has not.
        let culprit =
            if active { std::fs::read_to_string(&log).ok().and_then(|text| first_bad_in_log(&text)) } else { None };
        let current = if active {
            run_raw(root, &["rev-parse", "HEAD"], None)?.stdout_str().trim().to_string()
        } else {
            String::new()
        };
        Ok(GraphBisectState {
            active,
            current: (!current.is_empty()).then_some(current),
            culprit,
            output: String::new(),
        })
    }

    pub fn graph_ref_op(&self, op: &GraphRefOp) -> IdeResult<()> {
        let _scope = self.fork_scope();
        let root = self.root();
        match op {
            GraphRefOp::DeleteTag { name } => {
                run(root, &["tag", "-d", name_arg("tag", name)?], None)?;
            }
            GraphRefOp::PushTag { remote, name } => {
                let refspec = format!("refs/tags/{}", name_arg("tag", name)?);
                run(root, &["push", name_arg("remote", remote)?, &refspec], None)?;
            }
            GraphRefOp::DeleteRemoteTag { remote, name } => {
                let refspec = format!(":refs/tags/{}", name_arg("tag", name)?);
                run(root, &["push", name_arg("remote", remote)?, &refspec], None)?;
            }
            GraphRefOp::SetUpstream { branch, upstream } => {
                let flag = format!("--set-upstream-to={}", name_arg("upstream", upstream)?);
                run(root, &["branch", &flag, name_arg("branch", branch)?], None)?;
            }
            GraphRefOp::UnsetUpstream { branch } => {
                run(root, &["branch", "--unset-upstream", name_arg("branch", branch)?], None)?;
            }
        }
        Ok(())
    }
}

fn parse_porcelain(text: &str) -> GraphWorkingState {
    let mut s = GraphWorkingState::default();
    let mut entries = text.split(NUL);
    while let Some(entry) = entries.next() {
        let bytes = entry.as_bytes();
        if bytes.len() < 3 {
            continue;
        }
        let (x, y) = (bytes[0], bytes[1]);
        // A rename or copy carries its source path as the next entry.
        if x == b'R' || x == b'C' {
            entries.next();
        }
        match (x, y) {
            (b'?', b'?') => s.untracked += 1,
            (b'!', b'!') => {}
            (b'U', _) | (_, b'U') | (b'A', b'A') | (b'D', b'D') => s.conflicted += 1,
            _ => {
                if x != b' ' {
                    s.staged += 1;
                }
                if y != b' ' {
                    s.unstaged += 1;
                }
            }
        }
    }
    s
}

fn parse_shortlog(text: &str) -> Vec<GraphAuthorStat> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            let (count, rest) = line.split_once(char::is_whitespace)?;
            let commits = count.parse().ok()?;
            let rest = rest.trim();
            let (name, email) = match rest.rfind('<') {
                Some(i) if rest.ends_with('>') => (rest[..i].trim(), &rest[i + 1..rest.len() - 1]),
                _ => (rest, ""),
            };
            Some(GraphAuthorStat { name: name.to_string(), email: email.to_string(), commits })
        })
        .collect()
}

fn parse_ls_tree(text: &str) -> Vec<GraphTreeEntry> {
    text.split(NUL)
        .filter_map(|entry| {
            let (meta, path) = entry.split_once('\t')?;
            let mut parts = meta.split_whitespace();
            let _mode = parts.next()?;
            let kind = parts.next()?.to_string();
            let _id = parts.next()?;
            let size = parts.next().and_then(|s| s.parse::<f64>().ok());
            Some(GraphTreeEntry { path: path.to_string(), kind, size })
        })
        .collect()
}

/// `# first bad commit: [<sha>] subject` in `BISECT_LOG`.
fn first_bad_in_log(log: &str) -> Option<String> {
    log.lines().rev().find_map(|l| {
        let rest = l.strip_prefix("# first bad commit: [")?;
        Some(rest.split(']').next()?.trim().to_string())
    })
}

/// `<sha> is the first bad commit` in git's bisect output.
fn first_bad_commit(output: &str) -> Option<String> {
    output.lines().find_map(|l| l.strip_suffix(" is the first bad commit").map(|id| id.trim().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn porcelain_counts_each_side() {
        let text = "M  a\0 M b\0MM c\0?? d\0UU e\0R  new\0old\0";
        assert_eq!(parse_porcelain(text), GraphWorkingState { staged: 3, unstaged: 2, untracked: 1, conflicted: 1 });
    }

    #[test]
    fn shortlog_splits_name_and_email() {
        let text = "     3\tAnn Lee <ann@example.com>\n     1\tBob <bob@example.com>\n";
        assert_eq!(
            parse_shortlog(text),
            vec![
                GraphAuthorStat { name: "Ann Lee".into(), email: "ann@example.com".into(), commits: 3 },
                GraphAuthorStat { name: "Bob".into(), email: "bob@example.com".into(), commits: 1 },
            ]
        );
    }

    #[test]
    fn ls_tree_keeps_tabs_and_spaces_in_paths() {
        let text = "100644 blob abc     12\tdir/a b.txt\x00160000 commit def       -\tsub\0";
        assert_eq!(
            parse_ls_tree(text),
            vec![
                GraphTreeEntry { path: "dir/a b.txt".into(), kind: "blob".into(), size: Some(12.0) },
                GraphTreeEntry { path: "sub".into(), kind: "commit".into(), size: None },
            ]
        );
    }

    #[test]
    fn finds_the_first_bad_commit() {
        assert_eq!(first_bad_commit("abc123 is the first bad commit\ncommit abc123\n"), Some("abc123".to_string()));
        assert_eq!(first_bad_commit("Bisecting: 1 revision left"), None);
    }

    #[test]
    fn finds_the_first_bad_commit_in_the_log() {
        let log = "git bisect start 'b' 'g'\n# bad: [abc] x\ngit bisect bad abc\n# first bad commit: [abc123] bug\n";
        assert_eq!(first_bad_in_log(log), Some("abc123".to_string()));
        assert_eq!(first_bad_in_log("git bisect start\n"), None);
    }

    #[test]
    fn refuses_option_like_names() {
        assert!(name_arg("tag", "--delete").is_err());
        assert!(name_arg("tag", "  ").is_err());
        assert_eq!(name_arg("tag", " v1 ").unwrap(), "v1");
    }
}
