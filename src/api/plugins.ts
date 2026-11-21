import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { InstalledPlugin, PluginDocMeta, PluginDocRef, PluginDraftMeta, StoreEntry } from "../types";

export const pluginList = (): Promise<InstalledPlugin[]> => invoke("plugin_list");

export const pluginSetEnabled = (id: string, enabled: boolean): Promise<void> =>
  invoke("plugin_set_enabled", { id, enabled });

export const pluginRemove = (id: string): Promise<void> => invoke("plugin_remove", { id });

/** Debug builds only; the command is not registered in release. */
export const pluginDevLoad = (path: string): Promise<InstalledPlugin> => invoke("plugin_dev_load", { path });

// ── store (phase 3) ──

export const pluginStoreList = (): Promise<StoreEntry[]> => invoke("plugin_store_list");

/** Installs or updates to the version the store lists now; the backend re-reads the catalog. */
export const pluginInstall = (id: string): Promise<InstalledPlugin> => invoke("plugin_install", { id });

export interface InstallProgress { id: string; done: number; total: number | null }
export const onInstallProgress = (fn: (p: InstallProgress) => void) =>
  listen<InstallProgress>("plugin-install-progress", (e) => fn(e.payload));

// ── document plugins (phase 2) ──

/** Raw IPC body for write commands; parameters ride in a base64 JSON header (keys may be non-ASCII). */
function metaHeader(meta: object): Record<string, string> {
  const utf8 = new TextEncoder().encode(JSON.stringify(meta));
  let bin = "";
  for (const b of utf8) bin += String.fromCharCode(b);
  return { "x-cosmog-meta": btoa(bin) };
}

/** Splits a `[u32 LE meta len][meta JSON][bytes]` reply. Empty reply = nothing there. */
function unframe<M>(buf: ArrayBuffer): { meta: M; bytes: ArrayBuffer } | null {
  if (buf.byteLength === 0) return null;
  const n = new DataView(buf).getUint32(0, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n))) as M;
  return { meta, bytes: buf.slice(4 + n) };
}

export async function pluginDocRead(ref: PluginDocRef): Promise<{ meta: PluginDocMeta; bytes: ArrayBuffer }> {
  const out = unframe<PluginDocMeta>(await invoke<ArrayBuffer>("plugin_doc_read", { ...ref }));
  if (!out) throw new Error("empty document reply");
  return out;
}

/** Save over the version that was loaded (`ifMatch`) or create a new file (`create`). Rejects with
 *  code `conflict` when someone else changed it. Returns the new etag. */
export const pluginDocWrite = (
  ref: PluginDocRef & { mime: string; ifMatch?: string | null; create?: boolean },
  bytes: ArrayBuffer | Uint8Array,
): Promise<string | null> => invoke("plugin_doc_write", bytes, { headers: metaHeader(ref) });

export const pluginTemplate = (pluginId: string, ext: string): Promise<ArrayBuffer> =>
  invoke("plugin_template", { pluginId, ext });

export async function pluginDraftGet(pluginId: string, ref: PluginDocRef): Promise<{ meta: PluginDraftMeta; bytes: ArrayBuffer } | null> {
  return unframe<PluginDraftMeta>(await invoke<ArrayBuffer>("plugin_draft_get", { pluginId, ...ref }));
}

export const pluginDraftPut = (pluginId: string, ref: PluginDocRef & { baseEtag: string | null }, bytes: ArrayBuffer | Uint8Array): Promise<void> =>
  invoke("plugin_draft_put", bytes, { headers: metaHeader({ pluginId, ...ref }) });

export const pluginDraftClear = (pluginId: string, ref: PluginDocRef): Promise<void> =>
  invoke("plugin_draft_clear", { pluginId, ...ref });
