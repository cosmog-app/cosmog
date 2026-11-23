//! Plugin management commands. Phase 1: list, enable, remove, and dev-load (debug builds).

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::plugins::{InstalledPlugin, PluginRegistry};
use crate::state::AppState;

#[tracing::instrument(skip_all, err)]
#[tauri::command]
pub async fn plugin_list(registry: State<'_, PluginRegistry>) -> AppResult<Vec<InstalledPlugin>> {
    Ok(registry.list())
}

#[tracing::instrument(skip_all, err)]
#[tauri::command]
pub async fn plugin_set_enabled(
    state: State<'_, AppState>,
    registry: State<'_, PluginRegistry>,
    id: String,
    enabled: bool,
) -> AppResult<()> {
    if !state.db.plugin_set_enabled(&id, enabled).await? {
        return Err(AppError::NotFound(format!("plugin {id}")));
    }
    registry.reload(&state.db).await
}

#[tracing::instrument(skip_all, err)]
#[tauri::command]
pub async fn plugin_remove(
    state: State<'_, AppState>,
    registry: State<'_, PluginRegistry>,
    id: String,
) -> AppResult<()> {
    let _guard = crate::plugins::INSTALL_LOCK.lock().await;
    crate::plugins::dev::remove(&state.db, &registry, &id).await
}

#[cfg(debug_assertions)]
#[tracing::instrument(skip_all, err)]
#[tauri::command]
pub async fn plugin_dev_load(
    state: State<'_, AppState>,
    registry: State<'_, PluginRegistry>,
    path: String,
) -> AppResult<InstalledPlugin> {
    let _guard = crate::plugins::INSTALL_LOCK.lock().await;
    let m = crate::plugins::dev::load_unpacked(
        &state.db,
        &registry,
        std::path::Path::new(&path),
        env!("CARGO_PKG_VERSION"),
    )
    .await?;
    registry.get(&m.id).ok_or_else(|| AppError::Internal("plugin vanished after load".into()))
}
