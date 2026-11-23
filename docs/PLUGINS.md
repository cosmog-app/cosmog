# Plugin System: Implementation Plan

Status: Phase 1 runtime built 2026-11-18; manual sandbox matrix pending. First plugin: Excalidraw (desktop only).

## Goal

Users install plugins at runtime from a Plugins tab. Plugins are not shipped with the app. A plugin uses
Cosmog's accounts and S3 layer for storage without ever seeing credentials, keys or the Tauri IPC.

First target: an Excalidraw plugin that opens, edits and saves `.excalidraw` files anywhere in a
bucket, from the bucket browser, the way images open in the image editor.

## Decisions

| Topic | Decision |
| --- | --- |
| Runtime | Signed web bundle (zip) in a sandboxed iframe, talking to the host via `postMessage` |
| Trust | First-party only. App trusts plugins signed by keys compiled into the app |
| Platforms | Manifest `platforms` is required: `"desktop"`, `"mobile"` or both. Excalidraw is desktop only |
| Storage | None of its own. A plugin opens files from any bucket, like the image editor (no workspaces) |
| File UI | Bucket browser opens a matching file in a full-window editor over the app (name, Save, close, conflicts). Plugin renders the editor only |
| Open with | Preview pane button and right-click "Open in <plugin>"; New File lists plugin file types. One document at a time |
| Saving | Manual (Ctrl+S / Save). Local draft kept until saved. Unsaved-changes guard on close |
| Images | Embedded base64 in the `.excalidraw` JSON (portable to excalidraw.com) |
| Updates | Badge + user clicks update. Permission increases shown first. Previous version kept for rollback |
| Registry | Separate GitHub repo `cosmog-plugins`: `index.json` on main, zips as release assets |
| Sources | Plugin SDK and plugin sources live in `cosmog-plugins`, with CI that builds, signs and releases |
| New Rust deps | Phase 3 adds only `zip`. Download, SHA-256 and ed25519 use hyper + rustls + aws-lc-rs, already built for the S3 client |

## Architecture

```shell
Plugins tab --install--> Rust: fetch index.json -> download zip -> verify sha256 + ed25519 (keyId)
                                                       \-> <app_data>/plugins/<id>/<version>/

"Open in <plugin>" from the bucket browser
  PluginEditor (host, Solid)             one document: save, drafts, conflicts
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
  "permissions": [],
  "summary": "Sketch hand-drawn diagrams and whiteboards.",
  "description": "Paragraphs split by blank lines.",
  "icon": "icon.svg",
  "author": "Cosmog",
  "license": "MIT",
  "homepage": "https://...",
  "repository": "https://github.com/...",
  "upstream": { "name": "Excalidraw", "url": "https://github.com/excalidraw/excalidraw" }
}
```

Validation (Rust, `plugins/manifest.rs`):

- `id`: `^[a-z][a-z0-9-]{1,39}$`. `version`: semver.
- `apiVersion`: must be in the app's `SUPPORTED_API_VERSIONS`; otherwise refuse with a clear error.
- `kind`: `document-editor` now; `panel` reserved.
- `platforms`: required, non-empty, values `desktop` | `mobile`. Must include the current platform to
  list, install or load.
- `entry` and `template` paths: relative, no `..`, must exist in the package.
- Store listing fields are optional and display only: `summary` <= 140 chars, `description` <= 4000,
  `author` <= 80, `license` <= 40, `icon` a `.png`/`.svg` in the package (shown as a `data:` URI,
  max 128 KB), `homepage`, `repository` and `upstream.url` https only.
- `permissions`: known values only. `document-editor` needs none. Reserved: `storage:workspace`,
  `network:<host>`.

## Packaging and signing

- Package: zip with the manifest at the root. Max 64 MB compressed, 200 MB extracted, 5000 entries.
- Extract with path checks (`store/install.rs`): every entry name passes `safe_rel_path` (no absolute,
  `..`, backslash or empty segments), symlinks and special files are refused, duplicates fail
  (`create_new`), and the extracted byte limit counts bytes actually inflated, not header sizes.
- Signed statement, so a valid signature cannot be reused for another plugin or another version:

  ```text
  cosmog-plugin-v1
  <id>
  <version>
  <sha256 of zip, hex>
  ```

- Ed25519 over that statement. Each signature names a `keyId`. Verified with `aws-lc-rs`.
- App holds `TRUSTED_KEYS` (`store/keys.rs`). Rotation: add the new key in an app release, start
  signing with it, drop the old one a few releases later. Removing a key is the revocation, and needs an
  app release.
- Private key: `COSMOG_SIGNING_KEY` Actions secret in `cosmog-plugins`, plus the owner's offline copy.
  Never in a repo. Created with `scripts/keygen.mjs`. Current key: `cosmog-2026-1`.
- Install checks, in order: size equals the catalog's, sha256 equals the catalog's, signature by a
  trusted key over the statement built from the catalog's id + version + the computed hash, manifest
  inside the zip validates and has that same id and version, platform matches. Nothing is unpacked
  before the signature passes.
- No downgrades: a store install is only replaced by the same or a newer version (old releases stay
  validly signed forever). A dev copy is always replaced. The outgoing store version is kept on disk
  (`prev_version`) for a later rollback; older ones are deleted. Rollback UI is not built yet.

## Registry

`https://raw.githubusercontent.com/cosmog-app/cosmog-plugins/main/index.json`, written by the
release workflow (`scripts/update-index.mjs`). One entry per plugin, latest version only:

```json
{
  "schema": 1,
  "plugins": [
    {
      "id": "excalidraw",
      "name": "Excalidraw",
      "version": "0.1.0",
      "summary": "Sketch hand-drawn diagrams and whiteboards.",
      "description": "Paragraphs split by blank lines.",
      "icon": "data:image/svg+xml;base64,...",
      "author": "Cosmog",
      "license": "MIT",
      "repository": "https://github.com/...",
      "upstream": { "name": "Excalidraw", "url": "https://github.com/excalidraw/excalidraw" },
      "platforms": ["desktop"],
      "minAppVersion": "1.1.42",
      "fileTypes": [{ "ext": ".excalidraw", "label": "Drawing" }],
      "releasedAt": "2026-11-21T12:00:00.000Z",
      "download": {
        "url": "https://github.com/cosmog-app/cosmog-plugins/releases/download/excalidraw-v0.1.0/excalidraw-0.1.0.zip",
        "size": 15729837,
        "sha256": "<hex>",
        "keyId": "cosmog-2026-1",
        "signature": "<base64>"
      }
    }
  ]
}
```

- The index itself is unsigned; it is display data plus a pointer. Worst case, a tampered index hides
  a plugin or an update; it cannot install anything unsigned or older.
- Unknown fields are ignored (newer catalogs keep working). A `schema` other than 1 is an error that
  asks for a newer app. Entries with a bad id, version or non-https download are skipped; icons that
  are not a PNG/SVG `data:` URI and links that are not https are dropped.
- Icons are inlined as `data:` URIs, so the list needs no extra requests and the app CSP is unchanged.
- Fetched by Rust (`plugin_store_list`) when the Plugins view opens (the last copy is cached in
  localStorage for display), and by auto-update (`src/state/pluginUpdates.ts`, on by default, a pref):
  30 s after start, then every 6 h, it updates store installs that have a newer compatible version,
  skipping a plugin whose document is open. `plugin_install(id)` re-fetches
  the catalog itself, so the frontend cannot point an install at another package. Progress events:
  `plugin-install-progress { id, done, total }`, at most one per percent.

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
| host -> plugin | `ui.pinch` | `{x, y, deltaY}` in frame px. Linux only: Rust (`src-tauri/src/pinch_linux.rs`) swallows touchpad pinches, which WebKitGTK would turn into whole-page zoom, and the host forwards them (`src/utils/pinch.ts`). The SDK replays each as a Ctrl+wheel event at that point, like browsers report a trackpad pinch |
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
| `store/http.rs` | Phase 3: HTTPS GET on hyper + rustls, redirects (GitHub assets), size cap, idle timeout |
| `store/index.rs` | Phase 3: catalog URL, parse + sanitize |
| `store/keys.rs` | Phase 3: `TRUSTED_KEYS`, statement, sha256, ed25519 verify |
| `store/install.rs` | Phase 3: check package, safe unzip, manifest match, swap, keep previous version |
| `docs.rs` | Phase 2: draft store (age-encrypted for encrypted buckets) |

Commands (`commands/plugins.rs`, all `#[tracing::instrument(skip_all, err)]`):

- Phase 1: `plugin_list`, `plugin_dev_load(path)` (debug builds only), `plugin_remove`, `plugin_set_enabled`.
- Phase 2: `plugin_doc_read(account, bucket, key)` -> raw bytes + etag (`tauri::ipc::Response`, no JSON number arrays),
  `plugin_doc_write(account, bucket, key, mime, if_match)` with a raw request body -> new etag,
  `plugin_template`, `plugin_draft_get/put/clear`.
- Phase 3 (`commands/plugin_store.rs`, desktop): `plugin_store_list`, `plugin_install(id)` (install and update). Rollback later.

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
- Migration 24 drops `plugin_workspaces`, a table from an unreleased build of this branch (workspaces were removed).

Files on disk: `<app_data>/plugins/<id>/<version>/`, drafts in `<app_data>/plugin_drafts/<id>/<hash>.bin`.

## Frontend

| Path | Purpose |
| --- | --- |
| `src/routes/Plugins.tsx` + `src/routes/plugins/` | One list from the cached catalog plus installs: Install, Update, Uninstall |
| `src/plugins/broker.ts` | One broker per iframe: frame identity, request ids, timeouts, size caps |
| `src/plugins/PluginFrame.tsx` | Creates the sandboxed iframe, wires the broker |
| `src/plugins/PluginEditor.tsx` | Full-window editor for one document: Save, close guard, draft restore, conflict dialog |
| `src/plugins/shell/docTab.ts` | Document controller: read, conditional save, drafts, conflict resolution |
| `src/api/plugins.ts` | Thin `invoke()` wrappers |
| `src/styles/plugins.css`, `plugin-editor.css` | Plugin UI styles |

- `View` gains `"plugins"` (manage installed plugins). Sidebar entry is `desktopOnly` while no mobile plugin exists.
- The editor is mounted by `MainApp` from `openDoc` in `src/state/plugins.ts`, over every view.
- Unsaved guard: `src/routes/mainapp/closeGuard.ts` (was the folder-job guard) also asks before quitting
  while a plugin document is open: it runs the editor's own close (Save / Don't save / Cancel). Close
  checks the plugin's dirty flag and also compares a SHA-256 of a fresh serialize with the loaded/saved
  one, so a missed dirty message can't lose work. App-wide plugin state is `src/state/plugins.ts`.
- Bucket browser: objects matching a plugin `fileTypes.ext` get "Open in <plugin>" (preview pane and
  right-click). New File lists plugin file types, writes the plugin `template` and opens it.
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
index.json                      store catalog, written by CI
sdk/                            @cosmog/plugin-sdk (protocol types + client)
plugins/excalidraw/             source; public/ holds cosmog-plugin.json, icon.svg, templates/
scripts/keygen.mjs              one-off: new signing key (private PEM to a file, public half printed)
scripts/pack.mjs                dist -> zip -> sha256 -> sign -> release/<id>.entry.json
scripts/update-index.mjs        puts an entry into index.json
.github/workflows/release.yml   on tag <id>-v<ver> on main: build, pack, sign, GitHub release, commit index.json
```

Publishing: bump `version` in the plugin's `public/cosmog-plugin.json`, commit to main, push tag
`<id>-v<version>`. The workflow refuses a tag that does not match the manifest or is not on main.

## Phases

1. **Runtime spike** (desktop): scheme, sandboxed iframe, broker, dev load, hello plugin. Details below.
2. **Document editor + Excalidraw**: open from the browser, doc read/write with If-Match, drafts, unsaved guard,
   New File entry, Excalidraw plugin loaded via dev load.
3. **Registry + install**: new deps, signing keys, install/update/rollback, Plugins catalog UI, CI in
   `cosmog-plugins`.
4. **Polish**: preview thumbnails, version history from the editor, i18n strings, DOCS.md section.
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
2. Load the fixture from the devtools console (debug builds only, there is no button):
   `window.__TAURI_INTERNALS__.invoke("plugin_dev_load", { path: "<repo>/src-tauri/tests/fixtures/plugins/hello" })`,
   then open the Plugins view so the list refreshes.
3. In the bucket browser, New file > Hello file, then open it. The plugin lists every check; the toast
   says `Sandbox: N/N checks passed`.
4. Type in the plugin's text box (dirty dot), press Ctrl+S inside it (saves), close (Save / Don't save prompt).
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
