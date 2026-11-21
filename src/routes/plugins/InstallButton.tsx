import { Match, Switch } from "solid-js";
import { IconCheck } from "../../utils/icons";
import { t } from "../../i18n";
import type { StoreStatus } from "./storeStatus";

export function InstallButton(props: {
  status: StoreStatus;
  version: string;
  /** 0-100 while this plugin installs, else null. */
  progress: number | null;
  /** Another install is running. */
  blocked: boolean;
  onInstall: () => void;
}) {
  const run = (e: MouseEvent) => { e.stopPropagation(); props.onInstall(); };
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
        <button class="btn-primary pstore-btn" disabled={props.blocked} onClick={run}>{t("plugins.update", { version: props.version })}</button>
      </Match>
      <Match when={props.status.kind === "installed"}>
        <span class="pstore-installed"><IconCheck size={13} />{t("plugins.installedBadge")}</span>
      </Match>
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
