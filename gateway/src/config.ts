export type Config = ReturnType<typeof readConfig>;

const value = (name: string, fallback = "", legacyName?: string) =>
  process.env[name]?.trim() || (legacyName ? process.env[legacyName]?.trim() : "") || fallback;
const numberValue = (name: string, fallback: number) => {
  const parsed = Number(value(name));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const booleanValue = (name: string, fallback = false) => {
  const raw = value(name).toLowerCase();
  return raw ? ["1", "true", "yes", "on"].includes(raw) : fallback;
};

export function readConfig() {
  return {
    port: numberValue("PORT", 3001),
    dashboardOrigin: value("DASHBOARD_ORIGIN"),
    authHeader: value("AUTH_HEADER", "x-authentik-username").toLowerCase(),
    cacheTtlMs: numberValue("CACHE_TTL_MS", 30_000),
    staleTtlMs: numberValue("STALE_TTL_MS", 900_000),
    timeoutMs: numberValue("UPSTREAM_TIMEOUT_MS", 8_000),
    services: {
      jellyfin: { url: value("JELLYFIN_URL", "", "HOMEPAGE_VAR_JELLYFIN_URL"), key: value("JELLYFIN_API_KEY", "", "HOMEPAGE_VAR_JELLYFIN_WIDGET_KEY") },
      seerr: { url: value("SEERR_URL", "", "HOMEPAGE_VAR_SEERR_URL"), key: value("SEERR_API_KEY", "", "HOMEPAGE_VAR_SEERR_WIDGET_KEY") },
      radarr: { url: value("RADARR_URL", "", "HOMEPAGE_VAR_RADARR_URL"), key: value("RADARR_API_KEY", "", "HOMEPAGE_VAR_RADARR_WIDGET_KEY") },
      sonarr: { url: value("SONARR_URL", "", "HOMEPAGE_VAR_SONARR_URL"), key: value("SONARR_API_KEY", "", "HOMEPAGE_VAR_SONARR_WIDGET_KEY") },
      bazarr: { url: value("BAZARR_URL", "", "HOMEPAGE_VAR_BAZARR_URL"), key: value("BAZARR_API_KEY", "", "HOMEPAGE_VAR_BAZARR_WIDGET_KEY") },
      prowlarr: { url: value("PROWLARR_URL", "", "HOMEPAGE_VAR_PROWLARR_URL"), key: value("PROWLARR_API_KEY", "", "HOMEPAGE_VAR_PROWLARR_API_KEY") },
      qbittorrent: {
        url: value("QBITTORRENT_URL", "", "HOMEPAGE_VAR_QBITTORRENT_URL"),
        username: value("QBITTORRENT_USERNAME", "", "HOMEPAGE_VAR_QBITTORRENT_USERNAME"),
        password: value("QBITTORRENT_PASSWORD", "", "HOMEPAGE_VAR_QBITTORRENT_PASSWORD"),
      },
      tdarr: { url: value("TDARR_URL", "", "HOMEPAGE_VAR_TDARR_URL"), key: value("TDARR_API_KEY", "", "HOMEPAGE_VAR_TDARR_WIDGET_KEY") },
      immich: { url: value("IMMICH_URL", "", "HOMEPAGE_VAR_IMMICH_URL"), key: value("IMMICH_API_KEY", "", "HOMEPAGE_VAR_IMMICH_WIDGET_KEY") },
      adguard: {
        url: value("ADGUARD_URL", "", "HOMEPAGE_VAR_ADGUARD_URL"),
        username: value("ADGUARD_USERNAME", "", "HOMEPAGE_VAR_ADGUARD_USERNAME"),
        password: value("ADGUARD_PASSWORD", "", "HOMEPAGE_VAR_ADGUARD_PASSWORD"),
      },
      speedtest: { url: value("SPEEDTEST_URL", "", "HOMEPAGE_VAR_SPEEDTEST_URL"), key: value("SPEEDTEST_API_KEY", "", "HOMEPAGE_VAR_SPEEDTEST_WIDGET_KEY") },
      authentik: {
        url: value("AUTHENTIK_URL", "", "HOMEPAGE_VAR_AUTHENTIK_URL"),
        key: value("AUTHENTIK_API_KEY", "", "HOMEPAGE_VAR_AUTHENTIK_WIDGET_KEY"),
      },
      homeassistant: {
        url: value("HOME_ASSISTANT_URL", "", "HOMEPAGE_VAR_HOME_ASSISTANT_URL"),
        key: value("HOME_ASSISTANT_API_KEY", "", "HOMEPAGE_VAR_HA_WIDGET_KEY"),
      },
      dockhand: { url: value("DOCKHAND_URL"), key: value("DOCKHAND_API_TOKEN") },
      proxmox: {
        url: value("PROXMOX_URL", "", "HOMEPAGE_VAR_PROXMOX_API_URL"),
        tokenId: value("PROXMOX_TOKEN_ID", "", "HOMEPAGE_VAR_PROXMOX_USERNAME"),
        tokenSecret: value("PROXMOX_TOKEN_SECRET", "", "HOMEPAGE_VAR_PROXMOX_PASSWORD"),
        node: value("PROXMOX_NODE"),
        tlsInsecure: booleanValue("PROXMOX_TLS_INSECURE"),
        glancesUrl: value("GLANCES_URL"),
      },
    },
  };
}
