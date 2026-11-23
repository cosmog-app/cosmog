import type { ProviderDef } from "../providers";

/** Derive the signing region from a custom endpoint URL (B2/Wasabi/Spaces embed it in the
 *  subdomain); falls back to the provider's JSON default. */
export function regionFromEndpoint(provider: ProviderDef, endpoint: string): string | undefined {
  if (!provider.custom_endpoint) return undefined;
  if (provider.id === "r2") return "auto";

  if (endpoint) {
    try {
      const host = new URL(endpoint).hostname;

      const b2 = host.match(/^s3\.([^.]+)\.backblazeb2\.com$/);
      if (b2) return b2[1];

      const wasabi = host.match(/^s3\.([^.]+)\.wasabisys\.com$/);
      if (wasabi) return wasabi[1];

      const doSpaces = host.match(/^([^.]+)\.digitaloceanspaces\.com$/);
      if (doSpaces) return doSpaces[1];
    } catch {}
  }

  return provider.region || undefined;
}

/** Self-hosted servers pick their own region name (MinIO "us-east-1", Garage "garage") and the
 *  endpoint URL doesn't say which, so the user types it. */
export const regionIsEditable = (provider: ProviderDef) => provider.id === "s3" || provider.id === "minio";

/** Region to store: what the user typed for self-hosted providers, else derived from the endpoint. */
export function resolveRegion(provider: ProviderDef, endpoint: string, typed?: string): string | undefined {
  if (regionIsEditable(provider)) return typed?.trim() || provider.region || undefined;
  return regionFromEndpoint(provider, endpoint);
}
