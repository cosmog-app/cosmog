# Plugin System: Implementation Plan

Status: Phase 1 runtime built 2026-11-18; manual sandbox matrix pending. First plugin: Excalidraw (desktop only).

## Goal

Users install plugins at runtime from a Plugins tab. Plugins are not shipped with the app. A plugin uses
Cosmog's accounts and S3 layer for storage without ever seeing credentials, keys or the Tauri IPC.

First target: an Excalidraw plugin that stores many drawings in user-chosen bucket locations, with
open, edit and save from both the plugin page and the bucket browser.

## Decisions

| Topic | Decision |
| --- | --- |
| Runtime | Signed web bundle (zip) in a sandboxed iframe, talking to the host via `postMessage` |
| Trust | First-party only. App trusts plugins signed by keys compiled into the app |
| Platforms | Manifest `platforms` is required: `"desktop"`, `"mobile"` or both. Excalidraw is desktop only |
| Storage | Several workspaces per plugin (account + bucket + prefix), added by the user |
| File UI | Cosmog renders the document shell (file list, tabs, save, conflicts). Plugin renders the editor only |
| Open with | Allowed for files outside workspaces; scoped to that one object for that tab |
| Saving | Manual (Ctrl+S / Save). Local draft kept until saved. Unsaved-changes guard on close |
| Images | Embedded base64 in the `.excalidraw` JSON (portable to excalidraw.com) |
| Updates | Badge + user clicks update. Permission increases shown first. Previous version kept for rollback |
| Registry | Separate GitHub repo `cosmog-plugins`: `index.json` on main, zips as release assets |
| Sources | Plugin SDK and plugin sources live in `cosmog-plugins`, with CI that builds, signs and releases |
| New Rust deps | `reqwest` (rustls), `zip`, `ed25519-dalek`, added in Phase 3 |

## Architecture

```shell
Plugins tab --install--> Rust: fetch index.json -> download zip -> verify sha256 + ed25519 (keyId)
                                                       \-> <app_data>/plugins/<id>/<version>/

Plugin page / "Open in <plugin>" from the browser
  DocumentShell (host, Solid)            file list, tabs, save, drafts, conflicts
    |  invoke() plugin_doc_read / plugin_doc_write (raw bytes, If-Match)
    |
    +-- <iframe sandbox="allow-scripts" src="cosmog-plugin://localhost/<id>/<ver>/index.html">
          ^  postMessage RPC (protocol v1)
          |  host -> plugin: doc.load, doc.serialize, ui.theme
          |  plugin -> host: ready, doc.dirty, shell.save
          v
        Plugin (e.g. React + @excalidraw/excalidraw), no storage, no network, no IPC
```

Key point: a `document-editor` plugin never touches storage. The host reads bytes, hands them to the
plugin, asks for bytes back and writes them. The plugin only sees the content of documents the user
opened in it.

## Security model

1. **No IPC in the iframe.** Since Tauri 2.0.0-beta.20, the IPC script is not injected into iframes and
   uninitialized frames are blocked by an invoke key. Exception: on Windows an iframe with the *same
   origin* as the app can reach IPC, so plugins are never served from the app origin. The app is on
   Tauri 2.12.0.
2. **Sandboxed, opaque origin.** `sandbox="allow-scripts"` without `allow-same-origin`: no parent DOM, no
   cookies, no shared storage, no top navigation, no popups, no forms.
3. **Strict CSP response header** on every plugin file, set by the scheme handler:
   `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline';
   img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'none';
   frame-src 'none'; form-action 'none'; base-uri 'none'`. No network, so no exfiltration.
4. **Sender identity from the frame.** The broker maps `event.source` to the iframe it created. It never
   trusts an id or plugin name inside the message.
5. **Narrow protocol.** Only the messages listed below. Unknown methods are rejected. Payload size capped.
6. **Signed packages.** See "Packaging and signing".
7. **Drafts of encrypted buckets are encrypted at rest** with the bucket's age recipient, so a draft is
   never a plaintext copy of an encrypted object.

Plugins never get: credentials, encryption keys, delete-bucket, ACL changes, presigned URLs, or arbitrary
key access. Storage RPC for plugins (the future `panel` kind) will be checked in Rust against grants, the
same pattern as `mcp_fs_root`.

## Manifest

`cosmog-plugin.json` at the zip root:

```json
{
  "id": "excalidraw",
  "name": "Excalidraw",
  "version": "0.1.0",
  "apiVersion": 1,
  "kind": "document-editor",
  "entry": "index.html",
  "platforms": ["desktop"],
  "minAppVersion": "1.2.0",
  "fileTypes": [
    { "ext": ".excalidraw", "mime": "application/vnd.excalidraw+json", "label": "Drawing", "template": "templates/empty.excalidraw" }
  ],
  "permissions": []
}
```

Validation (Rust, `plugins/manifest.rs`):

- `id`: `^[a-z][a-z0-9-]{1,39}$`. `version`: semver.
- `apiVersion`: must be in the app's `SUPPORTED_API_VERSIONS`; otherwise refuse with a clear error.
- `kind`: `document-editor` now; `panel` reserved.
- `platforms`: required, non-empty, values `desktop` | `mobile`. Must include the current platform to
  list, install or load.
- `entry` and `template` paths: relative, no `..`, must exist in the package.
- `permissions`: known values only. `document-editor` needs none. Reserved: `storage:workspace`,
  `network:<host>`.

## Packaging and signing

- Package: zip with the manifest at the root. Max 50 MB compressed, 200 MB extracted, 5000 entries.
- Extract with path checks: reject absolute paths, `..`, symlinks and duplicate names.
- Signed statement, so a valid signature cannot be reused for another plugin or an older version:

  ```text
  cosmog-plugin-v1
  <id>
  <version>
  <sha256 of zip, hex>
  ```

- Ed25519 over that statement. Each signature names a `keyId`.
- App holds `TRUSTED_KEYS: &[(key_id, pubkey)]` and `REVOKED_KEYS: &[key_id]`. Key rotation: add the new
  key in an app release, start signing with it, drop the old one a few releases later. Revoking needs
  an app release.
- Private key: GitHub Actions secret in `cosmog-plugins` only.
- Install checks: signature valid for a trusted, non-revoked key; sha256 matches; manifest `id` and
  `version` inside the zip match the statement. A version lower than the installed one is refused
  unless the user rolls back to the locally kept previous version.

## Registry

`https://raw.githubusercontent.com/<owner>/cosmog-plugins/main/index.json`:

```json
{
  "schema": 1,
  "plugins": [
    {
      "id": "excalidraw",
      "name": "Excalidraw",
      "description": "Whiteboard drawings stored in your buckets",
      "icon": "https://.../excalidraw.svg",
      "platforms": ["desktop"],
      "latest": {
        "version": "0.1.0",
        "apiVersion": 1,
        "minAppVersion": "1.2.0",
        "url": "https://github.com/<owner>/cosmog-plugins/releases/download/excalidraw-v0.1.0/excalidraw-0.1.0.zip",
        "sha256": "<hex>",
        "keyId": "cosmog-2026",
        "signature": "<base64>",
        "permissions": []
      }
    }
  ]
}
```

The index is unsigned; every entry is. Worst case, a tampered index hides updates. Fetched by Rust
(`reqwest`), so the app CSP does not change for downloads. Icons go through the same path and are
cached locally.

## Host to plugin protocol (v1)

Envelope: `{ "cosmog": 1, "id": "<n>", "method": "<name>", "params": {...} }`, reply
`{ "cosmog": 1, "id": "<n>", "result": ... }` or `{ ..., "error": { "code", "message" } }`. Events have no
`id`. Binary content travels as a transferred `ArrayBuffer`. Max 128 MB per message.

| Direction | Message | Meaning |
| --- | --- | --- |
| plugin -> host | `ready` `{ apiVersion }` | Plugin booted. Host refuses an unsupported version |
| host -> plugin | `doc.load` `{ name, mime, bytes, readOnly }` | Show this document |
| host -> plugin | `doc.serialize` -> `{ bytes }` | Return current content |
| host -> plugin | `doc.exportPreview` -> `{ png }` | Optional thumbnail |
| host -> plugin | `ui.theme` `{ mode: "light" \| "dark" }` | Theme changed |
| host -> plugin | `doc.saved` | The last `doc.serialize` result is stored; move the dirty baseline there. The host never serializes between a save's serialize and this event |
| plugin -> host | `doc.dirty` `{ dirty }` | Content changed since last load/save |
| plugin -> host | `shell.save` | User pressed Ctrl+S inside the iframe (keys do not bubble to the host) |
| plugin -> host | `ui.toast` `{ kind, text }` | Short message, rate limited |

The SDK (`@cosmog/plugin-sdk` in `cosmog-plugins`) wraps this in a typed client:
`onLoad`, `onSerialize`, `onExportPreview`, `onSaved`, `setDirty`, `requestSave`, `onTheme`, `toast`. The app
keeps its own copy of the protocol types in `src/types/index.ts`; `apiVersion` keeps both repos honest.

## Rust (`src-tauri/src/plugins/`)

| File | Purpose |
| --- | --- |
| `mod.rs` | `PluginRegistry` (managed by Tauri on its own, not on `AppState`, so the scheme can serve before `AppState` exists): installed plugins, platform filter, load at startup |
| `dev.rs` | Load unpacked from a folder (staging dir, no symlinks, size caps), remove |
| `manifest.rs` | Parse + validate manifest |
| `scheme.rs` | `cosmog-plugin` async URI scheme: path resolution, traversal guard, MIME, CSP header |
| `install.rs` | Phase 3: download, verify, extract, swap, rollback |
| `keys.rs` | Phase 3: `TRUSTED_KEYS`, `REVOKED_KEYS`, statement verify |
| `docs.rs` | Phase 2: draft store (age-encrypted for encrypted buckets) |

Commands (`commands/plugins.rs`, all `#[tracing::instrument(skip_all, err)]`):

- Phase 1: `plugin_list`, `plugin_dev_load(path)` (debug builds only), `plugin_remove`, `plugin_set_enabled`.
- Phase 2: `plugin_workspace_list/add/remove`, `plugin_doc_list(workspace_id)`,
  `plugin_doc_read(account, bucket, key)` -> raw bytes + etag (`tauri::ipc::Response`, no JSON number arrays),
  `plugin_doc_write(account, bucket, key, mime, if_match)` with a raw request body -> new etag,
  `plugin_doc_create/rename/delete`, `plugin_draft_get/put/clear`.
- Phase 3: `plugin_registry_fetch`, `plugin_install`, `plugin_update`, `plugin_rollback`.

Store change for conflicts (built 2026-11-20): a new `ObjectStore::put_object_bytes_if(.., PutCond)`
returns the new etag. `PutCond { if_match, if_none_match }`. `412 Precondition Failed` maps to the
existing `AppError::Conflict`. A HEAD + etag compare runs right before the put for providers that ignore
`If-Match`; stores without a native impl get that check as the trait default. Providers that refuse the
conditional headers outright (B2 answers `NotImplemented`) get one plain retry, and that store sends
plain puts from then on, relying on the HEAD check alone (a narrow race remains there).

Wire format (built 2026-11-20, `commands/plugin_docs.rs`, `src/api/plugins.ts`):

- Reads (`plugin_doc_read`, `plugin_draft_get`) return `[u32 LE meta len][meta JSON][bytes]` as a raw
  `tauri::ipc::Response`. An empty reply means no draft.
- Writes (`plugin_doc_write`, `plugin_draft_put`) send the bytes as the raw invoke body and their
  parameters as base64 JSON in an `x-cosmog-meta` header (keys may be non-ASCII).
- `plugin_doc_write` needs `ifMatch` (save) or `create` (new file); an unconditional write is refused.
- `plugin_template(pluginId, ext)` returns the template bytes, empty when the file type has none.
- Rename/delete use the existing object commands; no plugin-specific ones.

Migrations (append-only):

- Phase 1 (migration 23): `plugins(id PK, version, source 'dev'|'registry', manifest_json, enabled, key_id, sha256, installed_at, prev_version)`.
  No path column: the dir is always `<app_data>/plugins/<id>/<version>/`, so a restored DB on another
  machine never points at a stale absolute path. A row whose files are missing is listed as incompatible.
- Phase 2: `plugin_workspaces(id PK, plugin_id, label, account_id, bucket, prefix, created_at)`.

Files on disk: `<app_data>/plugins/<id>/<version>/`, drafts in `<app_data>/plugin_drafts/<id>/<hash>.bin`.

## Frontend

| Path | Purpose |
| --- | --- |
| `src/routes/Plugins.tsx` + `src/routes/plugins/` | Catalog, installed list, workspaces, dev load |
| `src/plugins/broker.ts` | One broker per iframe: frame identity, request ids, timeouts, size caps |
| `src/plugins/PluginFrame.tsx` | Creates the sandboxed iframe, wires the broker |
| `src/plugins/DocumentShell.tsx` | Workspace switcher, file list, tabs, Save, draft restore, conflict dialog |
| `src/api/plugins.ts` | Thin `invoke()` wrappers |
| `src/styles/plugins.css` | All plugin UI styles |

- `View` gains `"plugins"`. Sidebar entry is `desktopOnly` while no mobile plugin exists. Each enabled
  `document-editor` plugin adds a sidebar entry for its shell page.
- One iframe per open tab (keeps per-document undo), cap 4 live; the least recent saved tab is unloaded.
  A dirty tab is never unloaded.
- Unsaved guard reuses the `folderCloseGuard` pattern for window close.
- Bucket browser: objects matching a plugin `fileTypes.ext` get "Open in <plugin>". New File modal lists
  plugin file types using the plugin `template`.
- App CSP (`tauri.conf.json`) adds `frame-src cosmog-plugin: http://cosmog-plugin.localhost`.

## Excalidraw plugin (`cosmog-plugins/plugins/excalidraw`)

- Vite + React + `@excalidraw/excalidraw`. Fonts and assets copied into the bundle;
  `window.EXCALIDRAW_ASSET_PATH` points at the plugin's own path (the default CDN is blocked by CSP).
- `onLoad`: `restore()` + `updateScene`, reset history. `onSerialize`: `serializeAsJSON(..., "local")`.
  `onExportPreview`: `exportToBlob` PNG, small. `onChange` -> `setDirty(true)` when the scene version moves.
- Theme follows the host. Ctrl+S calls `requestSave`. Collaboration and the share dialog are disabled.
- Template `templates/empty.excalidraw` for new drawings.

## `cosmog-plugins` repo

```shell
index.json
sdk/                    @cosmog/plugin-sdk (protocol types + client)
plugins/excalidraw/     source, cosmog-plugin.json, templates/
plugins/hello/          test plugin (escape checks + protocol round trip)
scripts/sign.ts         builds statement, signs with key from env
.github/workflows/      on tag <id>-v<ver>: build -> zip -> sha256 -> sign -> release -> PR to index.json
```

## Phases

1. **Runtime spike** (desktop): scheme, sandboxed iframe, broker, dev load, hello plugin. Details below.
2. **Document shell + Excalidraw**: workspaces, doc read/write with If-Match, drafts, tabs, unsaved guard,
   open-with, New File entry, Excalidraw plugin loaded via dev load.
3. **Registry + install**: new deps, signing keys, install/update/rollback, Plugins catalog UI, CI in
   `cosmog-plugins`.
4. **Polish**: thumbnails in the file list, version history from the shell, i18n strings, DOCS.md section.
5. **Later**: `panel` kind with Rust-enforced storage grants, mobile plugins, images as separate objects,
   more editors (draw.io, Mermaid).

## Phase 1 in detail

Goal: prove the isolation model on Linux, Windows and macOS before any Excalidraw work. No new
dependencies.

### Tasks

1. Migration: `plugins` table. Db methods: list, upsert, remove, set_enabled.
2. `plugins/manifest.rs`: parse + validate (rules above), unit tests.
3. `plugins/scheme.rs`: register `cosmog-plugin` with `register_asynchronous_uri_scheme_protocol`.
   URL form `cosmog-plugin://localhost/<id>/<version>/<path>` (`http://cosmog-plugin.localhost/...` on
   Windows). Resolve inside the plugin dir only: percent-decode, reject `..`, canonicalize, check the
   prefix, no symlink escape. Set MIME, the plugin CSP header, `X-Content-Type-Options: nosniff`,
   `Access-Control-Allow-Origin: *` (opaque origin loads fonts and workers as cross-origin). 404 for
   disabled or unknown plugins.
4. `plugins/mod.rs`: `PluginRegistry` on `AppState`, loads enabled plugins at startup, skips platform
   mismatches with a log line.
5. Commands: `plugin_list`, `plugin_dev_load` (`cfg(debug_assertions)`), `plugin_remove`,
   `plugin_set_enabled`. Dev load copies the folder into `<app_data>/plugins/<id>/<version>/`.
6. App CSP: add `frame-src`.
7. Frontend: `View` `"plugins"` (desktop only), `Plugins.tsx` with installed list, enable toggle, remove,
   "Load unpacked" (debug builds). `PluginFrame.tsx` + `broker.ts` with the protocol types. A debug page
   that loads a plugin and runs `doc.load` -> `doc.serialize` round trip.
8. Hello plugin fixture at `src-tauri/tests/fixtures/plugins/hello/`. On load it tries each escape and
   reports pass/fail over `ui.toast` and in its own page:
   `window.__TAURI_INTERNALS__`, `window.__TAURI__`, `fetch("ipc://localhost/...")`,
   `fetch("http://ipc.localhost/...")`, `fetch("https://example.com")`, `new Image().src = "https://..."`,
   `parent.document`, `top.location = ...`, `window.open(...)`, `localStorage`, `indexedDB`,
   `document.cookie`, a module worker, a WASM instantiate, and `navigator.clipboard.writeText`.

### Tests

- Rust integration tests (`src-tauri/tests/plugins_*.rs`, using `tests/common`):
  - Manifest: valid passes; bad id, missing `platforms`, wrong platform, unknown permission,
    unsupported `apiVersion`, `entry` with `..` are each rejected with the right error.
  - Scheme resolution: `..`, `%2e%2e`, absolute paths, backslashes, symlink pointing outside, unknown
    plugin, disabled plugin are refused; a valid file returns bytes with the right MIME and the exact
    CSP header.
  - Db: dev load upserts, remove deletes row and files, enable toggle persists across a reload.
- Manual escape matrix: run the hello plugin on Linux (WebKitGTK), Windows (WebView2) and macOS
  (WKWebView); record results in this file. Every escape must fail; the worker, WASM and protocol round
  trip must work.

### How to run the manual matrix

1. `npm run tauri dev` on the platform under test.
2. Plugins (sidebar, beta) > Load unpacked > pick `src-tauri/tests/fixtures/plugins/hello`.
3. Open. The plugin page lists every check; the toast says `Sandbox: N/N checks passed`.
4. Click Load sample doc, type in the plugin's text box (dirty), press Ctrl+S inside it (`shell.save`
   in the log), Serialize, 50 MB round trip.
5. Click "Try navigating this frame to example.com": the frame must stay on the plugin (app CSP
   `frame-src`).
6. Record the table below, including the info rows (origin, `webkit.messageHandlers`,
   `chrome.webview`, clipboard).

| Platform | Escapes blocked | Worker / WASM / blob / subtle | 50 MB round trip | Navigate away blocked | Notes |
| --- | --- | --- | --- | --- | --- |
| Linux (WebKitGTK) | 18/18 | WASM, blob image, blob worker, subtle ok (`isSecureContext=true`); URL workers fail | 50 MB in 35-40 ms | yes (`frame-src` refused, after dev CSP fix) | origin `null`; `webkit.messageHandlers` present; clipboard denied; plain `<link>` CSS refused, `crossorigin` needed |
| Windows (WebView2) | | | | | |
| macOS (WKWebView) | | | | | |

### Exit criteria

- All Rust tests pass; `cargo clippy` clean; `npm run build` clean.
- Escape matrix all blocked on all three desktop platforms, including the Windows IPC check.
- `doc.load` / `doc.serialize` round trip of a 50 MB buffer works without freezing the UI.
- No change in behaviour on Android (tab hidden, scheme unused).

### Plugin authoring rules (found in the Linux run, 2026-11-19)

- Every subresource from the plugin scheme must load in CORS mode. WebKit refuses a no-cors load of a
  custom scheme from a `null` origin ("Unsafe attempt to load URL ... from origin null"). Module
  scripts and fonts are CORS already; `<link rel="stylesheet">` and `<img>` need `crossorigin`. Vite
  adds it to the tags it emits; the SDK build must keep it.
- Workers from a URL never start (a worker script must be same-origin, and `null` matches nothing).
  Bundle workers inline as `blob:` (Vite `?worker&inline`). `worker-src` allows `blob:`.
- Clipboard API is denied inside the frame. Copy/paste needs a host bridge (protocol addition, Phase 2).
- `window.webkit.messageHandlers` is visible in the frame on WebKitGTK. Calls are rejected only because
  the frame never gets Tauri's invoke key; keep it that way (never pass anything from
  `__TAURI_INTERNALS__` into a plugin).

- `tauri dev` on desktop loads `devUrl` directly and injects no app CSP, so the iframe `frame-src`
  guard is absent in dev. `vite.config.ts` sends a `frame-src`-only CSP header to match release.
  Frame navigation is an exfil channel (`location = "https://x/?data"`) that `connect-src` cannot
  stop, so the app `frame-src` must hold in every build.

### Spike questions to answer

- Does CSP `'self'` match plugin files inside an opaque-origin iframe on all three webviews, or do we
  need the explicit scheme origin in the header?
- Clipboard in a sandboxed iframe: does Excalidraw copy/paste need `allow="clipboard-read; clipboard-write"`,
  and does WebKitGTK honor it?
- Module workers and font loading from an opaque origin with `Access-Control-Allow-Origin: *`.
- Does Ctrl+S, Ctrl+Z inside the iframe ever reach the host (they should not; the SDK forwards save)?

## Open questions

- Draft retention: keep drafts until saved or discarded, or expire after N days?
- Read-only open for files in buckets the user can read but not write (detect on first save, or HEAD
  with a permission probe)?
- Thumbnail storage: local cache only, or a sidecar object next to the drawing?

## References

- [Tauri advisory GHSA-57fm-592m-34r7 (iframe IPC)](https://github.com/tauri-apps/tauri/security/advisories/GHSA-57fm-592m-34r7)
- [Tauri 2.11.1 release (`.localhost` origin fix)](https://v2.tauri.app/release/tauri/v2.11.1/)
- [Excalidraw installation and self-hosted assets](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/installation)
- [Figma: building a plugin system on the web](https://www.figma.com/blog/how-we-built-the-figma-plugin-system/)
- [Obsidian plugin security](https://obsidian.md/help/plugin-security)
