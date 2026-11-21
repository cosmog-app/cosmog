//! Store installs without network: real zips, real signatures, a throwaway trusted key.
#![cfg(not(target_os = "android"))]

mod common;

use std::io::Write;
use std::path::Path;

use aws_lc_rs::signature::{Ed25519KeyPair, KeyPair};
use base64::Engine;
use cosmog_lib::plugins::store::index::{Download, StoreEntry};
use cosmog_lib::plugins::store::install::{check_package, install_package, unpack};
use cosmog_lib::plugins::store::keys::{sha256_hex, statement, TrustedKey};
use cosmog_lib::plugins::{plugin_dir, PluginRegistry};

const APP: &str = env!("CARGO_PKG_VERSION");

fn fixture_file(name: &str) -> Vec<u8> {
    std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/plugins/hello").join(name)).unwrap()
}

/// The hello fixture as a store package at `version`.
fn package(version: &str) -> Vec<u8> {
    let mut manifest: serde_json::Value = serde_json::from_slice(&fixture_file("cosmog-plugin.json")).unwrap();
    manifest["version"] = version.into();
    let mut files = vec![("cosmog-plugin.json".to_owned(), manifest.to_string().into_bytes())];
    for f in ["index.html", "main.js", "style.css", "worker.js"] {
        files.push((f.to_owned(), fixture_file(f)));
    }
    zip_of(&files)
}

fn zip_of(files: &[(String, Vec<u8>)]) -> Vec<u8> {
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (name, data) in files {
        w.start_file(name.as_str(), opts).unwrap();
        w.write_all(data).unwrap();
    }
    w.finish().unwrap().into_inner()
}

struct Signer {
    kp: Ed25519KeyPair,
    keys: Vec<TrustedKey>,
}

impl Signer {
    fn new() -> Self {
        let kp = Ed25519KeyPair::generate().unwrap();
        let public: [u8; 32] = kp.public_key().as_ref().try_into().unwrap();
        Self { kp, keys: vec![TrustedKey { id: "test-1", public }] }
    }

    fn entry(&self, id: &str, version: &str, data: &[u8]) -> StoreEntry {
        let sha = sha256_hex(data);
        let sig = self.kp.sign(statement(id, version, &sha).as_bytes());
        serde_json::from_value(serde_json::json!({
            "id": id, "name": "Hello", "version": version, "platforms": ["desktop"],
            "download": {
                "url": "https://example.invalid/p.zip", "size": data.len(), "sha256": sha, "keyId": "test-1",
                "signature": base64::engine::general_purpose::STANDARD.encode(sig.as_ref()),
            }
        }))
        .unwrap()
    }
}

fn with_download(e: &StoreEntry, f: impl FnOnce(&mut Download)) -> StoreEntry {
    let mut e = e.clone();
    f(&mut e.download);
    e
}

#[test]
fn check_package_rejects_tampering() {
    let s = Signer::new();
    let data = package("0.1.0");
    let good = s.entry("hello", "0.1.0", &data);
    assert_eq!(check_package(&good, &data, &s.keys).unwrap(), sha256_hex(&data));

    let mut flipped = data.clone();
    let mid = flipped.len() / 2;
    flipped[mid] ^= 1;
    assert!(check_package(&good, &flipped, &s.keys).is_err(), "changed bytes");

    // Catalog rewritten to match tampered bytes, but the signature still covers the old hash.
    let rehashed = with_download(&good, |d| d.sha256 = sha256_hex(&flipped));
    assert!(check_package(&rehashed, &flipped, &s.keys).is_err(), "signature over the old hash");

    let untrusted = Signer::new().entry("hello", "0.1.0", &data);
    assert!(check_package(&untrusted, &data, &s.keys).is_err(), "signed by an untrusted key");

    let wrong_size = with_download(&good, |d| d.size += 1);
    assert!(check_package(&wrong_size, &data, &s.keys).is_err(), "size mismatch");
}

#[test]
fn unpack_refuses_paths_that_escape() {
    for bad in ["../evil.js", "/abs.js", "a/../../evil.js", "a\\b.js"] {
        let td = tempfile::tempdir().unwrap();
        let z = zip_of(&[(bad.to_owned(), b"x".to_vec())]);
        assert!(unpack(&z, td.path()).is_err(), "{bad} accepted");
        assert!(!td.path().parent().unwrap().join("evil.js").exists());
    }
}

#[test]
fn unpack_refuses_symlinks() {
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    w.add_symlink("link", "/etc/passwd", zip::write::SimpleFileOptions::default()).unwrap();
    let z = w.finish().unwrap().into_inner();
    let td = tempfile::tempdir().unwrap();
    assert!(unpack(&z, td.path()).is_err());
    assert!(!td.path().join("link").exists());
}

#[tokio::test]
async fn install_then_update_keeps_one_previous_version() {
    let (db, td) = common::tmp_db().await;
    let reg = PluginRegistry::new(td.path().join("plugins"));
    let s = Signer::new();

    for v in ["0.1.0", "0.2.0", "0.3.0"] {
        let data = package(v);
        let m = install_package(&db, &reg, &s.entry("hello", v, &data), data, APP, &s.keys).await.unwrap();
        assert_eq!(m.version, v);
    }

    let p = reg.get("hello").unwrap();
    assert_eq!((p.version.as_str(), p.source.as_str(), p.compatible), ("0.3.0", "registry", true));
    let row = db.plugins_list().await.unwrap().into_iter().find(|r| r.id == "hello").unwrap();
    assert_eq!(row.prev_version.as_deref(), Some("0.2.0"));
    assert_eq!(row.key_id.as_deref(), Some("test-1"));
    let root = reg.root();
    assert!(plugin_dir(root, "hello", "0.3.0").join("index.html").is_file());
    assert!(plugin_dir(root, "hello", "0.2.0").is_dir(), "rollback copy kept");
    assert!(!plugin_dir(root, "hello", "0.1.0").exists(), "older versions removed");
    let leftovers = std::fs::read_dir(root).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().starts_with(".staging")).count();
    assert_eq!(leftovers, 0);
}

#[tokio::test]
async fn install_refuses_downgrade_of_a_store_install() {
    let (db, td) = common::tmp_db().await;
    let reg = PluginRegistry::new(td.path().join("plugins"));
    let s = Signer::new();
    let new = package("0.2.0");
    install_package(&db, &reg, &s.entry("hello", "0.2.0", &new), new, APP, &s.keys).await.unwrap();
    // An old release is still validly signed; a catalog pointing back at it must not win.
    let old = package("0.1.0");
    let err = install_package(&db, &reg, &s.entry("hello", "0.1.0", &old), old, APP, &s.keys).await.unwrap_err();
    assert!(err.to_string().contains("older than the installed 0.2.0"), "{err}");
    assert_eq!(reg.get("hello").unwrap().version, "0.2.0");
    // Reinstalling the same version is fine (repairs a damaged copy).
    let same = package("0.2.0");
    install_package(&db, &reg, &s.entry("hello", "0.2.0", &same), same, APP, &s.keys).await.unwrap();
}

#[tokio::test]
async fn reinstalling_the_same_version_keeps_the_rollback_copy() {
    let (db, td) = common::tmp_db().await;
    let reg = PluginRegistry::new(td.path().join("plugins"));
    let s = Signer::new();
    for v in ["0.1.0", "0.2.0", "0.2.0"] {
        let data = package(v);
        install_package(&db, &reg, &s.entry("hello", v, &data), data, APP, &s.keys).await.unwrap();
    }
    let row = db.plugins_list().await.unwrap().into_iter().find(|r| r.id == "hello").unwrap();
    assert_eq!(row.prev_version.as_deref(), Some("0.1.0"));
    assert!(plugin_dir(reg.root(), "hello", "0.1.0").is_dir());
    assert!(plugin_dir(reg.root(), "hello", "0.2.0").join("index.html").is_file());
}

#[tokio::test]
async fn install_refuses_package_that_is_not_the_listed_plugin() {
    let (db, td) = common::tmp_db().await;
    let reg = PluginRegistry::new(td.path().join("plugins"));
    let s = Signer::new();
    // Validly signed for "hello 0.2.0", but the zip's manifest says 0.1.0.
    let data = package("0.1.0");
    let entry = s.entry("hello", "0.2.0", &data);
    let err = install_package(&db, &reg, &entry, data, APP, &s.keys).await.unwrap_err();
    assert!(err.to_string().contains("expected hello 0.2.0"), "{err}");
    assert!(reg.get("hello").is_none());
    assert!(!reg.root().join("hello").join("0.1.0").exists());
}

/// Cross-check with the real pipeline: a package from cosmog-plugins `scripts/pack.mjs`, signed with
/// the production key, must install with the keys compiled into the app.
/// Run: COSMOG_PACKED=<cosmog-plugins>/release/<id> cargo test --test plugins_store -- --ignored
#[tokio::test]
#[ignore]
async fn package_from_pack_script_installs_with_production_keys() {
    let base = std::env::var("COSMOG_PACKED").expect("COSMOG_PACKED=<release dir>/<id>");
    let entry: StoreEntry = serde_json::from_slice(&std::fs::read(format!("{base}.entry.json")).unwrap()).unwrap();
    let data = std::fs::read(format!("{base}-{}.zip", entry.version)).unwrap();
    let (db, td) = common::tmp_db().await;
    let reg = PluginRegistry::new(td.path().join("plugins"));
    let keys = cosmog_lib::plugins::store::keys::TRUSTED_KEYS;
    let m = install_package(&db, &reg, &entry, data, APP, keys).await.unwrap();
    assert_eq!(m.id, entry.id);
    let p = reg.get(&entry.id).unwrap();
    assert!(p.compatible && p.icon.as_deref().is_some_and(|i| i.starts_with("data:image/")));
}
