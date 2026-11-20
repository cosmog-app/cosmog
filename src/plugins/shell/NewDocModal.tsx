import { createSignal, Show } from "solid-js";
import { pluginDocWrite, pluginTemplate } from "../../api/plugins";
import { Select } from "../../utils/Select";
import { errMsg } from "../../state/toast";
import { parseWireError } from "../../utils/wireError";
import { t } from "../../i18n";
import type { InstalledPlugin, PluginDocRef, PluginWorkspace } from "../../types";

/** Creates the file in storage from the plugin template, then hands it back to be opened. */
export function NewDocModal(props: {
  plugin: InstalledPlugin;
  workspace: PluginWorkspace;
  onClose: () => void;
  onCreated: (ref: PluginDocRef, mime: string) => void;
}) {
  const types = () => props.plugin.manifest.fileTypes;
  const [ext, setExt] = createSignal(types()[0]?.ext ?? "");
  const [name, setName] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal("");
  const ft = () => types().find((f) => f.ext === ext()) ?? types()[0];

  const key = () => {
    const base = name().trim().replace(/^\/+/, "");
    if (!base) return "";
    const withExt = base.toLowerCase().endsWith(ext().toLowerCase()) ? base : base + ext();
    return props.workspace.prefix + withExt;
  };

  async function submit() {
    const k = key();
    if (busy() || !k) return;
    setBusy(true);
    setErr("");
    try {
      const ref = { accountId: props.workspace.accountId, bucket: props.workspace.bucket, key: k };
      const bytes = await pluginTemplate(props.plugin.id, ext());
      await pluginDocWrite({ ...ref, mime: ft().mime, create: true }, bytes);
      props.onCreated(ref, ft().mime);
      props.onClose();
    } catch (e) {
      setErr(parseWireError(e).code === "conflict" ? t("plugins.shell.new.exists") : errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="modal-backdrop" onClick={props.onClose}>
      <div class="modal pshell-modal" onClick={(e) => e.stopPropagation()}>
        <div class="modal-title">{t("plugins.shell.new.title", { type: ft()?.label ?? "" })}</div>
        <Show when={types().length > 1}>
          <div class="modal-sub modal-sub-path-label">{t("common.type")}</div>
          <Select value={ext()} options={types().map((f) => ({ value: f.ext, label: `${f.label} (${f.ext})` }))} onChange={setExt} />
        </Show>
        <div class="modal-sub modal-sub-path-label">{t("common.name")}</div>
        <input class="field" placeholder={`untitled${ext()}`} autocapitalize="off" autocorrect="off" spellcheck={false}
               value={name()} onInput={(e) => { setName(e.currentTarget.value); setErr(""); }}
               onKeyDown={(e) => e.key === "Enter" && submit()} ref={(el) => queueMicrotask(() => el.focus())} />
        <Show when={key()}><div class="pshell-modal-path">{props.workspace.bucket}/{key()}</div></Show>
        <Show when={err()}><div class="status-msg err">{err()}</div></Show>
        <div class="btn-row mt-3">
          <button class="btn-secondary btn-half" onClick={props.onClose}>{t("common.cancel")}</button>
          <button class="btn-primary btn-half" disabled={busy() || !key()} onClick={submit}>
            {busy() ? t("browse.creating") : t("common.create")}
          </button>
        </div>
      </div>
    </div>
  );
}
