import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { Config } from "../src/config.js";

const config: Config = {
  port: 3001,
  dashboardOrigin: "https://dash.example.test",
  authHeader: "x-authentik-username",
  cacheTtlMs: 1,
  staleTtlMs: 60_000,
  timeoutMs: 100,
  services: {
    jellyfin: { url: "http://jellyfin:8096", key: "secret" },
    seerr: { url: "http://seerr:5055", key: "secret" },
    radarr: { url: "http://radarr:7878", key: "secret" },
    sonarr: { url: "http://sonarr:8989", key: "secret" },
    bazarr: { url: "http://bazarr:6767", key: "secret" },
    prowlarr: { url: "http://prowlarr:9696", key: "secret" },
    qbittorrent: { url: "http://qbittorrent:8080", username: "user", password: "secret" },
    tdarr: { url: "http://tdarr:8265", key: "secret" },
    immich: { url: "http://immich:2283", key: "secret" },
    adguard: { url: "http://adguard", username: "user", password: "secret" },
    speedtest: { url: "http://speedtest", key: "secret" },
    authentik: { url: "http://authentik:9000", key: "secret" },
    homeassistant: { url: "http://homeassistant:8123", key: "secret" },
    dockhand: { url: "http://dockhand:3000", key: "secret" },
    proxmox: { url: "https://proxmox:8006", tokenId: "user@pam!token", tokenSecret: "secret", node: "node", tlsInsecure: false, glancesUrl: "" },
  },
};

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json" },
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("widget gateway", () => {
  it("returns normalized successful summaries without exposing configuration", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json([{ Id: "session", UserName: "Ada", NowPlayingItem: { Name: "Film" }, PlayState: {} }]))
      .mockResolvedValueOnce(json({ MovieCount: 10, SeriesCount: 4, EpisodeCount: 80 }))
      .mockResolvedValueOnce(json([{ ItemId: "library", Name: "Movies", CollectionType: "movies" }])));
    const app = await buildApp(config);
    const response = await app.inject({ method: "GET", url: "/internal/v1/widgets/jellyfin/summary" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: { sessions: 1, movies: 10, series: 4, episodes: 80 },
      meta: { stale: false, partial: false },
    });
    expect(response.body).not.toContain("jellyfin:8096");
    expect(response.body).not.toContain("secret");
    await app.close();
  });

  it("marks a response partial when one optional upstream call fails", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json([]))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(json([])));
    const app = await buildApp(config);
    const response = await app.inject({ method: "GET", url: "/api/widget-gateway/v1/widgets/jellyfin/details" });
    expect(response.statusCode).toBe(200);
    expect(response.json().meta.partial).toBe(true);
    await app.close();
  });

  it("retains stale cached data during a temporary outage", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json({ MovieCount: 1 }))
      .mockResolvedValueOnce(json([]))
      .mockRejectedValue(new Error("timeout"));
    vi.stubGlobal("fetch", fetchMock);
    const app = await buildApp(config);
    expect((await app.inject({ method: "GET", url: "/internal/v1/widgets/jellyfin/summary" })).statusCode).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 5));
    const response = await app.inject({ method: "GET", url: "/internal/v1/widgets/jellyfin/summary" });
    expect(response.statusCode).toBe(200);
    expect(response.json().meta).toMatchObject({ stale: true, partial: true });
    await app.close();
  });

  it.each([
    ["unauthorized", { origin: "https://dash.example.test", host: "dash.example.test", "content-type": "application/json", "x-dashboard-csrf": "1" }],
    ["cross-origin", { origin: "https://evil.example", host: "dash.example.test", "content-type": "application/json", "x-dashboard-csrf": "1", "x-authentik-username": "ada" }],
  ])("rejects %s control requests", async (_name, headers) => {
    const app = await buildApp(config);
    const response = await app.inject({ method: "POST", url: "/api/widget-gateway/v1/actions/speedtest/run", headers, payload: {} });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("rejects arbitrary proxy fields and invalid actions", async () => {
    const app = await buildApp(config);
    const headers = { origin: "https://dash.example.test", host: "dash.example.test", "content-type": "application/json", "x-dashboard-csrf": "1", "x-authentik-username": "ada" };
    const arbitrary = await app.inject({ method: "POST", url: "/api/widget-gateway/v1/actions/speedtest/run", headers, payload: { url: "http://attacker" } });
    expect(arbitrary.statusCode).toBe(400);
    const invalid = await app.inject({ method: "POST", url: "/api/widget-gateway/v1/actions/speedtest/proxy", headers, payload: {} });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });

  it("requires separate qBittorrent torrent and file deletion confirmations", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = await buildApp(config);
    const headers = { origin: "https://dash.example.test", host: "dash.example.test", "content-type": "application/json", "x-dashboard-csrf": "1", "x-authentik-username": "ada" };
    const hashes = ["a".repeat(40)];
    const noTorrentConfirmation = await app.inject({
      method: "POST", url: "/api/widget-gateway/v1/actions/qbittorrent/delete",
      headers, payload: { hashes, deleteFiles: false },
    });
    expect(noTorrentConfirmation.statusCode).toBe(400);
    const noFileConfirmation = await app.inject({
      method: "POST", url: "/api/widget-gateway/v1/actions/qbittorrent/delete",
      headers, payload: { hashes, confirm: "DELETE", deleteFiles: true },
    });
    expect(noFileConfirmation.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("runs only allowlisted Radarr, Sonarr, and Bazarr searches", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const app = await buildApp(config);
    const headers = { origin: "https://dash.example.test", host: "dash.example.test", "content-type": "application/json", "x-dashboard-csrf": "1", "x-authentik-username": "ada" };
    expect((await app.inject({ method: "POST", url: "/api/widget-gateway/v1/actions/radarr/search", headers, payload: { id: 42 } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/widget-gateway/v1/actions/sonarr/search", headers, payload: { all: true } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/widget-gateway/v1/actions/bazarr/search", headers, payload: {
      id: 8, seriesId: 4, kind: "episode", languages: [{ code: "en", forced: false, hi: true }],
    } })).statusCode).toBe(200);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST", body: JSON.stringify({ name: "MoviesSearch", movieIds: [42] }) });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "POST", body: JSON.stringify({ name: "MissingEpisodeSearch" }) });
    expect(String(fetchMock.mock.calls[2][0])).toContain("/api/episodes/subtitles");
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: "PATCH" });
    await app.close();
  });

  it("aggregates Prowlarr query and grab totals from per-indexer statistics", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json([{ id: 1, name: "Indexer", enable: true }]))
      .mockResolvedValueOnce(json({ indexers: [
        { numberOfQueries: 12, numberOfGrabs: 3, numberOfFailedQueries: 1, numberOfFailedGrabs: 0 },
        { numberOfQueries: 8, numberOfGrabs: 2, numberOfFailedQueries: 0, numberOfFailedGrabs: 1 },
      ] }))
      .mockResolvedValueOnce(json({ records: [] }))
      .mockResolvedValueOnce(json([])));
    const app = await buildApp(config);
    const response = await app.inject({ method: "GET", url: "/internal/v1/widgets/prowlarr/summary" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ queries: 20, grabs: 5 });
    await app.close();
  });

  it("reports current Prowlarr cooldown failures separately from disabled indexers", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json([{ id: 1, name: "Healthy", enable: true }, { id: 2, name: "Cooling down", enable: true }]))
      .mockResolvedValueOnce(json({ indexers: [{ indexerName: "Healthy", numberOfQueries: 10, numberOfGrabs: 2 }] }))
      .mockResolvedValueOnce(json({ records: [] }))
      .mockResolvedValueOnce(json([{ indexerId: 2, disabledTill: "2099-01-01T00:00:00Z" }])));
    const app = await buildApp(config);
    const response = await app.inject({ method: "GET", url: "/api/widget-gateway/v1/widgets/prowlarr/details" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      indexers: [expect.objectContaining({ name: "Healthy", failing: false }), expect.objectContaining({ name: "Cooling down", failing: true })],
      perIndexer: [expect.objectContaining({ name: "Healthy", grabs: 2 })],
    });
    await app.close();
  });

  it("enriches Seerr requests with titles and posters while retaining review metadata", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json({ pending: 1, total: 1 }))
      .mockResolvedValueOnce(json({ results: [{
        id: 12, status: 1, type: "movie", createdAt: "2026-07-28T00:00:00Z",
        media: { mediaType: "movie", tmdbId: 99 },
        requestedBy: { displayName: "Ada" },
      }] }))
      .mockResolvedValueOnce(json({ id: 99, title: "Example Movie", posterPath: "/poster.jpg" })));
    const app = await buildApp(config);
    const response = await app.inject({ method: "GET", url: "/api/widget-gateway/v1/widgets/seerr/details" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.requests[0]).toMatchObject({
      id: 12, status: 1, title: "Example Movie", posterPath: "/poster.jpg", requestedBy: "Ada",
    });
    await app.close();
  });

  it("includes Sonarr series, episode number, and episode title metadata", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json([{ id: 7, title: "Example Show", monitored: true }]))
      .mockResolvedValueOnce(json({ records: [] }))
      .mockResolvedValueOnce(json({ records: [{
        id: 9, title: "The Episode", seasonNumber: 2, episodeNumber: 4,
        airDateUtc: "2026-07-30T04:00:00Z", series: { title: "Example Show" },
      }] })));
    const app = await buildApp(config);
    const response = await app.inject({ method: "GET", url: "/api/widget-gateway/v1/widgets/sonarr/details" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.missing[0]).toMatchObject({
      showTitle: "Example Show", episodeNumber: "S02E04", episodeTitle: "The Episode",
    });
    await app.close();
  });

  it("returns only Radarr and Sonarr releases with normalized episode metadata", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json([{ id: 1, title: "Movie", titleSlug: "movie-1", monitored: true, hasFile: true, digitalRelease: "2026-07-30T00:00:00Z" }]))
      .mockResolvedValueOnce(json([{
        id: 2, title: "Episode Name", seasonNumber: 1, episodeNumber: 6,
        hasFile: false, airDateUtc: "2026-07-30T04:00:00Z", series: { title: "Show Name", titleSlug: "show-name", monitored: true },
      }])));
    const app = await buildApp(config);
    const response = await app.inject({
      method: "GET",
      url: "/api/widget-gateway/v1/calendar?from=2026-07-01T00:00:00.000Z&to=2026-08-01T00:00:00.000Z",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.events).toEqual([
      expect.objectContaining({ source: "radarr", title: "Movie", slug: "movie-1", type: "movie", available: true }),
      expect.objectContaining({
        source: "sonarr", showTitle: "Show Name", episodeNumber: "S01E06",
        episodeTitle: "Episode Name", slug: "show-name", type: "episode", available: false,
      }),
    ]);
    await app.close();
  });

  it("uses current guest status for accurate running Proxmox VM memory", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json({ data: { cpu: 0.1, memory: { used: 7_000, total: 8_000 }, loadavg: [1, 1, 1] } }))
      .mockResolvedValueOnce(json({ data: [{ vmid: 100, name: "server", status: "running", cpu: 0.02, mem: 200, maxmem: 6_500 }] }))
      .mockResolvedValueOnce(json({ data: [] }))
      .mockResolvedValueOnce(json({ data: [] }))
      .mockResolvedValueOnce(json({ data: [] }))
      .mockResolvedValueOnce(json({ data: [] }))
      .mockResolvedValueOnce(json({ data: { cpu: 0.08, mem: 5_900, maxmem: 6_500 } })));
    const app = await buildApp(config);
    const response = await app.inject({ method: "GET", url: "/api/widget-gateway/v1/widgets/proxmox/details" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.vms[0]).toMatchObject({ cpu: 0.08, memory: 5_900, maxMemory: 6_500 });
    await app.close();
  });

  it("merges Dockhand scan outcomes into the existing environment widget", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json([{
        environment: { name: "NAS" },
        containers: { total: 12, running: 11, pendingUpdates: 3 },
        metrics: { cpuPercent: 4, memoryPercent: 50 },
      }]))
      .mockResolvedValueOnce(json({ schedules: [{
        lastExecution: { details: { updatesFound: 3, errors: 0 } },
        recentExecutions: [{ details: { summary: { updated: 2, failed: 1 } } }],
      }] }))
      .mockResolvedValueOnce(json([{
        environment: { name: "NAS" },
        containers: { total: 12, running: 11, pendingUpdates: 3 },
        metrics: { cpuPercent: 4, memoryPercent: 50 },
      }]))
      .mockResolvedValueOnce(json({ schedules: [{
        lastExecution: { details: { updatesFound: 3, errors: 0 } },
        recentExecutions: [{ details: { summary: { updated: 2, failed: 1 } } }],
      }] })));
    const app = await buildApp(config);
    const summary = await app.inject({ method: "GET", url: "/internal/v1/widgets/dockhand/summary" });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().data).toMatchObject({ containers: 12, running: 11, scanned: 3, updated: 2, failed: 1 });
    const details = await app.inject({ method: "GET", url: "/api/widget-gateway/v1/widgets/dockhand/details" });
    expect(details.statusCode).toBe(200);
    expect(details.json().data.updates).toMatchObject({ scanned: 3, found: 3, updated: 2, failed: 1 });
    await app.close();
  });

  it("uses milliseconds for allowlisted AdGuard pause durations", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const app = await buildApp(config);
    const headers = { origin: "https://dash.example.test", host: "dash.example.test", "content-type": "application/json", "x-dashboard-csrf": "1", "x-authentik-username": "ada" };
    const response = await app.inject({ method: "POST", url: "/api/widget-gateway/v1/actions/adguard/pause", headers, payload: { duration: 300 } });
    expect(response.statusCode).toBe(200);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ body: JSON.stringify({ enabled: false, duration: 300_000 }) });
    await app.close();
  });

  it("uses the current AdGuard protection payload for immediate enable", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const app = await buildApp(config);
    const headers = { origin: "https://dash.example.test", host: "dash.example.test", "content-type": "application/json", "x-dashboard-csrf": "1", "x-authentik-username": "ada" };
    const response = await app.inject({ method: "POST", url: "/api/widget-gateway/v1/actions/adguard/protection", headers, payload: { enabled: true } });
    expect(response.statusCode).toBe(200);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ body: JSON.stringify({ enabled: true, duration: 0 }) });
    await app.close();
  });

  it("requires explicit Seerr TV seasons and forwards only selected seasons", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const app = await buildApp(config);
    const headers = { origin: "https://dash.example.test", host: "dash.example.test", "content-type": "application/json", "x-dashboard-csrf": "1", "x-authentik-username": "ada" };
    const missing = await app.inject({ method: "POST", url: "/api/widget-gateway/v1/actions/seerr/request", headers, payload: { mediaType: "tv", mediaId: 2316 } });
    expect(missing.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    const selected = await app.inject({ method: "POST", url: "/api/widget-gateway/v1/actions/seerr/request", headers, payload: { mediaType: "tv", mediaId: 2316, seasons: [2, 4, 4, 0] } });
    expect(selected.statusCode).toBe(200);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ body: JSON.stringify({ mediaType: "tv", mediaId: 2316, seasons: [2, 4] }) });
    await app.close();
  });

  it("normalizes purposeful Home Assistant status without exposing entity ids", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json({ peopleHome: 1, lightsOn: 0, switchesOn: 2, automationsOn: 4 }))
      .mockResolvedValueOnce(json({ location_name: "Home", version: "2026.7" }))
      .mockResolvedValueOnce(json([
        { entity_id: "person.ada", state: "home", attributes: { friendly_name: "Ada" } },
        { entity_id: "scene.turn_on_ac", state: "unknown", attributes: { friendly_name: "turn on AC" } },
        { entity_id: "scene.turn_off_ac", state: "unknown", attributes: { friendly_name: "turn off AC" } },
        { entity_id: "switch.bedroom_mortien", state: "off", attributes: { friendly_name: "Mortien" } },
        { entity_id: "vacuum.robot", state: "docked", attributes: { friendly_name: "Rumba" } },
        { entity_id: "sensor.robot_battery_level", state: "100", attributes: {} },
        { entity_id: "sensor.robot_cleaning_progress", state: "0", attributes: {} },
        { entity_id: "todo.server", state: "3", attributes: { friendly_name: "Server" } },
        { entity_id: "binary_sensor.radarr_health", state: "on", attributes: { friendly_name: "Radarr Health", device_class: "problem" } },
      ])));
    const app = await buildApp(config);
    const response = await app.inject({ method: "GET", url: "/api/widget-gateway/v1/widgets/homeassistant/details" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      vacuum: { name: "Rumba", state: "docked", battery: 100 },
      serverTodos: 3,
      problems: [{ name: "Radarr Health", kind: "problem" }],
      people: [{ name: "Ada", state: "home" }],
      routines: { acOn: { available: true }, acOff: { available: true }, mortien: { available: true, state: "off" } },
    });
    expect(response.body).not.toContain("vacuum.robot");
    await app.close();
  });

  it("maps fixed Home Assistant vacuum commands to the discovered vacuum", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json([{ entity_id: "vacuum.robot", state: "docked" }]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const app = await buildApp(config);
    const headers = { origin: "https://dash.example.test", host: "dash.example.test", "content-type": "application/json", "x-dashboard-csrf": "1", "x-authentik-username": "ada" };
    const response = await app.inject({ method: "POST", url: "/api/widget-gateway/v1/actions/homeassistant/vacuum", headers, payload: { command: "dock" } });
    expect(response.statusCode).toBe(200);
    expect(String(fetchMock.mock.calls[1][0])).toContain("/api/services/vacuum/return_to_base");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ body: JSON.stringify({ entity_id: "vacuum.robot" }) });
    await app.close();
  });

  it("maps fixed Home Assistant routines without accepting entity ids", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json([{ entity_id: "switch.bedroom_mortien", state: "off", attributes: { friendly_name: "Mortien" } }]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const app = await buildApp(config);
    const headers = { origin: "https://dash.example.test", host: "dash.example.test", "content-type": "application/json", "x-dashboard-csrf": "1", "x-authentik-username": "ada" };
    const response = await app.inject({ method: "POST", url: "/api/widget-gateway/v1/actions/homeassistant/routine", headers, payload: { name: "mortienToggle" } });
    expect(response.statusCode).toBe(200);
    expect(String(fetchMock.mock.calls[1][0])).toContain("/api/services/switch/turn_on");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ body: JSON.stringify({ entity_id: "switch.bedroom_mortien" }) });
    await app.close();
  });

  it("sanitizes malformed, unauthorized, timeout, and offline upstream failures", async () => {
    for (const failure of [
      () => Promise.resolve(new Response("not json", { headers: { "content-type": "application/json" } })),
      () => Promise.resolve(json({ error: "upstream secret" }, 401)),
      () => Promise.reject(new DOMException("timed out", "TimeoutError")),
      () => Promise.reject(new Error("connect ECONNREFUSED 10.0.0.1")),
    ]) {
      vi.stubGlobal("fetch", vi.fn().mockImplementation(failure));
      const app = await buildApp({ ...config, cacheTtlMs: 1000 });
      const response = await app.inject({ method: "GET", url: "/internal/v1/widgets/jellyfin/summary" });
      expect(response.statusCode).toBe(502);
      expect(response.body).not.toMatch(/secret|10\.0\.0\.1|ECONNREFUSED/i);
      await app.close();
      vi.unstubAllGlobals();
    }
  });
});
