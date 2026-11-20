// Phase 1 test page: drives a plugin through the protocol without storage. Replaced by the
// document shell in Phase 2.

import { createSignal, For, Show } from "solid-js";
import { IconBack, IconList, IconTrash } from "../../utils/icons";
import type { InstalledPlugin } from "../../types";
import type { Broker } from "../../plugins/broker";
import { PluginFrame } from "../../plugins/PluginFrame";
import { toast } from "../../state/toast";
import { collapseSidebarWhileMounted } from "../../state/sidebar";
import { t } from "../../i18n";

const BIG_BYTES = 50 * 1024 * 1024;

// Cheap content check without hashing 50 MB on the UI thread.
function fingerprint(b: Uint8Array): string {
  let h = b.byteLength;
  for (let i = 0; i < b.byteLength; i += 4096) h = (h * 31 + b[i]) >>> 0;
  return `${b.byteLength}:${h.toString(16)}`;
}

type LogLine = { time: string; text: string; err: boolean };

export function PluginHarness(props: { plugin: InstalledPlugin; onBack: () => void }) {
  const [broker, setBroker] = createSignal<Broker | null>(null);
  const [ready, setReady] = createSignal(false);
  const [dirty, setDirty] = createSignal(false);
  const [fault, setFault] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [log, setLog] = createSignal<LogLine[]>([]);
  // Editors need the width.
  collapseSidebarWhileMounted();
  const [logOpen, setLogOpen] = createSignal(false);

  const note = (text: string, err = false) =>
    setLog((l) => [{ time: new Date().toLocaleTimeString(), text, err }, ...l].slice(0, 50));

  const run = async (label: string, fn: (b: Broker) => Promise<string>) => {
    const b = broker();
    if (!b) return;
    setBusy(true);
    const t0 = performance.now();
    try {
      note(`${label}: ${await fn(b)} (${Math.round(performance.now() - t0)} ms)`);
    } catch (e) {
      note(`${label} failed: ${String(e)}`, true);
    } finally {
      setBusy(false);
    }
  };

  // Empty bytes = new document, which every plugin must accept.
  const loadSample = () => run("doc.load", async (b) => {
    const ft = props.plugin.manifest.fileTypes[0];
    await b.load({ name: `untitled${ft?.ext ?? ""}`, mime: ft?.mime ?? "application/octet-stream", bytes: new ArrayBuffer(0), readOnly: false });
    return "empty document";
  });

  const reload = () => run("serialize + load", async (b) => {
    const bytes = await b.serialize();
    const n = bytes.byteLength;
    const ft = props.plugin.manifest.fileTypes[0];
    await b.load({ name: `untitled${ft?.ext ?? ""}`, mime: ft?.mime ?? "application/octet-stream", bytes, readOnly: false });
    return `${n} bytes`;
  });

  const serialize = () => run("doc.serialize", async (b) => {
    const out = new Uint8Array(await b.serialize());
    const preview = out.byteLength <= 200 ? JSON.stringify(new TextDecoder().decode(out)) : "";
    return `${out.byteLength} bytes ${preview}`;
  });

  const bigRoundTrip = () => run("50 MB round trip", async (b) => {
    const src = new Uint8Array(BIG_BYTES);
    for (let i = 0; i < src.byteLength; i += 4096) src[i] = (i / 4096) & 0xff;
    const before = fingerprint(src);
    await b.load({ name: "big.bin", mime: "application/octet-stream", bytes: src.buffer, readOnly: false });
    const after = fingerprint(new Uint8Array(await b.serialize()));
    if (after !== before) throw new Error(`mismatch ${before} != ${after}`);
    return `match ${after}`;
  });

  const off = () => !ready() || busy();

  return (
    <div class="plugins-harness">
      <div class="view-header plugins-harness-bar">
        <button class="icon-btn" title={t("plugins.harness.back")} aria-label={t("plugins.harness.back")} onClick={props.onBack}>
          <IconBack size={14} />
        </button>
        <span class="plugins-harness-name">{props.plugin.manifest.name}</span>
        <span class="plugins-harness-state" classList={{ "plugins-harness-dirty": dirty() }}>
          <span class="plugins-harness-dot" />
          {dirty() ? t("plugins.harness.dirty") : t("plugins.harness.clean")}
        </span>
        <div class="plugins-harness-actions">
          <span class="plugins-harness-label">{t("plugins.harness.tests")}</span>
          <div class="plugins-harness-group">
            <button class="btn-ghost" disabled={off()} onClick={loadSample}>{t("plugins.harness.loadSample")}</button>
            <button class="btn-ghost" disabled={off()} onClick={serialize}>{t("plugins.harness.serialize")}</button>
            <button class="btn-ghost" disabled={off()} onClick={reload}>{t("plugins.harness.reload")}</button>
            <button class="btn-ghost" disabled={off()} onClick={bigRoundTrip}>{t("plugins.harness.bigRoundTrip")}</button>
          </div>
          <button class="btn-ghost plugins-harness-logbtn" classList={{ "plugins-harness-on": logOpen() }} onClick={() => setLogOpen((o) => !o)}>
            <IconList size={14} />
            {t("plugins.harness.log")}
            <span class="plugins-harness-count">{log().length}</span>
          </button>
        </div>
      </div>
      <Show when={fault()} fallback={
        <Show when={!ready()}><div class="plugins-harness-note">{t("plugins.harness.waiting")}</div></Show>
      }>
        {(r) => <div class="plugins-harness-note plugins-harness-fault">{t("plugins.harness.fault", { reason: r() })}</div>}
      </Show>
      <Show when={!fault()}>
        <PluginFrame
          plugin={props.plugin}
          onBroker={setBroker}
          events={{
            onReady: (v) => { setReady(true); note(`ready (apiVersion ${v})`); },
            onDirty: (d) => { setDirty(d); note(`doc.dirty ${d}`); },
            onSave: () => { note("shell.save"); toast.info(t("plugins.harness.saveRequested")); },
            onToast: (kind, text) => { note(`ui.toast ${kind}: ${text}`); toast.info(text); },
            onFault: (reason) => { setFault(reason); note(`fault: ${reason}`, true); },
          }}
        />
      </Show>
      <Show when={logOpen()}>
        <div class="plugins-harness-log">
          <div class="plugins-harness-loghead">
            <span>{t("plugins.harness.log")}</span>
            <button class="btn-ghost" disabled={log().length === 0} onClick={() => setLog([])}>
              <IconTrash size={13} />
              {t("plugins.harness.clear")}
            </button>
          </div>
          <Show when={log().length > 0} fallback={<div class="plugins-harness-logempty">{t("plugins.harness.logEmpty")}</div>}>
            <ol class="plugins-harness-lines">
              <For each={log()}>
                {(l) => (
                  <li classList={{ "plugins-harness-err": l.err }}>
                    <span class="plugins-harness-time">{l.time}</span>
                    <span>{l.text}</span>
                  </li>
                )}
              </For>
            </ol>
          </Show>
        </div>
      </Show>
    </div>
  );
}
