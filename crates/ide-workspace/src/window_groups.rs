//! Window grouping is independent of a window's project or workspace.
use ide_core::{IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Platform adapters supply the system's tab preference and active project state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TabbingPreference {
    Always,
    InFullScreen,
    Manually,
}

pub fn should_group_new_project(
    preference: TabbingPreference,
    fullscreen: bool,
    active_project: bool,
    light_edit: bool,
) -> bool {
    active_project
        && !light_edit
        && match preference {
            TabbingPreference::Always => true,
            TabbingPreference::InFullScreen => fullscreen,
            TabbingPreference::Manually => false,
        }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowGroup {
    pub members: Vec<String>,
    pub selected: String,
}

#[derive(Debug, Default)]
pub struct WindowGroups {
    groups: Vec<WindowGroup>,
}

impl WindowGroups {
    pub fn group(&self, member: &str) -> Option<&WindowGroup> {
        self.groups.iter().find(|g| g.members.iter().any(|m| m == member))
    }

    pub fn groups(&self) -> &[WindowGroup] {
        &self.groups
    }

    /// Takes the groups a platform reports (macOS window tabs); `false` when nothing changed.
    pub fn replace(&mut self, groups: Vec<WindowGroup>) -> bool {
        let groups: Vec<_> =
            groups.into_iter().filter(|g| g.members.len() > 1 && g.members.contains(&g.selected)).collect();
        if groups == self.groups {
            return false;
        }
        self.groups = groups;
        true
    }

    pub fn merge(&mut self, members: Vec<String>, selected: &str) -> IdeResult<()> {
        let mut unique = Vec::new();
        for member in members {
            if !unique.contains(&member) {
                unique.push(member);
            }
        }
        if unique.len() < 2 || !unique.iter().any(|m| m == selected) {
            return Err(IdeError::invalid("Open at least two project windows to create a window group"));
        }
        for member in &unique {
            self.detach(member);
        }
        self.groups.push(WindowGroup { members: unique, selected: selected.to_owned() });
        Ok(())
    }

    /// Adds a window to the anchor's group without merging unrelated groups.
    pub fn join(&mut self, anchor: &str, member: &str) -> IdeResult<()> {
        let mut members = self.group(anchor).map(|g| g.members.clone()).unwrap_or_else(|| vec![anchor.to_owned()]);
        members.push(member.to_owned());
        self.merge(members, anchor)
    }

    pub fn select(&mut self, caller: &str, target: &str) -> IdeResult<WindowGroup> {
        let group = self
            .groups
            .iter_mut()
            .find(|g| g.members.iter().any(|m| m == caller))
            .ok_or_else(|| IdeError::not_found("This window is not grouped"))?;
        if !group.members.iter().any(|m| m == target) {
            return Err(IdeError::invalid("The window is not in this group"));
        }
        let before = group.clone();
        group.selected = target.to_owned();
        Ok(before)
    }

    /// Returns the remaining active member, including when the last pair dissolves.
    pub fn detach(&mut self, member: &str) -> Option<String> {
        let i = self.groups.iter().position(|g| g.members.iter().any(|m| m == member))?;
        let group = &mut self.groups[i];
        let index = group.members.iter().position(|m| m == member).unwrap();
        group.members.remove(index);
        if group.selected == member {
            group.selected = group.members[index.min(group.members.len() - 1)].clone();
        }
        let selected = group.selected.clone();
        if group.members.len() < 2 {
            self.groups.remove(i);
        }
        Some(selected)
    }

    pub fn reorder(&mut self, caller: &str, members: Vec<String>) -> IdeResult<()> {
        let group = self
            .groups
            .iter_mut()
            .find(|g| g.members.iter().any(|m| m == caller))
            .ok_or_else(|| IdeError::not_found("This window is not grouped"))?;
        let mut expected = group.members.clone();
        let mut actual = members.clone();
        expected.sort();
        actual.sort();
        if expected != actual {
            return Err(IdeError::invalid("Reordering must preserve every window exactly once"));
        }
        group.members = members;
        Ok(())
    }
}

/// A window group as saved between launches: its projects in tab order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedGroup {
    pub projects: Vec<PathBuf>,
    pub selected: usize,
    /// The group was in a fullscreen Space (files saved before this field: not).
    #[serde(default)]
    pub fullscreen: bool,
}

/// A saved group to reopen: the projects that still exist, in tab order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedGroup {
    pub projects: Vec<PathBuf>,
    pub selected: usize,
    pub fullscreen: bool,
    /// Holds `main`'s project, which anchors the group.
    pub main: bool,
}

impl PlannedGroup {
    /// Fewer than two projects left: they reopen as a plain window, not a group.
    pub fn grouped(&self) -> bool {
        self.projects.len() > 1
    }
}

/// Which saved groups to reopen and with which projects. Projects that no longer exist (`exists`)
/// or already belong to an earlier group are left out; the group holding `main_root` comes first.
pub fn restore_plan(
    saved: &[SavedGroup],
    main_root: Option<&Path>,
    exists: impl Fn(&Path) -> bool,
) -> Vec<PlannedGroup> {
    let mut taken: Vec<&Path> = Vec::new();
    let mut plan = Vec::new();
    for group in saved {
        let mut projects = Vec::new();
        for path in &group.projects {
            let main = main_root == Some(path.as_path());
            if !taken.contains(&path.as_path()) && (main || exists(path)) {
                taken.push(path);
                projects.push(path.clone());
            }
        }
        if projects.is_empty() {
            continue;
        }
        let selected = group.projects.get(group.selected).and_then(|s| projects.iter().position(|p| p == s));
        let main = main_root.and_then(|root| projects.iter().position(|p| p == root));
        plan.push(PlannedGroup {
            selected: selected.or(main).unwrap_or(0),
            projects,
            fullscreen: group.fullscreen,
            main: main.is_some(),
        });
    }
    plan.sort_by_key(|g| !g.main);
    plan
}

/// What to save: `current` (the open groups), plus, until the saved groups have been reopened,
/// each saved group that shares no project with an open one, so a quit or a save part way through
/// startup doesn't drop the groups not reopened yet.
pub fn groups_to_save(current: Vec<SavedGroup>, saved: Vec<SavedGroup>, restored: bool) -> Vec<SavedGroup> {
    if restored {
        return current;
    }
    let open = |path: &PathBuf| current.iter().any(|g| g.projects.contains(path));
    let kept: Vec<_> = saved.into_iter().filter(|g| !g.projects.iter().any(open)).collect();
    current.into_iter().chain(kept).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn members(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| (*s).into()).collect()
    }

    #[test]
    fn new_project_grouping_follows_system_preference_and_excludes_light_edit() {
        for preference in [TabbingPreference::Always, TabbingPreference::InFullScreen, TabbingPreference::Manually] {
            for fullscreen in [false, true] {
                for active_project in [false, true] {
                    for light_edit in [false, true] {
                        let expected = matches!(
                            (preference, fullscreen, active_project, light_edit),
                            (TabbingPreference::Always, _, true, false)
                                | (TabbingPreference::InFullScreen, true, true, false)
                        );
                        assert_eq!(
                            should_group_new_project(preference, fullscreen, active_project, light_edit),
                            expected,
                            "{preference:?}, fullscreen={fullscreen}, active={active_project}, light={light_edit}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn joining_new_windows_preserves_the_active_group_and_other_groups() {
        let mut groups = WindowGroups::default();
        groups.merge(members(&["other-a", "other-b"]), "other-b").unwrap();
        groups.join("a", "b").unwrap();
        assert_eq!(groups.group("a").unwrap().members, members(&["a", "b"]));
        let before = groups.select("a", "b").unwrap();
        assert_eq!(before.selected, "a");
        groups.join("b", "c").unwrap();
        let before = groups.select("b", "c").unwrap();
        assert_eq!(before.selected, "b");
        assert_eq!(groups.group("c").unwrap().members, members(&["a", "b", "c"]));
        assert_eq!(groups.group("c").unwrap().selected, "c");
        assert_eq!(groups.group("other-a").unwrap().members, members(&["other-a", "other-b"]));
        assert_eq!(groups.group("other-a").unwrap().selected, "other-b");
    }

    #[test]
    fn replacing_with_platform_groups_reports_changes_and_drops_invalid_groups() {
        let mut groups = WindowGroups::default();
        let reported = vec![
            WindowGroup { members: members(&["a", "b"]), selected: "b".into() },
            WindowGroup { members: members(&["lone"]), selected: "lone".into() },
            WindowGroup { members: members(&["c", "d"]), selected: "gone".into() },
        ];
        assert!(groups.replace(reported.clone()));
        assert_eq!(groups.groups(), &reported[..1]);
        assert!(!groups.replace(reported));
        assert_eq!(groups.group("b").unwrap().selected, "b");
        assert!(groups.replace(Vec::new()));
        assert!(groups.group("a").is_none());
    }

    #[test]
    fn selecting_and_detaching_preserve_the_other_sessions() {
        let mut groups = WindowGroups::default();
        groups.merge(members(&["a", "b", "c"]), "b").unwrap();
        assert!(groups.select("a", "unrelated").is_err());
        groups.select("a", "c").unwrap();
        assert_eq!(groups.detach("c"), Some("b".into()));
        assert_eq!(groups.group("a").unwrap().members, members(&["a", "b"]));
        assert_eq!(groups.detach("b"), Some("a".into()));
        assert!(groups.group("a").is_none());
    }

    #[test]
    fn merging_groups_and_reordering_keep_unique_members() {
        let mut groups = WindowGroups::default();
        groups.merge(members(&["a", "b"]), "a").unwrap();
        groups.merge(members(&["c", "d"]), "c").unwrap();
        groups.merge(members(&["a", "b", "c", "d", "a"]), "a").unwrap();
        assert_eq!(groups.groups().len(), 1);
        assert!(groups.reorder("a", members(&["a", "a", "c", "d"])).is_err());
        groups.reorder("a", members(&["d", "c", "b", "a"])).unwrap();
        assert_eq!(groups.group("a").unwrap().members[0], "d");
    }

    fn paths(values: &[&str]) -> Vec<PathBuf> {
        values.iter().map(PathBuf::from).collect()
    }

    fn saved(projects: &[&str], selected: usize, fullscreen: bool) -> SavedGroup {
        SavedGroup { projects: paths(projects), selected, fullscreen }
    }

    #[test]
    fn restore_plan_reopens_every_group_with_main_first() {
        let groups = [saved(&["/delta", "/epsilon"], 1, true), saved(&["/alpha", "/beta", "/gamma"], 2, false)];
        let plan = restore_plan(&groups, Some(Path::new("/beta")), |_| true);
        assert_eq!(
            plan,
            vec![
                PlannedGroup {
                    projects: paths(&["/alpha", "/beta", "/gamma"]),
                    selected: 2,
                    fullscreen: false,
                    main: true
                },
                PlannedGroup { projects: paths(&["/delta", "/epsilon"]), selected: 1, fullscreen: true, main: false },
            ]
        );
        assert!(plan.iter().all(PlannedGroup::grouped));
        // `main` showing a project of no saved group: every group still reopens.
        let plan = restore_plan(&groups, Some(Path::new("/other")), |_| true);
        assert_eq!(plan.len(), 2);
        assert!(plan.iter().all(|g| !g.main));
    }

    #[test]
    fn restore_plan_skips_missing_projects_and_keeps_a_lone_survivor_ungrouped() {
        let groups = [
            saved(&["/alpha", "/beta", "/gamma"], 1, false),
            saved(&["/delta", "/gone"], 1, true),
            saved(&["/gone", "/also-gone"], 0, false),
        ];
        let exists = |p: &Path| !p.starts_with("/gone") && !p.starts_with("/also-gone") && p != Path::new("/beta");
        let plan = restore_plan(&groups, Some(Path::new("/alpha")), exists);
        assert_eq!(plan.len(), 2);
        // The selected project is gone: `main`'s tab is shown instead.
        assert_eq!(plan[0].projects, paths(&["/alpha", "/gamma"]));
        assert_eq!(plan[0].selected, 0);
        assert!(plan[0].grouped());
        assert_eq!(plan[1].projects, paths(&["/delta"]));
        assert_eq!(plan[1].selected, 0);
        assert!(!plan[1].grouped());
    }

    #[test]
    fn restore_plan_reopens_a_project_saved_in_two_groups_once() {
        let groups = [saved(&["/a", "/b"], 0, false), saved(&["/b", "/c", "/d"], 0, false)];
        let plan = restore_plan(&groups, None, |_| true);
        assert_eq!(plan[0].projects, paths(&["/a", "/b"]));
        assert_eq!(plan[1].projects, paths(&["/c", "/d"]));
        assert_eq!(plan[1].selected, 0);
    }

    #[test]
    fn saved_groups_without_fullscreen_read_as_not_fullscreen() {
        let groups: Vec<SavedGroup> = serde_json::from_str(r#"[{"projects":["/a","/b"],"selected":1}]"#).unwrap();
        assert_eq!(groups, vec![saved(&["/a", "/b"], 1, false)]);
        let json = serde_json::to_string(&saved(&["/a", "/b"], 0, true)).unwrap();
        assert_eq!(serde_json::from_str::<SavedGroup>(&json).unwrap(), saved(&["/a", "/b"], 0, true));
    }

    #[test]
    fn saving_before_the_restore_keeps_the_groups_not_reopened_yet() {
        let on_disk = vec![saved(&["/alpha", "/beta"], 0, false), saved(&["/delta", "/epsilon"], 1, true)];
        // Only the first group has been reopened (with its tabs reordered).
        let current = vec![saved(&["/beta", "/alpha"], 1, false)];
        assert_eq!(
            groups_to_save(current.clone(), on_disk.clone(), false),
            vec![saved(&["/beta", "/alpha"], 1, false), saved(&["/delta", "/epsilon"], 1, true)]
        );
        // Once every group has been reopened, the open groups are the whole truth.
        assert_eq!(groups_to_save(current.clone(), on_disk, true), current);
        // A saved group sharing a project with an open one was reopened (perhaps changed).
        let on_disk = vec![saved(&["/beta", "/gamma"], 0, false)];
        assert_eq!(groups_to_save(current.clone(), on_disk, false), current);
    }
}
