// Served by Cosmog ahead of every plugin page's own scripts. The plugin CSP blocks fetch, sockets
// and frames but not WebRTC, whose ICE step can reach a STUN/TURN server, so the RTC constructors
// are removed from this window and from every same-origin child frame, at any depth.
(() => {
  const top = window;
  const locked = new WeakSet();

  const strip = (w) => {
    for (const k of Object.getOwnPropertyNames(w)) {
      if (!/^(webkit)?RTC/.test(k)) continue;
      try { delete w[k]; } catch { /* non-configurable: shadowed below */ }
      if (k in w) try { Object.defineProperty(w, k, { value: undefined }); } catch { /* leave */ }
    }
  };

  // A frame's window exists as soon as it is inserted and is reachable as window[n], which no
  // getter can intercept, so every DOM call that can insert one locks all frames right after.
  const lockFrames = (w) => {
    for (let i = 0; i < w.length; i++) {
      try { lock(w[i]); lockFrames(w[i]); } catch { /* cross-origin: no RTC reachable from here */ }
    }
  };

  const after = (obj, name) => {
    const d = obj && Object.getOwnPropertyDescriptor(obj, name);
    if (!d?.configurable) return;
    if (typeof d.value === "function") {
      const f = d.value;
      Object.defineProperty(obj, name, {
        ...d, value: function (...a) { try { return f.apply(this, a); } finally { lockFrames(top); } },
      });
    } else if (d.set) {
      const set = d.set;
      Object.defineProperty(obj, name, { ...d, set(v) { try { set.call(this, v); } finally { lockFrames(top); } } });
    }
  };

  // Each frame is its own realm with its own DOM prototypes, so the hooks go into every one.
  function lock(w) {
    if (locked.has(w)) return;
    locked.add(w);
    strip(w);
    const P = (n) => w[n]?.prototype;
    for (const [o, names] of [
      [P("Node"), ["appendChild", "insertBefore", "replaceChild"]],
      [P("Element"), ["append", "prepend", "before", "after", "replaceWith", "replaceChildren",
        "insertAdjacentElement", "insertAdjacentHTML", "innerHTML", "outerHTML", "setHTMLUnsafe", "setHTML"]],
      [P("CharacterData"), ["before", "after", "replaceWith"]],
      [P("Document"), ["write", "writeln", "append", "prepend", "replaceChildren"]],
      [P("DocumentFragment"), ["append", "prepend", "replaceChildren"]],
      [P("Range"), ["insertNode", "surroundContents"]],
      [P("ShadowRoot"), ["innerHTML", "setHTMLUnsafe", "setHTML"]],
    ]) for (const n of names) after(o, n);
    for (const name of ["HTMLIFrameElement", "HTMLObjectElement"]) {
      const proto = P(name);
      for (const prop of ["contentWindow", "contentDocument"]) {
        const d = proto && Object.getOwnPropertyDescriptor(proto, prop);
        if (!d?.get) continue;
        Object.defineProperty(proto, prop, {
          configurable: false,
          get() {
            const v = d.get.call(this);
            try { lockFrames(top); } catch { /* keep the getter working */ }
            return v;
          },
        });
      }
    }
  }

  lock(top);
})();
