//! Size the native title bar around the window buttons to match the web toolbar.
//!
//! An empty unified toolbar makes AppKit lay out and vertically centre the buttons itself, so
//! nothing moves them behind its back and they stay still during live resize. A bar lower than
//! the compact toolbar (IDEA's 30px compact header) keeps the plain title bar instead.

use objc2::MainThreadMarker;
use objc2_app_kit::{NSToolbar, NSWindow, NSWindowToolbarStyle};

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
