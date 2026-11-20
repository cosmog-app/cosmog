import { onCleanup, Show } from "solid-js";
import { PluginFrame } from "../PluginFrame";
import { t } from "../../i18n";
import type { InstalledPlugin } from "../../types";
import type { DocTab } from "./docTab";

/** One live iframe. Inactive tabs stay mounted but hidden so undo history and zoom survive. */
export function TabFrame(props: { plugin: InstalledPlugin; tab: DocTab; active: boolean; onSave: () => void }) {
  onCleanup(() => props.tab.detach());
  return (
    <div class="pshell-frame" classList={{ active: props.active }}>
      <PluginFrame
        plugin={props.plugin}
        onBroker={(b) => void props.tab.attach(b)}
        events={{
          onDirty: (d) => props.tab.onPluginDirty(d),
          onSave: props.onSave,
          onFault: (r) => props.tab.fault(r),
        }}
      />
      <Show when={props.tab.status() !== "ready"}>
        <div class="pshell-frame-cover" classList={{ err: props.tab.status() === "error" }}>
          {props.tab.status() === "error" ? t("plugins.shell.tab.failed", { reason: props.tab.error() ?? "" }) : t("common.loading")}
        </div>
      </Show>
    </div>
  );
}
