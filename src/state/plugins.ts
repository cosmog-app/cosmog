// App-wide plugin state: what is installed, and the one document open in a plugin editor.
// Plugins open files like the image editor does: from the bucket browser, over the app.

import { createSignal } from "solid-js";
import type { InstalledPlugin, PluginDocRef } from "../types";
import { pluginList } from "../api/plugins";
import { isDesktopShell } from "../utils/platform";
import { toast } from "./toast";
import { t } from "../i18n";

const [installed, setInstalled] = createSignal<InstalledPlugin[]>([]);
export const pluginsInstalled = installed;

export async function refreshPlugins() {
  if (!isDesktopShell) return;
  setInstalled(await pluginList().catch(() => installed()));
}

/** Enabled document editors that can run here. */
export const docPlugins = () =>
  installed().filter((p) => p.enabled && p.compatible && p.manifest.kind === "document-editor");

export function pluginForKey(key: string): InstalledPlugin | null {
  const k = key.toLowerCase();
  return docPlugins().find((p) => p.manifest.fileTypes.some((f) => k.endsWith(f.ext.toLowerCase()))) ?? null;
}

export const mimeForKey = (p: InstalledPlugin, key: string) =>
  p.manifest.fileTypes.find((f) => key.toLowerCase().endsWith(f.ext.toLowerCase()))?.mime ??
  p.manifest.fileTypes[0]?.mime ?? "application/octet-stream";

export interface OpenDoc {
  plugin: InstalledPlugin;
  ref: PluginDocRef;
  mime: string;
  /** The stored object changed (save, or save as copy); listings refresh. */
  onSaved?: () => void;
}

const [openDoc, setOpenDoc] = createSignal<OpenDoc | null>(null);
export { openDoc };

// Set while a background update swaps a plugin's files; an editor opened then would load the old
// version and lose its assets mid-session.
const [updatingPlugin, setUpdatingPlugin] = createSignal<string | null>(null);
export { updatingPlugin, setUpdatingPlugin };

/** Opens `key` in the plugin that handles it; false when none does. */
export function openWithPlugin(ref: PluginDocRef, onSaved?: () => void): boolean {
  const plugin = pluginForKey(ref.key);
  if (!plugin) return false;
  if (updatingPlugin() === plugin.id) {
    toast.info(t("plugins.updating.wait", { name: plugin.manifest.name }));
    return true;
  }
  setOpenDoc({ plugin, ref, mime: mimeForKey(plugin, ref.key), onSaved });
  return true;
}

export const closeOpenDoc = () => setOpenDoc(null);

// The open editor's close (asking Save / Don't save), for the quit guard.
let closer: (() => Promise<boolean>) | null = null;
export const setDocCloser = (fn: (() => Promise<boolean>) | null) => { closer = fn; };
/** True when nothing is open or the user saved or discarded; false when they cancelled. */
export const closeDocForQuit = () => closer?.() ?? Promise.resolve(true);
