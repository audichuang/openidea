//! Desktop adapter for project tabs. Each member retains its WebView and services.
//!
//! The page draws the tabs on every platform. Windows and Linux show one member window at a time.
//! macOS uses AppKit window tabs with the system tab bar hidden (see `macos.rs`): one shared frame
//! and fullscreen Space, and AppKit's own tab state, which [`sync`] mirrors into
//! [`WindowsState::groups`].
use crate::{
    state::AppState,
    windows::{self, WindowsState},
};
use ide_core::{IdeError, IdeEvent, IdeResult};
use ide_workspace::window_groups::{PlannedGroup, SavedGroup, WindowGroup, groups_to_save, restore_plan};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
#[cfg(not(target_os = "macos"))]
use std::sync::atomic::AtomicU64;
#[cfg(not(target_os = "macos"))]
use std::time::Duration;
#[cfg(not(target_os = "macos"))]
use tauri::WebviewWindow;
use tauri::{AppHandle, Manager};

/// Wait for the selection's asynchronous `hide` calls to take effect before moving the peers.
#[cfg(not(target_os = "macos"))]
const FRAME_SETTLE_AFTER_SELECT: Duration = Duration::from_millis(50);
/// Wait for a drag/resize to stop before copying its frame to the hidden peers.
#[cfg(not(target_os = "macos"))]
const FRAME_SETTLE_AFTER_MOVE: Duration = Duration::from_millis(100);
/// Coalesces the move/resize events a drag emits.
#[cfg(not(target_os = "macos"))]
static FRAME_SYNC_GENERATION: AtomicU64 = AtomicU64::new(0);

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
                .map(|p| ide_host::ops::project::info(p).display_name)
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
/// the app or AppKit (⌃Tab, Window menu) changed them, and names each tab after its project.
#[cfg(target_os = "macos")]
pub fn sync(app: &AppHandle) {
    let (Some(state), Some(host)) = (app.try_state::<WindowsState>(), app.try_state::<AppState>()) else { return };
    let windows: Vec<_> =
        windows::project_window_labels(app).into_iter().filter_map(|label| app.get_webview_window(&label)).collect();
    let labels = windows
        .iter()
        .filter_map(|w| {
            let project = host.opened_project(w.label())?;
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
/// tab groups as AppKit has them.
#[cfg(target_os = "macos")]
pub fn save_before_quit(app: &AppHandle) {
    windows::save_main_fullscreen(app);
    sync(app);
    if let Err(e) = tauri::async_runtime::block_on(persist(app)) {
        tracing::warn!("cannot save window groups: {}", e.message);
    }
}

/// macOS window resize: tell every tab of a group entering or leaving fullscreen, shown or not;
/// and once the size has settled, give the hidden tabs the new frame (window events: main thread).
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

/// Whether `to` already presents `from`'s frame, so moving it would only make it flicker.
#[cfg(not(target_os = "macos"))]
fn same_frame(from: &WebviewWindow, to: &WebviewWindow) -> bool {
    let (Ok(from_max), Ok(to_max)) = (from.is_maximized(), to.is_maximized()) else { return false };
    let (Ok(from_full), Ok(to_full)) = (from.is_fullscreen(), to.is_fullscreen()) else { return false };
    if from_max != to_max || from_full != to_full {
        return false;
    }
    let same_monitor = match (from.current_monitor(), to.current_monitor()) {
        (Ok(Some(a)), Ok(Some(b))) => a.position() == b.position() && a.size() == b.size(),
        // An unmapped window may not report a monitor; treat only equal states as matching.
        (Ok(None), Ok(None)) | (Err(_), Err(_)) => true,
        _ => false,
    };
    if !same_monitor {
        return false;
    }
    from_full
        || from_max
        || (from.outer_position().ok() == to.outer_position().ok() && from.inner_size().ok() == to.inner_size().ok())
}

/// Moves a hidden window onto `from`'s monitor. A restored window keeps its normal position on
/// the monitor it last occupied; maximizing or going fullscreen there would make the window
/// visibly jump across displays when its tab is selected.
#[cfg(not(target_os = "macos"))]
fn place_on_monitor(from: &WebviewWindow, to: &WebviewWindow) -> IdeResult<()> {
    // Wayland does not let clients place top-level windows; maximizing stays on that output.
    #[cfg(target_os = "linux")]
    if crate::linux_window_state::is_wayland() {
        return Ok(());
    }
    let err = |e: tauri::Error| IdeError::internal(e.to_string());
    if let Some(monitor) = from.current_monitor().map_err(err)? {
        to.set_position(*monitor.position()).map_err(err)?;
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn copy_frame(from: &WebviewWindow, to: &WebviewWindow) -> IdeResult<()> {
    if same_frame(from, to) {
        return Ok(());
    }
    let err = |e: tauri::Error| IdeError::internal(e.to_string());
    let fullscreen = from.is_fullscreen().map_err(err)?;
    if fullscreen {
        to.set_fullscreen(false).map_err(err)?;
        place_on_monitor(from, to)?;
        from.set_fullscreen(false).map_err(err)?;
        to.set_fullscreen(true).map_err(err)?;
        return Ok(());
    }
    to.set_fullscreen(false).map_err(err)?;
    let maximized = from.is_maximized().map_err(err)?;
    if !maximized {
        to.unmaximize().map_err(err)?;
        to.set_position(from.outer_position().map_err(err)?).map_err(err)?;
        // `set_size` excludes GTK's CSD shadow, which tao's inner size includes on Wayland.
        #[cfg(target_os = "linux")]
        let size = crate::linux_window_state::content_size(&from.as_ref().window()).map_err(err)?;
        #[cfg(not(target_os = "linux"))]
        let size = from.inner_size().map_err(err)?;
        #[cfg(target_os = "linux")]
        crate::linux_window_state::normal_size_requested(to.app_handle(), to.label(), size);
        to.set_size(size).map_err(err)?;
    } else {
        // Maximize the target on the source's monitor, not on the monitor it happened to
        // occupy while hidden.
        to.unmaximize().map_err(err)?;
        place_on_monitor(from, to)?;
        to.maximize().map_err(err)?;
    }
    Ok(())
}

/// Keeps hidden group members at the selected window's frame. Selecting a tab then only
/// changes which window is visible instead of moving or resizing one on screen.
#[cfg(not(target_os = "macos"))]
fn sync_member_frames(app: &AppHandle, selected: &str) {
    let Some(group) = app.state::<WindowsState>().groups.lock().group(selected).cloned() else { return };
    if group.selected != selected {
        return;
    }
    let Some(from) = app.get_webview_window(selected) else { return };
    if from.is_fullscreen().unwrap_or(false) || from.is_minimized().unwrap_or(false) {
        return;
    }
    for member in group.members.iter().filter(|member| member.as_str() != selected) {
        let Some(to) = app.get_webview_window(member) else { continue };
        // A visible peer is the one being presented; never move it behind the user's back.
        if to.is_visible().unwrap_or(false) {
            continue;
        }
        if let Err(error) = copy_frame(&from, &to) {
            tracing::warn!("cannot align window {member} with {selected}: {}", error.message);
        }
    }
}

/// A presented group window moved or resized. Align its hidden peers after the user stops, so
/// the next tab selection is only a visibility change.
#[cfg(not(target_os = "macos"))]
pub fn frame_changed(app: &AppHandle, label: &str) {
    let Some(group) = app.state::<WindowsState>().groups.lock().group(label).cloned() else { return };
    if group.selected != label {
        return;
    }
    let generation = FRAME_SYNC_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    let app = app.clone();
    let label = label.to_owned();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FRAME_SETTLE_AFTER_MOVE).await;
        if FRAME_SYNC_GENERATION.load(Ordering::Relaxed) != generation {
            return;
        }
        if !app.state::<WindowsState>().quitting() {
            sync_member_frames(&app, &label);
        }
    });
}

/// Puts the tabs of `caller`'s group in `labels` order (dragging in the page's tab strip).
pub fn reorder(app: &AppHandle, caller: &str, labels: Vec<String>) -> IdeResult<()> {
    app.state::<WindowsState>().groups.lock().reorder(caller, labels.clone())?;
    #[cfg(target_os = "macos")]
    {
        let order: Vec<_> = labels.iter().filter_map(|label| app.get_webview_window(label)).collect();
        crate::macos::reorder_tabs(app, &order)?;
    }
    changed(app);
    select(app, caller, caller)
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
    } else if !state.quitting() {
        // Align the members that are now hidden while they stay invisible, so the next
        // selection does not move or resize a window on screen. Hiding is asynchronous;
        // wait for it before moving a peer that is still on screen.
        let app = app.clone();
        let target = target.to_owned();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(FRAME_SETTLE_AFTER_SELECT).await;
            if !app.state::<WindowsState>().quitting() {
                sync_member_frames(&app, &target);
            }
        });
    }
    changed(app);
    result
}

/// Adds `new_window` to `anchor`'s group (or groups the two) and shows it.
pub fn join(app: &AppHandle, anchor: &str, new_window: &str) -> IdeResult<()> {
    #[cfg(target_os = "macos")]
    {
        let window = |label: &str| app.get_webview_window(label).ok_or_else(|| IdeError::not_found("Window closed"));
        let (anchor, new_window) = (window(anchor)?, window(new_window)?);
        crate::macos::add_tabs(app, &anchor, &[anchor.clone(), new_window.clone()], &new_window)?;
        sync(app);
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        app.state::<WindowsState>().groups.lock().join(anchor, new_window)?;
        // `anchor`'s frame (fullscreen included) moves to the new tab.
        select(app, anchor, new_window)?;
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = persist(&app).await {
                tracing::warn!("cannot save window groups: {}", e.message);
            }
        });
        Ok(())
    }
}

pub fn merge(app: &AppHandle, caller: &str) -> IdeResult<()> {
    let members = windows::project_window_labels(app)
        .into_iter()
        .filter(|label| app.state::<AppState>().opened_project(label).is_some())
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
    let advance = state.tab_closes.lock().as_mut().is_some_and(|batch| {
        let closing = batch.pending.front().is_some_and(|l| l == caller);
        if closing {
            batch.pending.pop_front();
        }
        closing
    });
    if advance {
        close_next(app);
    }
}

/// Tabs left to close; the first one is closing now.
pub struct TabCloses {
    keep: String,
    pending: VecDeque<String>,
}

/// Closes `labels` one at a time so each project's unsaved-changes prompt is shown in turn, then selects `keep`.
pub fn close_tabs(app: &AppHandle, caller: &str, keep: &str, labels: Vec<String>) -> IdeResult<()> {
    let state = app.state::<WindowsState>();
    let members = state
        .groups
        .lock()
        .group(caller)
        .map(|g| g.members.clone())
        .ok_or_else(|| IdeError::not_found("This window is not grouped"))?;
    if !members.iter().any(|m| m == keep) {
        return Err(IdeError::invalid("The window is not in this group"));
    }
    let pending = members.into_iter().filter(|m| m != keep && labels.contains(m)).collect();
    *state.tab_closes.lock() = Some(TabCloses { keep: keep.to_owned(), pending });
    close_next(app);
    Ok(())
}

/// The closing tab's project vetoed (its unsaved-changes prompt was cancelled): leave the rest open.
pub fn cancel_close(app: &AppHandle, caller: &str) {
    let state = app.state::<WindowsState>();
    let mut batch = state.tab_closes.lock();
    if batch.as_ref().is_some_and(|b| b.pending.front().is_some_and(|l| l == caller)) {
        *batch = None;
    }
}

fn close_next(app: &AppHandle) {
    let state = app.state::<WindowsState>();
    loop {
        let next = {
            let mut batch = state.tab_closes.lock();
            let Some(b) = batch.as_mut() else { return };
            match b.pending.front() {
                Some(label) => Ok(label.clone()),
                None => Err(batch.take().unwrap().keep),
            }
        };
        match next {
            Ok(label) => {
                if let Some(window) = app.get_webview_window(&label) {
                    windows::focus(&window);
                    if window.close().is_ok() {
                        return;
                    }
                }
                if let Some(b) = state.tab_closes.lock().as_mut() {
                    b.pending.pop_front();
                }
            }
            Err(keep) => {
                if let Some(window) = app.get_webview_window(&keep) {
                    windows::focus(&window);
                }
                return;
            }
        }
    }
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
    // A restored member may still be opening its project, or have failed to: saved as launched.
    let current = snapshot(
        &groups,
        |label| state.saved_project(label, host.project(label).ok().map(|p| p.root.clone())),
        &fullscreen,
    );
    let restored = state.groups_restore_done.load(Ordering::SeqCst)
        || !host.global_settings.effective().general.reopen_last_project;
    let unrestored = state.groups_unrestored.lock().clone();
    let open_count = current.len();
    let path = host.config_dir.join(SAVED_GROUPS);
    let written = tauri::async_runtime::spawn_blocking(move || {
        let not_reopened = if restored {
            unrestored
        } else {
            match read_saved(&path) {
                Ok(saved) => saved,
                // Saving now would drop the groups that could not be read.
                Err(e) => {
                    tracing::warn!("cannot read saved window groups: {}", e.message);
                    return Ok(None);
                }
            }
        };
        let groups = groups_to_save(current, not_reopened);
        let bytes = serde_json::to_vec(&groups).map_err(|e| IdeError::internal(e.to_string()))?;
        ide_vfs::write_atomic(&path, &bytes).map(|_| Some(groups))
    })
    .await
    .map_err(|e| IdeError::internal(e.to_string()))??;
    // Only the failed groups just kept stay: one whose project was opened in a group since is gone.
    if restored && let Some(mut written) = written {
        *state.groups_unrestored.lock() = written.split_off(open_count);
    }
    Ok(())
}

/// The open groups as saved. `resolve`: the project a member window holds or was launched with.
fn snapshot(
    groups: &[WindowGroup],
    resolve: impl Fn(&str) -> Option<PathBuf>,
    fullscreen: &HashSet<String>,
) -> Vec<SavedGroup> {
    groups
        .iter()
        .filter_map(|group| {
            // Left out: a member holding no project and not launched with one.
            let kept: Vec<_> =
                group.members.iter().enumerate().filter_map(|(i, label)| Some((i, resolve(label)?))).collect();
            // Fewer than two left: a plain window, as when tabs leave a group.
            if kept.len() < 2 {
                return None;
            }
            // A dropped shown tab passes to the next one, else the last, as `WindowGroups::detach`.
            let shown = group.members.iter().position(|l| l == &group.selected).unwrap_or(0);
            let selected = kept.iter().position(|(i, _)| *i >= shown).unwrap_or(kept.len() - 1);
            Some(SavedGroup {
                selected,
                // Every tab shares the group's Space, the dropped ones too.
                fullscreen: group.members.iter().any(|l| fullscreen.contains(l)),
                projects: kept.into_iter().map(|(_, project)| project).collect(),
            })
        })
        .collect()
}

/// Reopens every saved window group once `main` knows its startup project: the group holding that
/// project around `main`, every other one in new windows. Also when `main` stays on welcome, as
/// IntelliJ reopens every project open at exit; later projects opened in `main` restore nothing.
pub async fn restore(app: &AppHandle, caller: &str) -> IdeResult<()> {
    if caller != "main" {
        return Ok(());
    }
    let state = app.state::<WindowsState>();
    let host = app.state::<AppState>();
    let project = host.opened_project(caller);
    let reopen = match &project {
        Some(project) => project.settings.effective().general.reopen_last_project,
        None => host.global_settings.effective().general.reopen_last_project,
    };
    if restore_gate(&state, reopen) != RestoreGate::Restore {
        return Ok(());
    }
    // Unreadable saved groups: not done, so saving leaves them on disk.
    let failed = restore_groups(app, caller, project.as_ref().map(|p| p.root.as_path())).await?;
    *state.groups_unrestored.lock() = failed;
    state.groups_restore_done.store(true, Ordering::SeqCst);
    // Saves made while reopening kept the groups not reopened yet; now the open ones are complete.
    if let Err(e) = persist(app).await {
        tracing::warn!("cannot save window groups: {}", e.message);
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
enum RestoreGate {
    /// The saved groups are reopened now.
    Restore,
    /// Reopening is off for this launch: saving may overwrite the saved groups.
    Off,
    /// An earlier call already decided.
    Decided,
}

/// Only `main`'s first call per launch decides, the setting as it is then included: `main` calls
/// again whenever its project changes.
fn restore_gate(state: &WindowsState, reopen: bool) -> RestoreGate {
    if state.groups_restored.swap(true, Ordering::SeqCst) {
        return RestoreGate::Decided;
    }
    if !reopen {
        state.groups_restore_done.store(true, Ordering::SeqCst);
        return RestoreGate::Off;
    }
    RestoreGate::Restore
}

/// Returns the groups that failed to reopen.
async fn restore_groups(app: &AppHandle, caller: &str, root: Option<&Path>) -> IdeResult<Vec<SavedGroup>> {
    let path = app.state::<AppState>().config_dir.join(SAVED_GROUPS);
    let saved = tauri::async_runtime::spawn_blocking(move || read_saved(&path))
        .await
        .map_err(|e| IdeError::internal(e.to_string()))??;
    let plan = restore_plan(&saved, root, Path::is_dir);
    if plan.is_empty() {
        return Ok(Vec::new());
    }
    // `create_main_window` may have just started this window's fullscreen animation; tabs moved
    // into a window during one are lost.
    let main_fullscreen = match app.get_webview_window(caller) {
        Some(window) => {
            wait_fullscreen_transition(app, &window).await;
            // `main`'s group takes its saved fullscreen state (`SavedGroup::fullscreen`), not the
            // one `main` reopened in (`main-window-fullscreen.json`): leave it before tabs move in.
            let fullscreen = in_fullscreen(app, &window);
            let leave = plan.iter().any(|g| g.main && g.grouped() && g.fullscreen_change(fullscreen) == Some(false));
            if leave {
                if let Err(e) = window.set_fullscreen(false) {
                    tracing::warn!("cannot reopen a window group out of full screen: {e}");
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                wait_fullscreen_transition(app, &window).await;
            }
            fullscreen && !leave
        }
        None => false,
    };
    // Every group is merged before any enters fullscreen, so no tab moves during a transition.
    let (mut fullscreen, mut failed) = (Vec::new(), Vec::new());
    for group in &plan {
        match restore_group(app, caller, root, group) {
            Ok(Some(selected)) if group.fullscreen_change(main_fullscreen) == Some(true) => fullscreen.push(selected),
            Ok(_) => {}
            Err(e) => {
                tracing::warn!("cannot reopen a window group: {}", e.message);
                failed.push(SavedGroup {
                    projects: group.projects.clone(),
                    selected: group.selected,
                    fullscreen: group.fullscreen,
                });
            }
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
    Ok(failed)
}

/// Opens `group`'s projects (`root` in `caller`) and tabs them together; returns the shown tab.
fn restore_group(
    app: &AppHandle,
    caller: &str,
    root: Option<&Path>,
    group: &PlannedGroup,
) -> IdeResult<Option<String>> {
    let mut labels = Vec::new();
    for path in &group.projects {
        let label = if group.main && Some(path.as_path()) == root {
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

/// Whether `window`'s group is in fullscreen once grouped. Elsewhere than on macOS grouping leaves
/// fullscreen (`group_windows`).
fn in_fullscreen(_app: &AppHandle, _window: &tauri::WebviewWindow) -> bool {
    #[cfg(target_os = "macos")]
    return crate::macos::in_fullscreen_any_thread(_app, vec![_window.clone()]).first().copied().unwrap_or(false);
    #[cfg(not(target_os = "macos"))]
    false
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restore_gate_decides_once_per_launch() {
        let state = WindowsState::default();
        assert_eq!(restore_gate(&state, true), RestoreGate::Restore);
        assert_eq!(restore_gate(&state, true), RestoreGate::Decided);
    }

    // Turning the setting on later and opening a project in `main` must not pop every old group
    // up mid-session.
    #[test]
    fn restore_gate_off_at_startup_stays_off() {
        let state = WindowsState::default();
        assert_eq!(restore_gate(&state, false), RestoreGate::Off);
        assert!(state.groups_restore_done.load(Ordering::SeqCst));
        assert_eq!(restore_gate(&state, true), RestoreGate::Decided);
        assert_eq!(restore_gate(&state, false), RestoreGate::Decided);
    }

    fn group(members: &[&str], selected: &str) -> WindowGroup {
        WindowGroup { members: members.iter().map(|m| (*m).to_owned()).collect(), selected: selected.to_owned() }
    }

    fn saved(projects: &[&str], selected: usize, fullscreen: bool) -> SavedGroup {
        SavedGroup { projects: projects.iter().map(PathBuf::from).collect(), selected, fullscreen }
    }

    /// Member `x` holds project `/x`, except those in `failed`.
    fn resolver(failed: &[&str]) -> impl Fn(&str) -> Option<PathBuf> {
        let failed: Vec<String> = failed.iter().map(|f| (*f).to_owned()).collect();
        move |label| (!failed.iter().any(|f| f == label)).then(|| PathBuf::from(format!("/{label}")))
    }

    fn set(labels: &[&str]) -> HashSet<String> {
        labels.iter().map(|l| (*l).to_owned()).collect()
    }

    // A member holding no project and launched with none (a welcome window joined through the
    // system tab bar) leaves its group in the saved state; the rest is still saved, fullscreen
    // included.
    #[test]
    fn snapshot_drops_a_member_that_holds_no_project() {
        let groups = [group(&["a", "b", "c"], "a"), group(&["d", "e"], "e"), group(&["f", "g"], "f")];
        let current = snapshot(&groups, resolver(&["b", "f"]), &set(&["a", "d"]));
        // `f`'s group keeps one project: a plain window, not a group.
        assert_eq!(current, [saved(&["/a", "/c"], 0, true), saved(&["/d", "/e"], 1, true)]);
    }

    // The shown tab failed: the one after it is shown, as when a tab leaves the group.
    #[test]
    fn snapshot_moves_the_selection_off_a_dropped_member() {
        let groups = [group(&["a", "b", "c"], "b"), group(&["d", "e", "f"], "f")];
        let current = snapshot(&groups, resolver(&["b", "f"]), &set(&[]));
        assert_eq!(current, [saved(&["/a", "/c"], 1, false), saved(&["/d", "/e"], 1, false)]);
    }

    // A member still opening its project (launch pending or taken) stays in its group.
    #[test]
    fn snapshot_keeps_a_member_still_opening_its_project() {
        let groups = [group(&["a", "b"], "b")];
        let opening = |label: &str| Some(PathBuf::from(format!("/{label}")));
        assert_eq!(snapshot(&groups, opening, &set(&["b"])), [saved(&["/a", "/b"], 1, true)]);
    }

    // A restored member whose project failed to open (or whose trust prompt was cancelled) keeps
    // the project it was launched with: its group is still saved, so the healthy member reopens
    // with it next launch and the failed one is retried (a missing folder is skipped then).
    #[test]
    fn snapshot_keeps_a_member_whose_launch_did_not_open() {
        let st = WindowsState::default();
        for label in ["a", "b"] {
            let launch =
                windows::Launch { project: Some(PathBuf::from(format!("/{label}")).into()), ..Default::default() };
            st.set_launch(label, launch);
            st.take_launch(label);
            st.launch_settled(label, label == "a");
        }
        let held = |label: &str| (label == "a").then(|| PathBuf::from("/a"));
        let current = snapshot(&[group(&["a", "b"], "b")], |l| st.saved_project(l, held(l)), &set(&["a"]));
        assert_eq!(current, [saved(&["/a", "/b"], 1, true)]);
    }

    // Before the restore has run, saved groups not reopened yet stay saved, also when a member
    // that left a group held one of their projects.
    #[test]
    fn snapshot_keeps_the_saved_groups_not_reopened_yet() {
        let groups = [group(&["a", "b"], "a"), group(&["c", "d", "e"], "c")];
        let current = snapshot(&groups, resolver(&["e"]), &set(&["c"]));
        let on_disk = vec![saved(&["/x", "/y"], 1, true), saved(&["/e", "/z"], 0, false)];
        assert_eq!(
            groups_to_save(current, on_disk),
            [
                saved(&["/a", "/b"], 0, false),
                saved(&["/c", "/d"], 0, true),
                saved(&["/x", "/y"], 1, true),
                saved(&["/e", "/z"], 0, false),
            ]
        );
    }
}
