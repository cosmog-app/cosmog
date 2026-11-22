//! Document plumbing for document-editor plugins: whole-object reads and conditional writes
//! (decrypting and encrypting for encrypted buckets), plus the local draft store.
//! Drafts live in `<app_data>/plugin_drafts/<plugin>/<hash>.{bin,json}`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::store::{ObjectMeta, PutCond};

/// Same as the in-memory editor cap: a document goes through IPC whole.
pub const MAX_DOC_BYTES: usize = 64 * 1024 * 1024;

/// Binary IPC reply: `[u32 LE meta length][meta JSON][bytes]`. Avoids JSON number arrays.
pub fn frame<M: Serialize>(meta: &M, bytes: &[u8]) -> AppResult<Vec<u8>> {
    let m = serde_json::to_vec(meta).map_err(|e| AppError::Internal(e.to_string()))?;
    let mut out = Vec::with_capacity(4 + m.len() + bytes.len());
    out.extend_from_slice(&(m.len() as u32).to_le_bytes());
    out.extend_from_slice(&m);
    out.extend_from_slice(bytes);
    Ok(out)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocMeta {
    pub etag: Option<String>,
    pub content_type: Option<String>,
    pub last_modified: Option<i64>,
}

fn too_big(n: usize) -> AppError {
    AppError::EntityTooLarge(format!("document is {n} bytes, limit is {MAX_DOC_BYTES} bytes"))
}

async fn identity_for(account_id: &str, bucket: &str) -> AppResult<age::x25519::Identity> {
    let (aid, bkt) = (account_id.to_owned(), bucket.to_owned());
    let secret = tokio::task::spawn_blocking(move || crate::secrets::get_enc_identity(&aid, &bkt))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))??
        .ok_or_else(|| AppError::EncryptionIdentityMissing(format!("no identity for bucket '{bucket}'")))?;
    crate::crypto::parse_identity(&secret)
}

async fn decrypt(account_id: &str, bucket: &str, data: Vec<u8>) -> AppResult<Vec<u8>> {
    let identity = identity_for(account_id, bucket).await?;
    tokio::task::spawn_blocking(move || crate::crypto::decrypt_bytes(&identity, &data))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
}

/// Whole object as plaintext. The etag is read before the body, so a concurrent change can only
/// cause a false conflict on save, never a lost update.
pub async fn read(state: &AppState, account_id: &str, bucket: &str, key: &str) -> AppResult<(Vec<u8>, ObjectMeta)> {
    let store = state.store_for(account_id).await?;
    let head = store.head_object(bucket, key).await?;
    if head.size.max(0) as usize > MAX_DOC_BYTES {
        return Err(too_big(head.size as usize));
    }
    let data = store.read_object_full(bucket, key, MAX_DOC_BYTES as u64).await?;
    let marked = head.user_metadata.get("cosmog-encrypted").map(String::as_str) == Some("1");
    let age = crate::crypto::is_age_ciphertext(&data);
    // Trust the bytes over metadata: a stripped or forged marker must never hand ciphertext to a plugin.
    if marked && !age {
        return Err(AppError::DecryptionFailed("payload is not in the expected age format".into()));
    }
    let encrypted_bucket = state.db.get_encryption_config(account_id, bucket).await?.is_some();
    let plain = if age && (marked || encrypted_bucket) { decrypt(account_id, bucket, data).await? } else { data };
    Ok((plain, head))
}

/// Writes plaintext (encrypting for encrypted buckets) only if `cond` holds; returns the new etag.
pub async fn write(
    state: &AppState,
    account_id: &str,
    bucket: &str,
    key: &str,
    mime: &str,
    data: Vec<u8>,
    cond: PutCond,
) -> AppResult<Option<String>> {
    if data.len() > MAX_DOC_BYTES {
        return Err(too_big(data.len()));
    }
    let store = state.store_for(account_id).await?;
    let (data, md) = crate::commands::objects::encrypt_for_bucket(state, account_id, bucket, data).await?;
    let etag = store.put_object_bytes_if(bucket, key, mime, data, md, cond).await?;
    // Keep the browser listing fresh; a failed refresh only means a stale row until next sync.
    match store.head_object(bucket, key).await {
        Ok(meta) => {
            let _ = state.db.cache_upsert_object(account_id, bucket, &meta).await;
            Ok(etag.or(meta.etag))
        }
        Err(_) => Ok(etag),
    }
}

// ── drafts ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DraftMeta {
    /// Etag of the object the draft was edited from; `None` for a never-saved file.
    pub base_etag: Option<String>,
    pub saved_at: i64,
    /// Body is age ciphertext for the bucket's recipient.
    pub encrypted: bool,
}

/// One draft per (plugin, account, bucket, key). The name is a hash so keys never reach the path.
pub fn draft_paths(root: &Path, plugin_id: &str, account_id: &str, bucket: &str, key: &str) -> (PathBuf, PathBuf) {
    let mut h = blake3::Hasher::new();
    for part in [account_id, bucket, key] {
        h.update(part.as_bytes());
        h.update(&[0]);
    }
    let name = h.finalize().to_hex();
    let dir = root.join(plugin_id);
    (dir.join(format!("{name}.bin")), dir.join(format!("{name}.json")))
}

fn write_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    // Unique per write: two writers sharing one tmp file could swap body and meta.
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".{}.tmp", uuid::Uuid::new_v4().simple()));
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, data)?;
    std::fs::rename(&tmp, path)
}

/// Body first, meta last: a draft only counts once its meta exists.
pub fn draft_store(bin: &Path, json: &Path, body: &[u8], meta: &DraftMeta) -> AppResult<()> {
    if let Some(dir) = bin.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let m = serde_json::to_vec(meta).map_err(|e| AppError::Internal(e.to_string()))?;
    let _ = std::fs::remove_file(json);
    write_atomic(bin, body)?;
    write_atomic(json, &m)?;
    Ok(())
}

pub fn draft_load(bin: &Path, json: &Path) -> AppResult<Option<(Vec<u8>, DraftMeta)>> {
    let m = match std::fs::read(json) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let meta: DraftMeta = serde_json::from_slice(&m).map_err(|e| AppError::Internal(format!("draft meta: {e}")))?;
    Ok(Some((std::fs::read(bin)?, meta)))
}

pub fn draft_remove(bin: &Path, json: &Path) -> AppResult<()> {
    for p in [json, bin] {
        match std::fs::remove_file(p) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
    }
    Ok(())
}

/// Encrypts the draft body when the bucket is encrypted, so a draft is never a plaintext copy.
pub async fn seal_draft(state: &AppState, account_id: &str, bucket: &str, body: Vec<u8>) -> AppResult<(Vec<u8>, bool)> {
    let Some(cfg) = state.db.get_encryption_config(account_id, bucket).await? else {
        return Ok((body, false));
    };
    let recipient = crate::crypto::parse_recipient(&cfg.recipient)?;
    let sealed = tokio::task::spawn_blocking(move || crate::crypto::encrypt_bytes(&recipient, &body))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))??;
    Ok((sealed, true))
}

pub async fn open_draft(account_id: &str, bucket: &str, body: Vec<u8>, meta: &DraftMeta) -> AppResult<Vec<u8>> {
    if meta.encrypted { decrypt(account_id, bucket, body).await } else { Ok(body) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_layout() {
        let out = frame(&serde_json::json!({ "etag": "x" }), b"abc").unwrap();
        let n = u32::from_le_bytes(out[..4].try_into().unwrap()) as usize;
        assert_eq!(&out[4..4 + n], br#"{"etag":"x"}"#);
        assert_eq!(&out[4 + n..], b"abc");
    }

    #[test]
    fn draft_paths_hash_keys_and_separate_parts() {
        let root = Path::new("/r");
        let (a, _) = draft_paths(root, "excalidraw", "acc", "b", "../../etc/passwd");
        assert!(a.starts_with("/r/excalidraw"));
        assert!(!a.to_string_lossy().contains(".."));
        // "ab"+"c" must not collide with "a"+"bc".
        let (x, _) = draft_paths(root, "p", "acc", "ab", "c");
        let (y, _) = draft_paths(root, "p", "acc", "a", "bc");
        assert_ne!(x, y);
    }

    #[test]
    fn draft_roundtrip_and_remove() {
        let dir = tempfile::tempdir().unwrap();
        let (bin, json) = draft_paths(dir.path(), "p", "a", "b", "k.excalidraw");
        assert!(draft_load(&bin, &json).unwrap().is_none());
        let meta = DraftMeta { base_etag: Some("\"e1\"".into()), saved_at: 5, encrypted: false };
        draft_store(&bin, &json, b"v1", &meta).unwrap();
        draft_store(&bin, &json, b"v2", &meta).unwrap();
        let (body, got) = draft_load(&bin, &json).unwrap().unwrap();
        assert_eq!(body, b"v2");
        assert_eq!(got, meta);
        draft_remove(&bin, &json).unwrap();
        assert!(draft_load(&bin, &json).unwrap().is_none());
        draft_remove(&bin, &json).unwrap();
    }
}
