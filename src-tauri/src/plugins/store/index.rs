//! The store catalog: `index.json` on the main branch of the cosmog-plugins repo, written by its
//! release workflow. Display data plus, per plugin, where its signed package is and its hash.
//! Nothing here is trusted for install: the package's signature and manifest decide.

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::plugins::manifest::{is_https_url, parse_semver, valid_id, Link, Platform};

pub const INDEX_URL: &str = "https://raw.githubusercontent.com/cosmog-app/cosmog-plugins/main/index.json";
const MAX_INDEX_BYTES: u64 = 4 * 1024 * 1024;
const SCHEMA: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreFileType {
    pub ext: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Download {
    pub url: String,
    pub size: u64,
    pub sha256: String,
    pub key_id: String,
    /// Base64 ed25519 signature over `keys::statement(id, version, sha256)`.
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreEntry {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// `data:image/png;base64,...` or `data:image/svg+xml;base64,...`, so the list needs no extra fetches.
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default)]
    pub repository: Option<String>,
    #[serde(default)]
    pub upstream: Option<Link>,
    #[serde(deserialize_with = "known_platforms")]
    pub platforms: Vec<Platform>,
    #[serde(default)]
    pub min_app_version: Option<String>,
    #[serde(default)]
    pub file_types: Vec<StoreFileType>,
    /// RFC 3339, set by the release workflow.
    #[serde(default)]
    pub released_at: Option<String>,
    pub download: Download,
}

// Entries parse one by one: a single entry this version can't read must not hide the others.
#[derive(Debug, Deserialize)]
struct Index {
    schema: u32,
    plugins: Vec<serde_json::Value>,
}

/// Platforms added after this release are ignored, not an error.
fn known_platforms<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<Platform>, D::Error> {
    let raw = Vec::<serde_json::Value>::deserialize(d)?;
    Ok(raw.into_iter().filter_map(|v| serde_json::from_value(v).ok()).collect())
}

const ICON_PREFIXES: &[&str] = &["data:image/png;base64,", "data:image/svg+xml;base64,"];
const MAX_ICON_CHARS: usize = 256 * 1024;

impl StoreEntry {
    /// Drops what the UI must never render or open; false = skip the whole entry.
    fn sanitize(&mut self) -> bool {
        if self.icon.as_deref().is_some_and(|i| i.len() > MAX_ICON_CHARS || !ICON_PREFIXES.iter().any(|p| i.starts_with(p))) {
            self.icon = None;
        }
        for url in [&mut self.homepage, &mut self.repository] {
            if url.as_deref().is_some_and(|u| !is_https_url(u)) {
                *url = None;
            }
        }
        if self.upstream.as_ref().is_some_and(|u| !is_https_url(&u.url)) {
            self.upstream = None;
        }
        valid_id(&self.id) && parse_semver(&self.version).is_some() && is_https_url(&self.download.url)
    }
}

pub fn parse(json: &[u8]) -> AppResult<Vec<StoreEntry>> {
    let idx: Index = serde_json::from_slice(json).map_err(|e| AppError::InvalidInput(format!("plugin index: {e}")))?;
    if idx.schema != SCHEMA {
        return Err(AppError::InvalidInput(format!("plugin index schema {} needs a newer Cosmog", idx.schema)));
    }
    let mut out: Vec<StoreEntry> = idx
        .plugins
        .into_iter()
        .filter_map(|v| match serde_json::from_value::<StoreEntry>(v) {
            Ok(e) => Some(e),
            Err(e) => {
                tracing::warn!("plugin index: entry skipped: {e}");
                None
            }
        })
        .filter_map(|mut e| e.sanitize().then_some(e))
        .collect();
    out.sort_by_key(|e| e.name.to_lowercase());
    Ok(out)
}

pub async fn fetch() -> AppResult<Vec<StoreEntry>> {
    parse(&super::http::get(INDEX_URL, MAX_INDEX_BYTES, |_, _| {}).await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(extra: &str) -> String {
        format!(
            r#"{{"id":"excalidraw","name":"Excalidraw","version":"0.2.0","platforms":["desktop"],
               "download":{{"url":"https://github.com/x/y.zip","size":1,"sha256":"aa","keyId":"k","signature":"s"}}{extra}}}"#
        )
    }

    #[test]
    fn parses_and_strips_unsafe_display_fields() {
        let json = format!(
            r#"{{"schema":1,"plugins":[{}]}}"#,
            entry(r#","icon":"javascript:alert(1)","homepage":"http://x","upstream":{"name":"E","url":"https://excalidraw.com"},"futureField":1"#)
        );
        let list = parse(json.as_bytes()).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].icon, None);
        assert_eq!(list[0].homepage, None);
        assert_eq!(list[0].upstream.as_ref().unwrap().url, "https://excalidraw.com");
    }

    #[test]
    fn skips_entries_with_bad_identity_and_rejects_new_schema() {
        let bad = entry("").replace("\"excalidraw\"", "\"../x\"");
        let json = format!(r#"{{"schema":1,"plugins":[{bad},{}]}}"#, entry(""));
        assert_eq!(parse(json.as_bytes()).unwrap().len(), 1);
        assert!(parse(br#"{"schema":2,"plugins":[]}"#).is_err());
    }

    #[test]
    fn future_entries_do_not_break_the_catalog() {
        let ios = entry("").replace("\"excalidraw\"", "\"alpha\"").replace(r#"["desktop"]"#, r#"["desktop","ios"]"#);
        let broken = entry("").replace("\"excalidraw\"", "\"beta\"").replace(r#""download""#, r#""dl""#);
        let json = format!(r#"{{"schema":1,"plugins":[{ios},{broken},{}]}}"#, entry(""));
        let list = parse(json.as_bytes()).unwrap();
        let ids: Vec<_> = list.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids.len(), 2, "{ids:?}");
        let a = list.iter().find(|e| e.id == "alpha").unwrap();
        assert_eq!(a.platforms, vec![Platform::Desktop]);
    }
}
