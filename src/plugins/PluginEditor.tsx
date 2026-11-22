// One document open in its plugin, over the app (like the image editor). See docs/PLUGINS.md.

import { onCleanup, onMount, Show } from "solid-js";
import { closeOpenDoc, setDocCloser, type OpenDoc } from "../state/plugins";
import { confirmDialog } from "../state/confirm";
import { toast } from "../state/toast";
import { IconSave, IconX } from "../utils/icons";
import { t } from "../i18n";
import { PluginFrame } from "./PluginFrame";
import { createDocTab } from "./shell/docTab";

export function PluginEditor(props: { doc: OpenDoc }) {
  const tab = createDocTab(props.doc.plugin, props.doc.ref, props.doc.mime);
  const where = () => {
    const { bucket, key } = tab.ref();
    const dir = key.slice(0, key.lastIndexOf("/") + 1);
    return `${bucket}/${dir}`;
  };

  async function save() {
    try {
      if (await tab.save()) {
        toast.ok(t("plugins.shell.saved", { name: tab.name() }));
        props.doc.onSaved?.();
      }
    } catch (e) {
      toast.err(e);
    }
  }

  /** Asks Save / Don't save / Cancel when there are changes. False when the user cancelled. */
  async function close(): Promise<boolean> {
    if (tab.saving()) return false;
    if (await tab.hasChanges()) {
      const choice = await confirmDialog({
        title: t("plugins.shell.close.title", { name: tab.name() }),
        body: t("plugins.shell.close.body"),
        confirmLabel: t("common.save"),
        cancelLabel: t("plugins.shell.close.discard"),
        cancelDanger: true,
        dismissLabel: t("common.cancel"),
      });
      if (choice === null) return false;
      if (choice) {
        await save();
        if (tab.dirty()) return false;
      } else {
        await tab.discard();
      }
    }
    closeOpenDoc();
    return true;
  }

  // Quitting the app goes through the same Save / Don't save prompt.
  setDocCloser(close);
  onCleanup(() => { tab.detach(); setDocCloser(null); });

  // Ctrl/Cmd+S while focus is on the host bar (inside the frame the SDK sends shell.save).
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      void save();
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <div class="peditor" role="dialog" aria-label={tab.name()}>
      <div class="peditor-bar">
        <span class="peditor-name" title={`${tab.ref().bucket}/${tab.ref().key}`}>{tab.name()}</span>
        <Show when={tab.dirty()}>
          <span class="peditor-dot" title={t("plugins.shell.unsaved")} />
        </Show>
        <span class="peditor-where">{where()}</span>
        <span class="peditor-plugin">{props.doc.plugin.manifest.name}</span>
        <button class="btn-primary peditor-save" disabled={!tab.dirty() || tab.saving() || tab.status() !== "ready"}
                onClick={() => void save()}>
          <IconSave size={14} />
          {tab.saving() ? t("common.saving") : t("common.save")}
        </button>
        <button class="icon-btn" title={t("common.close")} aria-label={t("common.close")} onClick={() => void close()}>
          <IconX size={16} />
        </button>
      </div>
      <div class="peditor-stage">
        <PluginFrame
          plugin={props.doc.plugin}
          onBroker={(b) => void tab.attach(b)}
          events={{
            onDirty: (d) => tab.onPluginDirty(d),
            onSave: () => void save(),
            onFault: (r) => tab.fault(r),
            // Titled with the plugin's name so its text never passes for an app message.
            onToast: (kind, text) => kind === "error"
              ? toast.warn(text, props.doc.plugin.manifest.name)
              : toast.info(props.doc.plugin.manifest.name, text),
          }}
        />
        <Show when={tab.status() !== "ready"}>
          <div class="peditor-cover" classList={{ err: tab.status() === "error" }}>
            {tab.status() === "error" ? t("plugins.shell.tab.failed", { reason: tab.error() ?? "" }) : t("common.loading")}
          </div>
        </Show>
      </div>
    </div>
  );
}
