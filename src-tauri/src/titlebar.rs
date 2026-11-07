//! Size the native title bar around the window buttons to match the web toolbar.
//!
//! An empty unified toolbar makes AppKit lay out and vertically centre the buttons itself, so
//! nothing moves them behind its back and they stay still during live resize.

use std::sync::OnceLock;

use objc2::MainThreadMarker;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::sel;
use objc2_app_kit::{NSApplicationPresentationOptions, NSToolbar, NSWindow, NSWindowToolbarStyle};

/// Unified compact (38pt) and unified (52pt) toolbars; pick the one closer to the web bar.
const COMPACT_MAX_HEIGHT: f64 = 45.0;

pub fn set_height(window: &tauri::WebviewWindow, height: f64) -> tauri::Result<()> {
    // with_webview runs on the AppKit thread.
    window.with_webview(move |webview| unsafe {
        let Some(mtm) = MainThreadMarker::new() else { return };
        auto_hide_toolbar_in_fullscreen();
        let native = &*webview.ns_window().cast::<NSWindow>();
        if native.toolbar().is_none() {
            let toolbar = NSToolbar::new(mtm);
            native.setToolbar(Some(&toolbar));
        }
        let style = if height < COMPACT_MAX_HEIGHT {
            NSWindowToolbarStyle::UnifiedCompact
        } else {
            NSWindowToolbarStyle::Unified
        };
        if native.toolbarStyle() != style {
            native.setToolbarStyle(style);
        }
    })
}

type PresentationOptions = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject, usize) -> usize;

/// tao's `window:willUseFullScreenPresentationOptions:`, called by the replacement.
static PRESENTATION_OPTIONS: OnceLock<Option<PresentationOptions>> = OnceLock::new();

/// In a fullscreen Space AppKit moves the toolbar into a window of its own that stays at the top of
/// the screen, over the page's toolbar, and takes its clicks. Auto-hiding it (with the menu bar,
/// when the pointer reaches the top edge) leaves the page's toolbar at the top, as without a
/// native toolbar. This applies to the whole Space, so it also covers the other tabs of a
/// fullscreen window group. tao's window delegate already answers the delegate method, so its
/// implementation is wrapped rather than added.
fn auto_hide_toolbar_in_fullscreen() {
    PRESENTATION_OPTIONS.get_or_init(|| {
        let sel = sel!(window:willUseFullScreenPresentationOptions:);
        let Some(method) = AnyClass::get(c"TaoWindowDelegate").and_then(|class| class.instance_method(sel)) else {
            tracing::warn!("cannot auto-hide the toolbar in fullscreen: TaoWindowDelegate {sel:?} not found");
            return None;
        };
        let replacement: PresentationOptions = presentation_options;
        // SAFETY: the method takes two object arguments and an NSUInteger and returns an
        // NSUInteger, matching `PresentationOptions`; it is swapped once, on the main thread.
        unsafe {
            let original = method.set_implementation(std::mem::transmute::<PresentationOptions, Imp>(replacement));
            Some(std::mem::transmute::<Imp, PresentationOptions>(original))
        }
    });
}

unsafe extern "C-unwind" fn presentation_options(
    this: *mut AnyObject,
    sel: Sel,
    window: *mut AnyObject,
    proposed: usize,
) -> usize {
    let Some(Some(original)) = PRESENTATION_OPTIONS.get() else { return proposed };
    let options = NSApplicationPresentationOptions(unsafe { original(this, sel, window, proposed) });
    // AutoHideToolbar is only valid together with FullScreen and AutoHideMenuBar.
    let required = NSApplicationPresentationOptions::FullScreen | NSApplicationPresentationOptions::AutoHideMenuBar;
    if options.contains(required) { (options | NSApplicationPresentationOptions::AutoHideToolbar).0 } else { options.0 }
}
