//! Document-editor plugin commands (Phase 2): workspaces, document read/write, templates, drafts.
//! Called by the host shell only; plugins never reach IPC. Bodies travel as raw bytes, with
//! write parameters in a base64 JSON `x-cosmog-meta` header.

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::State;

use crate::db::plugin_workspaces::PluginWorkspace;
use crate::error::{AppError, AppResult};
use crate::plugins::docs::{self, DocMeta, DraftMeta};
use crate::plugins::{InstalledPlugin, PluginRegistry};
use crate::state::AppState;
use crate::store::{ListOptions, PutCond};
use crate::validate;

/// Listing stops here; a workspace with more documents than this is not a use case.
const MAX_LISTED_DOCS: usize = 5_000;

fn plugin(registry: &PluginRegistry, id: &str) -> AppResult<InstalledPlugin> {
    registry.get(id).ok_or_else(|| AppError::NotFound(format!("plugin {id}")))
}

fn normalize_prefix(p: &str) -> String {
    let p = p.trim().trim_start_matches('/');
    if p.is_empty() || p.ends_with('/') { p.to_owned() } else { format!("{p}/") }
}

fn raw_body(req: &Request<'_>) -> AppResult<Vec<u8>> {
    match req.body() {
        InvokeBody::Raw(b) => Ok(b.clone()),
        _ => Err(AppError::InvalidInput("expected a raw byte body".into())),
    }
}

fn header_meta<T: for<'de> Deserialize<'de>>(req: &Request<'_>) -> AppResult<T> {
    let v = req
        .headers()
        .get("x-cosmog-meta")
        .ok_or_else(|| AppError::InvalidInput("missing x-cosmog-meta header".into()))?;
    let json = base64::engine::general_purpose::STANDARD
        .decode(v.as_bytes())
        .map_err(|e| AppError::InvalidInput(format!("x-cosmog-meta: {e}")))?;
    serde_json::from_slice(&json).map_err(|e| AppError::InvalidInput(format!("x-cosmog-meta: {e}")))
}

// ── workspaces ──────────────────────────────────────────────────────────────

#[tracing::instrument(skip_all, err)]
#[tauri::command]
pub async fn plugin_workspace_list(state: State<'_, AppState>, plugin_id: String) -> AppResult<Vec<PluginWorkspace>> {
    state.db.plugin_workspace_list(&plugin_id).await
}

#[tracing::instrument(skip_all, err)]
#[tauri::command]
pub async fn plugin_workspace_add(
    state: State<'_, AppState>,
    registry: State<'_, PluginRegistry>,
    plugin_id: String,
    label: String,
    account_id: String,
    bucket: String,
    prefix: String,
) -> AppResult<PluginWorkspace> {
    plugin(&registry, &plugin_id)?;
    let label = validate::require_non_empty("label", &label)?;
    let account_id = validate::require_non_empty("account_id", &account_id)?;
    let bucket = validate::require_non_empty("bucket", &bucket)?;
    // Fails early on a bucket the account can't list instead of on first save.
    let store = state.store_for(&account_id).await?;
    let prefix = normalize_prefix(&prefix);
    store
        .list_objects(&bucket, ListOptions { prefix: Some(prefix.clone()), max_keys: Some(1), ..Default::default() })
        .await?;
    state.db.plugin_workspace_add(&plugin_id, &label, &account_id, &bucket, &prefix).await
}

#[tracing::instrument(skip_all, err)]
#[tauri::command]
pub async fn plugin_workspace_remove(state: State<'_, AppState>, id: String) -> AppResult<()> {
    if !state.db.plugin_workspace_remove(&id).await? {
        return Err(AppError::NotFound(format!("workspace {id}")));
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocEntry {
    pub key: String,
    pub size: i64,
    pub last_modified: Option<i64>,
    pub etag: Option<String>,
}

/// Every object under the workspace prefix whose name ends in one of the plugin's file types.
#[tracing::instrument(skip_all, err)]
#[tauri::command]
pub async fn plugin_doc_list(
    state: State<'_, AppState>,
    registry: State<'_, PluginRegistry>,
    workspace_id: String,
) -> AppResult<Vec<DocEntry>> {
    let ws = state
        .db
        .plugin_workspace_get(&workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("workspace {workspace_id}")))?;
    let exts: Vec<String> = plugin(&registry, &ws.plugin_id)?
        .manifest
        .file_types
        .iter()
        .map(|f| f.ext.to_lowercase())
        .collect();
    let store = state.store_for(&ws.account_id).await?;
    let mut out = Vec::new();
    let mut continuation = None;
    loop {
        let page = store
            .list_objects(
                &ws.bucket,
                ListOptions {
                    prefix: (!ws.prefix.is_empty()).then(|| ws.prefix.clone()),
                    delimiter: None,
                    continuation: continuation.take(),
                    max_keys: Some(1000),
                },
            )
            .await?;
        for o in page.objects {
            let lower = o.key.to_lowercase();
            if exts.iter().any(|e| lower.ends_with(e)) {
                out.push(DocEntry { key: o.key, size: o.size, last_modified: o.last_modified, etag: o.etag });
                if out.len() >= MAX_LISTED_DOCS {
                    return Ok(out);
                }
            }
        }
        match (page.is_truncated, page.continuation) {
            (true, Some(c)) => continuation = Some(c),
            _ => break,
        }
    }
    out.sort_by(|a, b| b.last_modified.cmp(&a.last_modified).then_with(|| a.key.cmp(&b.key)));
    Ok(out)
}

// ── documents ───────────────────────────────────────────────────────────────

/// Plaintext body framed with `DocMeta` (see `docs::frame`).
#[tracing::instrument(skip_all, err)]
#[tauri::command]
pub async fn plugin_doc_read(
    state: State<'_, AppState>,
    account_id: String,
    bucket: String,
    key: String,
) -> AppResult<Response> {
    let (bytes, head) = docs::read(&state, &account_id, &bucket, &key).await?;
    let meta = DocMeta { etag: head.etag, content_type: head.content_type, last_modified: head.last_modified };
    Ok(Response::new(docs::frame(&meta, &bytes)?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteMeta {
    account_id: String,
    bucket: String,
    key: String,
    mime: String,
    /// Etag the editor loaded; the write fails with `conflict` if the object changed since.
    #[serde(default)]
    if_match: Option<String>,
    /// New file: fail with `conflict` if the key already exists.
    #[serde(default)]
    create: bool,
}

/// Returns the new etag.
#[tracing::instrument(skip_all, err)]
#[tauri::command]
pub async fn plugin_doc_write(state: State<'_, AppState>, request: Request<'_>) -> AppResult<Option<String>> {
    let m: WriteMeta = header_meta(&request)?;
    let body = raw_body(&request)?;
    if m.if_match.is_none() && !m.create {
        return Err(AppError::InvalidInput("write needs ifMatch or create".into()));
    }
    let key = validate::require_non_empty("key", &m.key)?;
    if key.ends_with('/') {
        return Err(AppError::InvalidInput("key must name a file".into()));
    }
    let cond = PutCond { if_match: m.if_match, if_none_match: m.create };
    docs::write(&state, &m.account_id, &m.bucket, &key, &m.mime, body, cond).await
}

/// The manifest template for `ext`, or empty bytes when the plugin has none.
#[tracing::instrument(skip_all, err)]
#[tauri::command]
pub async fn plugin_template(registry: State<'_, PluginRegistry>, plugin_id: String, ext: String) -> AppResult<Response> {
    let p = plugin(&registry, &plugin_id)?;
    let ft = p
        .manifest
        .file_types
        .iter()
        .find(|f| f.ext.eq_ignore_ascii_case(&ext))
        .ok_or_else(|| AppError::NotFound(format!("{plugin_id} has no file type {ext}")))?;
    let Some(rel) = ft.template.as_deref() else {
        return Ok(Response::new(Vec::new()));
    };
    let path = crate::plugins::scheme::resolve(registry.root(), &registry, &format!("/{}/{}/{rel}", p.id, p.version))
        .map_err(|s| AppError::NotFound(format!("template {rel}: {s}")))?;
    Ok(Response::new(tokio::fs::read(path).await?))
}

// ── drafts ──────────────────────────────────────────────────────────────────

fn draft_paths(registry: &PluginRegistry, plugin_id: &str, account_id: &str, bucket: &str, key: &str) -> AppResult<(std::path::PathBuf, std::path::PathBuf)> {
    // Only installed ids, which the manifest validator keeps path-safe.
    plugin(registry, plugin_id)?;
    Ok(docs::draft_paths(&registry.drafts_root(), plugin_id, account_id, bucket, key))
}

/// Framed `DraftMeta` + plaintext, or an empty body when there is no draft.
#[tracing::instrument(skip_all, err)]
#[tauri::command]
pub async fn plugin_draft_get(
    registry: State<'_, PluginRegistry>,
    plugin_id: String,
    account_id: String,
    bucket: String,
    key: String,
) -> AppResult<Response> {
    let (bin, json) = draft_paths(&registry, &plugin_id, &account_id, &bucket, &key)?;
    let Some((body, meta)) = tokio::task::spawn_blocking(move || docs::draft_load(&bin, &json))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))??
    else {
        return Ok(Response::new(Vec::new()));
    };
    let plain = docs::open_draft(&account_id, &bucket, body, &meta).await?;
    Ok(Response::new(docs::frame(&meta, &plain)?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DraftPutMeta {
    plugin_id: String,
    account_id: String,
    bucket: String,
    key: String,
    #[serde(default)]
    base_etag: Option<String>,
}

#[tracing::instrument(skip_all, err)]
#[tauri::command]
pub async fn plugin_draft_put(
    state: State<'_, AppState>,
    registry: State<'_, PluginRegistry>,
    request: Request<'_>,
) -> AppResult<()> {
    let m: DraftPutMeta = header_meta(&request)?;
    let body = raw_body(&request)?;
    if body.len() > docs::MAX_DOC_BYTES {
        return Err(AppError::EntityTooLarge(format!("draft is {} bytes", body.len())));
    }
    let (bin, json) = draft_paths(&registry, &m.plugin_id, &m.account_id, &m.bucket, &m.key)?;
    let (sealed, encrypted) = docs::seal_draft(&state, &m.account_id, &m.bucket, body).await?;
    let meta = DraftMeta { base_etag: m.base_etag, saved_at: chrono::Utc::now().timestamp(), encrypted };
    tokio::task::spawn_blocking(move || docs::draft_store(&bin, &json, &sealed, &meta))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
}

#[tracing::instrument(skip_all, err)]
#[tauri::command]
pub async fn plugin_draft_clear(
    registry: State<'_, PluginRegistry>,
    plugin_id: String,
    account_id: String,
    bucket: String,
    key: String,
) -> AppResult<()> {
    let (bin, json) = draft_paths(&registry, &plugin_id, &account_id, &bucket, &key)?;
    tokio::task::spawn_blocking(move || docs::draft_remove(&bin, &json))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::normalize_prefix;

    #[test]
    fn prefix_is_relative_and_slash_terminated() {
        assert_eq!(normalize_prefix(""), "");
        assert_eq!(normalize_prefix("  "), "");
        assert_eq!(normalize_prefix("/drawings"), "drawings/");
        assert_eq!(normalize_prefix("a/b/"), "a/b/");
    }
}
