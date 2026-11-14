//! Fork-owned: file history without the second path-limited walk per creation.
//!
//! `history::file_history` cuts a file's history where the file appears: it walks the path
//! once, and when that walk lists creations it walks again with each creation's parents
//! excluded (`^<created>^@`) and keeps what both walks list. On a large repository each
//! walk costs as much as the first. When the first walk lists nothing behind a creation
//! (checked on the commit graph), the second keeps everything the first lists, so it is
//! skipped. A file that existed before under the same name still runs it.

use crate::log_index::LogIndex;
use gix::ObjectId;
use ide_core::{CancellationToken, IdeError, IdeResult};
use std::collections::HashSet;

#[cfg(test)]
thread_local! {
    /// Lets tests compare the result with the second walk's.
    pub(crate) static DISABLED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// How often the second walk was skipped.
    pub(crate) static SKIPPED: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

/// Whether the walk of `revs` excluding the parents of `created` can drop any of `listed`
/// (the first walk's commits), so that it has to run. Replace refs never get here: the
/// caller has no `repo` for them.
pub(crate) fn exclusion_walk_needed(
    repo: &gix::Repository,
    index: &mut LogIndex,
    revs: &[String],
    listed: &[ObjectId],
    created: &[ObjectId],
    cancel: &CancellationToken,
) -> IdeResult<bool> {
    #[cfg(test)]
    if DISABLED.with(|d| d.get()) {
        return Ok(true);
    }
    // Shallow boundaries are parentless for Git but not in every graph source.
    // Grafts: Git walks other parents than the graph read below.
    if repo.is_shallow().unwrap_or(true) || crate::history::grafts_in_effect(repo) {
        return Ok(true);
    }
    // A range or negative revision can hide a creation's ancestors from the first walk,
    // and then the second simplifies the merges around them differently.
    if revs.iter().any(|rev| rev.starts_with('^') || rev.contains("..")) {
        return Ok(true);
    }
    if let Err(error) = index.ensure_nodes(repo, created, &HashSet::new(), cancel) {
        return if cancel.is_cancelled() { Err(error) } else { Ok(true) };
    }
    let mut stack = Vec::new();
    for id in created {
        let Some((parents, _)) = index.nodes.get(id) else { return Ok(true) };
        stack.extend(parents.iter().copied());
    }
    // Everything the exclusion makes uninteresting.
    let mut excluded = HashSet::new();
    while let Some(id) = stack.pop() {
        if !excluded.insert(id) {
            continue;
        }
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let Some((parents, _)) = index.nodes.get(&id) else { return Ok(true) };
        stack.extend(parents.iter().filter(|p| !excluded.contains(*p)));
    }
    // A listed commit behind a creation: an older file of the same name. Dropping what is
    // behind is not enough there; the second walk also simplifies the merges around it
    // differently (random histories found such cases).
    if listed.iter().any(|id| excluded.contains(id)) {
        return Ok(true);
    }
    // Otherwise nothing behind the creations touches the path. A commit the first walk
    // lists changes the path (Git keeps it whatever else is interesting) or is a merge that
    // joins such commits; the exclusion only adds parents that do not touch the path, which
    // random histories and real repositories confirm never removes one of those merges.
    #[cfg(test)]
    SKIPPED.with(|s| s.set(s.get() + 1));
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::{DISABLED, SKIPPED};
    use crate::{Commit, LogQuery, Repo};
    use std::io::Write;
    use std::path::Path;
    use std::process::{Command, Stdio};

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").current_dir(dir).args(args).output().unwrap();
        assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// xorshift64*: deterministic per seed, no dependency.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }
        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
        fn chance(&mut self, percent: u64) -> bool {
            self.next() % 100 < percent
        }
    }

    #[derive(Clone, Default)]
    struct State {
        file: Option<u32>,
        source: Option<u32>,
        noise: u32,
    }

    fn content(n: u32) -> String {
        // Long enough that an unchanged blob under a new name is an exact rename.
        format!("content {n}\n{}", "shared line\n".repeat(20))
    }

    /// A random DAG over `file` (the followed path), `source` (renamed to `file` now and
    /// then) and `noise`, built with fast-import; returns the tips as one scope.
    fn random_repo(dir: &Path, seed: u64) -> Vec<String> {
        let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
        git(dir, &["init", "-q"]);
        let big = seed % 2 == 1;
        let count = if big { 20 + rng.below(40) } else { 8 + rng.below(22) };
        let mut states: Vec<State> = Vec::new();
        let mut next_content = 1u32;
        let mut stream = String::new();
        for i in 0..count {
            let parents: Vec<usize> = if i == 0 || rng.chance(4) {
                Vec::new()
            } else {
                let mut ps = vec![if rng.chance(60) { i - 1 } else { rng.below(i) }];
                let extra = if rng.chance(if big { 45 } else { 30 }) { 1 + usize::from(rng.chance(15)) } else { 0 };
                for _ in 0..extra {
                    let p = rng.below(i);
                    if !ps.contains(&p) {
                        ps.push(p);
                    }
                }
                ps
            };
            let mut state = parents.first().map(|p| states[*p].clone()).unwrap_or_default();
            let mut fresh = || {
                next_content += 1;
                next_content
            };
            match rng.below(100) {
                0..35 => {}
                35..55 if state.file.is_some() => state.file = Some(fresh()),
                55..67 if state.file.is_some() => state.file = None,
                67..80 if state.file.is_none() => state.file = Some(fresh()),
                80..92 if parents.len() > 1 => state.file = states[parents[1 + rng.below(parents.len() - 1)]].file,
                92..100 if state.file.is_none() && state.source.is_some() => {
                    state.file = state.source.take();
                }
                _ => {}
            }
            match rng.below(100) {
                0..15 if state.source.is_none() => state.source = Some(fresh()),
                15..22 if state.source.is_some() => state.source = Some(fresh()),
                22..27 => state.source = None,
                _ => {}
            }
            if rng.chance(50) {
                state.noise = fresh();
            }
            stream.push_str(&format!(
                "commit refs/heads/c{i}\nmark :{}\ncommitter T <t@e> {} +0000\ndata 3\nc{i}\n",
                i + 1,
                1_000_000_000 + i * 60
            ));
            for (n, p) in parents.iter().enumerate() {
                stream.push_str(&format!("{} :{}\n", if n == 0 { "from" } else { "merge" }, p + 1));
            }
            stream.push_str("deleteall\n");
            for (name, value) in [("file", state.file), ("source", state.source), ("noise", Some(state.noise))] {
                if let Some(value) = value {
                    let data = content(value);
                    stream.push_str(&format!("M 100644 inline {name}\ndata {}\n{data}\n", data.len()));
                }
            }
            states.push(state);
        }
        let mut child = Command::new("git")
            .current_dir(dir)
            .args(["fast-import", "--quiet"])
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(stream.as_bytes()).unwrap();
        assert!(child.wait().unwrap().success());
        let mut tips = vec![format!("c{}", count - 1)];
        for _ in 0..rng.below(3) {
            tips.push(format!("c{}", rng.below(count)));
        }
        tips.iter().map(|tip| git(dir, &["rev-parse", tip])).collect()
    }

    type Row = (String, Vec<String>, Option<String>);

    fn history(repo: &Repo, tips: &[String], first_parent: bool, disabled: bool) -> Vec<Row> {
        let query = LogQuery { branches: tips.to_vec(), first_parent, ..Default::default() };
        history_of(repo, &query, disabled)
    }

    fn history_of(repo: &Repo, query: &LogQuery, disabled: bool) -> Vec<Row> {
        DISABLED.with(|d| d.set(disabled));
        let log: Vec<Commit> =
            repo.log(&LogQuery { path: Some("file".into()), follow: true, ..query.clone() }).unwrap();
        DISABLED.with(|d| d.set(false));
        log.into_iter().map(|c| (c.id, c.graph_parents.unwrap_or_default(), c.history_path)).collect()
    }

    /// The history with the shortcut, after checking it against the second walk's, and how
    /// often the shortcut was taken.
    fn checked_history(repo: &Repo, tips: &[String], first_parent: bool) -> (Vec<Row>, u32) {
        SKIPPED.with(|s| s.set(0));
        let fast = history(repo, tips, first_parent, false);
        let skipped = SKIPPED.with(|s| s.replace(0));
        assert_eq!(fast, history(repo, tips, first_parent, true));
        (fast, skipped)
    }

    #[test]
    fn random_histories_match_the_second_walk() {
        // FH_START / FH_SEEDS widen the search (it found the cases the guard excludes).
        let var = |name: &str, default: u64| std::env::var(name).ok().and_then(|s| s.parse().ok()).unwrap_or(default);
        let start = var("FH_START", 0);
        let mut skipped = 0;
        for seed in start..start + var("FH_SEEDS", 120) {
            let tmp = tempfile::tempdir().unwrap();
            let tips = random_repo(tmp.path(), seed);
            let repo = Repo::discover(tmp.path()).unwrap().unwrap();
            for first_parent in [false, true] {
                SKIPPED.with(|s| s.set(0));
                let fast = history(&repo, &tips, first_parent, false);
                skipped += SKIPPED.with(|s| s.replace(0));
                assert_eq!(fast, history(&repo, &tips, first_parent, true), "seed {seed}, first parent {first_parent}");
            }
        }
        println!("second walk skipped {skipped} times");
        assert!(skipped > 0);
    }

    fn commit(dir: &Path, message: &str) -> String {
        git(dir, &["add", "-A"]);
        git(dir, &["-c", "user.name=T", "-c", "user.email=t@e", "commit", "-qm", message]);
        git(dir, &["rev-parse", "HEAD"])
    }

    fn merge_tree(dir: &Path, tree_of: &str, parents: &[&str]) -> String {
        let tree = format!("{tree_of}^{{tree}}");
        let mut args = vec!["-c", "user.name=T", "-c", "user.email=t@e", "commit-tree", &tree, "-m", "merge"];
        for parent in parents {
            args.extend(["-p", parent]);
        }
        git(dir, &args)
    }

    #[test]
    fn merges_at_the_creation_boundary_match_the_second_walk() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        git(dir, &["init", "-q", "-b", "main"]);
        std::fs::write(dir.join("noise"), "0").unwrap();
        let old = commit(dir, "old");
        std::fs::write(dir.join("noise"), "1").unwrap();
        let boundary = commit(dir, "boundary");
        std::fs::write(dir.join("file"), "created").unwrap();
        let created = commit(dir, "created");
        git(dir, &["checkout", "-q", "-b", "side", &boundary]);
        std::fs::write(dir.join("noise"), "2").unwrap();
        let side = commit(dir, "side");
        // A merge of a branch that forked at the creation's parent, one whose parent is the
        // creation's parent itself, and changes to the file on both sides of them.
        let merged = merge_tree(dir, &created, &[&created, &side]);
        let at_boundary = merge_tree(dir, &created, &[&merged, &boundary]);
        git(dir, &["checkout", "-q", "main"]);
        git(dir, &["reset", "-q", "--hard", &at_boundary]);
        std::fs::write(dir.join("file"), "changed").unwrap();
        let changed = commit(dir, "changed");
        git(dir, &["checkout", "-q", "-b", "other", &side]);
        std::fs::write(dir.join("file"), "other").unwrap();
        let other = commit(dir, "other");
        git(dir, &["checkout", "-q", "main"]);
        let both = merge_tree(dir, &changed, &[&changed, &other]);
        git(dir, &["reset", "-q", "--hard", &both]);
        let repo = Repo::discover(dir).unwrap().unwrap();
        let (rows, skipped) = checked_history(&repo, std::slice::from_ref(&both), false);
        let mut ids: Vec<&str> = rows.iter().map(|row| row.0.as_str()).collect();
        ids.sort();
        let mut expected = [both.as_str(), changed.as_str(), other.as_str(), created.as_str()];
        expected.sort();
        assert_eq!(skipped, 1);
        assert_eq!(ids, expected);
        assert!(!ids.contains(&old.as_str()) && !ids.contains(&boundary.as_str()));
        // A merge with a parent further behind the creation.
        let behind = merge_tree(dir, &both, &[&both, &old]);
        checked_history(&repo, &[behind], false);
    }

    #[test]
    fn a_recreated_file_keeps_the_second_walk() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        git(dir, &["init", "-q", "-b", "main"]);
        std::fs::write(dir.join("file"), "first").unwrap();
        let first = commit(dir, "first");
        git(dir, &["checkout", "-q", "-b", "old", &first]);
        std::fs::write(dir.join("file"), "old branch").unwrap();
        let old_branch = commit(dir, "old branch");
        git(dir, &["checkout", "-q", "main"]);
        std::fs::remove_file(dir.join("file")).unwrap();
        let deleted = commit(dir, "deleted");
        std::fs::write(dir.join("file"), "second").unwrap();
        let recreated = commit(dir, "recreated");
        let merged = merge_tree(dir, &recreated, &[&recreated, &old_branch]);
        git(dir, &["reset", "-q", "--hard", &merged]);
        let repo = Repo::discover(dir).unwrap().unwrap();
        let (rows, skipped) = checked_history(&repo, std::slice::from_ref(&merged), false);
        let ids: Vec<&str> = rows.iter().map(|row| row.0.as_str()).collect();
        assert_eq!(skipped, 0);
        assert!(ids.contains(&recreated.as_str()));
        assert!(!ids.contains(&first.as_str()) && !ids.contains(&deleted.as_str()));
    }

    /// `git <args>` with `stdin`, as user T.
    fn git_in(dir: &Path, args: &[&str], stdin: &str) -> String {
        let mut child = Command::new("git")
            .current_dir(dir)
            .args(["-c", "user.name=T", "-c", "user.email=t@e"])
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(stdin.as_bytes()).unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success(), "{args:?}");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A commit of `tree` with `parents`, without touching the work tree.
    fn commit_tree(dir: &Path, tree: &str, parents: &[&str], message: &str) -> String {
        let mut args = vec!["commit-tree", tree, "-m", message];
        for parent in parents {
            args.extend(["-p", parent]);
        }
        git_in(dir, &args, "")
    }

    /// The tree holding only `file` with `text`, and the empty tree.
    fn trees(dir: &Path, text: &str) -> (String, String) {
        let blob = git_in(dir, &["hash-object", "-w", "--stdin"], text);
        (git_in(dir, &["mktree"], &format!("100644 blob {blob}\tfile\n")), git_in(dir, &["mktree"], ""))
    }

    fn ids(rows: &[Row]) -> Vec<&str> {
        rows.iter().map(|row| row.0.as_str()).collect()
    }

    #[test]
    fn a_range_scope_keeps_the_second_walk() {
        // With a range the excluded side can hide a creation's ancestors from the first
        // walk, and the second walk simplifies the merges around them differently.
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        git(dir, &["init", "-q", "-b", "main"]);
        let (file, empty) = trees(dir, "same\n");
        let n6 = commit_tree(dir, &file, &[], "n6");
        let n7 = commit_tree(dir, &empty, &[], "n7");
        let n14 = commit_tree(dir, &empty, &[&n6, &n7], "n14");
        let n16 = commit_tree(dir, &file, &[&n6, &n7], "n16");
        let n18 = commit_tree(dir, &file, &[&n7], "n18");
        let n22 = commit_tree(dir, &file, &[&n14, &n18], "n22");
        git(dir, &["reset", "-q", "--hard", &n22]);
        let repo = Repo::discover(dir).unwrap().unwrap();
        let query = LogQuery { range: Some(format!("{n16}..{n22}")), ..Default::default() };
        let old = history_of(&repo, &query, true);
        assert_eq!(ids(&old), [n18.as_str()]);
        assert_eq!(history_of(&repo, &query, false), old);
    }

    #[test]
    fn grafted_parents_keep_the_second_walk() {
        // Git walks the grafted parents; the commit graph the shortcut reads does not.
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        git(dir, &["init", "-q", "-b", "main"]);
        let (file, empty) = trees(dir, "same\n");
        let f = commit_tree(dir, &file, &[], "F adds");
        let d = commit_tree(dir, &empty, &[&f], "D deletes");
        let c = commit_tree(dir, &file, &[], "C adds");
        git(dir, &["reset", "-q", "--hard", &c]);
        std::fs::write(dir.join(".git/info/grafts"), format!("{c} {d}\n")).unwrap();
        let repo = Repo::discover(dir).unwrap().unwrap();
        // D is a tip too, so the history behind the graft stays reachable without it.
        let query = LogQuery { branches: vec![c.clone(), d.clone()], ..Default::default() };
        let old = history_of(&repo, &query, true);
        assert_eq!(ids(&old), [c.as_str()]);
        assert_eq!(history_of(&repo, &query, false), old);
    }

    /// `FH_REPO=<repo> FH_PATHS=<file of paths> [FH_RUNS=n]`: the full log of each path with
    /// and without the shortcut, compared, and cold/warm timings (medians, interleaved).
    #[test]
    #[ignore]
    fn external_repo_equivalence() {
        let (Ok(root), Ok(list)) = (std::env::var("FH_REPO"), std::env::var("FH_PATHS")) else { return };
        let runs: usize = std::env::var("FH_RUNS").ok().and_then(|s| s.parse().ok()).unwrap_or(1);
        let paths = std::fs::read_to_string(list).unwrap();
        let query =
            |path: &str| LogQuery { path: Some(path.into()), follow: true, summary_only: true, ..Default::default() };
        let dump = |log: Vec<Commit>| -> Vec<(String, Vec<String>, Option<String>)> {
            log.into_iter().map(|c| (c.id, c.graph_parents.unwrap_or_default(), c.history_path)).collect()
        };
        let median = |mut v: Vec<f64>| {
            v.sort_by(f64::total_cmp);
            v[v.len() / 2]
        };
        let (mut same, mut differ, mut fast) = (0, 0, 0);
        for path in paths.lines().filter(|l| !l.is_empty()) {
            let mut times = [Vec::new(), Vec::new(), Vec::new(), Vec::new()];
            let mut outputs = [None, None];
            let mut skips = 0;
            for _ in 0..runs {
                for (slot, disabled) in [(0usize, true), (1, false)] {
                    let cache = tempfile::tempdir().unwrap();
                    let repo = Repo::discover(Path::new(&root)).unwrap().unwrap();
                    repo.enable_log_index(cache.path());
                    DISABLED.with(|d| d.set(disabled));
                    SKIPPED.with(|s| s.set(0));
                    let started = std::time::Instant::now();
                    let log = repo.log(&query(path)).unwrap();
                    times[slot].push(started.elapsed().as_secs_f64() * 1000.0);
                    skips = skips.max(SKIPPED.with(|s| s.get()));
                    drop(repo);
                    // Warm: a new window on the same cache, the walks stored.
                    let repo = Repo::discover(Path::new(&root)).unwrap().unwrap();
                    repo.enable_log_index(cache.path());
                    let started = std::time::Instant::now();
                    let warm = repo.log(&query(path)).unwrap();
                    times[slot + 2].push(started.elapsed().as_secs_f64() * 1000.0);
                    DISABLED.with(|d| d.set(false));
                    let log = dump(log);
                    assert_eq!(log, dump(warm), "{path}: warm differs");
                    outputs[slot].get_or_insert(log);
                }
            }
            let equal = outputs[0] == outputs[1];
            if equal {
                same += 1
            } else {
                differ += 1
            }
            fast += u32::from(skips > 0);
            let [a, b, c, d] = times.map(median);
            println!(
                "{} {path} skipped={skips} rows={} cold old={a:.0}ms new={b:.0}ms warm old={c:.0}ms new={d:.0}ms",
                if equal { "SAME" } else { "DIFF" },
                outputs[0].as_ref().map_or(0, Vec::len)
            );
        }
        println!("same={same} differ={differ} skipped_in={fast}");
        assert_eq!(differ, 0);
    }
}
