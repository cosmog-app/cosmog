import { invoke } from "@tauri-apps/api/core";
import type { InstalledPlugin } from "../types";

export const pluginList = (): Promise<InstalledPlugin[]> => invoke("plugin_list");

export const pluginSetEnabled = (id: string, enabled: boolean): Promise<void> =>
  invoke("plugin_set_enabled", { id, enabled });

export const pluginRemove = (id: string): Promise<void> => invoke("plugin_remove", { id });

/** Debug builds only; the command is not registered in release. */
export const pluginDevLoad = (path: string): Promise<InstalledPlugin> => invoke("plugin_dev_load", { path });
