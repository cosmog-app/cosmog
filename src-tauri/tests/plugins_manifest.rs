use cosmog_lib::error::AppError;
use cosmog_lib::plugins::manifest::{parse_semver, safe_rel_path, Manifest, Platform, PluginKind};

const APP: &str = "1.2.0";

fn base() -> serde_json::Value {
    serde_json::json!({
        "id": "excalidraw",
        "name": "Excalidraw",
        "version": "0.1.0",
        "apiVersion": 1,
        "kind": "document-editor",
        "entry": "index.html",
        "platforms": ["desktop"],
        "minAppVersion": "1.2.0",
        "fileTypes": [{ "ext": ".excalidraw", "mime": "application/vnd.excalidraw+json", "label": "Drawing", "template": "templates/empty.excalidraw" }],
        "permissions": []
    })
}

fn with(f: impl FnOnce(&mut serde_json::Value)) -> serde_json::Value {
    let mut v = base();
    f(&mut v);
    v
}

/// Parse + validate; returns the InvalidInput message on rejection.
fn check(v: serde_json::Value) -> Result<Manifest, String> {
    let m = Manifest::parse(&v.to_string()).map_err(|e| e.detail().to_string())?;
    match m.validate(APP) {
        Ok(()) => Ok(m),
        Err(AppError::InvalidInput(msg)) => Err(msg),
        Err(e) => panic!("unexpected error kind: {e}"),
    }
}

#[test]
fn valid_manifest_parses_all_fields() {
    let m = check(base()).expect("valid");
    assert_eq!(m.id, "excalidraw");
    assert_eq!(m.api_version, 1);
    assert_eq!(m.kind, PluginKind::DocumentEditor);
    assert_eq!(m.platforms, vec![Platform::Desktop]);
    assert_eq!(m.file_types[0].template.as_deref(), Some("templates/empty.excalidraw"));
    assert!(m.supports(Platform::Desktop));
    assert!(!m.supports(Platform::Mobile));
}

#[test]
fn bad_ids_rejected() {
    for id in ["", "a", "Excalidraw", "1draw", "ex_draw", "ex draw", "../x", &"a".repeat(41)] {
        let err = check(with(|v| v["id"] = id.into())).expect_err(id);
        assert!(err.contains("id"), "{id}: {err}");
    }
    assert!(check(with(|v| v["id"] = "my-plugin2".into())).is_ok());
}

#[test]
fn platforms_required_and_known() {
    let missing = with(|v| {
        v.as_object_mut().unwrap().remove("platforms");
    });
    assert!(check(missing).unwrap_err().contains("platforms"));
    assert!(check(with(|v| v["platforms"] = serde_json::json!([]))).unwrap_err().contains("platforms"));
    assert!(check(with(|v| v["platforms"] = serde_json::json!(["ios"]))).is_err());
    let both = check(with(|v| v["platforms"] = serde_json::json!(["desktop", "mobile"]))).unwrap();
    assert!(both.supports(Platform::Mobile) && both.supports(Platform::Desktop));
}

#[test]
fn current_platform_is_desktop_on_test_host() {
    assert_eq!(Platform::current(), Platform::Desktop);
}

#[test]
fn unsupported_api_version_rejected() {
    let err = check(with(|v| v["apiVersion"] = 2.into())).unwrap_err();
    assert!(err.contains("apiVersion 2"), "{err}");
}

#[test]
fn unknown_kind_and_fields_rejected() {
    assert!(check(with(|v| v["kind"] = "panel".into())).is_err());
    assert!(check(with(|v| v["extra"] = 1.into())).is_err());
}

#[test]
fn reserved_permissions_rejected_for_now() {
    for p in ["storage:workspace", "network:example.com", "anything"] {
        let err = check(with(|v| v["permissions"] = serde_json::json!([p]))).unwrap_err();
        assert!(err.contains("permission"), "{p}: {err}");
    }
}

#[test]
fn min_app_version_enforced() {
    assert!(check(with(|v| v["minAppVersion"] = "1.1.99".into())).is_ok());
    let err = check(with(|v| v["minAppVersion"] = "1.3.0".into())).unwrap_err();
    assert!(err.contains("1.3.0"), "{err}");
    assert!(check(with(|v| v["minAppVersion"] = "1.3".into())).is_err());
}

#[test]
fn unsafe_entry_and_template_rejected() {
    for p in ["../index.html", "/index.html", "a/../b.html", "a\\b.html", "./index.html", "a//b", ""] {
        assert!(check(with(|v| v["entry"] = p.into())).unwrap_err().contains("entry"), "entry {p:?}");
        let t = with(|v| v["fileTypes"][0]["template"] = p.into());
        assert!(check(t).unwrap_err().contains("template"), "template {p:?}");
    }
}

#[test]
fn bad_file_type_ext_rejected() {
    for ext in ["excalidraw", ".", ".EXC", ".a b", ".a/b"] {
        assert!(check(with(|v| v["fileTypes"][0]["ext"] = ext.into())).is_err(), "{ext}");
    }
}

#[test]
fn semver_strict() {
    assert_eq!(parse_semver("1.2.3"), Some((1, 2, 3)));
    assert_eq!(parse_semver("10.0.42"), Some((10, 0, 42)));
    for bad in ["1.2", "1.2.3.4", "01.2.3", "1.2.x", "1.2.3-beta", "", "v1.2.3"] {
        assert_eq!(parse_semver(bad), None, "{bad}");
    }
}

#[test]
fn safe_rel_path_rules() {
    assert!(safe_rel_path("assets/fonts/x.woff2").is_ok());
    for bad in ["..", "a/..", "/etc/passwd", "a\\b", "a/./b", "a\0b", "C:/x"] {
        // "C:/x" is a Normal component on unix; only flagged on Windows.
        if bad == "C:/x" && !cfg!(windows) {
            continue;
        }
        assert!(safe_rel_path(bad).is_err(), "{bad:?}");
    }
}

#[tokio::test]
async fn validate_files_requires_entry_and_templates() {
    let dir = tempfile::tempdir().unwrap();
    let m = check(base()).unwrap();
    assert!(m.validate_files(dir.path()).await.unwrap_err().detail().contains("index.html"));
    std::fs::write(dir.path().join("index.html"), "<p>").unwrap();
    assert!(m.validate_files(dir.path()).await.unwrap_err().detail().contains("templates/empty.excalidraw"));
    std::fs::create_dir_all(dir.path().join("templates")).unwrap();
    std::fs::write(dir.path().join("templates/empty.excalidraw"), "{}").unwrap();
    m.validate_files(dir.path()).await.unwrap();
}

#[tokio::test]
async fn hello_fixture_is_valid() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/plugins/hello");
    let m = Manifest::read(&dir).await.unwrap();
    m.validate(env!("CARGO_PKG_VERSION")).unwrap();
    m.validate_files(&dir).await.unwrap();
    assert_eq!(m.id, "hello");
}
