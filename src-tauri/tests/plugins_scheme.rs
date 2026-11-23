mod common;

use std::path::{Path, PathBuf};

use cosmog_lib::db::Db;
use cosmog_lib::plugins::scheme::{inject_lockdown, mime_for, resolve, serve, PLUGIN_CSP};
use cosmog_lib::plugins::{dev, PluginRegistry};
use tauri::http::{header, Method, Request, StatusCode};

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/plugins/hello")
}

/// Fresh DB + plugin root with the hello fixture dev-loaded.
async fn setup() -> (Db, PluginRegistry, tempfile::TempDir) {
    let (db, td) = common::tmp_db().await;
    let reg = PluginRegistry::new(td.path().join("plugins"));
    dev::load_unpacked(&db, &reg, &fixture(), env!("CARGO_PKG_VERSION")).await.unwrap();
    (db, reg, td)
}

fn req(method: Method, path: &str) -> Request<Vec<u8>> {
    Request::builder().method(method).uri(format!("cosmog-plugin://localhost{path}")).body(Vec::new()).unwrap()
}

#[tokio::test]
async fn serves_entry_with_csp_and_mime() {
    let (_db, reg, _td) = setup().await;
    let resp = serve(reg.root(), &reg, &req(Method::GET, "/hello/0.1.0/index.html")).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let h = resp.headers();
    assert_eq!(h[header::CONTENT_TYPE], "text/html; charset=utf-8");
    assert_eq!(h[header::CONTENT_SECURITY_POLICY], PLUGIN_CSP);
    assert_eq!(h[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    assert_eq!(h[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
    assert_eq!(h["x-dns-prefetch-control"], "off");
    let expected = inject_lockdown(&std::fs::read(fixture().join("index.html")).unwrap());
    assert_eq!(resp.body(), &expected);

    let js = serve(reg.root(), &reg, &req(Method::GET, "/hello/0.1.0/main.js")).await;
    assert_eq!(js.headers()[header::CONTENT_TYPE], "text/javascript; charset=utf-8");
}

#[test]
fn csp_blocks_network_and_framing() {
    for d in ["connect-src 'none'", "frame-src 'none'", "object-src 'none'", "form-action 'none'", "default-src 'none'"] {
        assert!(PLUGIN_CSP.contains(d), "{d}");
    }
    assert!(!PLUGIN_CSP.contains("https:"), "no remote sources");
    assert!(!PLUGIN_CSP.contains("'unsafe-eval'"), "only wasm eval");
}

#[tokio::test]
async fn error_responses_still_carry_csp() {
    let (_db, reg, _td) = setup().await;
    let resp = serve(reg.root(), &reg, &req(Method::GET, "/hello/0.1.0/nope.js")).await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    assert_eq!(resp.headers()[header::CONTENT_SECURITY_POLICY], PLUGIN_CSP);
}

#[tokio::test]
async fn traversal_and_malformed_paths_refused() {
    let (_db, reg, td) = setup().await;
    std::fs::write(td.path().join("secret.txt"), "s3cr3t").unwrap();
    let root = reg.root();
    let cases = [
        ("/hello/0.1.0/../../../secret.txt", StatusCode::BAD_REQUEST),
        ("/hello/0.1.0/%2e%2e/%2e%2e/%2e%2e/secret.txt", StatusCode::BAD_REQUEST),
        ("/hello/0.1.0/..%2F..%2F..%2Fsecret.txt", StatusCode::BAD_REQUEST),
        ("/hello/0.1.0/a\\..\\b", StatusCode::BAD_REQUEST),
        ("/hello/0.1.0//etc/passwd", StatusCode::BAD_REQUEST),
        ("/hello/0.1.0/./index.html", StatusCode::BAD_REQUEST),
        ("/hello/0.1.0/", StatusCode::BAD_REQUEST),
        ("/hello/0.1.0", StatusCode::NOT_FOUND),
        ("/hello/9.9.9/index.html", StatusCode::NOT_FOUND),
        ("/other/0.1.0/index.html", StatusCode::NOT_FOUND),
        ("/hello/0.1.0/missing.html", StatusCode::NOT_FOUND),
    ];
    for (path, want) in cases {
        assert_eq!(resolve(root, &reg, path).unwrap_err(), want, "{path}");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn symlink_escape_refused() {
    let (_db, reg, td) = setup().await;
    let outside = td.path().join("outside.txt");
    std::fs::write(&outside, "x").unwrap();
    let dir = reg.root().join("hello/0.1.0");
    std::os::unix::fs::symlink(&outside, dir.join("link.txt")).unwrap();
    assert_eq!(resolve(reg.root(), &reg, "/hello/0.1.0/link.txt").unwrap_err(), StatusCode::FORBIDDEN);
    // A symlinked directory pointing outside is refused the same way.
    std::os::unix::fs::symlink(td.path(), dir.join("up")).unwrap();
    assert_eq!(resolve(reg.root(), &reg, "/hello/0.1.0/up/outside.txt").unwrap_err(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn disabled_plugin_not_served() {
    let (db, reg, _td) = setup().await;
    db.plugin_set_enabled("hello", false).await.unwrap();
    reg.reload(&db).await.unwrap();
    let resp = serve(reg.root(), &reg, &req(Method::GET, "/hello/0.1.0/index.html")).await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    db.plugin_set_enabled("hello", true).await.unwrap();
    reg.reload(&db).await.unwrap();
    assert!(resolve(reg.root(), &reg, "/hello/0.1.0/index.html").is_ok());
}

#[tokio::test]
async fn only_get_and_head() {
    let (_db, reg, _td) = setup().await;
    let post = serve(reg.root(), &reg, &req(Method::POST, "/hello/0.1.0/index.html")).await;
    assert_eq!(post.status(), StatusCode::METHOD_NOT_ALLOWED);
    let head = serve(reg.root(), &reg, &req(Method::HEAD, "/hello/0.1.0/index.html")).await;
    assert_eq!(head.status(), StatusCode::OK);
    assert!(head.body().is_empty());
}

#[test]
fn mime_table() {
    for (f, m) in [
        ("a.wasm", "application/wasm"),
        ("a.WOFF2", "font/woff2"),
        ("a.svg", "image/svg+xml"),
        ("a.mjs", "text/javascript; charset=utf-8"),
        ("a.bin", "application/octet-stream"),
        ("noext", "application/octet-stream"),
    ] {
        assert_eq!(mime_for(Path::new(f)), m, "{f}");
    }
}

#[test]
fn lockdown_runs_before_any_plugin_script() {
    let tag = r#"<script src="/__cosmog/lockdown.js"></script>"#;
    let out = String::from_utf8(inject_lockdown(b"<!doctype html><HTML><Head lang=x><script src=a.js></script></head>")).unwrap();
    assert_eq!(out, format!("<!doctype html><HTML><Head lang=x>{tag}<script src=a.js></script></head>"));
    // No <head>: still first.
    let out = String::from_utf8(inject_lockdown(b"<script src=a.js></script>")).unwrap();
    assert!(out.starts_with(tag));
    // Fixture page: the tag precedes the fixture's own first script.
    let html = String::from_utf8(inject_lockdown(&std::fs::read(fixture().join("index.html")).unwrap())).unwrap();
    let first = html.find("<script").unwrap();
    assert!(html[first..].starts_with(tag), "first script is the lockdown");
}

#[tokio::test]
async fn lockdown_script_is_served_with_csp_and_strips_rtc() {
    let (_db, reg, _td) = setup().await;
    let resp = serve(reg.root(), &reg, &req(Method::GET, "/__cosmog/lockdown.js")).await;
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(resp.headers()[header::CONTENT_TYPE], "text/javascript; charset=utf-8");
    assert_eq!(resp.headers()[header::CONTENT_SECURITY_POLICY], PLUGIN_CSP);
    let js = String::from_utf8(resp.body().clone()).unwrap();
    assert!(js.contains("RTC") && js.contains("lockFrames"));
}
