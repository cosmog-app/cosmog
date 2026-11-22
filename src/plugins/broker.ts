// Host side of the plugin protocol (docs/PLUGINS.md). One broker per iframe. The sender is the
// iframe we created (`event.source`), never an id inside the message.

import type {
  InstalledPlugin, PluginDocLoad, PluginDocSerialized, PluginReply, PluginToastKind,
} from "../types";
import { desktopOs, isAndroid } from "../utils/platform";

export const PLUGIN_API_VERSIONS = [1];
/** Per-message payload cap, both directions. */
export const MAX_PLUGIN_BYTES = 128 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
// A plugin that never says ready (script error, missing asset) must fail visibly, not load forever.
const BOOT_TIMEOUT_MS = 20_000;
const TOAST_MIN_GAP_MS = 2_000;
const TOAST_MAX_CHARS = 200;

// Windows (WebView2) and Android serve custom schemes as http://<scheme>.localhost.
const ORIGIN = desktopOs === "windows" || isAndroid ? "http://cosmog-plugin.localhost" : "cosmog-plugin://localhost";

export function pluginEntryUrl(p: InstalledPlugin): string {
  const parts = [p.id, p.version, ...p.manifest.entry.split("/")].map(encodeURIComponent);
  return `${ORIGIN}/${parts.join("/")}`;
}

export interface BrokerEvents {
  onReady?: (apiVersion: number) => void;
  onDirty?: (dirty: boolean) => void;
  onSave?: () => void;
  onToast?: (kind: PluginToastKind, text: string) => void;
  /** Protocol violation or unsupported plugin; the frame should be torn down. */
  onFault?: (reason: string) => void;
}

export interface Broker {
  ready: Promise<number>;
  load(doc: PluginDocLoad): Promise<void>;
  serialize(): Promise<ArrayBuffer>;
  setTheme(mode: "light" | "dark"): void;
  /** The last serialize() result was stored; the plugin moves its dirty baseline there. */
  saved(): void;
  /** Pinch caught by the host (Linux), in frame coordinates; the plugin replays it as Ctrl+wheel. */
  pinch(x: number, y: number, deltaY: number): void;
  dispose(): void;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

// Lets host-wide input (pinch) find the plugin under the pointer.
const byFrame = new WeakMap<HTMLIFrameElement, Broker>();
export const brokerForFrame = (f: HTMLIFrameElement) => byFrame.get(f) ?? null;

export function createBroker(frame: HTMLIFrameElement, ev: BrokerEvents): Broker {
  let seq = 0;
  let disposed = false;
  let lastToast = 0;
  const pending = new Map<string, Pending>();
  let markReady!: (v: number) => void;
  let failReady!: (e: Error) => void;
  const ready = new Promise<number>((res, rej) => { markReady = res; failReady = rej; });
  // Avoid an unhandled rejection when nobody awaits `ready` before a fault.
  ready.catch(() => {});
  const boot = window.setTimeout(() => fault("plugin did not start"), BOOT_TIMEOUT_MS);

  let started = false;
  const fault = (reason: string) => {
    window.clearTimeout(boot);
    failReady(new Error(reason));
    ev.onFault?.(reason);
  };

  // Opaque-origin frames can only be addressed with "*". The app CSP frame-src keeps the frame
  // on the plugin scheme, so the receiver is still our plugin document.
  const post = (msg: object, transfer: Transferable[] = []) => {
    frame.contentWindow?.postMessage({ cosmog: 1, ...msg }, "*", transfer);
  };

  const onMessage = (e: MessageEvent) => {
    if (disposed || e.source !== frame.contentWindow) return;
    const m = e.data;
    if (!isObj(m) || m.cosmog !== 1) return;

    if (typeof m.id === "string" && ("result" in m || "error" in m)) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      window.clearTimeout(p.timer);
      const reply = m as unknown as PluginReply;
      if (reply.error) p.reject(new Error(`${reply.error.code}: ${reply.error.message}`));
      else p.resolve(reply.result);
      return;
    }

    const params = isObj(m.params) ? m.params : {};
    switch (m.method) {
      case "ready": {
        // A second ready means the page reloaded and lost the document; saving now would write a blank one.
        if (started) {
          fault("plugin reloaded");
          return;
        }
        const v = params.apiVersion;
        if (typeof v !== "number" || !PLUGIN_API_VERSIONS.includes(v)) {
          fault(`unsupported apiVersion ${String(v)}`);
          return;
        }
        started = true;
        window.clearTimeout(boot);
        markReady(v);
        ev.onReady?.(v);
        return;
      }
      case "doc.dirty":
        ev.onDirty?.(params.dirty === true);
        return;
      case "shell.save":
        ev.onSave?.();
        return;
      case "ui.toast": {
        const now = Date.now();
        if (now - lastToast < TOAST_MIN_GAP_MS || typeof params.text !== "string") return;
        lastToast = now;
        const kind: PluginToastKind = params.kind === "error" || params.kind === "success" ? params.kind : "info";
        ev.onToast?.(kind, params.text.slice(0, TOAST_MAX_CHARS));
        return;
      }
      default:
        // Unknown methods are dropped, not answered: v1 plugins send events only.
        return;
    }
  };
  window.addEventListener("message", onMessage);

  const request = async <T>(method: string, params: unknown, transfer: Transferable[] = [], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> => {
    await ready;
    if (disposed) throw new Error("plugin closed");
    const id = String(++seq);
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      post({ id, method, params }, transfer);
    });
  };

  const broker: Broker = {
    ready,
    async load(doc) {
      if (doc.bytes.byteLength > MAX_PLUGIN_BYTES) throw new Error("document too large for plugin");
      await request<null>("doc.load", doc, [doc.bytes]);
    },
    async serialize() {
      const r = await request<PluginDocSerialized>("doc.serialize", {});
      if (!isObj(r) || !(r.bytes instanceof ArrayBuffer)) throw new Error("plugin returned no bytes");
      if (r.bytes.byteLength > MAX_PLUGIN_BYTES) throw new Error("plugin returned too much data");
      return r.bytes;
    },
    setTheme(mode) {
      void ready.then(() => post({ method: "ui.theme", params: { mode } }), () => {});
    },
    saved() {
      if (!disposed) post({ method: "doc.saved" });
    },
    pinch(x, y, deltaY) {
      if (!disposed) post({ method: "ui.pinch", params: { x, y, deltaY } });
    },
    dispose() {
      disposed = true;
      window.clearTimeout(boot);
      window.removeEventListener("message", onMessage);
      for (const p of pending.values()) {
        window.clearTimeout(p.timer);
        p.reject(new Error("plugin closed"));
      }
      pending.clear();
      failReady(new Error("plugin closed"));
      byFrame.delete(frame);
    },
  };
  byFrame.set(frame, broker);
  return broker;
}
