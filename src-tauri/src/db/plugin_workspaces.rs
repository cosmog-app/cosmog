//! Workspaces: account + bucket + prefix where a document plugin lists and saves files.

use chrono::Utc;
use rusqlite::params;
use serde::Serialize;

use crate::error::AppResult;

use super::Db;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginWorkspace {
    pub id: String,
    pub plugin_id: String,
    pub label: String,
    pub account_id: String,
    pub bucket: String,
    /// Empty or ending in `/`.
    pub prefix: String,
    pub created_at: i64,
}

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<PluginWorkspace> {
    Ok(PluginWorkspace {
        id: r.get(0)?,
        plugin_id: r.get(1)?,
        label: r.get(2)?,
        account_id: r.get(3)?,
        bucket: r.get(4)?,
        prefix: r.get(5)?,
        created_at: r.get(6)?,
    })
}

const COLS: &str = "id, plugin_id, label, account_id, bucket, prefix, created_at";

impl Db {
    pub async fn plugin_workspace_list(&self, plugin_id: &str) -> AppResult<Vec<PluginWorkspace>> {
        let plugin_id = plugin_id.to_owned();
        Ok(self
            .conn
            .call(move |c| {
                let mut st = c.prepare(&format!(
                    "SELECT {COLS} FROM plugin_workspaces WHERE plugin_id = ?1 ORDER BY created_at, id"
                ))?;
                let rows = st.query_map(params![plugin_id], row)?.collect::<Result<Vec<_>, _>>()?;
                Ok::<_, tokio_rusqlite::Error>(rows)
            })
            .await?)
    }

    pub async fn plugin_workspace_get(&self, id: &str) -> AppResult<Option<PluginWorkspace>> {
        let id = id.to_owned();
        Ok(self
            .conn
            .call(move |c| {
                let mut st = c.prepare(&format!("SELECT {COLS} FROM plugin_workspaces WHERE id = ?1"))?;
                let mut rows = st.query_map(params![id], row)?;
                Ok::<_, tokio_rusqlite::Error>(rows.next().transpose()?)
            })
            .await?)
    }

    pub async fn plugin_workspace_add(
        &self,
        plugin_id: &str,
        label: &str,
        account_id: &str,
        bucket: &str,
        prefix: &str,
    ) -> AppResult<PluginWorkspace> {
        let ws = PluginWorkspace {
            id: uuid::Uuid::new_v4().to_string(),
            plugin_id: plugin_id.to_owned(),
            label: label.to_owned(),
            account_id: account_id.to_owned(),
            bucket: bucket.to_owned(),
            prefix: prefix.to_owned(),
            created_at: Utc::now().timestamp(),
        };
        let w = ws.clone();
        self.conn
            .call(move |c| {
                c.execute(
                    &format!("INSERT INTO plugin_workspaces ({COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"),
                    params![w.id, w.plugin_id, w.label, w.account_id, w.bucket, w.prefix, w.created_at],
                )?;
                Ok::<_, tokio_rusqlite::Error>(())
            })
            .await?;
        Ok(ws)
    }

    pub async fn plugin_workspace_remove(&self, id: &str) -> AppResult<bool> {
        let id = id.to_owned();
        let n = self
            .conn
            .call(move |c| Ok::<_, tokio_rusqlite::Error>(c.execute("DELETE FROM plugin_workspaces WHERE id = ?1", params![id])?))
            .await?;
        Ok(n > 0)
    }
}
