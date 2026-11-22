//! Load an unpacked plugin from a local folder (debug builds only expose the command).
//! Copies into `<root>/<id>/<version>/` via a staging dir so a failed copy never leaves half a plugin.

use std::path::{Path, PathBuf};

use crate::db::Db;
use crate::error::{AppError, AppResult};

use super::manifest::{Manifest, Platform};
use super::{plugin_dir, PluginRegistry, Staging};

pub const MAX_FILES: usize = 5000;
pub const MAX_TOTAL_BYTES: u64 = 200 * 1024 * 1024;

pub async fn load_unpacked(db: &Db, registry: &PluginRegistry, src: &Path, app_version: &str) -> AppResult<Manifest> {
    let manifest = Manifest::read(src).await?;
    manifest.validate(app_version)?;
    manifest.validate_files(src).await?;
    if !manifest.supports(Platform::current()) {
        return Err(AppError::InvalidInput(format!(
            "{} does not support this platform ({:?})",
            manifest.id, manifest.platforms
        )));
    }

    let root = registry.root().to_path_buf();
    let staging = Staging::new(&root);
    let src_owned = src.to_path_buf();
    let staging_c = staging.path().to_path_buf();
    tokio::task::spawn_blocking(move || copy_tree(&src_owned, &staging_c))
        .await
        .map_err(|e| AppError::Internal(format!("copy task: {e}")))??;

    let dest = plugin_dir(&root, &manifest.id, &manifest.version);
    let id_dir = root.join(&manifest.id);
    // Dev loads keep only the loaded version; rollback copies are a registry install concern.
    if id_dir.exists() {
        tokio::fs::remove_dir_all(&id_dir).await?;
    }
    tokio::fs::create_dir_all(&id_dir).await?;
    tokio::fs::rename(staging.path(), &dest).await?;
    staging.keep();

    let json = serde_json::to_string(&manifest).map_err(|e| AppError::Internal(e.to_string()))?;
    db.plugin_upsert(&manifest.id, &manifest.version, "dev", &json).await?;
    registry.reload(db).await?;
    Ok(manifest)
}

pub async fn remove(db: &Db, registry: &PluginRegistry, id: &str) -> AppResult<()> {
    if !super::manifest::valid_id(id) {
        return Err(AppError::InvalidInput(format!("bad plugin id {id:?}")));
    }
    db.plugin_remove(id).await?;
    let dir = registry.root().join(id);
    if dir.exists() {
        tokio::fs::remove_dir_all(&dir).await?;
    }
    // Unsaved drafts are copies of documents (plaintext for unencrypted buckets): they go too.
    let drafts = registry.drafts_root().join(id);
    if drafts.exists() {
        tokio::fs::remove_dir_all(&drafts).await?;
    }
    registry.reload(db).await
}

/// Regular files and dirs only; symlinks and special files are refused, not followed.
pub fn copy_tree(src: &Path, dst: &Path) -> AppResult<()> {
    let mut files = 0usize;
    let mut bytes = 0u64;
    let mut stack: Vec<(PathBuf, PathBuf)> = vec![(src.to_path_buf(), dst.to_path_buf())];
    while let Some((from, to)) = stack.pop() {
        std::fs::create_dir_all(&to)?;
        for entry in std::fs::read_dir(&from)? {
            let entry = entry?;
            let ft = entry.file_type()?;
            let name = entry.file_name();
            let (src_p, dst_p) = (entry.path(), to.join(&name));
            if ft.is_symlink() {
                return Err(AppError::InvalidInput(format!("symlink not allowed: {}", src_p.display())));
            }
            if ft.is_dir() {
                stack.push((src_p, dst_p));
            } else if ft.is_file() {
                files += 1;
                bytes += entry.metadata()?.len();
                if files > MAX_FILES || bytes > MAX_TOTAL_BYTES {
                    return Err(AppError::InvalidInput(format!(
                        "plugin too large (limit {MAX_FILES} files, {} MB)",
                        MAX_TOTAL_BYTES / 1024 / 1024
                    )));
                }
                std::fs::copy(&src_p, &dst_p)?;
            } else {
                return Err(AppError::InvalidInput(format!("special file not allowed: {}", src_p.display())));
            }
        }
    }
    Ok(())
}
