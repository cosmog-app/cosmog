// Host page for a document-editor plugin: workspace files on the left, one sandboxed frame per
// open tab. See docs/PLUGINS.md "Frontend".

import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { InstalledPlugin, PluginDocRef } from "../types";
import { collapseSidebarWhileMounted } from "../state/sidebar";
import { currentView } from "../state/app";
import { confirmDialog } from "../state/confirm";
import { toast } from "../state/toast";
import { getPref, setPref } from "../state/prefs";
import { IconBack, IconSave, IconSidebar, IconX } from "../utils/icons";
import { t } from "../i18n";
import { createDocTab, refKey, type DocTab } from "./shell/docTab";
import { FilePanel } from "./shell/FilePanel";
import { TabFrame } from "./shell/TabFrame";

/** Live iframes kept; the least recently used clean tab beyond this is unloaded. */
const MAX_LIVE = 4;

export function DocumentShell(props: { plugin: InstalledPlugin; onBack: () => void }) {
  collapseSidebarWhileMounted();
  const panelKey = `plugins.${props.plugin.id}.panel`;
  const [panel, setPanel] = createSignal(getPref(panelKey, true));
  const [tabs, setTabs] = createSignal<DocTab[]>([]);
  const [activeId, setActiveId] = createSignal<string | null>(null);
  const [tick, setTick] = createSignal(0);
  const active = () => tabs().find((x) => x.id === activeId()) ?? null;

  const togglePanel = () => { setPanel(!panel()); setPref(panelKey, panel()); };

  function enforceCap() {
    const live = tabs().filter((x) => x.live());
    const spare = live
      .filter((x) => x.id !== activeId() && !x.dirty() && !x.saving())
      .sort((a, b) => a.lastUsed() - b.lastUsed());
    for (const x of spare.slice(0, Math.max(0, live.length - MAX_LIVE))) x.unload();
  }

  function activate(tab: DocTab) {
    tab.touch();
    if (!tab.live()) tab.revive();
    setActiveId(tab.id);
    enforceCap();
  }

  function open(ref: PluginDocRef, mime: string) {
    const k = refKey(ref);
    const found = tabs().find((x) => refKey(x.ref()) === k);
    if (found) return activate(found);
    const tab = createDocTab(props.plugin, ref, mime);
    setTabs([...tabs(), tab]);
    activate(tab);
  }

  // Picking a file hands the width to the editor; the toggle brings the list back.
  function openFromPanel(ref: PluginDocRef, mime: string) {
    open(ref, mime);
    setPanel(false);
  }

  async function save(tab: DocTab | null) {
    if (!tab) return;
    const before = tab.ref().key;
    try {
      if (await tab.save()) {
        toast.ok(t("plugins.shell.saved", { name: tab.name() }));
        if (tab.ref().key !== before) setTick(tick() + 1);
      }
    } catch (e) {
      toast.err(e);
    }
  }

  async function close(tab: DocTab) {
    if (tab.dirty()) {
      const choice = await confirmDialog({
        title: t("plugins.shell.close.title", { name: tab.name() }),
        body: t("plugins.shell.close.body"),
        confirmLabel: t("common.save"),
        cancelLabel: t("plugins.shell.close.discard"),
        cancelDanger: true,
        dismissLabel: t("common.cancel"),
      });
      if (choice === null) return;
      if (choice) {
        await save(tab);
        if (tab.dirty()) return;
      } else {
        await tab.discard();
      }
    }
    const list = tabs();
    const i = list.indexOf(tab);
    const rest = list.filter((x) => x !== tab);
    setTabs(rest);
    if (activeId() === tab.id) {
      const next = rest[Math.min(i, rest.length - 1)];
      if (next) activate(next);
      else {
        setActiveId(null);
        setPanel(true);
      }
    }
  }

  async function back() {
    const unsaved = tabs().filter((x) => x.dirty()).length;
    if (unsaved > 0) {
      const ok = await confirmDialog({
        title: t("plugins.shell.leave.title", { n: unsaved }),
        body: t("plugins.shell.leave.body"),
        confirmLabel: t("plugins.shell.leave.confirm"),
      });
      if (!ok) return;
      await Promise.all(tabs().map((x) => x.flushDraft()));
    }
    props.onBack();
  }

  // Ctrl/Cmd+S while focus is on the host (inside the frame the SDK sends shell.save).
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (currentView() !== "plugins" || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      void save(active());
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <div class="pshell">
      <div class="view-header pshell-bar">
        <button class="icon-btn" title={t("plugins.harness.back")} aria-label={t("plugins.harness.back")} onClick={back}>
          <IconBack size={14} />
        </button>
        <button class="icon-btn" classList={{ "pshell-on": panel() }} title={t("plugins.shell.files.toggle")}
                aria-label={t("plugins.shell.files.toggle")} onClick={togglePanel}>
          <IconSidebar size={14} />
        </button>
        <span class="pshell-name">{props.plugin.manifest.name}</span>
        <div class="pshell-tabs" role="tablist">
          <For each={tabs()}>
            {(tab) => (
              <div class="pshell-tab" role="tab" aria-selected={tab.id === activeId()}
                   classList={{ active: tab.id === activeId(), dirty: tab.dirty() }}
                   title={`${tab.ref().bucket}/${tab.ref().key}`}
                   onClick={() => activate(tab)}
                   onAuxClick={(e) => e.button === 1 && void close(tab)}>
                <span class="pshell-tab-name">{tab.name()}</span>
                <span class="pshell-tab-dot" />
                <button class="pshell-tab-x" aria-label={t("common.close")}
                        onClick={(e) => { e.stopPropagation(); void close(tab); }}>
                  <IconX size={12} />
                </button>
              </div>
            )}
          </For>
        </div>
        <button class="btn-primary pshell-save" disabled={!active()?.dirty() || active()?.saving() || active()?.status() !== "ready"}
                onClick={() => void save(active())}>
          <IconSave size={14} />
          {active()?.saving() ? t("common.saving") : t("common.save")}
        </button>
      </div>
      <div class="pshell-body">
        {/* Stays mounted so the width can animate and the list keeps its scroll. */}
        <div class="pshell-panel-wrap" classList={{ closed: !panel() }} inert={!panel()}>
          <FilePanel plugin={props.plugin} tick={tick()} activeRef={active()?.ref() ?? null} onOpen={openFromPanel} />
        </div>
        <div class="pshell-stage">
          <For each={tabs()}>
            {(tab) => (
              <Show when={tab.live()}>
                <TabFrame plugin={props.plugin} tab={tab} active={tab.id === activeId()} onSave={() => void save(tab)} />
              </Show>
            )}
          </For>
          <Show when={!active()}>
            <div class="pshell-empty">
              <div class="pshell-empty-title">{t("plugins.shell.empty.title")}</div>
              <div class="pshell-empty-body">{t("plugins.shell.empty.body")}</div>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}
