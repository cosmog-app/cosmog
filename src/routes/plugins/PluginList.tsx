import { For, Show } from "solid-js";
import type { InstalledPlugin } from "../../types";
import { t } from "../../i18n";

export function PluginList(props: {
  plugins: InstalledPlugin[];
  busy: boolean;
  onToggle: (p: InstalledPlugin, enabled: boolean) => void;
  onOpen: (p: InstalledPlugin) => void;
  /** Dev builds: protocol test page. */
  onTest: (p: InstalledPlugin) => void;
  onRemove: (p: InstalledPlugin) => void;
}) {
  return (
    <Show when={props.plugins.length > 0} fallback={<div class="plugins-empty">{t("plugins.empty")}</div>}>
      <ul class="plugins-list">
        <For each={props.plugins}>
          {(p) => (
            <li class="plugins-item" classList={{ "plugins-item-off": !p.compatible }}>
              <div class="plugins-item-main">
                <span class="plugins-item-name">{p.manifest.name}</span>
                <span class="plugins-item-meta">
                  {p.id} · v{p.version}
                  <Show when={p.source === "dev"}>
                    <span class="plugins-badge">{t("plugins.source.dev")}</span>
                  </Show>
                </span>
                <Show when={!p.compatible}>
                  <span class="plugins-item-warn">{t("plugins.incompatible")}</span>
                </Show>
              </div>
              <div class="plugins-item-actions">
                <label class="plugins-switch">
                  <input
                    type="checkbox"
                    checked={p.enabled}
                    disabled={props.busy || !p.compatible}
                    onChange={(e) => props.onToggle(p, e.currentTarget.checked)}
                  />
                </label>
                <button class="btn-secondary" disabled={props.busy || !p.enabled || !p.compatible} onClick={() => props.onOpen(p)}>
                  {t("plugins.open")}
                </button>
                <Show when={import.meta.env.DEV}>
                  <button class="btn-ghost" disabled={props.busy || !p.enabled || !p.compatible} onClick={() => props.onTest(p)}>
                    {t("plugins.test")}
                  </button>
                </Show>
                <button class="btn-ghost" disabled={props.busy} onClick={() => props.onRemove(p)}>
                  {t("plugins.remove")}
                </button>
              </div>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}
