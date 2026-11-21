//! Installed plugins. Files live under `<app_data>/plugins/<id>/<version>/`; this table is the
//! source of truth for what is installed and enabled.

use chrono::Utc;
use rusqlite::params;
use serde::Serialize;

use crate::error::AppResult;

use super::Db;

#[derive(Debug, Clone, Serialize)]
pub struct PluginRow {
    pub id: String,
    pub version: String,
    /// `dev` (unpacked folder) or `registry` (signed install).
    pub source: String,
    pub manifest_json: String,
    pub enabled: bool,
    pub key_id: Option<String>,
    pub sha256: Option<String>,
    pub installed_at: i64,
    pub prev_version: Option<String>,
}

impl Db {
    pub async fn plugins_list(&self) -> AppResult<Vec<PluginRow>> {
        let rows = self
            .conn
            .call(|c| {
                let mut st = c.prepare(
                    "SELECT id, version, source, manifest_json, enabled, key_id, sha256, installed_at, prev_version
                     FROM plugins ORDER BY id",
                )?;
                let rows = st
                    .query_map([], |r| {
                        Ok(PluginRow {
                            id: r.get(0)?,
                            version: r.get(1)?,
                            source: r.get(2)?,
                            manifest_json: r.get(3)?,
                            enabled: r.get::<_, i64>(4)? != 0,
                            key_id: r.get(5)?,
                            sha256: r.get(6)?,
                            installed_at: r.get(7)?,
                            prev_version: r.get(8)?,
                        })
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok::<_, tokio_rusqlite::Error>(rows)
            })
            .await?;
        Ok(rows)
    }

    /// Insert or replace a dev install. Keeps the user's enabled flag on reload.
    pub async fn plugin_upsert(&self, id: &str, version: &str, source: &str, manifest_json: &str) -> AppResult<()> {
        let (id, version, source, json) = (id.to_owned(), version.to_owned(), source.to_owned(), manifest_json.to_owned());
        let now = Utc::now().timestamp();
        self.conn
            .call(move |c| {
                c.execute(
                    "INSERT INTO plugins (id, version, source, manifest_json, enabled, installed_at)
                     VALUES (?1, ?2, ?3, ?4, 1, ?5)
                     ON CONFLICT(id) DO UPDATE SET
                        version = excluded.version, source = excluded.source,
                        manifest_json = excluded.manifest_json, installed_at = excluded.installed_at,
                        key_id = NULL, sha256 = NULL, prev_version = NULL",
                    params![id, version, source, json, now],
                )?;
                Ok::<_, tokio_rusqlite::Error>(())
            })
            .await?;
        Ok(())
    }

    pub async fn plugin_set_enabled(&self, id: &str, enabled: bool) -> AppResult<bool> {
        let id = id.to_owned();
        let n = self
            .conn
            .call(move |c| {
                Ok::<_, tokio_rusqlite::Error>(
                    c.execute("UPDATE plugins SET enabled = ?2 WHERE id = ?1", params![id, enabled as i64])?,
                )
            })
            .await?;
        Ok(n > 0)
    }

    pub async fn plugin_remove(&self, id: &str) -> AppResult<()> {
        let id = id.to_owned();
        self.conn
            .call(move |c| {
                c.execute("DELETE FROM plugins WHERE id = ?1", params![id])?;
                Ok::<_, tokio_rusqlite::Error>(())
            })
            .await?;
        Ok(())
    }
}

/// What a signed store install records next to the manifest.
#[derive(Debug, Clone)]
pub struct SignedInstall {
    pub key_id: String,
    pub sha256: String,
    /// Version kept on disk for rollback, if any.
    pub prev_version: Option<String>,
}

impl Db {
    /// Insert or replace a store install. Keeps the user's enabled flag on update.
    pub async fn plugin_upsert_signed(&self, id: &str, version: &str, manifest_json: &str, s: SignedInstall) -> AppResult<()> {
        let (id, version, json) = (id.to_owned(), version.to_owned(), manifest_json.to_owned());
        let now = Utc::now().timestamp();
        self.conn
            .call(move |c| {
                c.execute(
                    "INSERT INTO plugins (id, version, source, manifest_json, enabled, key_id, sha256, installed_at, prev_version)
                     VALUES (?1, ?2, 'registry', ?3, 1, ?4, ?5, ?6, ?7)
                     ON CONFLICT(id) DO UPDATE SET
                        version = excluded.version, source = excluded.source,
                        manifest_json = excluded.manifest_json, key_id = excluded.key_id,
                        sha256 = excluded.sha256, installed_at = excluded.installed_at,
                        prev_version = excluded.prev_version",
                    params![id, version, json, s.key_id, s.sha256, now, s.prev_version],
                )?;
                Ok::<_, tokio_rusqlite::Error>(())
            })
            .await?;
        Ok(())
    }
}
