// Phase 1 test page: drives a plugin through the protocol without storage. Replaced by the
// document shell in Phase 2.

import { createSignal, For, Show } from "solid-js";
import type { InstalledPlugin } from "../../types";
import type { Broker } from "../../plugins/broker";
import { PluginFrame } from "../../plugins/PluginFrame";
import { toast } from "../../state/toast";
import { t } from "../../i18n";

const BIG_BYTES = 50 * 1024 * 1024;

// Cheap content check without hashing 50 MB on the UI thread.
function fingerprint(b: Uint8Array): string {
  let h = b.byteLength;
  for (let i = 0; i < b.byteLength; i += 4096) h = (h * 31 + b[i]) >>> 0;
  return `${b.byteLength}:${h.toString(16)}`;
}

export function PluginHarness(props: { plugin: InstalledPlugin; onBack: () => void }) {
  const [broker, setBroker] = createSignal<Broker | null>(null);
  const [ready, setReady] = createSignal(false);
  const [dirty, setDirty] = createSignal(false);
  const [fault, setFault] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [log, setLog] = createSignal<string[]>([]);

  const note = (line: string) => setLog((l) => [`${new Date().toLocaleTimeString()}  ${line}`, ...l].slice(0, 50));

  const run = async (label: string, fn: (b: Broker) => Promise<string>) => {
    const b = broker();
    if (!b) return;
    setBusy(true);
    const t0 = performance.now();
    try {
      note(`${label}: ${await fn(b)} (${Math.round(performance.now() - t0)} ms)`);
    } catch (e) {
      note(`${label} failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const loadSample = () => run("doc.load", async (b) => {
    const bytes = new TextEncoder().encode(`hello from cosmog at ${new Date().toISOString()}\n`);
    await b.load({ name: "sample.hello", mime: "text/plain", bytes: bytes.buffer, readOnly: false });
    return `${bytes.byteLength} bytes`;
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

  return (
    <div class="plugins-harness">
      <div class="plugins-harness-bar">
        <button class="btn-ghost" onClick={props.onBack}>{t("plugins.harness.back")}</button>
        <span class="plugins-harness-name">{props.plugin.manifest.name}</span>
        <span class="plugins-harness-state" classList={{ "plugins-harness-dirty": dirty() }}>
          {dirty() ? t("plugins.harness.dirty") : t("plugins.harness.clean")}
        </span>
        <div class="plugins-harness-actions">
          <button class="btn-secondary" disabled={!ready() || busy()} onClick={loadSample}>{t("plugins.harness.loadSample")}</button>
          <button class="btn-secondary" disabled={!ready() || busy()} onClick={serialize}>{t("plugins.harness.serialize")}</button>
          <button class="btn-secondary" disabled={!ready() || busy()} onClick={bigRoundTrip}>{t("plugins.harness.bigRoundTrip")}</button>
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
            onFault: (reason) => { setFault(reason); note(`fault: ${reason}`); },
          }}
        />
      </Show>
      <ol class="plugins-harness-log">
        <For each={log()}>{(l) => <li>{l}</li>}</For>
      </ol>
    </div>
  );
}
