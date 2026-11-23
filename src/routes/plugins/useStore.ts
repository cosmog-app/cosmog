// Store state for the Plugins view: the catalog, this app's version, and the running install.
// The last catalog is cached (state/pluginStoreCache) so the page opens filled in; a fresh copy
// loads behind it.

import { createResource, createSignal, onCleanup } from "solid-js";
import { onInstallProgress, pluginInstall, pluginStoreList } from "../../api/plugins";
import { pluginsInstalled, refreshPlugins } from "../../state/plugins";
import { toast } from "../../state/toast";
import { t } from "../../i18n";
import type { StoreEntry } from "../../types";
import { readStoreCache, writeStoreCache } from "../../state/pluginStoreCache";

const appVersion = () => import("@tauri-apps/api/app").then((m) => m.getVersion()).catch(() => null);

const STALE_MS = 10 * 60_000;

export function usePluginStore() {
  const cached = readStoreCache();
  const [entries, setEntries] = createSignal<StoreEntry[] | null>(cached?.entries ?? null);
  const [fetchedAt, setFetchedAt] = createSignal(cached?.at ?? 0);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<unknown>(null);
  const [version] = createResource(appVersion);
  const [installing, setInstalling] = createSignal<{ id: string; pct: number } | null>(null);

  async function load() {
    if (loading()) return;
    setLoading(true);
    try {
      const list = await pluginStoreList();
      setEntries(list);
      setFetchedAt(writeStoreCache(list).at);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }

  const unlisten = onInstallProgress((p) => {
    const cur = installing();
    if (cur?.id !== p.id) return;
    setInstalling({ id: p.id, pct: p.total ? Math.min(100, Math.floor((p.done * 100) / p.total)) : 0 });
  });
  onCleanup(() => void unlisten.then((f) => f()).catch(() => {}));

  async function install(e: StoreEntry) {
    if (installing()) return;
    const before = pluginsInstalled().find((p) => p.id === e.id);
    setInstalling({ id: e.id, pct: 0 });
    try {
      const p = await pluginInstall(e.id);
      toast.ok(before ? t("plugins.update.done", { name: p.manifest.name, version: p.version }) : t("plugins.install.done", { name: p.manifest.name }));
    } catch (err) {
      toast.err(err);
    } finally {
      setInstalling(null);
      await refreshPlugins();
    }
  }

  return {
    load,
    /** Called whenever the view shows: refreshes in the background once the cached copy is stale. */
    ensure: () => { if (Date.now() - fetchedAt() > STALE_MS) void load(); },
    entries,
    loading,
    error,
    appVersion: () => version() ?? null,
    progress: (id: string) => (installing()?.id === id ? installing()!.pct : null),
    busy: () => installing() !== null,
    install,
  };
}
