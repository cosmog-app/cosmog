//! `cosmog-plugin.json` parsing and validation. Rules live in docs/PLUGINS.md ("Manifest").

use std::path::{Component, Path};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

pub const MANIFEST_FILE: &str = "cosmog-plugin.json";

/// Host-to-plugin protocol versions this build speaks.
pub const SUPPORTED_API_VERSIONS: &[u32] = &[1];

/// Reserved names (`storage:workspace`, `network:<host>`) are refused until their phase ships.
const KNOWN_PERMISSIONS: &[&str] = &[];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Desktop,
    Mobile,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(any(target_os = "android", target_os = "ios")) {
            Platform::Mobile
        } else {
            Platform::Desktop
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PluginKind {
    DocumentEditor,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileType {
    pub ext: String,
    pub mime: String,
    pub label: String,
    #[serde(default)]
    pub template: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub api_version: u32,
    pub kind: PluginKind,
    pub entry: String,
    pub platforms: Vec<Platform>,
    #[serde(default)]
    pub min_app_version: Option<String>,
    #[serde(default)]
    pub file_types: Vec<FileType>,
    #[serde(default)]
    pub permissions: Vec<String>,
}

impl Manifest {
    pub fn parse(json: &str) -> AppResult<Self> {
        serde_json::from_str(json).map_err(|e| invalid(format!("manifest: {e}")))
    }

    pub async fn read(dir: &Path) -> AppResult<Self> {
        let raw = tokio::fs::read_to_string(dir.join(MANIFEST_FILE))
            .await
            .map_err(|e| invalid(format!("read {MANIFEST_FILE}: {e}")))?;
        Self::parse(&raw)
    }

    pub fn supports(&self, p: Platform) -> bool {
        self.platforms.contains(&p)
    }

    /// Checks fields only. `validate_files` adds the checks that need the package on disk.
    pub fn validate(&self, app_version: &str) -> AppResult<()> {
        if !valid_id(&self.id) {
            return Err(invalid(format!("id {:?} must match ^[a-z][a-z0-9-]{{1,39}}$", self.id)));
        }
        if self.name.trim().is_empty() || self.name.len() > 64 {
            return Err(invalid("name must be 1-64 chars".into()));
        }
        parse_semver(&self.version).ok_or_else(|| invalid(format!("version {:?} is not x.y.z", self.version)))?;
        if !SUPPORTED_API_VERSIONS.contains(&self.api_version) {
            return Err(invalid(format!(
                "apiVersion {} not supported (this app speaks {:?})",
                self.api_version, SUPPORTED_API_VERSIONS
            )));
        }
        if self.platforms.is_empty() {
            return Err(invalid("platforms must not be empty".into()));
        }
        if let Some(min) = &self.min_app_version {
            let need = parse_semver(min).ok_or_else(|| invalid(format!("minAppVersion {min:?} is not x.y.z")))?;
            let have = parse_semver(app_version).ok_or_else(|| invalid(format!("app version {app_version:?}")))?;
            if have < need {
                return Err(invalid(format!("needs Cosmog {min} or newer (this is {app_version})")));
            }
        }
        safe_rel_path(&self.entry).map_err(|e| invalid(format!("entry: {e}")))?;
        for ft in &self.file_types {
            let ext_ok = ft.ext.len() >= 2
                && ft.ext.len() <= 32
                && ft.ext.starts_with('.')
                && ft.ext[1..].chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-');
            if !ext_ok {
                return Err(invalid(format!("fileTypes ext {:?} must be like .excalidraw", ft.ext)));
            }
            if ft.mime.trim().is_empty() || ft.label.trim().is_empty() {
                return Err(invalid(format!("fileTypes {}: mime and label required", ft.ext)));
            }
            if let Some(t) = &ft.template {
                safe_rel_path(t).map_err(|e| invalid(format!("fileTypes {} template: {e}", ft.ext)))?;
            }
        }
        for p in &self.permissions {
            if !KNOWN_PERMISSIONS.contains(&p.as_str()) {
                return Err(invalid(format!("permission {p:?} is not supported")));
            }
        }
        Ok(())
    }

    /// Entry and templates must exist as regular files inside `dir`.
    pub async fn validate_files(&self, dir: &Path) -> AppResult<()> {
        let mut paths = vec![self.entry.as_str()];
        paths.extend(self.file_types.iter().filter_map(|f| f.template.as_deref()));
        for rel in paths {
            let meta = tokio::fs::symlink_metadata(dir.join(rel)).await;
            if !matches!(meta, Ok(m) if m.is_file()) {
                return Err(invalid(format!("{rel} is missing from the package")));
            }
        }
        Ok(())
    }
}

fn invalid(msg: String) -> AppError {
    AppError::InvalidInput(msg)
}

pub fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    (2..=40).contains(&b.len())
        && b[0].is_ascii_lowercase()
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// Strict `MAJOR.MINOR.PATCH`; prerelease tags are not used for plugins.
pub fn parse_semver(v: &str) -> Option<(u64, u64, u64)> {
    let mut it = v.split('.');
    let mut n = || -> Option<u64> {
        let s = it.next()?;
        if s.is_empty() || (s.len() > 1 && s.starts_with('0')) || !s.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        s.parse().ok()
    };
    let out = (n()?, n()?, n()?);
    it.next().is_none().then_some(out)
}

/// Relative, forward-slash path with only normal segments. Rejects `..`, `.`, absolute, backslash, NUL.
pub fn safe_rel_path(p: &str) -> Result<(), String> {
    if p.is_empty() || p.len() > 512 {
        return Err("empty or too long".into());
    }
    if p.contains('\\') || p.contains('\0') || p.starts_with('/') {
        return Err(format!("{p:?} must be a relative forward-slash path"));
    }
    if p.split('/').any(|s| s.is_empty() || s == "." || s == "..") {
        return Err(format!("{p:?} has an empty, . or .. segment"));
    }
    if !Path::new(p).components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(format!("{p:?} is not a plain relative path"));
    }
    Ok(())
}
