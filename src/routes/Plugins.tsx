import { createEffect, createSignal, Match, on, Show, Switch } from "solid-js";
import { currentView } from "../state/app";
import { pluginRemove } from "../api/plugins";
import { pluginsInstalled, refreshPlugins } from "../state/plugins";
import { IconPlugin, IconRefresh } from "../utils/icons";
import { toast } from "../state/toast";
import { confirmDialog } from "../state/confirm";
import { t } from "../i18n";
import { PluginDetail } from "./plugins/PluginDetail";
import { StoreGrid } from "./plugins/StoreGrid";
import { usePluginStore } from "./plugins/useStore";
import { listings, type Listing } from "./plugins/listing";
import { pluginAutoUpdate, setPluginAutoUpdate } from "../state/pluginUpdates";
import { parseWireError } from "../utils/wireError";

export default function Plugins() {
  const store = usePluginStore();
  const [removing, setRemoving] = createSignal(false);
  const [detailId, setDetailId] = createSignal<string | null>(null);
  const items = () => listings(store.entries() ?? [], pluginsInstalled());
  const detail = () => items().find((l) => l.id === detailId()) ?? null;
  const busy = () => store.busy() || removing();
  const reason = () => parseWireError(store.error()).detail || String(store.error());

  // Views stay mounted from startup; only showing this one contacts the store.
  createEffect(on(currentView, (v) => {
    if (v !== "plugins") return;
    void refreshPlugins();
    store.ensure();
  }));

  const install = (l: Listing) => { if (l.entry) void store.install(l.entry); };

  async function remove(l: Listing) {
    const ok = await confirmDialog({
      title: t("plugins.remove.title", { name: l.name }),
      body: t("plugins.remove.body"),
      confirmLabel: t("plugins.remove"),
      danger: true,
    });
    if (!ok) return;
    setRemoving(true);
    try {
      await pluginRemove(l.id);
    } catch (e) {
      toast.err(e);
    } finally {
      await refreshPlugins();
      setRemoving(false);
    }
  }

  return (
    <div class="view-container">
      <Show when={detail()} fallback={<>
        <div class="view-header">
          <span class="section-title">{t("plugins.title")}</span>
          <button class="icon-btn refresh-btn plugins-refresh" classList={{ spinning: store.loading() }}
                  title={t("plugins.store.refresh")} aria-label={t("plugins.store.refresh")} onClick={() => void store.load()}>
            <IconRefresh size={14} />
          </button>
        </div>
        <div class="plugins-body">
          <div class="plugins-intro">
            <div class="plugins-intro-badge"><IconPlugin size={18} /></div>
            <div class="plugins-intro-text">
              <span class="plugins-intro-lead">{t("plugins.intro.lead")}</span>
              <span class="plugins-intro-body">{t("plugins.intro.body")}</span>
            </div>
          </div>
          <label class="plugins-auto">
            <input type="checkbox" checked={pluginAutoUpdate()}
                   onChange={(e) => setPluginAutoUpdate(e.currentTarget.checked)} />
            <span class="plugins-auto-text">
              <span class="plugins-auto-label">{t("plugins.autoUpdate")}</span>
              <span class="plugins-auto-hint">{t("plugins.autoUpdate.hint")}</span>
            </span>
          </label>
          <Switch fallback={<div class="plugins-empty">{t("plugins.store.empty")}</div>}>
            <Match when={items().length > 0}>
              <StoreGrid items={items()} appVersion={store.appVersion()} progress={store.progress} busy={busy()}
                         onOpen={(l) => setDetailId(l.id)} onInstall={install} onRemove={(l) => void remove(l)} />
              <Show when={store.error()}>
                <div class="plugins-empty">{t("plugins.store.stale", { reason: reason() })}</div>
              </Show>
            </Match>
            <Match when={store.error()}>
              <div class="plugins-empty plugins-warn">{t("plugins.store.failed", { reason: reason() })}</div>
            </Match>
            <Match when={store.entries() === null}>
              <div class="plugins-empty">{t("plugins.store.loading")}</div>
            </Match>
          </Switch>
        </div>
      </>}>
        {(l) => (
          <PluginDetail listing={l()} appVersion={store.appVersion()} progress={store.progress(l().id)} busy={busy()}
                        onBack={() => setDetailId(null)} onInstall={() => install(l())} onRemove={() => void remove(l())} />
        )}
      </Show>
    </div>
  );
}
