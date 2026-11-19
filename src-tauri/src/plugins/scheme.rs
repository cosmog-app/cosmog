//! `cosmog-plugin` URI scheme: serves installed plugin files to their sandboxed iframes.
//! URL: `cosmog-plugin://localhost/<id>/<version>/<path>` (`http://cosmog-plugin.localhost/...` on
//! Windows/Android). Every response carries the plugin CSP, so a plugin has no network access.

use std::path::{Path, PathBuf};

use tauri::http::{header, Method, Request, Response, StatusCode};

use super::PluginRegistry;

pub const SCHEME: &str = "cosmog-plugin";

/// Largest single file served; bigger assets should be split by the plugin build.
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// `'self'` plus the explicit scheme origins: an opaque-origin (sandboxed) document may not
/// match `'self'` on every webview.
pub const PLUGIN_CSP: &str = "default-src 'none'; \
    script-src 'self' cosmog-plugin: http://cosmog-plugin.localhost 'wasm-unsafe-eval'; \
    style-src 'self' cosmog-plugin: http://cosmog-plugin.localhost 'unsafe-inline'; \
    img-src 'self' cosmog-plugin: http://cosmog-plugin.localhost data: blob:; \
    font-src 'self' cosmog-plugin: http://cosmog-plugin.localhost data:; \
    worker-src 'self' cosmog-plugin: http://cosmog-plugin.localhost blob:; \
    connect-src 'none'; frame-src 'none'; object-src 'none'; \
    form-action 'none'; base-uri 'none'";

/// Resolves a request path to a file inside the plugin's install dir, or the status to return.
pub fn resolve(root: &Path, registry: &PluginRegistry, uri_path: &str) -> Result<PathBuf, StatusCode> {
    let decoded = urlencoding::decode(uri_path).map_err(|_| StatusCode::BAD_REQUEST)?;
    let rel = decoded.strip_prefix('/').unwrap_or(&decoded);
    let mut parts = rel.splitn(3, '/');
    let (id, version, file) = match (parts.next(), parts.next(), parts.next()) {
        (Some(i), Some(v), Some(f)) => (i, v, f),
        _ => return Err(StatusCode::NOT_FOUND),
    };
    let plugin = registry.get(id).ok_or(StatusCode::NOT_FOUND)?;
    if !plugin.enabled || !plugin.compatible || plugin.version != version {
        return Err(StatusCode::NOT_FOUND);
    }
    super::manifest::safe_rel_path(file).map_err(|_| StatusCode::BAD_REQUEST)?;

    // Canonicalize both sides so a symlink inside the package can't point outside it.
    let dir = std::fs::canonicalize(super::plugin_dir(root, id, version)).map_err(|_| StatusCode::NOT_FOUND)?;
    let path = std::fs::canonicalize(dir.join(file)).map_err(|_| StatusCode::NOT_FOUND)?;
    if !path.starts_with(&dir) {
        return Err(StatusCode::FORBIDDEN);
    }
    let meta = std::fs::metadata(&path).map_err(|_| StatusCode::NOT_FOUND)?;
    if !meta.is_file() {
        return Err(StatusCode::NOT_FOUND);
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    Ok(path)
}

pub fn mime_for(path: &Path) -> &'static str {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "txt" => "text/plain; charset=utf-8",
        "excalidraw" => "application/json",
        _ => "application/octet-stream",
    }
}

fn base(status: StatusCode) -> tauri::http::response::Builder {
    Response::builder()
        .status(status)
        .header(header::CONTENT_SECURITY_POLICY, PLUGIN_CSP)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::REFERRER_POLICY, "no-referrer")
        .header(header::CACHE_CONTROL, "no-store")
        // Sandboxed frames have an opaque origin, so fonts, module scripts and workers load as CORS.
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
}

fn status_only(status: StatusCode) -> Response<Vec<u8>> {
    base(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(status.canonical_reason().unwrap_or("error").as_bytes().to_vec())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

pub async fn serve(root: &Path, registry: &PluginRegistry, req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let head = req.method() == Method::HEAD;
    if req.method() != Method::GET && !head {
        return status_only(StatusCode::METHOD_NOT_ALLOWED);
    }
    let path = match resolve(root, registry, req.uri().path()) {
        Ok(p) => p,
        Err(s) => {
            tracing::debug!("plugin scheme {} {} -> {s}", req.method(), req.uri());
            return status_only(s);
        }
    };
    tracing::debug!("plugin scheme {} {} -> 200", req.method(), req.uri());
    let body = if head {
        Vec::new()
    } else {
        match tokio::fs::read(&path).await {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!("plugin scheme read {}: {e}", path.display());
                return status_only(StatusCode::NOT_FOUND);
            }
        }
    };
    base(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime_for(&path))
        .body(body)
        .unwrap_or_else(|_| status_only(StatusCode::INTERNAL_SERVER_ERROR))
}
