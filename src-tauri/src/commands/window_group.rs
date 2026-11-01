use crate::{window_groups as groups, windows::WindowsState};
use ide_core::{IdeError, IdeResult};
use tauri::{Manager, WebviewWindow};

#[tauri::command]
#[specta::specta]
pub fn window_group_current(window: WebviewWindow) -> IdeResult<Vec<groups::WindowTab>> {
    Ok(groups::current(window.app_handle(), window.label()))
}

#[tauri::command]
#[specta::specta]
pub async fn window_group_merge(window: WebviewWindow) -> IdeResult<()> {
    groups::merge(window.app_handle(), window.label())?;
    groups::persist(window.app_handle()).await
}

#[tauri::command]
#[specta::specta]
pub async fn window_group_select(window: WebviewWindow, label: String) -> IdeResult<()> {
    groups::select(window.app_handle(), window.label(), &label)?;
    groups::persist(window.app_handle()).await
}

#[tauri::command]
#[specta::specta]
pub async fn window_group_detach(window: WebviewWindow) -> IdeResult<()> {
    groups::detach(window.app_handle(), window.label())?;
    groups::persist(window.app_handle()).await
}

#[tauri::command]
#[specta::specta]
pub fn window_group_close(window: WebviewWindow, label: String) -> IdeResult<()> {
    groups::select(window.app_handle(), window.label(), &label)?;
    window
        .app_handle()
        .get_webview_window(&label)
        .ok_or_else(|| IdeError::not_found("Window closed"))?
        .close()
        .map_err(|e| IdeError::internal(e.to_string()))
}

#[tauri::command]
#[specta::specta]
pub async fn window_group_reorder(window: WebviewWindow, labels: Vec<String>) -> IdeResult<()> {
    window.state::<WindowsState>().groups.lock().reorder(window.label(), labels)?;
    groups::select(window.app_handle(), window.label(), window.label())?;
    groups::persist(window.app_handle()).await
}

#[tauri::command]
#[specta::specta]
pub async fn window_group_restore(window: WebviewWindow) -> IdeResult<()> {
    groups::restore(window.app_handle(), window.label()).await?;
    // The window's project is open now: name its system tab after it.
    #[cfg(target_os = "macos")]
    groups::sync(window.app_handle());
    Ok(())
}

/// The system tab bar over this window's page (macOS window tabs).
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SystemTabBar {
    /// In points; 0 without a tab bar.
    pub height: f64,
    /// At the top of the window (fullscreen) instead of below the title bar.
    pub top: bool,
}

#[tauri::command]
#[specta::specta]
pub fn window_group_tab_bar(window: WebviewWindow) -> IdeResult<SystemTabBar> {
    #[cfg(target_os = "macos")]
    {
        let (height, top) = crate::macos::tab_bar(window.app_handle(), &window)?;
        Ok(SystemTabBar { height, top })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Ok(SystemTabBar { height: 0.0, top: false })
    }
}
