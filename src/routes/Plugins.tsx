import { createEffect, createSignal, onMount, Show } from "solid-js";
import { currentView } from "../state/app";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { InstalledPlugin } from "../types";
import { pluginDevLoad, pluginRemove, pluginSetEnabled } from "../api/plugins";
import { pluginsInstalled, refreshPlugins } from "../state/plugins";
import { IconPlugin, IconRefresh } from "../utils/icons";
import { toast } from "../state/toast";
import { confirmDialog } from "../state/confirm";
import { t } from "../i18n";
import { PluginList } from "./plugins/PluginList";
import { PluginHarness } from "./plugins/PluginHarness";
import { PluginDetail } from "./plugins/PluginDetail";
import { StoreGrid } from "./plugins/StoreGrid";
import { usePluginStore } from "./plugins/useStore";
import { parseWireError } from "../utils/wireError";

export default function Plugins() {
  const plugins = pluginsInstalled;
  const refetch = refreshPlugins;
  // Dev builds: the plugin whose protocol test page is showing.
  const [openId, setOpenId] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const store = usePluginStore();
  const [detailId, setDetailId] = createSignal<string | null>(null);
  const detail = () => store.entries()?.find((e) => e.id === detailId()) ?? null;
  onMount(() => void refreshPlugins());
  // Views stay mounted from startup; only actually showing this one contacts the store.
  createEffect(() => { if (currentView() === "plugins") store.ensure(); });
  const opened = () => plugins().find((p) => p.id === openId() && p.enabled && p.compatible) ?? null;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.err(e);
    } finally {
      await refetch();
      setBusy(false);
    }
  };

  const devLoad = () => act(async () => {
    const dir = await openDialog({ directory: true, multiple: false, title: t("plugins.devLoad.pick") });
    if (typeof dir !== "string") return;
    const p = await pluginDevLoad(dir);
    toast.ok(t("plugins.devLoad.done"), `${p.manifest.name} v${p.version}`);
  });

  const remove = async (p: InstalledPlugin) => {
    const ok = await confirmDialog({
      title: t("plugins.remove.title", { name: p.manifest.name }),
      body: t("plugins.remove.body"),
      confirmLabel: t("plugins.remove"),
      danger: true,
    });
    if (!ok) return;
    if (openId() === p.id) setOpenId(null);
    await act(() => pluginRemove(p.id));
  };

  return (
    <div class="view-container">
      <Show when={opened()} fallback={
        <Show when={detail()} fallback={<>
        <div class="view-header">
          <span class="section-title">{t("plugins.title")}</span>
        </div>
        <div class="plugins-body">
          <div class="plugins-intro">
            <div class="plugins-intro-badge"><IconPlugin size={18} /></div>
            <div class="plugins-intro-text">
              <span class="plugins-intro-lead">{t("plugins.intro.lead")}</span>
              <span class="plugins-intro-body">{t("plugins.intro.body")}</span>
            </div>
          </div>
          <div class="settings-section">
            <div class="plugins-section-head">
              <div class="settings-section-title">{t("plugins.store.title")}</div>
              <button class="icon-btn" title={t("plugins.store.refresh")} aria-label={t("plugins.store.refresh")}
                      disabled={store.entries.loading} onClick={store.load}>
                <IconRefresh size={14} />
              </button>
            </div>
            <Show when={!store.entries.error} fallback={
              <div class="plugins-empty plugins-item-warn">
                {t("plugins.store.failed", { reason: parseWireError(store.entries.error).detail || String(store.entries.error) })}
              </div>
            }>
              <Show when={store.entries()} fallback={<div class="plugins-empty">{t("plugins.store.loading")}</div>}>
                {(list) => (
                  <Show when={list().length > 0} fallback={<div class="plugins-empty">{t("plugins.store.empty")}</div>}>
                    <StoreGrid entries={list()} installed={plugins()} appVersion={store.appVersion()}
                               progress={store.progress} busy={store.busy()}
                               onOpen={(e) => setDetailId(e.id)} onInstall={(e) => void store.install(e)} />
                  </Show>
                )}
              </Show>
            </Show>
          </div>
          <div class="settings-section">
            <div class="plugins-section-head">
              <div class="settings-section-title">{t("plugins.installed")}</div>
              <Show when={import.meta.env.DEV}>
                <button class="btn-secondary" disabled={busy()} onClick={devLoad}>{t("plugins.devLoad")}</button>
              </Show>
            </div>
            <PluginList
              plugins={plugins()}
              busy={busy() || store.busy()}
              onToggle={(p, enabled) => act(async () => {
                if (!enabled && openId() === p.id) setOpenId(null);
                await pluginSetEnabled(p.id, enabled);
              })}
              onTest={(p) => setOpenId(p.id)}
              onRemove={remove}
            />
          </div>
        </div>
        </>}>
          {(e) => (
            <PluginDetail entry={e()} installed={plugins().find((p) => p.id === e().id)} appVersion={store.appVersion()}
                          progress={store.progress(e().id)} busy={store.busy()}
                          onBack={() => setDetailId(null)} onInstall={() => void store.install(e())} />
          )}
        </Show>
      }>
        {(p) => <PluginHarness plugin={p()} onBack={() => setOpenId(null)} />}
      </Show>
    </div>
  );
}
