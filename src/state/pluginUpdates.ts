// Background plugin updates, on by default. Store installs only (signed, newer); a plugin with a
// document open is skipped so its files never change under the editor, and tried again next round.

import { createSignal } from "solid-js";
import { pluginInstall, pluginStoreList } from "../api/plugins";
import { storeStatus } from "../routes/plugins/storeStatus";
import { isDesktopShell } from "../utils/platform";
import { t } from "../i18n";
import { getPref, setPref } from "./prefs";
import { openDoc, pluginsInstalled, refreshPlugins } from "./plugins";
import { writeStoreCache } from "./pluginStoreCache";
import { toast } from "./toast";

const PREF = "plugins.autoUpdate";
const FIRST_CHECK_MS = 30_000;
const EVERY_MS = 6 * 60 * 60_000;

// Read in startPluginAutoUpdate: prefs load after this module is imported.
const [autoUpdate, setAutoUpdate] = createSignal(true);
export const pluginAutoUpdate = autoUpdate;

export function setPluginAutoUpdate(on: boolean) {
  setAutoUpdate(on);
  setPref(PREF, on);
  if (on) void updatePlugins();
}

const appVersion = () => import("@tauri-apps/api/app").then((m) => m.getVersion()).catch(() => null);

let running = false;

async function updatePlugins() {
  if (!autoUpdate() || running) return;
  running = true;
  let changed = false;
  try {
    await refreshPlugins();
    const installed = pluginsInstalled().filter((p) => p.source === "registry");
    if (installed.length === 0) return;
    const entries = await pluginStoreList();
    writeStoreCache(entries);
    const version = await appVersion();
    for (const e of entries) {
      const p = installed.find((i) => i.id === e.id);
      if (!p || storeStatus(e, p, version).kind !== "update" || openDoc()?.plugin.id === e.id) continue;
      try {
        const m = await pluginInstall(e.id);
        changed = true;
        toast.ok(t("plugins.update.done", { name: m.manifest.name, version: m.version }));
      } catch (err) {
        console.warn(`plugin auto-update ${e.id} failed`, err);
      }
    }
  } catch (err) {
    // Offline or the store is down: the next round retries.
    console.warn("plugin auto-update check failed", err);
  } finally {
    running = false;
    if (changed) await refreshPlugins();
  }
}

export function startPluginAutoUpdate() {
  if (!isDesktopShell) return;
  setAutoUpdate(getPref(PREF, true));
  window.setTimeout(() => void updatePlugins(), FIRST_CHECK_MS);
  window.setInterval(() => void updatePlugins(), EVERY_MS);
}
