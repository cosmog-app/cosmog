import { createEffect, createResource, createSignal, For, Show } from "solid-js";
import { pluginDocList, pluginWorkspaceList, pluginWorkspaceRemove } from "../../api/plugins";
import { getPref, setPref } from "../../state/prefs";
import { confirmDialog } from "../../state/confirm";
import { errMsg, toast } from "../../state/toast";
import { Select } from "../../utils/Select";
import { IconFile, IconPlus, IconRefresh, IconTrash } from "../../utils/icons";
import { formatRelative } from "../../utils/fmt";
import { t } from "../../i18n";
import type { InstalledPlugin, PluginDocRef, PluginWorkspace } from "../../types";
import { AddWorkspaceModal } from "./AddWorkspaceModal";
import { NewDocModal } from "./NewDocModal";

export function FilePanel(props: {
  plugin: InstalledPlugin;
  /** Bumped by the shell after a save that may add a file (save as copy). */
  tick: number;
  activeRef: PluginDocRef | null;
  onOpen: (ref: PluginDocRef, mime: string) => void;
}) {
  const prefKey = `plugins.${props.plugin.id}.workspace`;
  const [wsId, setWsId] = createSignal<string>(getPref(prefKey, ""));
  const [adding, setAdding] = createSignal(false);
  const [creating, setCreating] = createSignal(false);

  const [workspaces, { refetch: refetchWs }] = createResource(() => props.plugin.id, pluginWorkspaceList, { initialValue: [] });
  const ws = (): PluginWorkspace | null => workspaces().find((w) => w.id === wsId()) ?? workspaces()[0] ?? null;

  const [docs, { refetch: refetchDocs }] = createResource(
    () => (ws() ? { id: ws()!.id, tick: props.tick } : null),
    (k) => pluginDocList(k.id),
  );

  createEffect(() => {
    const id = ws()?.id;
    if (id && id !== wsId()) setWsId(id);
  });

  const choose = (id: string) => { setWsId(id); setPref(prefKey, id); };
  const mimeFor = (key: string) =>
    props.plugin.manifest.fileTypes.find((f) => key.toLowerCase().endsWith(f.ext.toLowerCase()))?.mime ??
    props.plugin.manifest.fileTypes[0]?.mime ?? "application/octet-stream";
  const isActive = (key: string) => {
    const a = props.activeRef, w = ws();
    return !!a && !!w && a.accountId === w.accountId && a.bucket === w.bucket && a.key === key;
  };

  async function removeWs() {
    const w = ws();
    if (!w) return;
    const ok = await confirmDialog({
      title: t("plugins.shell.ws.removeTitle", { name: w.label }),
      body: t("plugins.shell.ws.removeBody"),
      confirmLabel: t("common.remove"),
      danger: true,
    });
    if (!ok) return;
    try {
      await pluginWorkspaceRemove(w.id);
      await refetchWs();
    } catch (e) {
      toast.err(e);
    }
  }

  return (
    <aside class="pshell-panel">
      <Show
        when={ws()}
        fallback={
          <div class="pshell-panel-empty">
            <div class="pshell-panel-empty-title">{t("plugins.shell.ws.emptyTitle")}</div>
            <div class="pshell-panel-empty-body">{t("plugins.shell.ws.emptyBody")}</div>
            <button class="btn-secondary" onClick={() => setAdding(true)}>
              <IconPlus size={14} />{t("plugins.shell.ws.add")}
            </button>
          </div>
        }
      >
        {(w) => (
          <>
            <div class="pshell-panel-head">
              <Select
                class="pshell-ws-select"
                value={w().id}
                options={workspaces().map((x) => ({ value: x.id, label: x.label }))}
                onChange={choose}
              />
              <button class="icon-btn" title={t("plugins.shell.ws.add")} aria-label={t("plugins.shell.ws.add")} onClick={() => setAdding(true)}>
                <IconPlus size={14} />
              </button>
              <button class="icon-btn danger" title={t("plugins.shell.ws.remove")} aria-label={t("plugins.shell.ws.remove")} onClick={removeWs}>
                <IconTrash size={14} />
              </button>
            </div>
            <div class="pshell-panel-where" title={`${w().bucket}/${w().prefix}`}>{w().bucket}/{w().prefix}</div>
            <div class="pshell-panel-actions">
              <button class="btn-secondary pshell-new" onClick={() => setCreating(true)}>
                <IconPlus size={14} />
                {t("plugins.shell.new.button", { type: props.plugin.manifest.fileTypes[0]?.label ?? "" })}
              </button>
              <button class="icon-btn" title={t("common.refresh")} aria-label={t("common.refresh")} onClick={() => refetchDocs()}>
                <IconRefresh size={14} />
              </button>
            </div>
            <Show when={!docs.error} fallback={<div class="pshell-panel-note err">{errMsg(docs.error)}</div>}>
              <Show when={(docs() ?? []).length > 0} fallback={
                <div class="pshell-panel-note">{docs.loading ? t("common.loading") : t("plugins.shell.files.empty")}</div>
              }>
                <ul class="pshell-files">
                  <For each={docs()}>
                    {(d) => (
                      <li>
                        <button
                          class="pshell-file"
                          classList={{ active: isActive(d.key) }}
                          title={d.key}
                          onClick={() => props.onOpen({ accountId: w().accountId, bucket: w().bucket, key: d.key }, mimeFor(d.key))}
                        >
                          <IconFile size={14} />
                          <span class="pshell-file-name">{d.key.slice(w().prefix.length)}</span>
                          <Show when={d.lastModified}>
                            <span class="pshell-file-time">{formatRelative(d.lastModified!)}</span>
                          </Show>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </Show>
          </>
        )}
      </Show>
      <Show when={adding()}>
        <AddWorkspaceModal
          pluginId={props.plugin.id}
          onClose={() => setAdding(false)}
          onAdded={async (nw) => { await refetchWs(); choose(nw.id); }}
        />
      </Show>
      <Show when={creating() && ws()}>
        <NewDocModal
          plugin={props.plugin}
          workspace={ws()!}
          onClose={() => setCreating(false)}
          onCreated={(ref, mime) => { void refetchDocs(); props.onOpen(ref, mime); }}
        />
      </Show>
    </aside>
  );
}
