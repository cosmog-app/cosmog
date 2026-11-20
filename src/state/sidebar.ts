import { createSignal, onCleanup } from "solid-js";

const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);
export { sidebarCollapsed, setSidebarCollapsed };

/** Collapse for the lifetime of the calling component, then restore what the user had. */
export function collapseSidebarWhileMounted() {
  const was = sidebarCollapsed();
  setSidebarCollapsed(true);
  onCleanup(() => {
    // The user expanded it meanwhile: leave their choice alone.
    if (!was && sidebarCollapsed()) setSidebarCollapsed(false);
  });
}
