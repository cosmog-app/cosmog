//! Linux: WebKitGTK turns a touchpad pinch into whole-page zoom before the page sees it.
//! The pinch is swallowed here and handed to the frontend as a `pinch` event, which forwards it
//! to whatever is under the fingers (a plugin canvas, the PDF viewer) as Ctrl+wheel zoom.

use gtk::glib::Propagation;
use gtk::prelude::*;
use tauri::Emitter;

#[derive(Clone, serde::Serialize)]
struct Pinch {
    /// 0 begin, 1 update, 2 end, 3 cancel (GdkTouchpadGesturePhase).
    phase: i32,
    /// Relative to the pinch start.
    scale: f64,
    x: f64,
    y: f64,
}

pub fn install(win: &tauri::WebviewWindow) {
    let target = win.clone();
    let res = win.with_webview(move |wv| {
        // The handler runs before WebKit's own class handler; Stop keeps the page unzoomed.
        wv.inner().connect_event(move |_, ev| {
            let Some(p) = ev.downcast_ref::<gtk::gdk::EventTouchpadPinch>() else {
                return Propagation::Proceed;
            };
            let (x, y) = p.position();
            let raw: &gtk::gdk::ffi::GdkEventTouchpadPinch = p.as_ref();
            let pinch = Pinch { phase: raw.phase as i32, scale: p.scale(), x, y };
            let _ = target.emit_to(target.label(), "pinch", pinch);
            Propagation::Stop
        });
    });
    if let Err(e) = res {
        tracing::warn!("pinch: could not reach the webview: {e}");
    }
}
