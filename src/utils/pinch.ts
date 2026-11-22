// Linux: Rust swallows touchpad pinches (WebKitGTK would zoom the whole page) and emits `pinch`.
// Each step is replayed as Ctrl+wheel under the fingers, like browsers report a trackpad pinch:
// plugin canvases get it through the broker, host viewers (PDF) as a synthetic wheel event.

import { listen } from "@tauri-apps/api/event";
import { brokerForFrame } from "../plugins/broker";

interface Pinch { phase: number; scale: number; x: number; y: number }
const BEGIN = 0, UPDATE = 1;

export function forwardPinch() {
  let last = 1;
  void listen<Pinch>("pinch", ({ payload: p }) => {
    if (p.phase === BEGIN) { last = 1; return; }
    // End and cancel can report scale 1.0 (Wayland): replaying them would undo the zoom.
    if (p.phase !== UPDATE) return;
    if (!(p.scale > 0) || p.scale === last) return;
    // Chromium's pinch-to-wheel mapping, so plugins see the same deltas as in a browser.
    const deltaY = -Math.log(p.scale / last) * 100;
    last = p.scale;
    const el = document.elementFromPoint(p.x, p.y);
    if (el instanceof HTMLIFrameElement) {
      const r = el.getBoundingClientRect();
      brokerForFrame(el)?.pinch(p.x - r.left, p.y - r.top, deltaY);
      return;
    }
    el?.dispatchEvent(new WheelEvent("wheel", {
      ctrlKey: true, deltaY, deltaMode: 0, clientX: p.x, clientY: p.y, bubbles: true, cancelable: true,
    }));
  }).catch(() => {});
}
