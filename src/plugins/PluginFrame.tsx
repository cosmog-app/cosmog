import { createEffect, onCleanup, onMount } from "solid-js";
import type { InstalledPlugin } from "../types";
import { createBroker, pluginEntryUrl, type Broker, type BrokerEvents } from "./broker";
import { resolvedTheme } from "../state/theme";

// Sandboxed: scripts only. No allow-same-origin, so the plugin gets an opaque origin, no IPC,
// no parent DOM, no storage, no popups, no top navigation.
export function PluginFrame(props: { plugin: InstalledPlugin; events: BrokerEvents; onBroker: (b: Broker) => void }) {
  let frame!: HTMLIFrameElement;
  let broker: Broker | undefined;

  onMount(() => {
    broker = createBroker(frame, props.events);
    props.onBroker(broker);
  });

  createEffect(() => {
    const mode = resolvedTheme();
    broker?.setTheme(mode);
  });

  onCleanup(() => broker?.dispose());

  return (
    <iframe
      ref={frame}
      class="plugin-frame"
      title={props.plugin.manifest.name}
      src={pluginEntryUrl(props.plugin)}
      sandbox="allow-scripts"
      allow="clipboard-read; clipboard-write"
      referrerpolicy="no-referrer"
    />
  );
}
