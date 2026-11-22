// Store page for one plugin: what it is, what it opens, where it comes from.

import { For, Show } from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import { formatBytes } from "../../utils/fmt";
import { IconBack, IconLink } from "../../utils/icons";
import { t } from "../../i18n";
import { PluginIcon } from "./PluginIcon";
import { InstallButton } from "./InstallButton";
import { listingStatus, type Listing } from "./listing";

export function PluginDetail(props: {
  listing: Listing;
  appVersion: string | null;
  progress: number | null;
  busy: boolean;
  onBack: () => void;
  onInstall: () => void;
  onRemove: () => void;
}) {
  const e = () => props.listing;
  const paragraphs = () => (e().description ?? "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const types = () => e().fileTypes.map((f) => f.ext).join(", ");
  const released = () => {
    const d = e().releasedAt ? new Date(e().releasedAt!) : null;
    return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString() : null;
  };
  const links = () => [
    e().repository ? { label: t("plugins.detail.repository"), url: e().repository! } : null,
    e().homepage ? { label: t("plugins.detail.homepage"), url: e().homepage! } : null,
    e().upstream ? { label: t("plugins.detail.upstream", { name: e().upstream!.name }), url: e().upstream!.url } : null,
  ].filter((l): l is { label: string; url: string } => l !== null);

  return (
    <>
      <div class="view-header pstore-detail-bar">
        <button class="icon-btn" title={t("plugins.detail.back")} aria-label={t("plugins.detail.back")} onClick={props.onBack}>
          <IconBack size={14} />
        </button>
        <span class="section-title">{t("plugins.title")}</span>
      </div>
      <div class="plugins-body">
        <div class="pstore-hero">
          <PluginIcon src={e().icon} size="lg" />
          <div class="pstore-hero-text">
            <h2 class="pstore-hero-name">{e().name}</h2>
            <Show when={e().summary}>{(s) => <p class="pstore-hero-summary">{s()}</p>}</Show>
            <span class="pstore-hero-meta">
              v{e().version}
              <Show when={e().author}>{(a) => <> · {t("plugins.detail.author", { author: a() })}</>}</Show>
              <Show when={e().installed}>{(p) => <> · {t("plugins.detail.installedVersion", { version: p().version })}</>}</Show>
            </span>
          </div>
          <div class="pstore-hero-action">
            <InstallButton status={listingStatus(e(), props.appVersion)} version={e().version} installed={!!e().installed}
                           progress={props.progress} blocked={props.busy} full
                           onInstall={props.onInstall} onRemove={props.onRemove} />
          </div>
        </div>

        <div class="pstore-detail">
          <section class="pstore-about">
            <div class="settings-section-title">{t("plugins.detail.about")}</div>
            <For each={paragraphs()}>{(p) => <p class="pstore-para">{p}</p>}</For>
            <Show when={e().upstream}>
              {(u) => (
                <div class="pstore-credit">
                  <span class="pstore-credit-text">{t("plugins.detail.credit", { name: u().name })}</span>
                  <button class="pstore-link" title={u().url} onClick={() => openUrl(u().url).catch(() => {})}>
                    <IconLink size={13} /> {u().name}
                  </button>
                </div>
              )}
            </Show>
            <Show when={types()}>
              <p class="pstore-howto">{t("plugins.detail.howto", { types: types() })}</p>
            </Show>
          </section>

          <aside class="pstore-side">
            <div class="settings-section-title">{t("plugins.detail.info")}</div>
            <dl class="pstore-facts">
              <dt>{t("plugins.detail.version")}</dt><dd>{e().version}</dd>
              <Show when={released()}>{(d) => <><dt>{t("plugins.detail.released")}</dt><dd>{d()}</dd></>}</Show>
              <Show when={e().size}>{(s) => <><dt>{t("plugins.detail.size")}</dt><dd>{formatBytes(s())}</dd></>}</Show>
              <Show when={types()}><dt>{t("plugins.detail.opens")}</dt><dd>{types()}</dd></Show>
              <Show when={e().license}>{(l) => <><dt>{t("plugins.detail.license")}</dt><dd>{l()}</dd></>}</Show>
            </dl>
            <Show when={links().length > 0}>
              <div class="settings-section-title">{t("plugins.detail.links")}</div>
              <div class="pstore-links">
                <For each={links()}>
                  {(l) => (
                    <button class="pstore-link" title={l.url} onClick={() => openUrl(l.url).catch(() => {})}>
                      <IconLink size={13} /> {l.label}
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </aside>
        </div>
      </div>
    </>
  );
}
