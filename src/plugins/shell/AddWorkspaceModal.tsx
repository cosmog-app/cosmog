import { createResource, createSignal, Show } from "solid-js";
import { accounts } from "../../state/app";
import { listBuckets } from "../../api/buckets";
import { pluginWorkspaceAdd } from "../../api/plugins";
import { Select } from "../../utils/Select";
import { errMsg } from "../../state/toast";
import { t } from "../../i18n";
import type { PluginWorkspace } from "../../types";

export function AddWorkspaceModal(props: { pluginId: string; onClose: () => void; onAdded: (w: PluginWorkspace) => void }) {
  const [accountId, setAccountId] = createSignal(accounts()[0]?.id ?? "");
  const [bucket, setBucket] = createSignal("");
  const [prefix, setPrefix] = createSignal("");
  const [label, setLabel] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal("");

  // Errors swallowed so a listing hiccup never breaks the form.
  const [buckets] = createResource(accountId, (id) => (id ? listBuckets(id).catch(() => []) : []));
  const autoLabel = () => [bucket(), prefix().trim().replace(/^\/+|\/+$/g, "")].filter(Boolean).join("/");

  async function submit() {
    if (busy() || !accountId() || !bucket()) return;
    setBusy(true);
    setErr("");
    try {
      const w = await pluginWorkspaceAdd({
        pluginId: props.pluginId,
        label: label().trim() || autoLabel(),
        accountId: accountId(),
        bucket: bucket(),
        prefix: prefix(),
      });
      props.onAdded(w);
      props.onClose();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="modal-backdrop" onClick={props.onClose}>
      <div class="modal pshell-modal" onClick={(e) => e.stopPropagation()}>
        <div class="modal-title">{t("plugins.shell.ws.addTitle")}</div>
        <div class="modal-sub">{t("plugins.shell.ws.addBody")}</div>
        <div class="modal-sub modal-sub-path-label">{t("plugins.shell.ws.account")}</div>
        <Select
          value={accountId()}
          options={accounts().map((a) => ({ value: a.id, label: a.name }))}
          onChange={(v) => { setAccountId(v); setBucket(""); }}
        />
        <div class="modal-sub modal-sub-path-label">{t("plugins.shell.ws.bucket")}</div>
        <Select
          value={bucket()}
          placeholder={buckets.loading ? t("common.loading") : t("common.select")}
          disabled={!accountId()}
          options={(buckets() ?? []).map((b) => ({ value: b.name, label: b.name }))}
          onChange={setBucket}
        />
        <div class="modal-sub modal-sub-path-label">{t("plugins.shell.ws.folder")}</div>
        <input class="field" placeholder="drawings/" autocapitalize="off" autocorrect="off" spellcheck={false}
               value={prefix()} onInput={(e) => setPrefix(e.currentTarget.value)} />
        <div class="modal-sub modal-sub-path-label">{t("plugins.shell.ws.label")}</div>
        <input class="field" placeholder={autoLabel() || t("plugins.shell.ws.labelHint")}
               value={label()} onInput={(e) => setLabel(e.currentTarget.value)}
               onKeyDown={(e) => e.key === "Enter" && submit()} />
        <Show when={err()}><div class="status-msg err">{err()}</div></Show>
        <div class="btn-row mt-3">
          <button class="btn-secondary btn-half" onClick={props.onClose}>{t("common.cancel")}</button>
          <button class="btn-primary btn-half" disabled={busy() || !accountId() || !bucket()} onClick={submit}>
            {busy() ? t("common.loading") : t("common.add")}
          </button>
        </div>
      </div>
    </div>
  );
}
