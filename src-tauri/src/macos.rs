//! macOS window tab preferences, applied to application-drawn project tabs.
use crate::windows::{Launch, WindowsState};
use ide_core::{IdeError, IdeResult};
use ide_workspace::window_groups::{TabbingPreference, should_group_new_project};
use objc2::{
    MainThreadMarker,
    rc::Retained,
    runtime::{AnyClass, AnyObject, Imp, ProtocolObject, Sel},
};
use objc2_app_kit::{NSWindow, NSWindowAnimationBehavior, NSWindowUserTabbingPreference};
use objc2_foundation::{NSNotificationCenter, NSObjectProtocol};
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
        host.project(w.label()).is_ok_and(|p| !p.light) || host.remote_dev.get(w.label()).is_some()
    });
    let fullscreen = active.as_ref().is_some_and(|w| w.is_fullscreen().unwrap_or(false));
    let light_edit = launch.project.is_none() && launch.remote.is_none();
    Ok(should_group_new_project(tabbing_preference(app)?, fullscreen, active.is_some(), light_edit)
        .then_some(active)
        .flatten())
}

struct FullscreenObserver(Retained<ProtocolObject<dyn NSObjectProtocol>>);

impl Drop for FullscreenObserver {
    fn drop(&mut self) {
        let observer: &ProtocolObject<dyn NSObjectProtocol> = &self.0;
        unsafe { NSNotificationCenter::defaultCenter().removeObserver(observer.as_ref()) };
    }
}

thread_local! {
    static FULLSCREEN_TRANSFERS: std::cell::RefCell<std::collections::HashMap<String, FullscreenObserver>> = std::cell::RefCell::default();
}

pub fn forget_fullscreen(label: &str) {
    FULLSCREEN_TRANSFERS.with_borrow_mut(|observers| observers.remove(label));
}

/// AppKit cannot enter another window's fullscreen Space until the old one has exited.
pub fn transfer_fullscreen(from: &WebviewWindow, to: &WebviewWindow) -> tauri::Result<()> {
    let source = from.label().to_owned();
    let to = to.clone();
    from.with_webview(move |webview| unsafe {
        let native = &*webview.ns_window().cast::<NSWindow>();
        forget_fullscreen(&source);
        let label = source.clone();
        let block = block2::RcBlock::new(move |_| {
            forget_fullscreen(&label);
            let app = to.app_handle();
            let selected = app.state::<WindowsState>().groups.lock().group(to.label()).map(|g| g.selected.clone());
            if let Some(selected) = selected {
                // Exiting fullscreen can show the old window again; reapply group visibility.
                let _ = crate::window_groups::select(app, &selected, &selected);
                if selected == to.label() {
                    let _ = to.set_fullscreen(true);
                }
            }
        });
        let observer = NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(objc2_app_kit::NSWindowDidExitFullScreenNotification),
            Some(native),
            None,
            &block,
        );
        FULLSCREEN_TRANSFERS.with_borrow_mut(|observers| observers.insert(source, FullscreenObserver(observer)));
        native.toggleFullScreen(None);
    })
}

type ShouldTerminate = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize;

/// `NSApplicationTerminateReply`.
const TERMINATE_CANCEL: usize = 0;
const TERMINATE_NOW: usize = 1;

/// The Dock's Quit, the system's app menu and a logout ask the application delegate whether it
/// may terminate; tao's delegate doesn't answer, so AppKit terminated at once, past the exit,
/// running-process and unsaved-changes prompts. Answer it: cancel, and quit like Cmd+Q does.
pub fn intercept_system_quit(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let Some(mtm) = MainThreadMarker::new() else { return };
    let application = objc2_app_kit::NSApplication::sharedApplication(mtm);
    unsafe {
        let delegate: *mut AnyObject = objc2::msg_send![&*application, delegate];
        if delegate.is_null() {
            return;
        }
        let class = objc2::ffi::object_getClass(delegate.cast()) as *mut AnyClass;
        let imp: Imp = std::mem::transmute(should_terminate as ShouldTerminate);
        let added = objc2::ffi::class_addMethod(class, objc2::sel!(applicationShouldTerminate:), imp, c"Q@:@".as_ptr());
        if !added.as_bool() {
            tracing::warn!("could not handle applicationShouldTerminate:");
        }
    }
}

unsafe extern "C-unwind" fn should_terminate(_this: *mut AnyObject, _selector: Sel, _sender: *mut AnyObject) -> usize {
    let Some(app) = APP.get() else { return TERMINATE_NOW };
    // Our own quit exits through the event loop; a system quit during it goes ahead.
    if app.try_state::<WindowsState>().is_none_or(|w| w.quitting()) {
        return TERMINATE_NOW;
    }
    crate::dispatch_menu_action(app, "app.quit");
    TERMINATE_CANCEL
}

static APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

/// Copies `from`'s frame onto `to`. `setFrame:display:animate:` finishes before it returns;
/// tao's position and size setters only schedule the change.
pub fn copy_window_frame(from: &WebviewWindow, to: &WebviewWindow) -> tauri::Result<()> {
    apply_window_frame(from, to, false)
}

/// Copies the frame and orders `to` front before AppKit can animate or constrain it.
/// A later `show` runs `constrainFrameRect:toScreen:` and slides a titled window into place.
pub fn present_window_frame(from: &WebviewWindow, to: &WebviewWindow) -> tauri::Result<()> {
    apply_window_frame(from, to, true)
}

fn apply_window_frame(from: &WebviewWindow, to: &WebviewWindow, show: bool) -> tauri::Result<()> {
    if MainThreadMarker::new().is_some() {
        return apply_window_frame_on_main(from, to, show);
    }
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let from = from.clone();
    let to = to.clone();
    to.clone().run_on_main_thread(move || {
        let _ = tx.send(apply_window_frame_on_main(&from, &to, show));
    })?;
    rx.recv().map_err(|error| tauri::Error::Io(std::io::Error::other(error.to_string())))?
}

fn apply_window_frame_on_main(from: &WebviewWindow, to: &WebviewWindow, show: bool) -> tauri::Result<()> {
    let source_pointer = from.ns_window()?;
    let target_pointer = to.ns_window()?;
    unsafe {
        let source = &*source_pointer.cast::<NSWindow>();
        let target = &*target_pointer.cast::<NSWindow>();
        let frame = source.frame();
        let current = target.frame();
        let differs = frame.origin.x != current.origin.x
            || frame.origin.y != current.origin.y
            || frame.size.width != current.size.width
            || frame.size.height != current.size.height;
        if !differs && !show {
            return Ok(());
        }
        // Zoom and ordering use the window's animation behavior. `animate: false` alone does not
        // stop a zoomed window from sliding to the new frame as it is shown.
        let behavior = target.animationBehavior();
        target.setAnimationBehavior(NSWindowAnimationBehavior::None);
        let result = (|| {
            if differs {
                target.setFrame_display_animate(frame, false, false);
            }
            if show {
                to.show()?;
                to.set_focus()?;
            }
            Ok(())
        })();
        target.setAnimationBehavior(behavior);
        result
    }
}

