// Store state for the Plugins view: the catalog, this app's version, and the running install.

import { createResource, createSignal, onCleanup } from "solid-js";
import { onInstallProgress, pluginInstall, pluginStoreList } from "../../api/plugins";
import { pluginsInstalled, refreshPlugins } from "../../state/plugins";
import { toast } from "../../state/toast";
import { t } from "../../i18n";
import type { StoreEntry } from "../../types";

const appVersion = () => import("@tauri-apps/api/app").then((m) => m.getVersion()).catch(() => null);

export function usePluginStore() {
  // Not fetched until the view asks: opening the app never contacts GitHub.
  const [wanted, setWanted] = createSignal(false);
  const [entries, { refetch }] = createResource(wanted, () => pluginStoreList());
  const [version] = createResource(appVersion);
  const [installing, setInstalling] = createSignal<{ id: string; pct: number } | null>(null);

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
    /** First call fetches; later calls refetch. */
    load: () => (wanted() ? void refetch() : setWanted(true)),
    /** Fetch once, the first time the view is shown. */
    ensure: () => { if (!wanted()) setWanted(true); },
    entries,
    appVersion: () => version() ?? null,
    progress: (id: string) => (installing()?.id === id ? installing()!.pct : null),
    busy: () => installing() !== null,
    install,
  };
}
