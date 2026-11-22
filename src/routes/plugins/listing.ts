// One card on the plugins page: a catalog entry, an install, or both. The catalog wins for display.

import type { InstalledPlugin, PluginLink, StoreEntry } from "../../types";
import { storeStatus, type StoreStatus } from "./storeStatus";

export interface Listing {
  id: string;
  name: string;
  version: string;
  summary?: string | null;
  description?: string | null;
  icon?: string | null;
  author?: string | null;
  license?: string | null;
  homepage?: string | null;
  repository?: string | null;
  upstream?: PluginLink | null;
  fileTypes: { ext: string; label: string }[];
  releasedAt?: string | null;
  size?: number;
  entry?: StoreEntry;
  installed?: InstalledPlugin;
}

function fromEntry(e: StoreEntry, installed: InstalledPlugin | undefined): Listing {
  return { ...e, size: e.download.size, entry: e, installed };
}

// Installed but not in the catalog (delisted, or the store has not loaded yet): still removable.
function fromInstalled(p: InstalledPlugin): Listing {
  const m = p.manifest;
  return {
    id: p.id, name: m.name, version: p.version, summary: m.summary, description: m.description, icon: p.icon,
    author: m.author, license: m.license, homepage: m.homepage, repository: m.repository, upstream: m.upstream,
    fileTypes: m.fileTypes.map((f) => ({ ext: f.ext, label: f.label })), installed: p,
  };
}

export function listings(entries: StoreEntry[], installed: InstalledPlugin[]): Listing[] {
  const listed = new Set(entries.map((e) => e.id));
  return [
    ...entries.map((e) => fromEntry(e, installed.find((p) => p.id === e.id))),
    ...installed.filter((p) => !listed.has(p.id)).map(fromInstalled),
  ];
}

export function listingStatus(l: Listing, appVersion: string | null): StoreStatus {
  if (l.entry) return storeStatus(l.entry, l.installed, appVersion);
  return l.installed?.compatible ? { kind: "installed" } : { kind: "unavailable", reason: "platform" };
}
