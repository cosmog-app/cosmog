import { createResource, createSignal, Show } from "solid-js";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { InstalledPlugin } from "../types";
import { pluginDevLoad, pluginList, pluginRemove, pluginSetEnabled } from "../api/plugins";
import { IconPlugin } from "../utils/icons";
import { toast } from "../state/toast";
import { confirmDialog } from "../state/confirm";
import { t } from "../i18n";
import { PluginList } from "./plugins/PluginList";
import { PluginHarness } from "./plugins/PluginHarness";

export default function Plugins() {
  const [plugins, { refetch }] = createResource(pluginList, { initialValue: [] });
  const [busy, setBusy] = createSignal(false);
  const [openId, setOpenId] = createSignal<string | null>(null);
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
      <div class="view-header">
        <span class="section-title">{t("plugins.title")}</span>
      </div>
      <Show when={opened()} fallback={
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
              <div class="settings-section-title">{t("plugins.installed")}</div>
              <Show when={import.meta.env.DEV}>
                <button class="btn-secondary" disabled={busy()} onClick={devLoad}>{t("plugins.devLoad")}</button>
              </Show>
            </div>
            <PluginList
              plugins={plugins()}
              busy={busy()}
              onToggle={(p, enabled) => act(async () => {
                if (!enabled && openId() === p.id) setOpenId(null);
                await pluginSetEnabled(p.id, enabled);
              })}
              onOpen={(p) => setOpenId(p.id)}
              onRemove={remove}
            />
          </div>
        </div>
      }>
        {(p) => <PluginHarness plugin={p()} onBack={() => setOpenId(null)} />}
      </Show>
    </div>
  );
}
