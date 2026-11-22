import { Index, Show } from "solid-js";
import { PluginIcon } from "./PluginIcon";
import { InstallButton } from "./InstallButton";
import { listingStatus, type Listing } from "./listing";

export function StoreGrid(props: {
  items: Listing[];
  appVersion: string | null;
  progress: (id: string) => number | null;
  busy: boolean;
  onOpen: (l: Listing) => void;
  onInstall: (l: Listing) => void;
  onRemove: (l: Listing) => void;
}) {
  // Index, not For: a background refresh updates cards in place instead of rebuilding them.
  return (
    <div class="pstore-grid">
      <Index each={props.items}>
        {(l) => (
          <div class="pstore-card" role="button" tabIndex={0}
               onClick={() => props.onOpen(l())}
               onKeyDown={(k) => (k.key === "Enter" || k.key === " ") && (k.preventDefault(), props.onOpen(l()))}>
            <div class="pstore-card-head">
              <PluginIcon src={l().icon} size="md" />
              <div class="pstore-card-title">
                <span class="pstore-card-name">{l().name}</span>
                <span class="pstore-card-meta">
                  v{l().version}
                  <Show when={l().author}>{(a) => <> · {a()}</>}</Show>
                </span>
              </div>
            </div>
            <p class="pstore-card-summary">{l().summary ?? ""}</p>
            <div class="pstore-card-foot">
              <span class="pstore-card-types">{l().fileTypes.map((f) => f.ext).join(" ")}</span>
              <InstallButton status={listingStatus(l(), props.appVersion)} version={l().version}
                             installed={!!l().installed} progress={props.progress(l().id)} blocked={props.busy}
                             onInstall={() => props.onInstall(l())} onRemove={() => props.onRemove(l())} />
            </div>
          </div>
        )}
      </Index>
    </div>
  );
}
