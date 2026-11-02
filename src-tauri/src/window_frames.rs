//! macOS: keeps each window's last frame outside fullscreen and writes it over the size and
//! position tauri-plugin-window-state saved. The plugin records every resize, fullscreen included,
//! so a window that quit in fullscreen reopened screen-sized and stayed so after leaving fullscreen.
use serde_json::Value;
use std::collections::HashMap;

/// Outer position and inner size in physical pixels, as window-state saves them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Frame {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// The states in which a window does not show its normal frame.
#[derive(Clone, Copy, Debug, Default)]
pub struct Mode {
    /// In a fullscreen Space, itself or as a tab of a fullscreen group.
    pub fullscreen: bool,
    /// Entering or leaving fullscreen.
    pub transition: bool,
    pub minimized: bool,
    /// window-state keeps the size from before the window was zoomed.
    pub maximized: bool,
}

/// The frame to keep for a window after seeing `live`: only a window in none of [`Mode`]'s states
/// (and not zero-sized, which window-state also skips) shows its normal frame.
pub fn remember(current: Option<Frame>, live: Frame, mode: Mode) -> Option<Frame> {
    let normal =
        !(mode.fullscreen || mode.transition || mode.minimized || mode.maximized) && live.width > 0 && live.height > 0;
    if normal { Some(live) } else { current }
}

/// The frames in window-state's file, by label: the normal frames it restored this launch.
pub fn saved(state: &Value) -> HashMap<String, Frame> {
    let Some(windows) = state.as_object() else { return HashMap::new() };
    windows
        .iter()
        .filter_map(|(label, s)| {
            let int = |key: &str| s.get(key).and_then(Value::as_i64);
            let frame = Frame {
                x: int("x")?.try_into().ok()?,
                y: int("y")?.try_into().ok()?,
                width: int("width")?.try_into().ok()?,
                height: int("height")?.try_into().ok()?,
            };
            (frame.width > 0 && frame.height > 0).then(|| (label.clone(), frame))
        })
        .collect()
}

/// Writes `frames` over the size and position of the windows window-state saved; other fields and
/// labels without a frame are kept. `prev_x` / `prev_y` (where a zoomed window is restored) take
/// the same position, since a frame is only kept while the window is not zoomed.
pub fn patch(state: &mut Value, frames: &HashMap<String, Frame>) {
    let Some(windows) = state.as_object_mut() else { return };
    for (label, s) in windows.iter_mut() {
        let (Some(frame), Some(s)) = (frames.get(label), s.as_object_mut()) else { continue };
        s.insert("width".into(), frame.width.into());
        s.insert("height".into(), frame.height.into());
        for (key, value) in [("x", frame.x), ("prev_x", frame.x), ("y", frame.y), ("prev_y", frame.y)] {
            s.insert(key.into(), value.into());
        }
    }
}

#[cfg(target_os = "macos")]
mod runtime {
    use super::*;
    use parking_lot::Mutex;
    use std::path::PathBuf;
    use tauri::{AppHandle, Manager, RunEvent, WindowEvent, plugin::TauriPlugin};

    const FILE: &str = tauri_plugin_window_state::DEFAULT_FILENAME;

    /// Last normal frame by window-state label, kept for closed windows too: window-state keeps
    /// their state until it saves at exit.
    struct Frames(Mutex<HashMap<String, Frame>>);

    /// window-state's label (`map_label` in lib.rs).
    fn key(label: &str) -> &str {
        if crate::windows::is_settings_window(label) { "settings" } else { label }
    }

    fn path(app: &AppHandle) -> Option<PathBuf> {
        app.path().app_config_dir().ok().map(|dir| dir.join(FILE))
    }

    fn read(path: &std::path::Path) -> Option<Value> {
        std::fs::read(path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok())
    }

    /// Main thread (window and run events).
    fn sample(app: &AppHandle, label: &str) {
        let Some(window) = app.get_webview_window(label) else { return };
        let (Ok(size), Ok(position)) = (window.inner_size(), window.outer_position()) else { return };
        let live = Frame { x: position.x, y: position.y, width: size.width, height: size.height };
        let mode = Mode {
            fullscreen: crate::macos::in_fullscreen(&window),
            transition: crate::macos::group_in_fullscreen_transition(&window),
            minimized: window.is_minimized().unwrap_or(true),
            maximized: window.is_maximized().unwrap_or(true),
        };
        let frames = app.state::<Frames>();
        let mut frames = frames.0.lock();
        let key = key(label);
        if let Some(frame) = remember(frames.get(key).copied(), live, mode) {
            frames.insert(key.to_owned(), frame);
        }
    }

    /// After window-state has saved its file at exit (it is registered first).
    fn persist(app: &AppHandle) {
        let Some(path) = path(app) else { return };
        let Some(mut state) = read(&path) else { return };
        patch(&mut state, &app.state::<Frames>().0.lock());
        let written = serde_json::to_vec_pretty(&state)
            .map_err(|e| ide_core::IdeError::internal(e.to_string()))
            .and_then(|bytes| ide_vfs::write_atomic(&path, &bytes));
        if let Err(e) = written {
            tracing::warn!("cannot save window frames: {}", e.message);
        }
    }

    /// Register right after window-state: plugins see run events in registration order.
    pub fn plugin() -> TauriPlugin<tauri::Wry> {
        tauri::plugin::Builder::new("window-frames")
            .setup(|app, _| {
                // A window that never shows its normal frame this launch (reopened in fullscreen,
                // or a tab joining a fullscreen group) keeps the one it was restored with.
                let frames = path(app).as_deref().and_then(read).map(|s| saved(&s)).unwrap_or_default();
                app.manage(Frames(Mutex::new(frames)));
                Ok(())
            })
            .on_window_ready(|window| {
                let app = window.app_handle().clone();
                let label = window.label().to_owned();
                window.on_window_event(move |event| {
                    if matches!(
                        event,
                        WindowEvent::Moved(_) | WindowEvent::Resized(_) | WindowEvent::CloseRequested { .. }
                    ) {
                        sample(&app, &label);
                    }
                });
            })
            .on_event(|app, event| {
                if let RunEvent::Exit = event {
                    for label in app.webview_windows().keys() {
                        sample(app, label);
                    }
                    persist(app);
                }
            })
            .build()
    }
}

#[cfg(target_os = "macos")]
pub use runtime::plugin;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NORMAL: Frame = Frame { x: 100, y: 80, width: 1200, height: 800 };
    const SCREEN: Frame = Frame { x: 0, y: 0, width: 3024, height: 1964 };

    #[test]
    fn remembers_only_normal_frames() {
        assert_eq!(remember(None, NORMAL, Mode::default()), Some(NORMAL));
        assert_eq!(remember(Some(NORMAL), SCREEN, Mode { fullscreen: true, ..Default::default() }), Some(NORMAL));
        assert_eq!(remember(Some(NORMAL), SCREEN, Mode { transition: true, ..Default::default() }), Some(NORMAL));
        assert_eq!(remember(Some(NORMAL), SCREEN, Mode { minimized: true, ..Default::default() }), Some(NORMAL));
        assert_eq!(remember(Some(NORMAL), SCREEN, Mode { maximized: true, ..Default::default() }), Some(NORMAL));
        assert_eq!(remember(None, SCREEN, Mode { fullscreen: true, ..Default::default() }), None);
        assert_eq!(remember(Some(NORMAL), Frame { width: 0, ..SCREEN }, Mode::default()), Some(NORMAL));
        let moved = Frame { x: 300, ..NORMAL };
        assert_eq!(remember(Some(NORMAL), moved, Mode::default()), Some(moved));
    }

    fn state() -> Value {
        json!({
            "main": { "width": 3024, "height": 1964, "x": 0, "y": 0, "prev_x": 0, "prev_y": 0,
                      "maximized": false, "visible": true, "decorated": true, "fullscreen": false },
            "window-2": { "width": 900, "height": 600, "x": 40, "y": 40, "prev_x": 10, "prev_y": 10,
                          "maximized": true, "visible": true, "decorated": true, "fullscreen": false },
            "settings": { "width": 0, "height": 0, "x": 0, "y": 0, "prev_x": 0, "prev_y": 0,
                          "maximized": false, "visible": true, "decorated": true, "fullscreen": false }
        })
    }

    #[test]
    fn reads_saved_frames() {
        let frames = saved(&state());
        assert_eq!(frames.get("main"), Some(&SCREEN));
        assert_eq!(frames.get("window-2"), Some(&Frame { x: 40, y: 40, width: 900, height: 600 }));
        assert_eq!(frames.get("settings"), None);
        assert!(saved(&json!(null)).is_empty());
    }

    #[test]
    fn patches_only_known_frames() {
        let mut state = state();
        let frames = HashMap::from([("main".to_owned(), NORMAL), ("window-9".to_owned(), NORMAL)]);
        patch(&mut state, &frames);
        assert_eq!(
            state["main"],
            json!({ "width": 1200, "height": 800, "x": 100, "y": 80, "prev_x": 100, "prev_y": 80,
                    "maximized": false, "visible": true, "decorated": true, "fullscreen": false })
        );
        assert_eq!(state["window-2"], self::state()["window-2"]);
        assert_eq!(state.get("window-9"), None);
    }
}
