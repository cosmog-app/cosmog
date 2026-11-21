// What the store can do for a catalog entry on this device, given what is installed.

import type { InstalledPlugin, StoreEntry } from "../../types";

export type StoreStatus =
  | { kind: "install" }
  | { kind: "update"; from: string }
  | { kind: "installed" }
  | { kind: "unavailable"; reason: "platform" | "app"; need?: string };

function semver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1, 0, 1; unparsable versions compare equal so nothing is offered on bad data. */
export function cmpVersion(a: string, b: string): number {
  const x = semver(a), y = semver(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

export function storeStatus(e: StoreEntry, installed: InstalledPlugin | undefined, appVersion: string | null): StoreStatus {
  if (!e.platforms.includes("desktop")) return { kind: "unavailable", reason: "platform" };
  if (e.minAppVersion && appVersion && cmpVersion(appVersion, e.minAppVersion) < 0) {
    return { kind: "unavailable", reason: "app", need: e.minAppVersion };
  }
  if (!installed) return { kind: "install" };
  // A dev copy is replaced by the signed one, whatever its version.
  if (installed.source === "dev" || cmpVersion(installed.version, e.version) < 0) return { kind: "update", from: installed.version };
  return { kind: "installed" };
}
