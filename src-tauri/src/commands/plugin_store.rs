//! Plugin store commands (Phase 3, desktop): catalog and signed install.

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::error::{AppError, AppResult};
use crate::plugins::store::{index, install};
use crate::plugins::{InstalledPlugin, PluginRegistry};
use crate::state::AppState;

/// One install at a time: two would race on the same plugin dir.
static INSTALL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tracing::instrument(skip_all, err)]
#[tauri::command]
pub async fn plugin_store_list() -> AppResult<Vec<index::StoreEntry>> {
    index::fetch().await
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    id: &'a str,
    done: u64,
    total: Option<u64>,
}

/// Installs or updates `id` to the version the catalog lists now. The catalog is fetched here,
/// not passed in, so the frontend can't point an install at another package.
#[tracing::instrument(skip_all, fields(id = %id), err)]
#[tauri::command]
pub async fn plugin_install(
    app: AppHandle,
    state: State<'_, AppState>,
    registry: State<'_, PluginRegistry>,
    id: String,
) -> AppResult<InstalledPlugin> {
    let _guard = INSTALL_LOCK.lock().await;
    let entry = index::fetch()
        .await?
        .into_iter()
        .find(|e| e.id == id)
        .ok_or_else(|| AppError::NotFound(format!("plugin {id} is not in the store")))?;
    // Whole percents only: a 20 MB package arrives in over a thousand chunks.
    let mut last_pct = u64::MAX;
    let progress = |done: u64, total: Option<u64>| {
        let pct = total.filter(|t| *t > 0).map(|t| done * 100 / t).unwrap_or(0);
        if pct != last_pct {
            last_pct = pct;
            let _ = app.emit("plugin-install-progress", Progress { id: &id, done, total });
        }
    };
    install::install(&state.db, &registry, &entry, env!("CARGO_PKG_VERSION"), progress).await?;
    registry.get(&id).ok_or_else(|| AppError::Internal("plugin vanished after install".into()))
}
