// Last plugin catalog, kept so the Plugins page opens filled in. Display only: installs re-read
// the catalog in Rust and check signatures there.

import type { StoreEntry } from "../types";

const CACHE_KEY = "cosmog.pluginStore.v1";

export interface CachedCatalog { at: number; entries: StoreEntry[] }

export function readStoreCache(): CachedCatalog | null {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null") as CachedCatalog | null;
    return c && Array.isArray(c.entries) && typeof c.at === "number" ? c : null;
  } catch {
    return null;
  }
}

export function writeStoreCache(entries: StoreEntry[]): CachedCatalog {
  const c = { at: Date.now(), entries };
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch { /* storage full or blocked */ }
  return c;
}
