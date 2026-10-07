# Secure widget gateway deployment

## Prerequisites

- Create an Authentik proxy provider/outpost for `https://dash.maadmustafa.dev`.
- Confirm the embedded outpost endpoint at
  `https://auth.maadmustafa.dev/outpost.goauthentik.io/auth/traefik` returns the
  expected forward-auth response for an authenticated user.
- Copy `config/public.env.example` to `config/public.env` and populate public
  Homepage links only.
- Copy `gateway/.env.example` to `gateway/.env` and populate credentials. Prefer
  Docker DNS names. The Compose file supplies internal addresses for services
  that are currently attached to shared networks.
- Set `PROXMOX_NODE`. `GLANCES_URL` is optional.
- Set `AUTHENTIK_API_KEY` to a read-only token that can view users, events, and
  outposts. Set `HOME_ASSISTANT_API_KEY` to a long-lived access token.
- `DOCKHAND_API_TOKEN` is optional when Dockhand API authentication is disabled.
- Give the Immich key only `server.statistics` and `adminUser.read`. Without
  `adminUser.read`, totals and per-user usage still work, but quota and account
  status remain unknown and the widget reports degraded data.

Never place an API key, password, session cookie, private address, or internal
hostname in `config/custom.js`, `config/custom.css`, or `config/public.env`.

## Validate and deploy

```sh
docker compose config --quiet
docker compose build widget-gateway
docker compose up -d
docker compose ps
docker compose logs --no-color --tail=200 widget-gateway homepage
```

The gateway's `/internal` routes are not attached to a Traefik router. Public
browser routes are limited to `/api/widget-gateway` and share the dashboard's
Authentik middleware. Homepage reaches summaries at
`http://widget-gateway:3001/internal/v1/widgets/<id>/summary`.

## Credential cutover

After every widget and guarded action has been verified through the gateway:

1. Rotate the Jellyfin, Seerr, Radarr, Sonarr, Bazarr, Prowlarr, Tdarr, Immich,
   Speedtest, Proxmox, Authentik, Home Assistant, and any other API keys
   previously used by browser code.
2. Change the qBittorrent and AdGuard passwords.
3. Put only the new values in `gateway/.env`.
4. Recreate `widget-gateway`, verify the dashboard, then revoke the old values.
5. Scan tracked files, served assets, gateway responses, logs, and source maps
   for the revoked values.

Tdarr was not running when this configuration was built. Its native card maps
to the expected `tdarr` container name and will show unavailable until that
container returns. Calendar and Proxmox intentionally use `siteMonitor`; they
do not claim Docker CPU, memory, RX, or TX statistics.
