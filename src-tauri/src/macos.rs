//! macOS window tabs: the system tab preference for new project windows, and project window
//! groups as AppKit tab groups.
use crate::windows::{Launch, WindowsState};
use ide_core::{IdeError, IdeResult};
use ide_workspace::window_groups::{TabbingPreference, WindowGroup, should_group_new_project};
use objc2::{MainThreadMarker, Message, rc::Retained, runtime::ProtocolObject};
use objc2_app_kit::{NSWindow, NSWindowOrderingMode, NSWindowStyleMask, NSWindowUserTabbingPreference};
use objc2_foundation::{NSNotification, NSNotificationCenter, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString};
use tauri::{AppHandle, Manager, WebviewWindow};

fn tabbing_preference(app: &AppHandle) -> IdeResult<TabbingPreference> {
    fn read(mtm: MainThreadMarker) -> TabbingPreference {
        match NSWindow::userTabbingPreference(mtm) {
            NSWindowUserTabbingPreference::Always => TabbingPreference::Always,
            NSWindowUserTabbingPreference::InFullScreen => TabbingPreference::InFullScreen,
            _ => TabbingPreference::Manually,
        }
    }
    if let Some(mtm) = MainThreadMarker::new() {
        return Ok(read(mtm));
    }
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = tx.send(read(MainThreadMarker::new().expect("AppKit main thread")));
    })
    .map_err(|e| IdeError::internal(e.to_string()))?;
    rx.recv().map_err(|e| IdeError::internal(e.to_string()))
}

/// Capture before building the new window, which takes focus itself.
pub fn new_project_tab_target(app: &AppHandle, launch: &Launch) -> IdeResult<Option<WebviewWindow>> {
    let windows = app.webview_windows();
    let active = windows
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
        .cloned()
        .or_else(|| app.state::<WindowsState>().last_focused().and_then(|label| windows.get(&label).cloned()));
    let active = active.and_then(|w| {
        let label = crate::windows::auxiliary_parent(w.label()).unwrap_or(w.label());
        windows.get(label).cloned()
    });
    let active = active.filter(|w| {
        let host = app.state::<crate::state::AppState>();
        host.opened_project(w.label()).is_some() || host.remote_dev.get(w.label()).is_some()
    });
    let fullscreen = active.as_ref().is_some_and(|w| w.is_fullscreen().unwrap_or(false));
    let light_edit = launch.project.is_none() && launch.remote.is_none();
    Ok(should_group_new_project(tabbing_preference(app)?, fullscreen, active.is_some(), light_edit)
        .then_some(active)
        .flatten())
}

// Project window groups are AppKit tab groups: one frame and one fullscreen Space for every
// member, so switching tabs never leaves fullscreen and never animates between Spaces. AppKit
// owns membership, order and the selected tab (its tab bar can also change them); the shared
// `WindowGroups` model mirrors it through `native_groups`.

/// Runs `f` on the AppKit main thread and returns its result.
fn on_main<R: Send + 'static>(app: &AppHandle, f: impl FnOnce(MainThreadMarker) -> R + Send + 'static) -> IdeResult<R> {
    if let Some(mtm) = MainThreadMarker::new() {
        return Ok(f(mtm));
    }
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = tx.send(f(MainThreadMarker::new().expect("AppKit main thread")));
    })
    .map_err(|e| IdeError::internal(e.to_string()))?;
    rx.recv().map_err(|e| IdeError::internal(e.to_string()))
}

/// The window's `NSWindow`; only dereference it on the main thread while the window is alive.
fn ns_window(window: &WebviewWindow) -> Option<*const NSWindow> {
    window.ns_window().ok().map(|p| p.cast::<NSWindow>().cast_const())
}

/// Grouping follows the "Open project in" / system tab preference logic in `windows.rs`, not
/// AppKit's automatic tabbing (which would also tab settings and LightEdit windows).
pub fn init_window_tabbing(mtm: MainThreadMarker) {
    NSWindow::setAllowsAutomaticWindowTabbing(false, mtm);
}

/// Makes `order` (which contains `anchor`) tabs of `anchor`'s group in that order around `anchor`,
/// then selects `select`.
///
/// Refused while one of them is in another fullscreen Space: its group would have to leave
/// fullscreen first, and moving tabs between groups during or right after an AppKit fullscreen
/// transition leaves windows half-fullscreen or raises NSInternalInconsistencyException
/// (-[NSWindowStackController _enterWindow:intoFullScreenWithWindow:]).
pub fn add_tabs(
    app: &AppHandle,
    anchor: &WebviewWindow,
    order: &[WebviewWindow],
    select: &WebviewWindow,
) -> IdeResult<()> {
    let (anchor, order, select) = (anchor.clone(), order.to_vec(), select.clone());
    on_main(app, move |_| {
        let Some(anchor_ns) = ns_window(&anchor).map(|n| unsafe { (*n).retain() }) else { return Ok(()) };
        let elsewhere = order.iter().any(|window| {
            ns_window(window)
                .map(|n| unsafe { (*n).retain() })
                .is_some_and(|native| !same_group(&native, &anchor_ns) && in_fullscreen_space(&native))
        });
        if elsewhere {
            return Err(IdeError::invalid(
                "Another project window is in its own full screen space. Exit full screen there first, then merge.",
            ));
        }
        if order.iter().any(|w| ns_window(w).is_some_and(|n| in_fullscreen_transition(unsafe { &*n }))) {
            return Err(IdeError::invalid(
                "A project window is entering or leaving full screen. Try again when it has.",
            ));
        }
        arrange(&anchor, &order, &select);
        Ok(())
    })?
}

/// Tabs `order` around `anchor` and selects `select`. Main thread only.
fn arrange(anchor: &WebviewWindow, order: &[WebviewWindow], select: &WebviewWindow) {
    let Some(anchor_ns) = ns_window(anchor).map(|n| unsafe { (*n).retain() }) else { return };
    let at = order.iter().position(|w| w.label() == anchor.label()).unwrap_or(0);
    let (before, after) = order.split_at(at.min(order.len()));
    // Right of the anchor, in order; then left of it, nearest first. Tabs already in the anchor's
    // group keep their place and become the next cursor.
    let mut cursor = anchor_ns.clone();
    for window in after.iter().filter(|w| w.label() != anchor.label()) {
        let Some(native) = ns_window(window).map(|n| unsafe { (*n).retain() }) else { continue };
        if !same_group(&native, &anchor_ns) {
            cursor.addTabbedWindow_ordered(&native, NSWindowOrderingMode::Above);
        }
        cursor = native;
    }
    let mut cursor = anchor_ns.clone();
    for window in before.iter().rev() {
        let Some(native) = ns_window(window).map(|n| unsafe { (*n).retain() }) else { continue };
        if !same_group(&native, &anchor_ns) {
            cursor.addTabbedWindow_ordered(&native, NSWindowOrderingMode::Below);
        }
        cursor = native;
    }
    if let Some(native) = ns_window(select) {
        unsafe { select_native(&*native) };
    }
}

/// Only a fullscreen group's selected tab carries the fullscreen style; its other tabs share the Space.
fn in_fullscreen_space(window: &NSWindow) -> bool {
    let fullscreen = |w: &NSWindow| w.styleMask().contains(NSWindowStyleMask::FullScreen);
    fullscreen(window) || window.tabGroup().and_then(|g| g.selectedWindow()).is_some_and(|w| fullscreen(&w))
}

fn same_group(a: &NSWindow, b: &NSWindow) -> bool {
    let group = |w: &NSWindow| w.tabGroup().map(|g| Retained::as_ptr(&g));
    std::ptr::eq(a, b) || (group(a).is_some() && group(a) == group(b))
}

unsafe fn select_native(window: &NSWindow) {
    if let Some(group) = window.tabGroup() {
        group.setSelectedWindow(Some(window));
    }
    if window.isMiniaturized() {
        window.deminiaturize(None);
    }
    window.makeKeyAndOrderFront(None);
}

/// Shows `window`'s tab (instantly, in the group's fullscreen Space when there is one).
pub fn select_tab(app: &AppHandle, window: &WebviewWindow) -> IdeResult<()> {
    let window = window.clone();
    on_main(app, move |_| unsafe {
        if let Some(native) = ns_window(&window) {
            select_native(&*native);
        }
    })
}

/// "Move Tab to New Window".
pub fn move_tab_to_new_window(app: &AppHandle, window: &WebviewWindow) -> IdeResult<()> {
    let window = window.clone();
    on_main(app, move |_| unsafe {
        if let Some(native) = ns_window(&window) {
            (*native).moveTabToNewWindow(None);
            (*native).makeKeyAndOrderFront(None);
        }
    })
}

/// A tab's title and tooltip (project name and root); without one AppKit shows the window title.
pub struct TabLabel {
    pub title: String,
    pub tooltip: Option<String>,
}

/// The tab groups AppKit has made of `windows` (labels in tab order), with each tab's selected
/// state; also applies `labels` to the tabs.
pub fn native_groups(
    app: &AppHandle,
    windows: Vec<WebviewWindow>,
    labels: std::collections::HashMap<String, TabLabel>,
) -> IdeResult<Vec<WindowGroup>> {
    on_main(app, move |_| unsafe {
        let natives: Vec<(String, *const NSWindow)> =
            windows.iter().filter_map(|w| ns_window(w).map(|n| (w.label().to_owned(), n))).collect();
        let label_of =
            |window: &NSWindow| natives.iter().find(|(_, n)| std::ptr::eq(*n, window)).map(|(label, _)| label.clone());
        let mut groups: Vec<WindowGroup> = Vec::new();
        for (label, native) in &natives {
            let native = &**native;
            if let Some(tab) = labels.get(label) {
                let t = native.tab();
                t.setTitle(Some(&NSString::from_str(&tab.title)));
                t.setToolTip(tab.tooltip.as_deref().map(NSString::from_str).as_deref());
            }
            if groups.iter().any(|g| g.members.contains(label)) {
                continue;
            }
            let Some(group) = native.tabGroup() else { continue };
            let members: Vec<String> = group.windows().iter().filter_map(|w| label_of(&w)).collect();
            let selected = group.selectedWindow().and_then(|w| label_of(&w));
            if members.len() > 1 {
                let selected = selected.filter(|s| members.contains(s)).unwrap_or_else(|| members[0].clone());
                groups.push(WindowGroup { members, selected });
            }
        }
        groups
    })
}

/// The system tab bar `window` shows over its page: height in points (0 without one), and whether
/// it sits at the very top (fullscreen hides the title bar) rather than below the title bar. Read
/// from the group's selected tab, which is laid out and alone carries the fullscreen style, so a
/// tab not shown yet is already set up for when it is.
pub fn tab_bar(app: &AppHandle, window: &WebviewWindow) -> IdeResult<(f64, bool)> {
    let window = window.clone();
    on_main(app, move |mtm| unsafe {
        let Some(native) = ns_window(&window) else { return (0.0, false) };
        let Some(group) = (*native).tabGroup().filter(|g| g.isTabBarVisible()) else { return (0.0, false) };
        let shown = group.selectedWindow().unwrap_or_else(|| (*native).retain());
        let top = shown.frame().size.height - shown.contentLayoutRect().size.height;
        if shown.styleMask().contains(NSWindowStyleMask::FullScreen) {
            (top.max(0.0), true)
        } else {
            ((top - titlebar_height(&shown, mtm)).max(0.0), false)
        }
    })
}

/// Gives `window`'s hidden tabs the shown tab's frame. AppKit only resizes a tab when it is
/// selected, so after a resize (or entering or leaving fullscreen) each tab's page would lay
/// itself out again on its first showing, a few frames with the old layout. Main thread only.
pub fn match_tab_frames(window: &WebviewWindow) {
    let Some(native) = ns_window(window) else { return };
    let Some(group) = (unsafe { &*native }).tabGroup() else { return };
    let Some(shown) = group.selectedWindow() else { return };
    let frame = shown.frame();
    for tab in group.windows().iter() {
        if !std::ptr::eq(&*tab, &*shown) && tab.frame() != frame {
            tab.setFrame_display(frame, false);
        }
    }
}

/// Fullscreen transitions by `NSWindow` address: when the last one started, and when it ended
/// (`None` while running). AppKit animates them with a snapshot window, so neither the window's
/// frame nor its fullscreen style shows one in progress; only the will/did notifications do.
#[derive(Clone, Copy)]
struct Transition {
    started: std::time::Instant,
    ended: Option<std::time::Instant>,
}

thread_local! {
    static TRANSITIONS: std::cell::RefCell<std::collections::HashMap<usize, Transition>> =
        std::cell::RefCell::default();
    static TRANSITION_OBSERVERS: std::cell::RefCell<Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>> =
        const { std::cell::RefCell::new(Vec::new()) };
}

/// After a transition has ended AppKit still settles the window (moving a tab out of a group in
/// `DidExitFullScreen` raises NSInternalInconsistencyException). A transition still running after
/// `STUCK` is taken as over: its window may have closed without an end notification.
const SETTLE: std::time::Duration = std::time::Duration::from_millis(300);
const STUCK: std::time::Duration = std::time::Duration::from_secs(5);

/// Starts tracking every window's fullscreen transitions (main thread, once at startup).
pub fn observe_fullscreen_transitions(_mtm: MainThreadMarker) {
    let names = unsafe {
        [
            (objc2_app_kit::NSWindowWillEnterFullScreenNotification, false),
            (objc2_app_kit::NSWindowDidEnterFullScreenNotification, true),
            (objc2_app_kit::NSWindowWillExitFullScreenNotification, false),
            (objc2_app_kit::NSWindowDidExitFullScreenNotification, true),
        ]
    };
    for (name, ends) in names {
        let block = block2::RcBlock::new(move |notification: std::ptr::NonNull<NSNotification>| {
            let Some(window) = (unsafe { notification.as_ref() }).object() else { return };
            let key = Retained::as_ptr(&window) as usize;
            let now = std::time::Instant::now();
            TRANSITIONS.with_borrow_mut(|transitions| {
                if ends {
                    let started = transitions.get(&key).map_or(now, |t| t.started);
                    transitions.insert(key, Transition { started, ended: Some(now) });
                } else {
                    transitions.insert(key, Transition { started: now, ended: None });
                }
            });
        });
        let observer = unsafe {
            NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
                Some(name),
                None,
                None,
                &block,
            )
        };
        TRANSITION_OBSERVERS.with_borrow_mut(|observers| observers.push(observer));
    }
}

fn in_fullscreen_transition(window: &NSWindow) -> bool {
    let key = window as *const NSWindow as usize;
    TRANSITIONS.with_borrow(|transitions| match transitions.get(&key) {
        Some(Transition { ended: Some(ended), .. }) => ended.elapsed() < SETTLE,
        Some(Transition { started, ended: None }) => started.elapsed() < STUCK,
        None => false,
    })
}

/// Whether `window` is entering or leaving fullscreen.
pub fn fullscreen_transition(app: &AppHandle, window: &WebviewWindow) -> bool {
    let window = window.clone();
    on_main(app, move |_| ns_window(&window).is_some_and(|n| in_fullscreen_transition(unsafe { &*n }))).unwrap_or(false)
}

/// Whether `window`, or the tab its group shows, is entering or leaving fullscreen. Main thread
/// only.
pub fn group_in_fullscreen_transition(window: &WebviewWindow) -> bool {
    ns_window(window).is_some_and(|native| {
        let native = unsafe { &*native };
        in_fullscreen_transition(native)
            || native.tabGroup().and_then(|g| g.selectedWindow()).is_some_and(|w| in_fullscreen_transition(&w))
    })
}

/// The labels of the other windows in `window`'s tab group. Main thread only.
pub fn tab_mates(app: &AppHandle, window: &WebviewWindow) -> Vec<String> {
    let Some(native) = ns_window(window) else { return Vec::new() };
    let Some(group) = (unsafe { &*native }).tabGroup() else { return Vec::new() };
    let tabs = group.windows();
    app.webview_windows()
        .into_values()
        .filter(|w| w.label() != window.label())
        .filter(|w| ns_window(w).is_some_and(|n| tabs.iter().any(|t| std::ptr::eq(&*t, n))))
        .map(|w| w.label().to_owned())
        .collect()
}

/// Whether `window` is in a fullscreen Space, itself or as a tab of a fullscreen group. Main
/// thread only.
pub fn in_fullscreen(window: &WebviewWindow) -> bool {
    ns_window(window).is_some_and(|n| in_fullscreen_space(unsafe { &*n }))
}

/// Which of `windows` are in a fullscreen Space (see [`in_fullscreen`]), from any thread.
pub fn in_fullscreen_any_thread(app: &AppHandle, windows: Vec<WebviewWindow>) -> Vec<bool> {
    let count = windows.len();
    on_main(app, move |_| windows.iter().map(in_fullscreen).collect()).unwrap_or_else(|_| vec![false; count])
}

/// The standard title bar height for `window`'s style, without a tab bar.
pub unsafe fn titlebar_height(window: &NSWindow, mtm: MainThreadMarker) -> f64 {
    let content = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(100.0, 100.0));
    let style = window.styleMask() & !NSWindowStyleMask::FullSizeContentView & !NSWindowStyleMask::FullScreen;
    NSWindow::frameRectForContentRect_styleMask(content, style, mtm).size.height - 100.0
}
