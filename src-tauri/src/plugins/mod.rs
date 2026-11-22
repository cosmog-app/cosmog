//! Runtime plugins: signed web bundles run in a sandboxed iframe. See docs/PLUGINS.md.
//! The registry is the in-memory view of enabled, platform-compatible installs that the
//! scheme handler serves from; SQLite (`plugins` table) is the source of truth.

pub mod dev;
pub mod docs;
pub mod manifest;
pub mod scheme;
#[cfg(not(target_os = "android"))]
pub mod store;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use serde::Serialize;

use crate::db::plugins::PluginRow;
use crate::db::Db;
use crate::error::AppResult;
use manifest::{Manifest, Platform};

#[derive(Debug, Clone, Serialize)]
pub struct InstalledPlugin {
    pub id: String,
    pub version: String,
    pub source: String,
    pub enabled: bool,
    pub installed_at: i64,
    pub manifest: Manifest,
    /// False when the package is for another platform or its files are gone; never served.
    pub compatible: bool,
    /// The manifest icon as a data URI, so the host page can show it without the plugin scheme.
    pub icon: Option<String>,
}

const MAX_ICON_BYTES: u64 = 128 * 1024;

fn icon_data_uri(dir: &Path, rel: &str) -> Option<String> {
    use base64::Engine;
    let mime = if rel.ends_with(".svg") { "image/svg+xml" } else { "image/png" };
    let path = dir.join(rel);
    let meta = std::fs::symlink_metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > MAX_ICON_BYTES {
        return None;
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(std::fs::read(path).ok()?);
    Some(format!("data:{mime};base64,{b64}"))
}

/// Cheap to clone. Managed by Tauri on its own so the scheme handler can serve before AppState exists.
#[derive(Clone)]
pub struct PluginRegistry {
    root: PathBuf,
    inner: Arc<RwLock<HashMap<String, InstalledPlugin>>>,
}

pub fn plugin_dir(root: &Path, id: &str, version: &str) -> PathBuf {
    root.join(id).join(version)
}

const STAGING_PREFIX: &str = ".staging-";

/// An install's temp dir under the plugin root; removed on drop unless `keep` was called.
pub(crate) struct Staging {
    path: PathBuf,
    armed: bool,
}

impl Staging {
    pub fn new(root: &Path) -> Self {
        Self { path: root.join(format!("{STAGING_PREFIX}{}", uuid::Uuid::new_v4())), armed: true }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The dir was moved into place; nothing to clean up.
    pub fn keep(mut self) {
        self.armed = false;
    }
}

impl Drop for Staging {
    fn drop(&mut self) {
        if self.armed {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}

impl PluginRegistry {
    pub fn new(root: PathBuf) -> Self {
        Self { root, inner: Arc::new(RwLock::new(HashMap::new())) }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Staging dirs left by a crash mid-install. Startup only: a running install owns its own.
    pub async fn sweep_staging(&self) {
        let Ok(mut rd) = tokio::fs::read_dir(&self.root).await else { return };
        while let Ok(Some(e)) = rd.next_entry().await {
            if e.file_name().to_string_lossy().starts_with(STAGING_PREFIX) {
                let _ = tokio::fs::remove_dir_all(e.path()).await;
            }
        }
    }

    /// `<app_data>/plugin_drafts`, next to the install root.
    pub fn drafts_root(&self) -> PathBuf {
        self.root.parent().unwrap_or(&self.root).join("plugin_drafts")
    }

    pub fn get(&self, id: &str) -> Option<InstalledPlugin> {
        self.inner.read().ok()?.get(id).cloned()
    }

    pub fn list(&self) -> Vec<InstalledPlugin> {
        let mut v: Vec<_> = self.inner.read().map(|m| m.values().cloned().collect()).unwrap_or_default();
        v.sort_by_key(|p| p.manifest.name.to_lowercase());
        v
    }

    /// Rebuilds from the DB. A row whose manifest no longer parses is skipped with a warning.
    pub async fn reload(&self, db: &Db) -> AppResult<()> {
        let rows = db.plugins_list().await?;
        let mut map = HashMap::new();
        for row in rows {
            match self.build(&row) {
                Ok(p) => {
                    map.insert(p.id.clone(), p);
                }
                Err(e) => tracing::warn!("plugin {} skipped: {e}", row.id),
            }
        }
        if let Ok(mut m) = self.inner.write() {
            *m = map;
        }
        Ok(())
    }

    fn build(&self, row: &PluginRow) -> AppResult<InstalledPlugin> {
        let manifest = Manifest::parse(&row.manifest_json)?;
        let dir = plugin_dir(&self.root, &row.id, &row.version);
        let on_disk = dir.join(&manifest.entry).is_file();
        let icon = manifest.icon.as_deref().and_then(|rel| icon_data_uri(&dir, rel));
        let platform_ok = manifest.supports(Platform::current());
        if !on_disk {
            tracing::warn!("plugin {} {}: files missing, not served", row.id, row.version);
        }
        if !platform_ok {
            tracing::info!("plugin {} is not for this platform, not served", row.id);
        }
        Ok(InstalledPlugin {
            id: row.id.clone(),
            version: row.version.clone(),
            source: row.source.clone(),
            enabled: row.enabled,
            installed_at: row.installed_at,
            manifest,
            compatible: on_disk && platform_ok,
            icon,
        })
    }
}
