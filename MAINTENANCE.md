# homepage maintenance

Compose: `compose.yml`. Local environment: `.env` (never commit it).

Dockhand and SSH edit these same server files. Review Git changes before publishing.

URLs: https://dash.maadmustafa.dev

Docker networks: `authentik-server-widget-gateway`, `bazarr-widget-gateway`, `dockhand-widget-gateway`, `homepage-traefik`, `homepage-widget-gateway`, `immich-server-widget-gateway`, `jellyfin-widget-gateway`, `prowlarr-widget-gateway`, `qbittorrent-widget-gateway`, `radarr-widget-gateway`, `seerr-widget-gateway`, `sonarr-widget-gateway`, `speedtest-widget-gateway`, `traefik-widget-gateway`. Peer links are isolated; egress/Traefik links permit outbound traffic. Shared `db`, `cache` and `proxy` remain only where release-managed apps still need them.

Mounts observed on 2026-10-06 (includes read-only configuration):

| Type | Host path or volume | Container path |
|---|---|---|
| bind | `/home` | `/home` |
| bind | `/home/nightwalker28/homepage/config` | `/app/config` |
| bind | `/home/nightwalker28/homepage/config/icons` | `/app/public/icons` |
| bind | `/mnt/media` | `/mnt/media` |

Compose layout and network manifest: [homelab standard](../maintenance/compose-refactor/README.md).
