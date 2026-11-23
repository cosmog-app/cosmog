//! Document-editor plugin commands (Phase 2): document read/write, templates, drafts.
//! Called by the host shell only; plugins never reach IPC. Bodies travel as raw bytes, with
//! write parameters in a base64 JSON `x-cosmog-meta` header.

use base64::Engine;
use serde::Deserialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::plugins::docs::{self, DocMeta, DraftMeta};
use crate::plugins::{InstalledPlugin, PluginRegistry};
use crate::state::AppState;
use crate::store::PutCond;
use crate::validate;

fn plugin(registry: &PluginRegistry, id: &str) -> AppResult<InstalledPlugin> {
    registry.get(id).ok_or_else(|| AppError::NotFound(format!("plugin {id}")))
}

fn raw_body(req: &Request<'_>) -> AppResult<Vec<u8>> {
    match req.body() {
        InvokeBody::Raw(b) => Ok(b.clone()),
        // Tauri's postMessage fallback (custom-protocol IPC blocked, or Android) sends bytes as JSON.
        InvokeBody::Json(v @ serde_json::Value::Array(_)) => {
            serde_json::from_value(v.clone()).map_err(|_| AppError::InvalidInput("expected a byte array body".into()))
        }
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
    // Validated, never trimmed: the save must hit the exact key that was opened.
    validate::require_non_empty("key", &m.key)?;
    let key = m.key;
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
    // resolve() URL-decodes, and manifest paths may contain '%': encode each segment first.
    let enc: Vec<_> = rel.split('/').map(urlencoding::encode).collect();
    let path = crate::plugins::scheme::resolve(registry.root(), &registry, &format!("/{}/{}/{}", p.id, p.version, enc.join("/")))
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

