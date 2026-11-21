import { For, Show } from "solid-js";
import type { InstalledPlugin, StoreEntry } from "../../types";
import { PluginIcon } from "./PluginIcon";
import { InstallButton } from "./InstallButton";
import { storeStatus } from "./storeStatus";

export function StoreGrid(props: {
  entries: StoreEntry[];
  installed: InstalledPlugin[];
  appVersion: string | null;
  progress: (id: string) => number | null;
  busy: boolean;
  onOpen: (e: StoreEntry) => void;
  onInstall: (e: StoreEntry) => void;
}) {
  return (
    <div class="pstore-grid">
      <For each={props.entries}>
        {(e) => {
          const status = () => storeStatus(e, props.installed.find((p) => p.id === e.id), props.appVersion);
          return (
            <div class="pstore-card" role="button" tabIndex={0}
                 onClick={() => props.onOpen(e)}
                 onKeyDown={(k) => (k.key === "Enter" || k.key === " ") && (k.preventDefault(), props.onOpen(e))}>
              <div class="pstore-card-head">
                <PluginIcon src={e.icon} size="md" />
                <div class="pstore-card-title">
                  <span class="pstore-card-name">{e.name}</span>
                  <span class="pstore-card-meta">
                    v{e.version}
                    <Show when={e.author}>{(a) => <> · {a()}</>}</Show>
                  </span>
                </div>
              </div>
              <p class="pstore-card-summary">{e.summary ?? ""}</p>
              <div class="pstore-card-foot">
                <span class="pstore-card-types">{e.fileTypes.map((f) => f.ext).join(" ")}</span>
                <InstallButton status={status()} version={e.version} progress={props.progress(e.id)}
                               blocked={props.busy} onInstall={() => props.onInstall(e)} />
              </div>
            </div>
          );
        }}
      </For>
    </div>
  );
}
