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

/// The frame to keep for a window that has none and is closing or quitting in fullscreen (it was
/// created in fullscreen or joined a fullscreen group before showing its normal frame); otherwise
/// window-state's screen-sized frame would stay. Its tab mates share its frame outside fullscreen,
/// so one of theirs is taken, else `default`. A minimized or zoomed window keeps window-state's
/// own frame, which is not updated in those states.
pub fn fallback(
    mode: Mode,
    mates: impl IntoIterator<Item = Frame>,
    default: impl FnOnce() -> Option<Frame>,
) -> Option<Frame> {
    if !(mode.fullscreen || mode.transition) {
        return None;
    }
    mates.into_iter().next().or_else(default)
}

/// The frame to give a window that has just been created with `live` (after window-state restored
/// it), when its label already has `known`. window-state keeps a closed window's state in memory and
/// updates it on close, so a label reused in the same launch (a closed project-N, settings) is
/// restored to the frame it had when closed, the screen if it was fullscreen; the normal frame kept
/// here wins. A window window-state zoomed or made fullscreen keeps that. Like window-state, the
/// position is only applied when the frame is on one of `monitors`.
pub fn reapply(
    known: Option<Frame>,
    live: Frame,
    mode: Mode,
    monitors: impl IntoIterator<Item = Frame>,
) -> Option<Frame> {
    let known = known.filter(|known| *known != live)?;
    if mode.fullscreen || mode.transition || mode.minimized || mode.maximized {
        return None;
    }
    let overlaps = |m: &Frame| {
        let (left, top) = (i64::from(known.x), i64::from(known.y));
        let (right, bottom) = (left + i64::from(known.width), top + i64::from(known.height));
        let (m_left, m_top) = (i64::from(m.x), i64::from(m.y));
        left < m_left + i64::from(m.width) && m_left < right && top < m_top + i64::from(m.height) && m_top < bottom
    };
    if monitors.into_iter().any(|m| overlaps(&m)) { Some(known) } else { Some(Frame { x: live.x, y: live.y, ..known }) }
}

/// A `width`×`height` frame centred in `area`, no larger than it.
pub fn centred(width: u32, height: u32, area: Frame) -> Frame {
    let (width, height) = (width.min(area.width), height.min(area.height));
    let offset = |free: u32| i32::try_from(free / 2).unwrap_or(i32::MAX);
    Frame {
        x: area.x.saturating_add(offset(area.width - width)),
        y: area.y.saturating_add(offset(area.height - height)),
        width,
        height,
    }
}

/// The frames in window-state's file, by label: the normal frames it restored this launch. A
/// zoomed window's x / y is where it was zoomed to (window-state follows every move); it is
/// restored at prev_x / prev_y, with the size from before it was zoomed.
pub fn saved(state: &Value) -> HashMap<String, Frame> {
    let Some(windows) = state.as_object() else { return HashMap::new() };
    windows
        .iter()
        .filter_map(|(label, s)| {
            let int = |key: &str| s.get(key).and_then(Value::as_i64);
            let zoomed = s.get("maximized").and_then(Value::as_bool).unwrap_or(false);
            let (x, y) = if zoomed { ("prev_x", "prev_y") } else { ("x", "y") };
            let frame = Frame {
                x: int(x)?.try_into().ok()?,
                y: int(y)?.try_into().ok()?,
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
        crate::windows::state_key(label)
    }

    fn path(app: &AppHandle) -> Option<PathBuf> {
        app.path().app_config_dir().ok().map(|dir| dir.join(FILE))
    }

    fn read(path: &std::path::Path) -> Option<Value> {
        std::fs::read(path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok())
    }

    /// Main thread (window and run events). `last`: the window is closing or the app quitting, so
    /// a window without a normal frame yet takes a [`fallback`] one.
    fn sample(app: &AppHandle, label: &str, last: bool) {
        let Some(window) = app.get_webview_window(label) else { return };
        let (Ok(size), Ok(position)) = (window.inner_size(), window.outer_position()) else { return };
        let live = Frame { x: position.x, y: position.y, width: size.width, height: size.height };
        let mode = Mode {
            fullscreen: crate::macos::in_fullscreen(&window),
            transition: crate::macos::group_in_fullscreen_transition(&window),
            minimized: window.is_minimized().unwrap_or(true),
            maximized: window.is_maximized().unwrap_or(true),
        };
        let mates = if last { crate::macos::tab_mates(app, &window) } else { Vec::new() };
        let frames = app.state::<Frames>();
        let mut frames = frames.0.lock();
        let key = key(label);
        let mut frame = remember(frames.get(key).copied(), live, mode);
        if last && frame.is_none() {
            let mates = mates.iter().filter_map(|mate| frames.get(self::key(mate)).copied());
            frame = fallback(mode, mates, || default_frame(app, &window));
        }
        if let Some(frame) = frame {
            frames.insert(key.to_owned(), frame);
        }
    }

    /// The configured size of a new window, centred in the work area of `window`'s display.
    fn default_frame(app: &AppHandle, window: &tauri::WebviewWindow) -> Option<Frame> {
        let config = crate::windows::window_config(app).ok()?;
        let monitor = window.current_monitor().ok().flatten().or_else(|| window.primary_monitor().ok().flatten())?;
        let size = tauri::LogicalSize::new(config.width, config.height).to_physical::<u32>(monitor.scale_factor());
        let area = monitor.work_area();
        let area = Frame { x: area.position.x, y: area.position.y, width: area.size.width, height: area.size.height };
        Some(centred(size.width, size.height, area))
    }

    /// Main thread, right after window-state restored `window` (it is registered first): see
    /// [`reapply`]. Called from window-ready, before the webview is attached, so it works on the
    /// `Window`; the window is not in a fullscreen Space or a tab group yet.
    fn restore(app: &AppHandle, window: &tauri::Window) {
        let Some(known) = app.state::<Frames>().0.lock().get(key(window.label())).copied() else { return };
        let (Ok(size), Ok(position)) = (window.inner_size(), window.outer_position()) else { return };
        let live = Frame { x: position.x, y: position.y, width: size.width, height: size.height };
        let mode = Mode {
            fullscreen: window.is_fullscreen().unwrap_or(true),
            transition: false,
            minimized: window.is_minimized().unwrap_or(true),
            maximized: window.is_maximized().unwrap_or(true),
        };
        let monitors = window.available_monitors().unwrap_or_default().into_iter().map(|m| {
            let (position, size) = (m.position(), m.size());
            Frame { x: position.x, y: position.y, width: size.width, height: size.height }
        });
        let Some(frame) = reapply(Some(known), live, mode, monitors) else { return };
        let _ = window.set_size(tauri::PhysicalSize::new(frame.width, frame.height));
        let _ = window.set_position(tauri::PhysicalPosition::new(frame.x, frame.y));
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
                restore(&app, &window);
                window.on_window_event(move |event| match event {
                    WindowEvent::Moved(_) | WindowEvent::Resized(_) => sample(&app, &label, false),
                    WindowEvent::CloseRequested { .. } => sample(&app, &label, true),
                    _ => {}
                });
            })
            .on_event(|app, event| {
                if let RunEvent::Exit = event {
                    for label in app.webview_windows().keys() {
                        sample(app, label, true);
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

    #[test]
    fn a_window_never_seen_outside_fullscreen_takes_a_mates_or_the_default_frame() {
        let fullscreen = Mode { fullscreen: true, ..Default::default() };
        let mate = Frame { x: 300, ..NORMAL };
        assert_eq!(fallback(fullscreen, [mate], || Some(NORMAL)), Some(mate));
        assert_eq!(fallback(fullscreen, [], || Some(NORMAL)), Some(NORMAL));
        assert_eq!(fallback(Mode { transition: true, ..Default::default() }, [], || Some(NORMAL)), Some(NORMAL));
        assert_eq!(fallback(fullscreen, [], || None), None);
        // window-state does not save the frame of a minimized or zoomed window.
        assert_eq!(fallback(Mode { minimized: true, ..Default::default() }, [mate], || Some(NORMAL)), None);
        assert_eq!(fallback(Mode { maximized: true, ..Default::default() }, [mate], || Some(NORMAL)), None);
    }

    #[test]
    fn a_reused_label_gets_its_normal_frame_back_over_window_states_stale_one() {
        let display = [Frame { x: 0, y: 0, width: 3024, height: 1964 }];
        // Closed in fullscreen, reopened: window-state restored the screen frame.
        assert_eq!(reapply(Some(NORMAL), SCREEN, Mode::default(), display), Some(NORMAL));
        // Nothing to fix: no frame yet, or window-state restored the same one (first window of a launch).
        assert_eq!(reapply(None, SCREEN, Mode::default(), display), None);
        assert_eq!(reapply(Some(NORMAL), NORMAL, Mode::default(), display), None);
        // window-state zoomed it, or it is already fullscreen / minimized / changing Space.
        for mode in [
            Mode { maximized: true, ..Default::default() },
            Mode { fullscreen: true, ..Default::default() },
            Mode { transition: true, ..Default::default() },
            Mode { minimized: true, ..Default::default() },
        ] {
            assert_eq!(reapply(Some(NORMAL), SCREEN, mode, display), None);
        }
        // Its display is gone: the size still applies, the OS-chosen position stays.
        let elsewhere = Frame { x: 5000, ..NORMAL };
        assert_eq!(reapply(Some(elsewhere), SCREEN, Mode::default(), display), Some(Frame { x: 0, y: 0, ..NORMAL }));
        assert_eq!(reapply(Some(NORMAL), SCREEN, Mode::default(), []), Some(Frame { x: 0, y: 0, ..NORMAL }));
        // Partly on a display counts, like window-state.
        let edge = Frame { x: 3000, ..NORMAL };
        assert_eq!(reapply(Some(edge), SCREEN, Mode::default(), display), Some(edge));
    }

    #[test]
    fn centres_the_default_size_in_the_work_area() {
        let area = Frame { x: 0, y: 50, width: 3024, height: 1900 };
        assert_eq!(centred(2880, 1800, area), Frame { x: 72, y: 100, width: 2880, height: 1800 });
        assert_eq!(centred(4000, 2000, area), area);
        let right = Frame { x: 3024, y: -200, width: 1920, height: 1080 };
        assert_eq!(centred(1440, 900, right), Frame { x: 3264, y: -110, width: 1440, height: 900 });
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
        // Zoomed: x / y is where it was zoomed to, prev_x / prev_y where it is restored.
        assert_eq!(frames.get("window-2"), Some(&Frame { x: 10, y: 10, width: 900, height: 600 }));
        assert_eq!(frames.get("settings"), None);
        assert!(saved(&json!(null)).is_empty());
    }

    #[test]
    fn keeps_a_zoomed_windows_restore_position() {
        let mut state = state();
        let frames = saved(&state);
        patch(&mut state, &frames);
        assert_eq!((state["window-2"]["prev_x"].as_i64(), state["window-2"]["prev_y"].as_i64()), (Some(10), Some(10)));
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
