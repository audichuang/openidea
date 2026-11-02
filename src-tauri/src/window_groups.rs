//! Desktop adapter for project tabs. Each member retains its WebView and services.
//!
//! Windows and Linux draw the tabs in the page and show one member window at a time. macOS uses
//! AppKit window tabs (see `macos.rs`): the system tab bar, one shared frame and fullscreen Space,
//! and AppKit's own tab state, which [`sync`] mirrors into [`WindowsState::groups`].
use crate::{
    state::AppState,
    windows::{self, WindowsState},
};
use ide_core::{IdeError, IdeEvent, IdeResult};
use ide_workspace::window_groups::{PlannedGroup, SavedGroup, WindowGroup, groups_to_save, restore_plan};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::Ordering;
#[cfg(not(target_os = "macos"))]
use tauri::WebviewWindow;
use tauri::{AppHandle, Manager};

#[derive(Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WindowTab {
    pub label: String,
    pub name: String,
    pub root: Option<ide_core::IpcPath>,
    pub current: bool,
}

pub fn current(app: &AppHandle, caller: &str) -> Vec<WindowTab> {
    let state = app.state::<WindowsState>();
    let Some(group) = state.groups.lock().group(caller).cloned() else { return Vec::new() };
    let host = app.state::<AppState>();
    group
        .members
        .iter()
        .filter_map(|label| {
            let window = app.get_webview_window(label)?;
            let project = host.project(label).ok();
            let name = project
                .as_ref()
                .map(|p| ide_host::ops::project::info(p).name)
                .unwrap_or_else(|| window.title().unwrap_or_default());
            Some(WindowTab {
                label: label.clone(),
                name,
                root: project.map(|p| p.root.clone().into()),
                current: label == caller,
            })
        })
        .collect()
}

fn changed(app: &AppHandle) {
    app.state::<AppState>().sink.emit(IdeEvent::WindowGroupsChanged);
}

/// macOS: mirrors AppKit's tab groups (membership, order, selected tab) into the model, after
/// the app or the system tab bar changed them, and names each tab after its project.
#[cfg(target_os = "macos")]
pub fn sync(app: &AppHandle) {
    let (Some(state), Some(host)) = (app.try_state::<WindowsState>(), app.try_state::<AppState>()) else { return };
    let windows: Vec<_> =
        windows::project_window_labels(app).into_iter().filter_map(|label| app.get_webview_window(&label)).collect();
    let labels = windows
        .iter()
        .filter_map(|w| {
            let project = host.project(w.label()).ok().filter(|p| !p.light)?;
            let tab = crate::macos::TabLabel {
                title: ide_host::ops::project::info(&project).name,
                tooltip: Some(project.root.to_string_lossy().into_owned()),
            };
            Some((w.label().to_owned(), tab))
        })
        .collect();
    let groups = match crate::macos::native_groups(app, windows, labels) {
        Ok(groups) => groups,
        Err(e) => return tracing::warn!("cannot read window tabs: {}", e.message),
    };
    if state.groups.lock().replace(groups) {
        changed(app);
        if !state.quitting() {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = persist(&app).await;
            });
        }
    }
}

/// macOS, main thread, before a quit closes any window: records `main`'s fullscreen state and the
/// tab groups as AppKit has them (the system tab bar reorders tabs without telling the app).
#[cfg(target_os = "macos")]
pub fn save_before_quit(app: &AppHandle) {
    windows::save_main_fullscreen(app);
    sync(app);
    if let Err(e) = tauri::async_runtime::block_on(persist(app)) {
        tracing::warn!("cannot save window groups: {}", e.message);
    }
}

/// macOS window resize: a group entering or leaving fullscreen moves the system tab bar from below
/// the title bar to the top of every tab, shown or not, so tell them all; and once the size has
/// settled, give the hidden tabs the new frame (window events: main thread).
#[cfg(target_os = "macos")]
pub fn resized(app: &AppHandle, label: &str) {
    use std::sync::atomic::{AtomicU64, Ordering};
    static FULLSCREEN: std::sync::LazyLock<parking_lot::Mutex<std::collections::HashSet<String>>> =
        std::sync::LazyLock::new(Default::default);
    static RESIZES: AtomicU64 = AtomicU64::new(0);
    let Some(state) = app.try_state::<WindowsState>() else { return };
    let Some(members) = state.groups.lock().group(label).map(|g| g.members.clone()) else {
        FULLSCREEN.lock().remove(label);
        return;
    };
    let Some(window) = app.get_webview_window(label) else { return };
    // Live resizing and fullscreen animations send many events: act after the last one.
    let resize = RESIZES.fetch_add(1, Ordering::SeqCst) + 1;
    let settled = window.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        if RESIZES.load(Ordering::SeqCst) == resize {
            let window = settled.clone();
            let _ = settled.run_on_main_thread(move || crate::macos::match_tab_frames(&window));
        }
    });
    let fullscreen = crate::macos::in_fullscreen(&window);
    {
        let mut known = FULLSCREEN.lock();
        if known.contains(label) == fullscreen {
            return;
        }
        // Any tab can be the one shown when the group enters or leaves fullscreen.
        for member in members {
            if fullscreen {
                known.insert(member);
            } else {
                known.remove(&member);
            }
        }
    }
    changed(app);
}

#[cfg(not(target_os = "macos"))]
fn copy_frame(from: &WebviewWindow, to: &WebviewWindow) -> IdeResult<()> {
    let err = |e: tauri::Error| IdeError::internal(e.to_string());
    let fullscreen = from.is_fullscreen().map_err(err)?;
    if fullscreen {
        from.set_fullscreen(false).map_err(err)?;
        to.set_fullscreen(true).map_err(err)?;
        return Ok(());
    }
    to.set_fullscreen(false).map_err(err)?;
    let maximized = from.is_maximized().map_err(err)?;
    if !maximized {
        to.unmaximize().map_err(err)?;
        to.set_position(from.outer_position().map_err(err)?).map_err(err)?;
        let size = from.inner_size().map_err(err)?;
        #[cfg(target_os = "linux")]
        crate::linux_window_state::normal_size_requested(to.app_handle(), to.label(), size);
        to.set_size(size).map_err(err)?;
    } else {
        to.maximize().map_err(err)?;
    }
    Ok(())
}

pub fn select(app: &AppHandle, caller: &str, target: &str) -> IdeResult<()> {
    let to = app.get_webview_window(target).ok_or_else(|| IdeError::not_found("Window closed"))?;
    let state = app.state::<WindowsState>();
    #[cfg(target_os = "macos")]
    {
        state.groups.lock().select(caller, target)?;
        crate::macos::select_tab(app, &to)?;
        // Menu commands go to the last focused window; across fullscreen Spaces AppKit's key
        // window events can arrive out of order.
        state.focused(target);
        sync(app);
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    select_shown(app, &state, caller, target, &to)
}

#[cfg(not(target_os = "macos"))]
fn select_shown(
    app: &AppHandle,
    state: &WindowsState,
    caller: &str,
    target: &str,
    to: &WebviewWindow,
) -> IdeResult<()> {
    let previous = state.groups.lock().select(caller, target)?;
    let result = (|| {
        if previous.selected != target
            && let Some(from) = app.get_webview_window(&previous.selected)
        {
            copy_frame(&from, to)?;
        }
        to.unminimize().map_err(|e| IdeError::internal(e.to_string()))?;
        to.show().map_err(|e| IdeError::internal(e.to_string()))?;
        to.set_focus().map_err(|e| IdeError::internal(e.to_string()))?;
        for member in &previous.members {
            if member != target
                && let Some(window) = app.get_webview_window(member)
            {
                window.hide().map_err(|e| IdeError::internal(e.to_string()))?;
            }
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = state.groups.lock().select(caller, &previous.selected);
        for member in &previous.members {
            if let Some(window) = app.get_webview_window(member) {
                if member == &previous.selected {
                    let _ = window.show();
                    let _ = window.set_focus();
                } else {
                    let _ = window.hide();
                }
            }
        }
    }
    changed(app);
    result
}

#[cfg(target_os = "macos")]
pub fn join(app: &AppHandle, anchor: &str, new_window: &str) -> IdeResult<()> {
    let window = |label: &str| app.get_webview_window(label).ok_or_else(|| IdeError::not_found("Window closed"));
    let (anchor, new_window) = (window(anchor)?, window(new_window)?);
    crate::macos::add_tabs(app, &anchor, &[anchor.clone(), new_window.clone()], &new_window)?;
    sync(app);
    Ok(())
}

pub fn merge(app: &AppHandle, caller: &str) -> IdeResult<()> {
    let members = windows::project_window_labels(app)
        .into_iter()
        .filter(|label| app.state::<AppState>().project(label).is_ok_and(|p| !p.light))
        .collect::<Vec<_>>();
    if members.len() < 2 || !members.iter().any(|label| label == caller) {
        return Err(IdeError::invalid("Open at least two project windows to create a window group"));
    }
    group_windows(app, members, caller, caller)
}

/// Makes `members` one group, in that order, showing `selected`; `caller`'s frame and fullscreen
/// state are kept.
fn group_windows(app: &AppHandle, members: Vec<String>, caller: &str, selected: &str) -> IdeResult<()> {
    #[cfg(target_os = "macos")]
    {
        let window = |label: &str| app.get_webview_window(label).ok_or_else(|| IdeError::not_found("Window closed"));
        let order: Vec<_> = members.iter().filter_map(|l| app.get_webview_window(l)).collect();
        crate::macos::add_tabs(app, &window(caller)?, &order, &window(selected)?)?;
        sync(app);
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Fullscreen puts each window in a separate Space; leave it before grouping.
        for label in &members {
            if let Some(window) = app.get_webview_window(label) {
                window.set_fullscreen(false).map_err(|e| IdeError::internal(e.to_string()))?;
            }
        }
        app.state::<WindowsState>().groups.lock().merge(members, caller)?;
        select(app, caller, selected)
    }
}

pub fn detach(app: &AppHandle, caller: &str) -> IdeResult<()> {
    #[cfg(target_os = "macos")]
    {
        let window = app.get_webview_window(caller).ok_or_else(|| IdeError::not_found("Window closed"))?;
        crate::macos::move_tab_to_new_window(app, &window)?;
        // The group it left can take the key window back after the moved tab's Space opens.
        app.state::<WindowsState>().focused(caller);
        sync(app);
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    detach_shown(app, caller)
}

#[cfg(not(target_os = "macos"))]
fn detach_shown(app: &AppHandle, caller: &str) -> IdeResult<()> {
    let state = app.state::<WindowsState>();
    let next = state.groups.lock().detach(caller);
    if let Some(next) = next {
        if let Some(window) = app.get_webview_window(&next) {
            window.show().map_err(|e| IdeError::internal(e.to_string()))?;
        }
        if let Some(window) = app.get_webview_window(caller) {
            if let Ok(position) = window.outer_position() {
                let _ = window.set_position(tauri::PhysicalPosition::new(position.x + 32, position.y + 32));
            }
            windows::focus(&window);
        }
    }
    changed(app);
    Ok(())
}

pub fn destroyed(app: &AppHandle, caller: &str) {
    let Some(state) = app.try_state::<WindowsState>() else { return };
    let next = state.groups.lock().detach(caller);
    if !state.quitting() {
        if let Some(window) = next.and_then(|label| app.get_webview_window(&label)) {
            windows::focus(&window);
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = persist(&app).await;
        });
    }
    changed(app);
}

const SAVED_GROUPS: &str = "window-groups.json";

fn read_saved(path: &Path) -> IdeResult<Vec<SavedGroup>> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| IdeError::invalid(e.to_string())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.into()),
    }
}

/// The grouped windows in a fullscreen Space, by label. Read before taking the save lock: on macOS
/// this asks the main thread, which `save_before_quit` blocks while it saves.
fn fullscreen_members(app: &AppHandle, groups: &[WindowGroup]) -> HashSet<String> {
    let windows: Vec<_> =
        groups.iter().flat_map(|g| &g.members).filter_map(|label| app.get_webview_window(label)).collect();
    #[cfg(target_os = "macos")]
    let fullscreen = crate::macos::in_fullscreen_any_thread(app, windows.clone());
    #[cfg(not(target_os = "macos"))]
    let fullscreen: Vec<_> = windows.iter().map(|w| w.is_fullscreen().unwrap_or(false)).collect();
    windows.iter().zip(fullscreen).filter(|(_, on)| *on).map(|(w, _)| w.label().to_owned()).collect()
}

pub async fn persist(app: &AppHandle) -> IdeResult<()> {
    let state = app.state::<WindowsState>();
    let open = state.groups.lock().groups().to_vec();
    let fullscreen = fullscreen_members(app, &open);
    let _write = state.groups_persist.lock().await;
    if state.quitting() {
        return Ok(());
    }
    let groups = state.groups.lock().groups().to_vec();
    let host = app.state::<AppState>();
    let current: Vec<_> = groups
        .iter()
        .filter_map(|group| {
            let projects: Vec<_> = group
                .members
                .iter()
                .filter_map(|label| {
                    host.project(label)
                        .ok()
                        .map(|p| p.root.clone())
                        .or_else(|| state.pending(label).and_then(|l| l.project).map(Into::into))
                })
                .collect();
            (projects.len() == group.members.len()).then(|| SavedGroup {
                projects,
                selected: group.members.iter().position(|l| l == &group.selected).unwrap_or(0),
                fullscreen: group.members.iter().any(|l| fullscreen.contains(l)),
            })
        })
        .collect();
    // A restored member may have taken its launch but not finished opening yet.
    if current.len() != groups.len() {
        return Ok(());
    }
    let restored = state.groups_restore_done.load(Ordering::SeqCst)
        || !host.global_settings.effective().general.reopen_last_project;
    let path = host.config_dir.join(SAVED_GROUPS);
    tauri::async_runtime::spawn_blocking(move || {
        let saved = if restored {
            Vec::new()
        } else {
            read_saved(&path).unwrap_or_else(|e| {
                tracing::warn!("cannot read saved window groups: {}", e.message);
                Vec::new()
            })
        };
        let groups = groups_to_save(current, saved, restored);
        let bytes = serde_json::to_vec(&groups).map_err(|e| IdeError::internal(e.to_string()))?;
        ide_vfs::write_atomic(&path, &bytes).map(|_| ())
    })
    .await
    .map_err(|e| IdeError::internal(e.to_string()))?
}

/// Reopens every saved window group once `main` has reopened its project: the group holding that
/// project around `main`, every other one in new windows.
pub async fn restore(app: &AppHandle, caller: &str) -> IdeResult<()> {
    if caller != "main" {
        return Ok(());
    }
    let state = app.state::<WindowsState>();
    let host = app.state::<AppState>();
    let project = host.project(caller)?;
    if !project.settings.effective().general.reopen_last_project {
        state.groups_restore_done.store(true, Ordering::SeqCst);
        return Ok(());
    }
    if state.groups_restored.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let result = restore_groups(app, caller, &project.root).await;
    state.groups_restore_done.store(true, Ordering::SeqCst);
    // Saves made while reopening kept the groups not reopened yet; now the open ones are complete.
    if let Err(e) = persist(app).await {
        tracing::warn!("cannot save window groups: {}", e.message);
    }
    result
}

async fn restore_groups(app: &AppHandle, caller: &str, root: &Path) -> IdeResult<()> {
    let path = app.state::<AppState>().config_dir.join(SAVED_GROUPS);
    let saved = tauri::async_runtime::spawn_blocking(move || read_saved(&path))
        .await
        .map_err(|e| IdeError::internal(e.to_string()))??;
    let plan = restore_plan(&saved, Some(root), Path::is_dir);
    if plan.is_empty() {
        return Ok(());
    }
    // `create_main_window` may have just started this window's fullscreen animation; tabs moved
    // into a window during one are lost.
    if let Some(window) = app.get_webview_window(caller) {
        wait_fullscreen_transition(app, &window).await;
    }
    // Every group is merged before any enters fullscreen, so no tab moves during a transition.
    let mut fullscreen = Vec::new();
    for group in &plan {
        match restore_group(app, caller, root, group) {
            // `main`'s group reopens in fullscreen with `main` (`main-window-fullscreen.json`).
            Ok(Some(selected)) if group.fullscreen && !group.main => fullscreen.push(selected),
            Ok(_) => {}
            Err(e) => tracing::warn!("cannot reopen a window group: {}", e.message),
        }
    }
    for label in fullscreen {
        let Some(window) = app.get_webview_window(&label) else { continue };
        wait_fullscreen_transition(app, &window).await;
        if let Err(e) = window.set_fullscreen(true) {
            tracing::warn!("cannot reopen a window group in full screen: {e}");
            continue;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        wait_fullscreen_transition(app, &window).await;
    }
    Ok(())
}

/// Opens `group`'s projects (`root` in `caller`) and tabs them together; returns the shown tab.
fn restore_group(app: &AppHandle, caller: &str, root: &Path, group: &PlannedGroup) -> IdeResult<Option<String>> {
    let mut labels = Vec::new();
    for path in &group.projects {
        let label = if group.main && path == root {
            caller.to_owned()
        } else {
            match windows::find_project_window(app, path) {
                Some(w) => w,
                None => windows::create_restored_window(app, path.clone())?,
            }
            .label()
            .to_owned()
        };
        labels.push(label);
    }
    if !group.grouped() {
        return Ok(None);
    }
    let anchor = if group.main { caller.to_owned() } else { labels[0].clone() };
    let selected = labels[group.selected].clone();
    group_windows(app, labels, &anchor, &selected)?;
    Ok(Some(selected))
}

/// Waits (up to 3 s) for `window` to finish entering or leaving fullscreen.
async fn wait_fullscreen_transition(_app: &AppHandle, _window: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    for _ in 0..30 {
        if !crate::macos::fullscreen_transition(_app, _window) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}
