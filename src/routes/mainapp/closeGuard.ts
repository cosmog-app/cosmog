import { createEffect, onCleanup } from "solid-js";
import { appCloseQuits } from "../../api/folderUpload";
import { movingFolderJobs } from "../../state/folderJobs";
import { closeDocForQuit, openDoc } from "../../state/plugins";
import { confirmDialog } from "../../state/confirm";
import { isDesktopShell } from "../../utils/platform";
import { t } from "../../i18n";

type Win = Awaited<ReturnType<typeof getWin>>;
const getWin = async () => (await import("@tauri-apps/api/window")).getCurrentWindow();
// Tauri's unlisten returns a promise despite its `() => void` type.
const release = (fn: () => unknown) => { void Promise.resolve().then(fn).catch(() => {}); };

// While a folder job moves or a plugin document is open, a close that really quits asks first.
// The listener always preventDefaults (Tauri's JS default would destroy the window, even in tray
// mode); to close it unlistens and re-issues close(), so Rust's own CloseRequested handling decides.
// An open document is checked at close time, since its dirty flag may lag the content.
const needed = () => movingFolderJobs().length > 0 || openDoc() !== null;

export function useCloseGuard() {
  if (!isDesktopShell) return;
  let unlisten: (() => void) | null = null;
  let pending = false;
  let asking = false;

  async function shouldClose(): Promise<boolean> {
    const quits = await appCloseQuits().catch(() => null);
    // Keep-alive: Rust already hid the window.
    if (quits === false) return false;
    // Unknown state or nothing running: behave as without the guard.
    if (quits === null || !needed()) return true;
    if (movingFolderJobs().length > 0) {
      const ok = await confirmDialog({
        title: t("folderUpload.close.title"),
        body: t("folderUpload.close.body"),
        confirmLabel: t("folderUpload.close.confirm"),
        cancelLabel: t("folderUpload.close.keep"),
        danger: true,
      }).catch(() => false);
      if (ok !== true) return false;
    }
    // Last, because Save / Don't save closes the document.
    return !openDoc() || (await closeDocForQuit().catch(() => false));
  }

  async function closeUnguarded(win: Win) {
    const fn = unlisten;
    unlisten = null;
    // Tauri's unlisten is async; Rust must see no JS listener before close() or it would block it again.
    try { await fn?.(); await win.close(); } catch { /* window stays open */ }
    // Still alive (hidden to tray or close refused): re-arm if still needed.
    setTimeout(sync, 1000);
  }

  async function register() {
    pending = true;
    try {
      const win = await getWin();
      const fn = await win.onCloseRequested(async (evt) => {
        evt.preventDefault();
        if (asking) return;
        asking = true;
        try {
          if (await shouldClose()) await closeUnguarded(win);
        } finally { asking = false; }
      });
      if (!needed()) release(fn); else unlisten = fn;
    } catch { /* no window API: close behaves as before */ }
    pending = false;
  }

  function sync() {
    const need = needed();
    if (need && !unlisten && !pending) void register();
    if (!need && unlisten) { release(unlisten); unlisten = null; }
  }

  createEffect(sync);
  onCleanup(() => { if (unlisten) release(unlisten); unlisten = null; });
}
