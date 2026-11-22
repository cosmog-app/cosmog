//! Signed install from the store: download, check size + SHA-256 + signature, unpack into a
//! staging dir with strict path rules, check the manifest matches the catalog, then swap in.
//! The previous store version stays on disk for rollback; anything older is removed.

use std::io::{Cursor, Read};
use std::path::Path;

use base64::Engine;

use crate::db::plugins::SignedInstall;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::plugins::dev::{MAX_FILES, MAX_TOTAL_BYTES};
use crate::plugins::manifest::{parse_semver, safe_rel_path, Manifest, Platform};
use crate::plugins::{plugin_dir, PluginRegistry, Staging};

use super::index::StoreEntry;
use super::keys::{self, TrustedKey};

/// A package is downloaded into memory whole.
pub const MAX_PACKAGE_BYTES: u64 = 64 * 1024 * 1024;

fn bad(msg: impl Into<String>) -> AppError {
    AppError::InvalidInput(msg.into())
}

/// Size, hash and signature, before a single byte is unpacked. Returns the hex SHA-256.
pub fn check_package(entry: &StoreEntry, data: &[u8], trusted: &[TrustedKey]) -> AppResult<String> {
    if data.len() as u64 != entry.download.size {
        return Err(bad(format!("package is {} bytes, the catalog says {}", data.len(), entry.download.size)));
    }
    let hash = keys::sha256_hex(data);
    if hash != entry.download.sha256.to_ascii_lowercase() {
        return Err(bad("package hash does not match the catalog"));
    }
    let sig = base64::engine::general_purpose::STANDARD
        .decode(entry.download.signature.trim())
        .map_err(|_| bad("package signature is not base64"))?;
    keys::verify(trusted, &entry.download.key_id, &sig, keys::statement(&entry.id, &entry.version, &hash).as_bytes())?;
    Ok(hash)
}

/// Regular files only, every path checked like a manifest path; limits count real bytes written.
pub fn unpack(data: &[u8], dest: &Path) -> AppResult<()> {
    let mut zip = zip::ZipArchive::new(Cursor::new(data)).map_err(|e| bad(format!("package is not a zip: {e}")))?;
    if zip.len() > MAX_FILES {
        return Err(bad(format!("package has more than {MAX_FILES} entries")));
    }
    let mut total = 0u64;
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| bad(format!("zip entry {i}: {e}")))?;
        let name = f.name().map_err(|e| bad(format!("zip entry {i} name: {e}")))?.into_owned();
        if f.is_dir() {
            safe_rel_path(name.trim_end_matches('/')).map_err(|e| bad(format!("zip entry: {e}")))?;
            continue;
        }
        if f.is_symlink() || !f.is_file() {
            return Err(bad(format!("zip entry {name:?} is not a regular file")));
        }
        safe_rel_path(&name).map_err(|e| bad(format!("zip entry: {e}")))?;
        let out = dest.join(&name);
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut w = std::fs::OpenOptions::new().write(true).create_new(true).open(&out)?;
        // Header sizes can lie; cap what is actually inflated.
        let left = MAX_TOTAL_BYTES - total;
        let n = std::io::copy(&mut (&mut f).take(left + 1), &mut w)?;
        total += n;
        if total > MAX_TOTAL_BYTES {
            return Err(bad(format!("package unpacks to more than {} MB", MAX_TOTAL_BYTES / 1024 / 1024)));
        }
    }
    Ok(())
}

/// Store versions other than `keep` are deleted; dev copies too.
async fn prune(id_dir: &Path, keep: &[&str]) -> AppResult<()> {
    let Ok(mut rd) = tokio::fs::read_dir(id_dir).await else { return Ok(()) };
    while let Some(e) = rd.next_entry().await? {
        let name = e.file_name().to_string_lossy().into_owned();
        if !keep.contains(&name.as_str()) {
            tokio::fs::remove_dir_all(e.path()).await?;
        }
    }
    Ok(())
}

pub async fn install(
    db: &Db,
    registry: &PluginRegistry,
    entry: &StoreEntry,
    app_version: &str,
    progress: impl FnMut(u64, Option<u64>),
) -> AppResult<Manifest> {
    if entry.download.size > MAX_PACKAGE_BYTES {
        return Err(AppError::EntityTooLarge(format!("{} package is too large", entry.id)));
    }
    let data = super::http::get(&entry.download.url, entry.download.size, progress).await?;
    install_package(db, registry, entry, data, app_version, keys::TRUSTED_KEYS).await
}

/// Everything after the download; separate so tests can feed a package without network.
pub async fn install_package(
    db: &Db,
    registry: &PluginRegistry,
    entry: &StoreEntry,
    data: Vec<u8>,
    app_version: &str,
    trusted: &[TrustedKey],
) -> AppResult<Manifest> {
    let sha256 = check_package(entry, &data, trusted)?;
    // Every old release stays validly signed; only a newer one may replace a store install.
    if let Some(cur) = registry.get(&entry.id).filter(|p| p.source == "registry") {
        if parse_semver(&entry.version) < parse_semver(&cur.version) {
            return Err(bad(format!("{} {} is older than the installed {}", entry.id, entry.version, cur.version)));
        }
    }

    let root = registry.root().to_path_buf();
    tokio::fs::create_dir_all(&root).await?;
    let staging = Staging::new(&root);
    let st = staging.path().to_path_buf();
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&st)?;
        unpack(&data, &st)
    })
    .await
    .map_err(|e| AppError::Internal(format!("unpack task: {e}")))??;
    let manifest = checked_manifest(staging.path(), entry, app_version).await?;

    // Updating keeps the outgoing version; reinstalling the same one keeps whatever was kept before.
    let prev = match registry.get(&entry.id).filter(|p| p.source == "registry") {
        Some(p) if p.version != entry.version => Some(p.version),
        Some(_) => db.plugins_list().await?.into_iter().find(|r| r.id == entry.id).and_then(|r| r.prev_version),
        None => None,
    };
    let id_dir = root.join(&entry.id);
    tokio::fs::create_dir_all(&id_dir).await?;
    let dest = plugin_dir(&root, &entry.id, &entry.version);
    // Reinstalling the same version repairs it; any other installed version is left alone here.
    if tokio::fs::try_exists(&dest).await? {
        tokio::fs::remove_dir_all(&dest).await?;
    }
    tokio::fs::rename(staging.path(), &dest).await?;
    staging.keep();

    let json = serde_json::to_string(&manifest).map_err(|e| AppError::Internal(e.to_string()))?;
    let keep: Vec<String> = [Some(entry.version.clone()), prev.clone()].into_iter().flatten().collect();
    let signed = SignedInstall { key_id: entry.download.key_id.clone(), sha256, prev_version: prev };
    db.plugin_upsert_signed(&manifest.id, &manifest.version, &json, signed).await?;
    registry.reload(db).await?;
    // Old versions go last, once the DB points at the new one: a failure only leaves extra files.
    let keep: Vec<&str> = keep.iter().map(String::as_str).collect();
    if let Err(e) = prune(&id_dir, &keep).await {
        tracing::warn!("plugin {}: old versions not removed: {e}", entry.id);
    }
    Ok(manifest)
}

/// The signed package decides what is installed; it must be the plugin and version the user picked.
async fn checked_manifest(dir: &Path, entry: &StoreEntry, app_version: &str) -> AppResult<Manifest> {
    let m = Manifest::read(dir).await?;
    m.validate(app_version)?;
    if m.id != entry.id || m.version != entry.version {
        return Err(bad(format!("package is {} {}, expected {} {}", m.id, m.version, entry.id, entry.version)));
    }
    m.validate_files(dir).await?;
    if !m.supports(Platform::current()) {
        return Err(bad(format!("{} does not support this platform", m.id)));
    }
    Ok(m)
}
