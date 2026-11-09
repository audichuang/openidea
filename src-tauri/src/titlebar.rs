//! Size the native title bar around the window buttons to match the web toolbar.
//!
//! An empty unified toolbar makes AppKit lay out and vertically centre the buttons itself, so
//! nothing moves them behind its back and they stay still during live resize. A bar lower than
//! the compact toolbar (IDEA's 30px compact header) keeps the plain title bar instead.

use std::sync::OnceLock;

use objc2::MainThreadMarker;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::sel;
use objc2_app_kit::{NSApplicationPresentationOptions, NSToolbar, NSWindow, NSWindowToolbarStyle};

/// The native chrome around the window buttons: the plain title bar (28pt), or an empty unified
/// compact (38pt) or unified (52pt) toolbar.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Chrome {
    Plain,
    Toolbar(NSWindowToolbarStyle),
}

/// Midpoints between the 28, 38 and 52pt bars.
const PLAIN_MAX_HEIGHT: f64 = 33.0;
const COMPACT_MAX_HEIGHT: f64 = 45.0;

/// The chrome closest to the web bar, so the buttons sit on its centre line (IDEA's 30px compact
/// header takes the plain title bar).
fn chrome_for(height: f64) -> Chrome {
    if height < PLAIN_MAX_HEIGHT {
        Chrome::Plain
    } else if height < COMPACT_MAX_HEIGHT {
        Chrome::Toolbar(NSWindowToolbarStyle::UnifiedCompact)
    } else {
        Chrome::Toolbar(NSWindowToolbarStyle::Unified)
    }
}

pub fn set_height(window: &tauri::WebviewWindow, height: f64) -> tauri::Result<()> {
    // with_webview runs on the AppKit thread.
    window.with_webview(move |webview| unsafe {
        let Some(mtm) = MainThreadMarker::new() else { return };
        auto_hide_toolbar_in_fullscreen();
        let native = &*webview.ns_window().cast::<NSWindow>();
        match chrome_for(height) {
            Chrome::Plain => {
                if native.toolbar().is_some() {
                    native.setToolbar(None);
                }
            }
            Chrome::Toolbar(style) => {
                if native.toolbar().is_none() {
                    let toolbar = NSToolbar::new(mtm);
                    native.setToolbar(Some(&toolbar));
                }
                if native.toolbarStyle() != style {
                    native.setToolbarStyle(style);
                }
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chrome_is_the_closest_to_the_web_bar_height() {
        use NSWindowToolbarStyle as Style;
        for (height, expected) in [
            (28.0, Chrome::Plain),
            (30.0, Chrome::Plain),
            (32.0, Chrome::Plain),
            (32.9, Chrome::Plain),
            (33.0, Chrome::Toolbar(Style::UnifiedCompact)),
            (38.0, Chrome::Toolbar(Style::UnifiedCompact)),
            (40.0, Chrome::Toolbar(Style::UnifiedCompact)),
            (44.9, Chrome::Toolbar(Style::UnifiedCompact)),
            (45.0, Chrome::Toolbar(Style::Unified)),
            (52.0, Chrome::Toolbar(Style::Unified)),
            (120.0, Chrome::Toolbar(Style::Unified)),
        ] {
            assert_eq!(chrome_for(height), expected, "{height}");
        }
    }
}
