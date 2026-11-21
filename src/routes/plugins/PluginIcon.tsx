import { Show } from "solid-js";
import { IconPlugin } from "../../utils/icons";

/** Store or manifest icon (data: URI only), else the generic plugin glyph. */
export function PluginIcon(props: { src?: string | null; size: "sm" | "md" | "lg" }) {
  const safe = () => (props.src?.startsWith("data:image/") ? props.src : null);
  return (
    <span class={`pstore-icon pstore-icon-${props.size}`}>
      <Show when={safe()} fallback={<IconPlugin size={props.size === "lg" ? 30 : 18} />}>
        {(src) => <img src={src()} alt="" draggable={false} />}
      </Show>
    </span>
  );
}
