import { Match, Show, Switch } from "solid-js";
import { t } from "../../i18n";
import type { StoreStatus } from "./storeStatus";

export function InstallButton(props: {
  status: StoreStatus;
  version: string;
  installed: boolean;
  /** 0-100 while this plugin installs, else null. */
  progress: number | null;
  /** Another install or removal is running. */
  blocked: boolean;
  /** Detail page: show Uninstall next to Update too. */
  full?: boolean;
  onInstall: () => void;
  onRemove: () => void;
}) {
  const run = (e: MouseEvent) => { e.stopPropagation(); props.onInstall(); };
  const Uninstall = () => (
    <button class="btn-secondary pstore-btn" disabled={props.blocked}
            onClick={(e) => { e.stopPropagation(); props.onRemove(); }}>
      {t("plugins.remove")}
    </button>
  );
  return (
    <Switch>
      <Match when={props.progress !== null}>
        <span class="pstore-busy">
          <span class="pstore-busy-label">{t("plugins.installing", { pct: props.progress ?? 0 })}</span>
          <progress class="pstore-progress" max={100} value={props.progress ?? 0} />
        </span>
      </Match>
      <Match when={props.status.kind === "install"}>
        <button class="btn-primary pstore-btn" disabled={props.blocked} onClick={run}>{t("plugins.install")}</button>
      </Match>
      <Match when={props.status.kind === "update"}>
        <span class="pstore-actions">
          <Show when={props.full}><Uninstall /></Show>
          <button class="btn-primary pstore-btn" disabled={props.blocked} onClick={run}>{t("plugins.update", { version: props.version })}</button>
        </span>
      </Match>
      <Match when={props.installed}><Uninstall /></Match>
      <Match when={props.status.kind === "unavailable" ? props.status : null}>
        {(s) => (
          <span class="pstore-unavailable">
            {s().reason === "app" ? t("plugins.unavailable.app", { version: s().need ?? "" }) : t("plugins.incompatible")}
          </span>
        )}
      </Match>
    </Switch>
  );
}
