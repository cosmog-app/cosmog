// Sandbox test plugin. Speaks protocol v1 (docs/PLUGINS.md) and reports which escapes work.

const API_VERSION = 1;
const send = (msg, transfer = []) => parent.postMessage({ cosmog: 1, ...msg }, "*", transfer);

// ---- protocol ----------------------------------------------------------------------------
let doc = null;

const handlers = {
  "doc.load": (p) => {
    doc = { name: p.name, mime: p.mime, bytes: new Uint8Array(p.bytes), readOnly: !!p.readOnly };
    document.getElementById("doc").textContent =
      `${doc.name} (${doc.mime}, ${doc.bytes.byteLength} bytes${doc.readOnly ? ", read-only" : ""})`;
    if (doc.bytes.byteLength <= 64 * 1024) {
      document.getElementById("editor").value = new TextDecoder().decode(doc.bytes);
    }
    send({ method: "doc.dirty", params: { dirty: false } });
    return null;
  },
  "doc.serialize": () => {
    const ta = document.getElementById("editor");
    // Big buffers round-trip untouched; small ones reflect the textarea.
    const out = doc && doc.bytes.byteLength > 64 * 1024 ? doc.bytes.slice() : new TextEncoder().encode(ta.value);
    return { result: { bytes: out.buffer }, transfer: [out.buffer] };
  },
  "ui.theme": (p) => {
    document.documentElement.dataset.theme = p.mode;
    return null;
  },
};

window.addEventListener("message", async (e) => {
  if (e.source !== parent) return;
  const m = e.data;
  if (!m || m.cosmog !== 1 || typeof m.method !== "string") return;
  const h = handlers[m.method];
  if (!h) {
    if (m.id) send({ id: m.id, error: { code: "unknown_method", message: m.method } });
    return;
  }
  try {
    const r = await h(m.params ?? {});
    if (!m.id) return;
    if (r && r.transfer) send({ id: m.id, result: r.result }, r.transfer);
    else send({ id: m.id, result: r });
  } catch (err) {
    if (m.id) send({ id: m.id, error: { code: "plugin_error", message: String(err) } });
  }
});

document.getElementById("editor").addEventListener("input", () => {
  send({ method: "doc.dirty", params: { dirty: true } });
});

window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    send({ method: "shell.save" });
  }
});

document.getElementById("nav").addEventListener("click", () => {
  location.href = "https://example.com/";
});

// ---- sandbox checks ----------------------------------------------------------------------
const violations = [];
document.addEventListener("securitypolicyviolation", (e) => {
  violations.push(`${e.effectiveDirective}: ${e.blockedURI || "(inline)"}`);
  const li = document.createElement("li");
  li.textContent = violations[violations.length - 1];
  document.getElementById("violations").appendChild(li);
});

const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms));
const race = (p, ms = 3000) => Promise.race([p, timeout(ms)]);

// Each check resolves to a detail string if the thing WORKED, throws if it failed.
const loadImg = (src, cors) =>
  race(new Promise((res, rej) => {
    const img = new Image();
    if (cors) img.crossOrigin = "anonymous";
    img.onload = () => res("loaded");
    img.onerror = () => rej(new Error("error"));
    img.src = `${src}?${Date.now()}`;
  }));

const mustFail = {
  "window.__TAURI_INTERNALS__": async () => {
    if (window.__TAURI_INTERNALS__ === undefined) throw new Error("undefined");
    return "present";
  },
  "window.__TAURI__": async () => {
    if (window.__TAURI__ === undefined) throw new Error("undefined");
    return "present";
  },
  "window.ipc (wry)": async () => {
    if (window.ipc === undefined) throw new Error("undefined");
    return "present";
  },
  "fetch ipc://localhost": async () => {
    const r = await race(fetch("ipc://localhost/plugin_list", { method: "POST", body: "{}" }));
    return `status ${r.status}`;
  },
  "fetch http://ipc.localhost": async () => {
    const r = await race(fetch("http://ipc.localhost/plugin_list", { method: "POST", body: "{}" }));
    return `status ${r.status}`;
  },
  "fetch tauri://localhost": async () => {
    const r = await race(fetch("tauri://localhost/"));
    return `status ${r.status}`;
  },
  "fetch http://tauri.localhost": async () => {
    const r = await race(fetch("http://tauri.localhost/"));
    return `status ${r.status}`;
  },
  "fetch https://example.com": async () => {
    const r = await race(fetch("https://example.com/"));
    return `status ${r.status}`;
  },
  "XMLHttpRequest https": () =>
    race(new Promise((res, rej) => {
      const x = new XMLHttpRequest();
      x.onload = () => res(`status ${x.status}`);
      x.onerror = () => rej(new Error("error"));
      x.open("GET", "https://example.com/");
      x.send();
    })),
  "WebSocket wss": () =>
    race(new Promise((res, rej) => {
      const ws = new WebSocket("wss://echo.websocket.org/");
      ws.onopen = () => { ws.close(); res("opened"); };
      ws.onerror = () => rej(new Error("error"));
    })),
  "remote <img>": () =>
    race(new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res("loaded");
      img.onerror = () => rej(new Error("error"));
      img.src = `https://www.google.com/favicon.ico?${Date.now()}`;
    })),
  "parent.document": async () => {
    return `title=${parent.document.title}`;
  },
  "top.location.href read": async () => {
    return top.location.href;
  },
  "window.open popup": async () => {
    const w = window.open("https://example.com/");
    if (!w) throw new Error("null");
    return "opened";
  },
  localStorage: async () => {
    localStorage.setItem("x", "1");
    return "writable";
  },
  indexedDB: () =>
    race(new Promise((res, rej) => {
      const r = indexedDB.open("x");
      r.onsuccess = () => res("opened");
      r.onerror = () => rej(new Error("error"));
    })),
  "document.cookie write": async () => {
    document.cookie = "x=1";
    if (!document.cookie.includes("x=1")) throw new Error("not stored");
    return "stored";
  },
};

const mustWork = {
  "blob: worker": () =>
    race(new Promise((res, rej) => {
      const src = "self.onmessage = (e) => self.postMessage(`echo:${e.data}`);";
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
      w.onmessage = (e) => { w.terminate(); res(String(e.data)); };
      w.onerror = (e) => rej(new Error(e.message || "worker error"));
      w.postMessage("hi");
    })),
  "style.css applied": async () => {
    const link = document.querySelector('link[rel="stylesheet"]');
    const bg = getComputedStyle(document.body).backgroundColor;
    if (bg !== "rgb(250, 250, 250)") throw new Error(`sheet=${link && link.sheet ? "parsed" : "null"}, body bg=${bg}`);
    return bg;
  },
  "scheme <img crossorigin>": () => loadImg("icon.svg", true),
  "WebAssembly instantiate": async () => {
    // Smallest valid module: magic + version.
    await WebAssembly.instantiate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    return "ok";
  },
  "blob: image": () =>
    race(new Promise((res, rej) => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';
      const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      const img = new Image();
      img.onload = () => res("loaded");
      img.onerror = () => rej(new Error("error"));
      img.src = url;
    })),
  "crypto.subtle digest": async () => {
    const d = await crypto.subtle.digest("SHA-256", new Uint8Array([1]));
    return `${d.byteLength} bytes, secureContext=${window.isSecureContext}`;
  },
};

const info = {
  origin: async () => String(self.origin),
  // URL workers need a same-origin script; a null origin never matches. Plugins inline workers as blob:.
  "module worker": () =>
    race(new Promise((res, rej) => {
      const w = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
      w.onmessage = (e) => { w.terminate(); res(String(e.data)); };
      w.onerror = (e) => rej(new Error(e.message || "worker error"));
      w.postMessage("hi");
    })),
  "classic worker": () =>
    race(new Promise((res, rej) => {
      const w = new Worker("worker.js");
      w.onmessage = (e) => { w.terminate(); res(String(e.data)); };
      w.onerror = (e) => rej(new Error(e.message || "worker error"));
      w.postMessage("hi");
    })),
  "scheme <img> without crossorigin": () => loadImg("icon.svg", false),
  "window.webkit.messageHandlers": async () =>
    window.webkit && window.webkit.messageHandlers ? "present (wry rejects frames without the invoke key)" : "absent",
  "window.chrome.webview": async () => (window.chrome && window.chrome.webview ? "present" : "absent"),
  "clipboard.writeText": async () => {
    await race(navigator.clipboard.writeText("cosmog"), 1500);
    return "ok";
  },
};

function row(name, cls, label, detail) {
  const tr = document.createElement("tr");
  tr.innerHTML = `<td class="s ${cls}">${label}</td><td></td><td></td>`;
  tr.children[1].textContent = name;
  tr.children[2].textContent = detail;
  document.getElementById("checks").appendChild(tr);
}

async function runChecks() {
  let pass = 0;
  let total = 0;
  for (const [name, fn] of Object.entries(mustFail)) {
    total++;
    try {
      const d = await fn();
      row(name, "fail", "OPEN", d);
    } catch (e) {
      pass++;
      row(name, "pass", "blocked", String(e && e.message ? e.message : e));
    }
  }
  for (const [name, fn] of Object.entries(mustWork)) {
    total++;
    try {
      const d = await fn();
      pass++;
      row(name, "pass", "works", d);
    } catch (e) {
      row(name, "fail", "BROKEN", String(e && e.message ? e.message : e));
    }
  }
  for (const [name, fn] of Object.entries(info)) {
    try {
      row(name, "info", "info", await fn());
    } catch (e) {
      row(name, "info", "info", `failed: ${e && e.message ? e.message : e}`);
    }
  }
  const ok = pass === total;
  const el = document.getElementById("summary");
  el.textContent = `${pass}/${total} checks passed`;
  el.className = ok ? "pass" : "fail";
  send({ method: "ui.toast", params: { kind: ok ? "success" : "error", text: `Sandbox: ${pass}/${total} checks passed` } });
}

send({ method: "ready", params: { apiVersion: API_VERSION } });
runChecks();
