mod common;

use std::path::{Path, PathBuf};

use cosmog_lib::plugins::{dev, PluginRegistry};

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/plugins/hello")
}

const APP: &str = env!("CARGO_PKG_VERSION");

/// Copy of the fixture with a patched manifest, for negative cases.
fn patched(td: &Path, f: impl FnOnce(&mut serde_json::Value)) -> PathBuf {
    let dst = td.join(format!("src-{}", uuid::Uuid::new_v4()));
    dev::copy_tree(&fixture(), &dst).unwrap();
    let mf = dst.join("cosmog-plugin.json");
    let mut v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&mf).unwrap()).unwrap();
    f(&mut v);
    std::fs::write(&mf, v.to_string()).unwrap();
    dst
}

#[tokio::test]
async fn dev_load_installs_files_row_and_registry() {
    let (db, td) = common::tmp_db().await;
    let reg = PluginRegistry::new(td.path().join("plugins"));
    let m = dev::load_unpacked(&db, &reg, &fixture(), APP).await.unwrap();
    assert_eq!((m.id.as_str(), m.version.as_str()), ("hello", "0.1.0"));

    let installed = reg.root().join("hello/0.1.0");
    for f in ["cosmog-plugin.json", "index.html", "main.js", "worker.js", "style.css"] {
        assert_eq!(std::fs::read(installed.join(f)).unwrap(), std::fs::read(fixture().join(f)).unwrap(), "{f}");
    }

    let rows = db.plugins_list().await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].source, "dev");
    assert!(rows[0].enabled);
    assert!(rows[0].key_id.is_none());

    let p = reg.get("hello").unwrap();
    assert!(p.enabled && p.compatible);
    assert_eq!(p.manifest.name, "Hello (sandbox test)");
    // No staging leftovers.
    let leftovers: Vec<_> = std::fs::read_dir(reg.root()).unwrap().flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(".staging")).collect();
    assert!(leftovers.is_empty());
}

#[tokio::test]
async fn reload_new_version_replaces_old_and_keeps_disabled_flag() {
    let (db, td) = common::tmp_db().await;
    let reg = PluginRegistry::new(td.path().join("plugins"));
    dev::load_unpacked(&db, &reg, &fixture(), APP).await.unwrap();
    db.plugin_set_enabled("hello", false).await.unwrap();

    let v2 = patched(td.path(), |v| v["version"] = "0.2.0".into());
    dev::load_unpacked(&db, &reg, &v2, APP).await.unwrap();
    assert!(!reg.root().join("hello/0.1.0").exists());
    assert!(reg.root().join("hello/0.2.0/index.html").is_file());
    let p = reg.get("hello").unwrap();
    assert_eq!(p.version, "0.2.0");
    assert!(!p.enabled, "user's disabled flag survives a reload");
}

#[tokio::test]
async fn invalid_or_foreign_plugin_not_installed() {
    let (db, td) = common::tmp_db().await;
    let reg = PluginRegistry::new(td.path().join("plugins"));
    let mobile = patched(td.path(), |v| v["platforms"] = serde_json::json!(["mobile"]));
    let err = dev::load_unpacked(&db, &reg, &mobile, APP).await.unwrap_err();
    assert!(err.detail().contains("platform"), "{err}");

    let api2 = patched(td.path(), |v| v["apiVersion"] = 2.into());
    assert!(dev::load_unpacked(&db, &reg, &api2, APP).await.is_err());

    let no_entry = patched(td.path(), |v| v["entry"] = "nope.html".into());
    assert!(dev::load_unpacked(&db, &reg, &no_entry, APP).await.unwrap_err().detail().contains("nope.html"));

    assert!(db.plugins_list().await.unwrap().is_empty());
    assert!(reg.list().is_empty());
    assert!(!reg.root().join("hello").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn symlink_in_package_refused_and_cleaned_up() {
    let (db, td) = common::tmp_db().await;
    let reg = PluginRegistry::new(td.path().join("plugins"));
    let src = patched(td.path(), |_| {});
    std::os::unix::fs::symlink("/etc/hostname", src.join("leak.txt")).unwrap();
    let err = dev::load_unpacked(&db, &reg, &src, APP).await.unwrap_err();
    assert!(err.detail().contains("symlink"), "{err}");
    let entries: Vec<_> = std::fs::read_dir(reg.root()).map(|r| r.flatten().collect()).unwrap_or_default();
    assert!(entries.is_empty(), "staging removed, nothing installed");
}

#[tokio::test]
async fn remove_deletes_row_files_and_registry_entry() {
    let (db, td) = common::tmp_db().await;
    let reg = PluginRegistry::new(td.path().join("plugins"));
    dev::load_unpacked(&db, &reg, &fixture(), APP).await.unwrap();
    dev::remove(&db, &reg, "hello").await.unwrap();
    assert!(db.plugins_list().await.unwrap().is_empty());
    assert!(reg.get("hello").is_none());
    assert!(!reg.root().join("hello").exists());
    assert!(dev::remove(&db, &reg, "../etc").await.is_err());
}

#[tokio::test]
async fn missing_files_marks_incompatible_on_reload() {
    let (db, td) = common::tmp_db().await;
    let reg = PluginRegistry::new(td.path().join("plugins"));
    dev::load_unpacked(&db, &reg, &fixture(), APP).await.unwrap();
    std::fs::remove_dir_all(reg.root().join("hello")).unwrap();
    reg.reload(&db).await.unwrap();
    let p = reg.get("hello").unwrap();
    assert!(!p.compatible, "row from a restored DB without files is listed but not served");
}

#[tokio::test]
async fn set_enabled_unknown_id_reports_false() {
    let (db, _td) = common::tmp_db().await;
    assert!(!db.plugin_set_enabled("ghost", true).await.unwrap());
}
