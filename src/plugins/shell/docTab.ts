// One open document: its frame's broker, the etag it was loaded at, drafts and saving.
// Saves are conditional (If-Match); a conflict asks the user, never overwrites silently.

import { createSignal } from "solid-js";
import type { Broker } from "../broker";
import type { InstalledPlugin, PluginDocRef } from "../../types";
import {
  pluginDocRead, pluginDocWrite, pluginDraftClear, pluginDraftGet, pluginDraftPut,
} from "../../api/plugins";
import { headObject } from "../../api/objects";
import { confirmDialog } from "../../state/confirm";
import { parseWireError } from "../../utils/wireError";
import { basename } from "../../utils/fmt";
import { t } from "../../i18n";

const DRAFT_EVERY_MS = 5_000;

export type TabStatus = "loading" | "ready" | "error";

/** "a/b/plan.excalidraw" -> "a/b/plan (conflict 2026-11-20 14-05).excalidraw" */
export function conflictCopyKey(key: string, now = new Date()): string {
  const slash = key.lastIndexOf("/") + 1;
  const dot = key.lastIndexOf(".");
  const cut = dot > slash ? dot : key.length;
  const stamp = now.toISOString().slice(0, 16).replace("T", " ").replace(":", "-");
  return `${key.slice(0, cut)} (conflict ${stamp})${key.slice(cut)}`;
}

// Cheap change check so an idle dirty tab doesn't rewrite the same draft every tick.
function fingerprint(b: ArrayBuffer): string {
  const u = new Uint8Array(b);
  let h = u.byteLength;
  for (let i = 0; i < u.byteLength; i += 64) h = (h * 31 + u[i]) >>> 0;
  return `${u.byteLength}:${h}`;
}

async function digest(b: ArrayBuffer): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", b));
  return Array.from(h, (x) => x.toString(16).padStart(2, "0")).join("");
}

export type DocTab = ReturnType<typeof createDocTab>;

export function createDocTab(plugin: InstalledPlugin, initial: PluginDocRef, mime: string) {
  const id = crypto.randomUUID();
  const [ref, setRef] = createSignal(initial);
  const [status, setStatus] = createSignal<TabStatus>("loading");
  const [error, setError] = createSignal<string | null>(null);
  const [pluginDirty, setPluginDirty] = createSignal(false);
  // A restored draft differs from the stored file even though the plugin just loaded it.
  const [restored, setRestored] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  let etag: string | null = null;
  let broker: Broker | null = null;
  let timer: number | undefined;
  let lastDraft = "";
  // Hash of what the editor showed when loaded or last saved; backs up the plugin's dirty flag.
  let savedHash: string | null = null;

  const dirty = () => pluginDirty() || restored();
  const name = () => basename(ref().key);

  const fail = (e: unknown) => {
    setError(parseWireError(e).detail || String(e));
    setStatus("error");
  };

  async function askRestore(savedAt: number, stale: boolean): Promise<boolean | null> {
    const when = new Date(savedAt * 1000).toLocaleString();
    return confirmDialog({
      title: t("plugins.shell.restore.title", { name: name() }),
      body: t(stale ? "plugins.shell.restore.bodyStale" : "plugins.shell.restore.body", { when }),
      confirmLabel: t("plugins.shell.restore.confirm"),
      cancelLabel: t("plugins.shell.restore.discard"),
      cancelDanger: true,
    });
  }

  /** Called once per frame mount, after the plugin said ready. */
  async function attach(b: Broker) {
    broker = b;
    setStatus("loading");
    setError(null);
    try {
      await b.ready;
      const doc = await pluginDocRead(ref());
      let bytes = doc.bytes;
      etag = doc.meta.etag;
      let fromDraft = false;
      const draft = await pluginDraftGet(plugin.id, ref());
      if (draft) {
        const choice = await askRestore(draft.meta.savedAt, draft.meta.baseEtag !== etag);
        if (choice === true) {
          bytes = draft.bytes;
          // Saving a draft made on an older version must hit the conflict path.
          etag = draft.meta.baseEtag;
          fromDraft = true;
        } else if (choice === false) {
          await pluginDraftClear(plugin.id, ref());
        }
      }
      if (broker !== b) return;
      await b.load({ name: name(), mime, bytes, readOnly: false });
      // Best effort: without it the close check relies on the plugin's flag alone.
      savedHash = await b.serialize().then(digest).catch(() => null);
      setPluginDirty(false);
      setRestored(fromDraft);
      setStatus("ready");
      startDrafts();
    } catch (e) {
      if (broker === b) fail(e);
    }
  }

  function detach() {
    window.clearInterval(timer);
    timer = undefined;
    broker = null;
  }

  function startDrafts() {
    window.clearInterval(timer);
    timer = window.setInterval(() => void writeDraft(), DRAFT_EVERY_MS);
  }

  async function writeDraft() {
    // Never serialize mid-save: the plugin's saved baseline is the last serialize it answered.
    if (!broker || !dirty() || saving() || status() !== "ready") return;
    try {
      const bytes = await broker.serialize();
      if (saving()) return;
      const fp = fingerprint(bytes);
      if (fp === lastDraft) return;
      await pluginDraftPut(plugin.id, { ...ref(), baseEtag: etag }, bytes);
      lastDraft = fp;
    } catch {
      // A missed draft is retried next tick; the document itself is untouched.
    }
  }

  async function write(bytes: ArrayBuffer, target: PluginDocRef, ifMatch: string | null) {
    return pluginDocWrite({ ...target, mime, ifMatch, create: ifMatch === null }, bytes);
  }

  /** Returns true when the content is stored (also after a conflict resolution). */
  async function save(): Promise<boolean> {
    const b = broker;
    if (!b || saving() || status() !== "ready") return false;
    setSaving(true);
    try {
      const bytes = await b.serialize();
      let target = ref();
      try {
        etag = await write(bytes.slice(0), target, etag);
      } catch (e) {
        if (parseWireError(e).code !== "conflict") throw e;
        const choice = await confirmDialog({
          title: t("plugins.shell.conflict.title", { name: name() }),
          body: t("plugins.shell.conflict.body"),
          confirmLabel: t("plugins.shell.conflict.overwrite"),
          danger: true,
          cancelLabel: t("plugins.shell.conflict.copy"),
          dismissLabel: t("common.cancel"),
        });
        if (choice === null) return false;
        if (choice) {
          // Overwrite what is there now, still conditionally: a third writer conflicts again.
          const head = await headObject(target.accountId, target.bucket, target.key).catch(() => null);
          etag = await write(bytes, target, head?.etag ?? null);
        } else {
          target = { ...target, key: conflictCopyKey(target.key) };
          etag = await write(bytes, target, null);
          await pluginDraftClear(plugin.id, ref());
          setRef(target);
        }
      }
      b.saved();
      savedHash = await digest(bytes);
      setPluginDirty(false);
      setRestored(false);
      lastDraft = "";
      await pluginDraftClear(plugin.id, target).catch(() => {});
      return true;
    } finally {
      setSaving(false);
    }
  }

  /** Close-time check: the plugin's flag, or the content differs from the loaded/saved version. */
  async function hasChanges(): Promise<boolean> {
    if (dirty()) return true;
    if (!broker || saving() || status() !== "ready" || savedHash === null) return false;
    try {
      const now = await digest(await broker.serialize());
      if (now === savedHash) return false;
      setPluginDirty(true);
      return true;
    } catch {
      return false;
    }
  }

  /** Close without saving: the draft goes too. */
  async function discard() {
    detach();
    await pluginDraftClear(plugin.id, ref()).catch(() => {});
  }

  return {
    id,
    ref,
    name,
    mime,
    status,
    error,
    dirty,
    saving,
    hasChanges,
    attach,
    detach,
    save,
    discard,
    onPluginDirty: setPluginDirty,
    fault: (reason: string) => { detach(); fail(new Error(reason)); },
  };
}
