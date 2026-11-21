import { createSignal, Show } from "solid-js";
import { putObjectText } from "../../api/objects";
import { focusEnd, objectExists, prefixToPath } from "./newItem";
import { errMsg } from "../../state/toast";
import { extOf } from "../../utils/fmt";
import { Select } from "../../utils/Select";
import { TEXT_TYPES, textTypeForName, withExt, type TextType } from "../../utils/textTypes";
import { t } from "../../i18n";
import { mimeTypeSchema, objectKeySchema, parseSchema } from "../../validation";
import { docPlugins } from "../../state/plugins";
import { pluginDocWrite, pluginTemplate } from "../../api/plugins";
import { parseWireError } from "../../utils/wireError";
import type { InstalledPlugin, PluginFileType } from "../../types";

// Document plugin file types join the list; their value can't collide with a bare text ext.
interface PluginType { value: string; plugin: InstalledPlugin; ft: PluginFileType }
const pluginTypes = (): PluginType[] =>
  docPlugins().flatMap((p) => p.manifest.fileTypes.map((ft) => ({ value: `plugin:${p.id}:${ft.ext}`, plugin: p, ft })));

// Only the generic labels are translated; language names stay as is.
const typeLabel = (x: TextType) =>
  x.ext === "txt" ? t("browse.newFile.plainText") : x.ext === "log" ? t("browse.newFile.log") : x.label;

export function NewFileModal(props: {
  accountId: string;
  bucket: string;
  prefix: string;
  onClose: () => void;
  onCreated: (key: string, mime: string) => void;
  /** A plugin document was created from its template; the caller opens it. */
  onPluginCreated: (key: string) => void;
}) {
  const [name, setName] = createSignal(prefixToPath(props.prefix));
  const [ext, setExt] = createSignal("txt");
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal("");

  // empty = follow the selected type
  const [customMime, setCustomMime] = createSignal("");
  const pluginType = () => pluginTypes().find((x) => x.value === ext()) ?? null;
  const typeMime = () => pluginType()?.ft.mime ?? TEXT_TYPES.find((t) => t.ext === ext())?.mime ?? "text/plain";
  const mime = () => customMime().trim() || typeMime();

  function onNameInput(v: string) {
    setName(v);
    setErr("");
    const lower = v.toLowerCase();
    const pt = pluginTypes().find((x) => lower.endsWith(x.ft.ext.toLowerCase()));
    const t = textTypeForName(v);
    if (pt) setExt(pt.value);
    else if (t) setExt(t.ext);
    else if (extOf(v.split("/").pop() ?? "")) setExt("txt");
  }

  function onTypeChange(v: string) {
    setExt(v);
    setCustomMime("");
    const pt = pluginTypes().find((x) => x.value === v);
    if (!pt) setName(withExt(name(), v));
    else if (!name().toLowerCase().endsWith(pt.ft.ext.toLowerCase())) setName(withExt(name(), pt.ft.ext.slice(1)));
    setErr("");
  }

  async function submit() {
    if (busy()) return;
    const result = parseSchema(objectKeySchema, name());
    if (!result.success) { setErr(result.message); return; }
    let key = result.data;
    if (key.endsWith("/")) { setErr(t("browse.newFile.nameRequired")); return; }
    // The plugin opens files by extension, so a plugin type always gets its own.
    const ptExt = pluginType()?.ft.ext;
    if (ptExt && !key.toLowerCase().endsWith(ptExt.toLowerCase())) key += ptExt;
    const mimeResult = parseSchema(mimeTypeSchema, mime());
    if (!mimeResult.success) { setErr(mimeResult.message); return; }
    const contentType = mimeResult.data;
    setBusy(true);
    const pt = pluginType();
    if (pt) {
      try {
        const ref = { accountId: props.accountId, bucket: props.bucket, key };
        await pluginDocWrite({ ...ref, mime: contentType, create: true }, await pluginTemplate(pt.plugin.id, pt.ft.ext));
        props.onClose();
        props.onPluginCreated(key);
      } catch (e) {
        setErr(parseWireError(e).code === "conflict" ? t("browse.newFile.exists") : errMsg(e));
      } finally {
        setBusy(false);
      }
      return;
    }
    try {
      const exists = await objectExists(props.accountId, props.bucket, key);
      if (exists) { setErr(t("browse.newFile.exists")); return; }
      await putObjectText(props.accountId, props.bucket, key, "", contentType);
      props.onCreated(key, contentType);
      props.onClose();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="modal-backdrop" onClick={props.onClose}>
      <div class="modal new-file-modal" onClick={(e) => e.stopPropagation()}>
        <div class="modal-title">{t("browse.newFile.title")}</div>
        <div class="modal-sub modal-sub-path-label">{t("common.type")}</div>
        <Select
          value={ext()}
          options={[
            ...pluginTypes().map((x) => ({ value: x.value, label: `${x.ft.label} (${x.ft.ext}) · ${x.plugin.manifest.name}` })),
            ...TEXT_TYPES.map((tt) => ({ value: tt.ext, label: `${typeLabel(tt)} (.${tt.ext})` })),
          ]}
          onChange={onTypeChange}
        />
        <div class="modal-sub modal-sub-path-label">{t("browse.newFile.path")}</div>
        <input class="field" placeholder="path/to/file.txt" autocapitalize="off" autocorrect="off" spellcheck={false}
               value={name()}
               onInput={(e) => onNameInput(e.currentTarget.value)}
               onKeyDown={(e) => e.key === "Enter" && submit()}
               ref={focusEnd} />
        <div class="modal-sub modal-sub-path-label">{t("browse.newFile.contentType")}</div>
        <input class="field" placeholder={typeMime()} autocapitalize="off" autocorrect="off" spellcheck={false} value={customMime()}
               onInput={(e) => { setCustomMime(e.currentTarget.value); setErr(""); }}
               onKeyDown={(e) => e.key === "Enter" && submit()} />
        <Show when={err()}><div class="status-msg err">{err()}</div></Show>
        <div class="btn-row mt-3">
          <button class="btn-secondary btn-half" onClick={props.onClose}>{t("common.cancel")}</button>
          <button class="btn-primary btn-half" disabled={busy() || !name().trim().replace(/\//g, "")} onClick={submit}>
            {busy() ? t("browse.creating") : t("common.create")}
          </button>
        </div>
      </div>
    </div>
  );
}
