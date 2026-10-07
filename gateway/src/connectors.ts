import type { Config } from "./config.js";
import { finite, identifier, list, records, text, upstream } from "./http.js";
import { Agent } from "undici";

const insecureProxmoxAgent = new Agent({ connect: { rejectUnauthorized: false } });

export type WidgetId =
  | "jellyfin" | "seerr" | "radarr" | "sonarr" | "bazarr" | "prowlarr"
  | "qbittorrent" | "tdarr" | "immich" | "calendar" | "adguard" | "speedtest"
  | "authentik" | "homeassistant" | "dockhand" | "proxmox";

export const widgetIds: WidgetId[] = [
  "jellyfin", "seerr", "radarr", "sonarr", "bazarr", "prowlarr", "qbittorrent",
  "tdarr", "immich", "calendar", "adguard", "speedtest", "authentik",
  "homeassistant", "dockhand", "proxmox",
];

type Result = { summary: Record<string, unknown>; details: Record<string, unknown>; partial?: boolean };

export class Connectors {
  constructor(private config: Config) {}
  private get timeoutMs() { return this.config.timeoutMs; }
  private keyHeader(key: string) { return { "X-Api-Key": key }; }

  async read(id: WidgetId): Promise<Result> {
    if (id === "jellyfin") return this.jellyfin();
    if (id === "seerr") return this.seerr();
    if (id === "radarr" || id === "sonarr") return this.arr(id);
    if (id === "bazarr") return this.bazarr();
    if (id === "prowlarr") return this.prowlarr();
    if (id === "qbittorrent") return this.qbittorrent();
    if (id === "tdarr") return this.tdarr();
    if (id === "immich") return this.immich();
    if (id === "calendar") return this.calendar();
    if (id === "adguard") return this.adguard();
    if (id === "speedtest") return this.speedtest();
    if (id === "authentik") return this.authentik();
    if (id === "homeassistant") return this.homeassistant();
    if (id === "dockhand") return this.dockhand();
    return this.proxmox();
  }

  private async settled<T>(tasks: Promise<T>[]) {
    const results = await Promise.allSettled(tasks);
    const values = results.map(result => result.status === "fulfilled" ? result.value : null);
    if (values.every(value => value === null)) throw results.find(r => r.status === "rejected")?.reason;
    return { values, partial: values.some(value => value === null) };
  }

  private async jellyfin(): Promise<Result> {
    const cfg = this.config.services.jellyfin;
    const headers = { Authorization: `MediaBrowser Token="${cfg.key}"` };
    const { values: [sessionsRaw, countsRaw, librariesRaw], partial } = await this.settled([
      upstream<any>(cfg.url, "/Sessions", { headers, timeoutMs: this.timeoutMs }),
      upstream<any>(cfg.url, "/Items/Counts", { headers, timeoutMs: this.timeoutMs }),
      upstream<any>(cfg.url, "/Library/VirtualFolders", { headers, timeoutMs: this.timeoutMs }),
    ]);
    const sessions = list(sessionsRaw).filter(s => s.NowPlayingItem).map(s => ({
      id: identifier(s.Id), user: text(s.UserName, "Unknown"), client: text(s.Client),
      device: text(s.DeviceName), item: text(s.NowPlayingItem?.Name, "Unknown"),
      series: text(s.NowPlayingItem?.SeriesName), paused: !!s.PlayState?.IsPaused,
      positionTicks: finite(s.PlayState?.PositionTicks), runtimeTicks: finite(s.NowPlayingItem?.RunTimeTicks),
    }));
    const counts = (countsRaw || {}) as Record<string, any>;
    const libraries = list(librariesRaw).map(item => ({
      id: identifier(item.ItemId), name: text(item.Name), type: text(item.CollectionType, "mixed"),
    }));
    return {
      summary: { sessions: sessions.length, movies: finite(counts.MovieCount), series: finite(counts.SeriesCount), episodes: finite(counts.EpisodeCount) },
      details: { sessions, libraries, counts: { movies: finite(counts.MovieCount), series: finite(counts.SeriesCount), episodes: finite(counts.EpisodeCount), songs: finite(counts.SongCount) } },
      partial,
    };
  }

  private async seerr(): Promise<Result> {
    const cfg = this.config.services.seerr;
    const headers = this.keyHeader(cfg.key);
    const { values: [countsRaw, requestsRaw], partial } = await this.settled([
      upstream<any>(cfg.url, "/api/v1/request/count", { headers, timeoutMs: this.timeoutMs }),
      upstream<any>(cfg.url, "/api/v1/request?take=100&skip=0&sort=added", { headers, timeoutMs: this.timeoutMs }),
    ]);
    const counts = countsRaw || {};
    const requestRecords = records(requestsRaw).slice(0, 20);
    const detailResults = await Promise.allSettled(requestRecords.map(req => {
      const type = text(req.type || req.media?.mediaType);
      const tmdbId = finite(req.media?.tmdbId);
      return type && tmdbId
        ? upstream<any>(cfg.url, `/api/v1/${type}/${tmdbId}`, { headers, timeoutMs: this.timeoutMs })
        : Promise.resolve({});
    }));
    const requests = requestRecords.map((req, index) => {
      const result = detailResults[index];
      const detail = result.status === "fulfilled" ? result.value || {} : {};
      return {
      id: finite(req.id), status: finite(req.status), createdAt: text(req.createdAt),
      type: text(req.type || req.media?.mediaType), tmdbId: finite(req.media?.tmdbId),
      title: text(detail.title || detail.name || req.media?.title || req.media?.name, "Media request"),
      posterPath: text(detail.posterPath),
      requestedBy: text(req.requestedBy?.displayName),
    };
    });
    return {
      summary: { pending: finite(counts.pending), approved: finite(counts.approved), available: finite(counts.available), total: finite(counts.total, requests.length) },
      details: { requests },
      partial: partial || detailResults.some(result => result.status === "rejected"),
    };
  }

  private async arr(id: "radarr" | "sonarr"): Promise<Result> {
    const cfg = this.config.services[id];
    const headers = this.keyHeader(cfg.key);
    const entityPath = id === "radarr" ? "movie" : "series";
    const { values: [libraryRaw, queueRaw, missingRaw], partial } = await this.settled([
      upstream<any>(cfg.url, `/api/v3/${entityPath}`, { headers, timeoutMs: this.timeoutMs }),
      upstream<any>(cfg.url, "/api/v3/queue?page=1&pageSize=50", { headers, timeoutMs: this.timeoutMs }),
      upstream<any>(cfg.url, `/api/v3/wanted/missing?page=1&pageSize=50${id === "sonarr" ? "&includeSeries=true" : ""}`, { headers, timeoutMs: this.timeoutMs }),
    ]);
    const library = list(libraryRaw);
    const episodeLabel = (item: Record<string, any>) => id === "sonarr" && Number.isFinite(Number(item.seasonNumber)) && Number.isFinite(Number(item.episodeNumber))
      ? `S${String(finite(item.seasonNumber)).padStart(2, "0")}E${String(finite(item.episodeNumber)).padStart(2, "0")}`
      : "";
    const queue = records(queueRaw).map(item => ({
      id: finite(item.id), title: text(item.title), status: text(item.status),
      size: finite(item.size), sizeleft: finite(item.sizeleft),
      showTitle: text(item.series?.title || item.seriesTitle),
      episodeNumber: episodeLabel(item.episode || item),
      episodeTitle: text(item.episode?.title),
    }));
    const missing = records(missingRaw).map(item => ({
      id: finite(item.id), title: text(item.title || item.seriesTitle),
      airDateUtc: text(item.airDateUtc || item.digitalRelease),
      showTitle: text(item.series?.title || item.seriesTitle),
      episodeNumber: episodeLabel(item),
      episodeTitle: id === "sonarr" ? text(item.title) : "",
    }));
    const monitored = library.filter(item => item.monitored).length;
    return { summary: { library: library.length, monitored, missing: missing.length, queued: queue.length }, details: { library: library.map(item => ({ id: finite(item.id), title: text(item.title), monitored: !!item.monitored, status: text(item.status) })), queue, missing }, partial };
  }

  private async bazarr(): Promise<Result> {
    const cfg = this.config.services.bazarr;
    const paths = ["/api/movies?start=0&length=10000", "/api/series?start=0&length=10000", "/api/movies/wanted?start=0&length=100", "/api/episodes/wanted?start=0&length=100", "/api/episodes/history?start=0&length=50", "/api/movies/history?start=0&length=50"];
    const withKey = (path: string) => `${path}${path.includes("?") ? "&" : "?"}apikey=${encodeURIComponent(cfg.key)}`;
    const { values, partial } = await this.settled(paths.map(path => upstream<any>(cfg.url, withKey(path), { timeoutMs: this.timeoutMs })));
    const movies = records(values[0]); const series = records(values[1]);
    const wantedMovies = records(values[2]); const wantedEpisodes = records(values[3]);
    const history = [...records(values[4]), ...records(values[5])].slice(0, 50).map(item => ({ title: text(item.title || item.episode), language: text(item.language?.name || item.language), timestamp: text(item.timestamp), action: finite(item.action) }));
    const languages = (value: unknown) => list(value).map(language => ({
      code: text(language.code2), forced: !!language.forced, hi: !!language.hi,
    })).filter(language => language.code);
    return {
      summary: { movies: movies.length, series: series.length, wanted: wantedMovies.length + wantedEpisodes.length, history: history.length },
      details: {
        movies: movies.map(x => ({ id: finite(x.radarrId), title: text(x.title), missing: finite(x.missing_subtitles?.length) })),
        series: series.map(x => ({ id: finite(x.sonarrSeriesId), title: text(x.title), missing: finite(x.episodeMissingCount ?? x.missing_subtitles?.length) })),
        wantedMovies: wantedMovies.map(x => ({ id: finite(x.radarrId), title: text(x.title), missingSubtitles: languages(x.missing_subtitles) })),
        wantedEpisodes: wantedEpisodes.map(x => ({
          id: finite(x.sonarrEpisodeId), seriesId: finite(x.sonarrSeriesId),
          title: text(x.seriesTitle || x.title), episode: text(x.episode_number || x.episode),
          episodeTitle: text(x.episodeTitle), missingSubtitles: languages(x.missing_subtitles),
        })),
        history,
      },
      partial,
    };
  }

  private async prowlarr(): Promise<Result> {
    const cfg = this.config.services.prowlarr; const headers = this.keyHeader(cfg.key);
    const { values: [indexersRaw, statsRaw, historyRaw, statusRaw], partial } = await this.settled([
      upstream<any>(cfg.url, "/api/v1/indexer", { headers, timeoutMs: this.timeoutMs }),
      upstream<any>(cfg.url, "/api/v1/indexerstats", { headers, timeoutMs: this.timeoutMs }),
      upstream<any>(cfg.url, "/api/v1/history?pageSize=50&sortKey=date&sortDirection=descending", { headers, timeoutMs: this.timeoutMs }),
      upstream<any>(cfg.url, "/api/v1/indexerstatus", { headers, timeoutMs: this.timeoutMs }),
    ]);
    const statuses = list(statusRaw);
    const activeFailure = (indexerId: number) => statuses.find(status => {
      if (finite(status.indexerId ?? status.id) !== indexerId) return false;
      const until = Date.parse(text(status.disabledTill));
      return Number.isFinite(until) && until > Date.now();
    });
    const indexers = list(indexersRaw).map(x => {
      const failure = activeFailure(finite(x.id));
      return {
        id: finite(x.id), name: text(x.name), enabled: !!x.enable,
        priority: finite(x.priority), protocol: text(x.protocol),
        failing: !!failure, disabledTill: text(failure?.disabledTill),
      };
    });
    const history = records(historyRaw).map(x => ({ id: finite(x.id), date: text(x.date), eventType: text(x.eventType), indexer: text(x.indexer), query: text(x.data?.query) }));
    const stats = statsRaw || {};
    const indexerStats = list(stats.indexers);
    const total = (key: string) => {
      const direct = Number(stats[key]);
      return Number.isFinite(direct) ? direct : indexerStats.reduce((sum, row) => sum + finite(row[key]), 0);
    };
    const statistics = {
      queries: total("numberOfQueries"),
      grabs: total("numberOfGrabs"),
      failedQueries: total("numberOfFailedQueries"),
      failedGrabs: total("numberOfFailedGrabs"),
    };
    const perIndexer = indexerStats.map(row => ({
      name: text(row.indexerName, "Indexer"), queries: finite(row.numberOfQueries),
      grabs: finite(row.numberOfGrabs), failedQueries: finite(row.numberOfFailedQueries),
      failedGrabs: finite(row.numberOfFailedGrabs),
    })).sort((a, b) => b.grabs - a.grabs);
    return {
      summary: { indexers: indexers.length, enabled: indexers.filter(x => x.enabled).length, failing: indexers.filter(x => x.failing).length, queries: statistics.queries, grabs: statistics.grabs },
      details: { indexers, history, statistics, perIndexer },
      partial,
    };
  }

  private async qbitSession() {
    const cfg = this.config.services.qbittorrent;
    const response = await fetch(new URL("/api/v2/auth/login", cfg.url), {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: cfg.url },
      body: new URLSearchParams({ username: cfg.username, password: cfg.password }), redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const loginBody = (await response.text()).trim();
    if (!response.ok || (loginBody && loginBody !== "Ok.")) throw new Error("qBittorrent authentication failed");
    const cookie = response.headers.get("set-cookie")?.match(/(?:QBT_SID_\d+|SID)=[^;,\s]+/)?.[0];
    if (!cookie) throw new Error("qBittorrent authentication failed");
    return cookie;
  }

  private async qbittorrent(): Promise<Result> {
    const cfg = this.config.services.qbittorrent; const cookie = await this.qbitSession(); const headers = { Cookie: cookie, Referer: cfg.url };
    const { values: [torrentsRaw, transferRaw, mainRaw], partial } = await this.settled([
      upstream<any>(cfg.url, "/api/v2/torrents/info", { headers, timeoutMs: this.timeoutMs }),
      upstream<any>(cfg.url, "/api/v2/transfer/info", { headers, timeoutMs: this.timeoutMs }),
      upstream<any>(cfg.url, "/api/v2/sync/maindata", { headers, timeoutMs: this.timeoutMs }),
    ]);
    const torrents = list(torrentsRaw).map(t => ({ hash: identifier(t.hash), name: text(t.name), state: text(t.state), progress: finite(t.progress), dlspeed: finite(t.dlspeed), upspeed: finite(t.upspeed), size: finite(t.size), ratio: finite(t.ratio), eta: finite(t.eta) }));
    const transfer = transferRaw || {}; const server = mainRaw?.server_state || {};
    return { summary: { download: finite(transfer.dl_info_speed), upload: finite(transfer.up_info_speed), active: torrents.filter(t => /downloading|uploading|stalled/i.test(t.state)).length, free: finite(server.free_space_on_disk) }, details: { transfer: { download: finite(transfer.dl_info_speed), upload: finite(transfer.up_info_speed), downloaded: finite(transfer.dl_info_data), uploaded: finite(transfer.up_info_data), freeSpace: finite(server.free_space_on_disk) }, torrents }, partial };
  }

  private async tdarr(): Promise<Result> {
    const cfg = this.config.services.tdarr; const headers = { "x-api-key": cfg.key };
    const { values: [statsRaw, nodesRaw], partial } = await this.settled([
      upstream<any>(cfg.url, "/api/v2/cruddb", { method: "POST", headers, body: { data: { collection: "StatisticsJSONDB", mode: "getById", docID: "statistics", obj: {} } }, timeoutMs: this.timeoutMs }),
      upstream<any>(cfg.url, "/api/v2/get-nodes", { headers, timeoutMs: this.timeoutMs }),
    ]);
    const stats = statsRaw || {};
    const nodes = nodesRaw && typeof nodesRaw === "object" ? Object.values(nodesRaw as Record<string, any>).map(n => ({ id: identifier(n._id), name: text(n.nodeName || n.name, "Node"), status: text(n.status), paused: !!n.nodePaused, workers: finite(Object.keys(n.workers || {}).length) })) : [];
    const queue = { transcode: finite(stats.table3Count), health: finite(stats.table4Count), errors: finite(stats.table6Count) };
    return { summary: { files: finite(stats.totalFileCount), transcoded: finite(stats.totalTranscodeCount), queued: queue.transcode + queue.health, errors: queue.errors }, details: { statistics: { files: finite(stats.totalFileCount), transcoded: finite(stats.totalTranscodeCount), sizeDiff: finite(stats.sizeDiff) }, nodes, queue }, partial };
  }

  private async immich(): Promise<Result> {
    const cfg = this.config.services.immich; const headers = this.keyHeader(cfg.key);
    const { values: [statsRaw, usersRaw], partial } = await this.settled([
      upstream<any>(cfg.url, "/api/server/statistics", { headers, timeoutMs: this.timeoutMs }),
      upstream<any>(cfg.url, "/api/admin/users?withDeleted=true", { headers, timeoutMs: this.timeoutMs }),
    ]);
    const stats = statsRaw || {};
    const adminUsers = list(usersRaw);
    const usageByUser = list(stats.usageByUser);
    const users = usageByUser.map(usage => {
      const user = adminUsers.find(item => item.id === usage.userId) || {};
      return { id: identifier(usage.userId), name: text(user.name || usage.userName, "User"), photos: finite(usage.photos), videos: finite(usage.videos), usage: finite(usage.usage), quotaSize: finite(user.quotaSizeInBytes), status: user.id ? (user.deletedAt ? "deleted" : text(user.status, "active")) : "unknown" };
    });
    const activeUsers = adminUsers.length ? adminUsers.filter(user => !user.deletedAt && user.status !== "removing").length : users.length;
    return { summary: { users: activeUsers, storage: finite(stats.usage), photos: finite(stats.photos), videos: finite(stats.videos) }, details: { totals: { photos: finite(stats.photos), videos: finite(stats.videos), usage: finite(stats.usage), photoUsage: finite(stats.usagePhotos), videoUsage: finite(stats.usageVideos) }, users }, partial };
  }

  async calendarRange(from: string, to: string) {
    const services = [["radarr", this.config.services.radarr], ["sonarr", this.config.services.sonarr]] as const;
    const rangeStart = Date.parse(from); const rangeEnd = Date.parse(to);
    const releaseDate = (item: Record<string, any>, source: "radarr" | "sonarr") => {
      const candidates = source === "sonarr"
        ? [item.airDateUtc, item.airDate]
        : [item.digitalRelease, item.physicalRelease, item.inCinemas];
      return text(candidates.find(value => {
        const date = Date.parse(value);
        return Number.isFinite(date) && date >= rangeStart && date < rangeEnd;
      }) || "");
    };
    const requests: Promise<{ source: string; id: number; title: string; date: string; type: string; showTitle: string; episodeNumber: string; episodeTitle: string; available: boolean }[]>[] =
      services.map(([source, cfg]) => upstream<any>(cfg.url, `/api/v3/calendar?start=${encodeURIComponent(from)}&end=${encodeURIComponent(to)}&unmonitored=false${source === "sonarr" ? "&includeSeries=true" : ""}`, { headers: this.keyHeader(cfg.key), timeoutMs: this.timeoutMs }).then(raw => list(raw)
        .filter(item => source === "radarr" ? item.monitored !== false : item.series?.monitored !== false)
        .filter(item => releaseDate(item, source))
        .map(item => ({
          source,
          id: finite(item.id),
          title: text(item.title || item.series?.title),
          date: releaseDate(item, source),
          type: source === "radarr" ? "movie" : "episode",
          showTitle: source === "sonarr" ? text(item.series?.title, "Unknown series") : "",
          episodeNumber: source === "sonarr" ? `S${String(finite(item.seasonNumber)).padStart(2, "0")}E${String(finite(item.episodeNumber)).padStart(2, "0")}` : "",
          episodeTitle: source === "sonarr" ? text(item.title, "Untitled episode") : "",
          available: !!item.hasFile,
          slug: text(source === "radarr" ? item.titleSlug || item.movie?.titleSlug : item.series?.titleSlug),
        }))));
    const results = await Promise.allSettled(requests);
    const events = results.flatMap(result => result.status === "fulfilled" ? result.value : []);
    if (!events.length && results.every(result => result.status === "rejected")) throw results[0].reason;
    return { data: { events: events.sort((a, b) => a.date.localeCompare(b.date)) }, partial: results.some(result => result.status === "rejected") };
  }

  private async calendar(): Promise<Result> {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
    const end = new Date(start.getTime() + 42 * 86_400_000);
    const range = await this.calendarRange(start.toISOString(), end.toISOString());
    const events = range.data.events;
    return { summary: { today: events.filter(e => e.date.slice(0, 10) === now.toISOString().slice(0, 10)).length, movies: events.filter(e => e.type === "movie").length, episodes: events.filter(e => e.type === "episode").length, upcoming: events.length }, details: { events }, partial: range.partial };
  }

  private async adguard(): Promise<Result> {
    const cfg = this.config.services.adguard; const authorization = `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64")}`; const headers = { Authorization: authorization };
    const { values: [statsRaw, statusRaw, safeRaw, parentalRaw], partial } = await this.settled([
      upstream<any>(cfg.url, "/control/stats", { headers, timeoutMs: this.timeoutMs }),
      upstream<any>(cfg.url, "/control/status", { headers, timeoutMs: this.timeoutMs }),
      upstream<any>(cfg.url, "/control/safebrowsing/status", { headers, timeoutMs: this.timeoutMs }),
      upstream<any>(cfg.url, "/control/parental/status", { headers, timeoutMs: this.timeoutMs }),
    ]);
    const stats = statsRaw || {}; const status = statusRaw || {};
    const queries = finite(stats.num_dns_queries); const blocked = finite(stats.num_blocked_filtering);
    return { summary: { queries, blocked, blockedPct: queries ? Math.round(blocked / queries * 100) : 0, latency: finite(stats.avg_processing_time) }, details: { statistics: { queries, blocked, blockedPct: queries ? blocked / queries * 100 : 0, latency: finite(stats.avg_processing_time) }, controls: { protection: !!status.protection_enabled, pauseRemainingMs: finite(status.protection_disabled_duration), safeBrowsing: !!safeRaw?.enabled, parental: !!parentalRaw?.enabled } }, partial };
  }

  private speedResult(raw: any) {
    return { id: identifier(raw.id), createdAt: text(raw.created_at), download: finite(raw.download), upload: finite(raw.upload), ping: finite(raw.ping), jitter: finite(raw.jitter ?? raw.data?.ping?.jitter), packetLoss: finite(raw.packet_loss ?? raw.data?.packetLoss), serverName: text(raw.server_name || raw.server?.name || raw.data?.server?.name) };
  }
  private async speedtest(): Promise<Result> {
    const cfg = this.config.services.speedtest; const headers = { Authorization: `Bearer ${cfg.key}` };
    const raw = await upstream<any>(cfg.url, "/api/v1/results?per_page=10&sort=-created_at", { headers, timeoutMs: this.timeoutMs });
    const history = records(raw).map(item => this.speedResult(item)); const latest = history[0] || this.speedResult({});
    return { summary: { download: latest.download, upload: latest.upload, ping: latest.ping, jitter: latest.jitter }, details: { latest, history } };
  }

  private volumeTotal(raw: any): number {
    if (Array.isArray(raw)) return raw.reduce((sum, item) => sum + this.volumeTotal(item), 0);
    if (!raw || typeof raw !== "object") return 0;
    for (const key of ["count", "total", "value", "y"]) {
      if (Number.isFinite(Number(raw[key]))) return finite(raw[key]);
    }
    for (const key of ["data", "results", "entries"]) {
      if (Array.isArray(raw[key])) return this.volumeTotal(raw[key]);
    }
    return 0;
  }

  private async authentik(): Promise<Result> {
    const cfg = this.config.services.authentik;
    const headers = { Authorization: `Bearer ${cfg.key}` };
    const { values: [usersRaw, loginsRaw, failedRaw, outpostsRaw], partial } = await this.settled([
      upstream<any>(cfg.url, "/api/v3/core/users/?page=1&page_size=20&is_active=true", { headers, timeoutMs: this.timeoutMs }),
      upstream<any>(cfg.url, "/api/v3/events/events/volume/?action=login&history_days=1", { headers, timeoutMs: this.timeoutMs }),
      upstream<any>(cfg.url, "/api/v3/events/events/volume/?action=login_failed&history_days=1", { headers, timeoutMs: this.timeoutMs }),
      upstream<any>(cfg.url, "/api/v3/outposts/instances/?page=1&page_size=20", { headers, timeoutMs: this.timeoutMs }),
    ]);
    const users = records(usersRaw).map(user => ({
      username: text(user.username), name: text(user.name), active: !!user.is_active,
      lastLogin: text(user.last_login),
    }));
    const outposts = records(outpostsRaw).map(outpost => ({
      name: text(outpost.name), type: text(outpost.type), managed: text(outpost.managed),
    }));
    const activeUsers = finite(usersRaw?.pagination?.count, users.length);
    const logins = this.volumeTotal(loginsRaw);
    const failed = this.volumeTotal(failedRaw);
    return {
      summary: { users: activeUsers, logins, failed, outposts: finite(outpostsRaw?.pagination?.count, outposts.length) },
      details: { users, outposts, activity: { logins, failed } },
      partial,
    };
  }

  private async homeassistant(): Promise<Result> {
    const cfg = this.config.services.homeassistant;
    const headers = { Authorization: `Bearer ${cfg.key}` };
    const template = `{{ {"peopleHome": states.person | selectattr("state", "eq", "home") | list | count, "lightsOn": states.light | selectattr("state", "eq", "on") | list | count, "switchesOn": states.switch | selectattr("state", "eq", "on") | list | count, "automationsOn": states.automation | selectattr("state", "eq", "on") | list | count} | tojson }}`;
    const { values: [metricsRaw, configRaw, statesRaw], partial } = await this.settled([
      upstream<any>(cfg.url, "/api/template", { method: "POST", headers, body: { template }, timeoutMs: this.timeoutMs }),
      upstream<any>(cfg.url, "/api/config", { headers, timeoutMs: this.timeoutMs }),
      upstream<any>(cfg.url, "/api/states", { headers, timeoutMs: this.timeoutMs }),
    ]);
    let metrics: Record<string, any> = {};
    try { metrics = typeof metricsRaw === "string" ? JSON.parse(metricsRaw) : metricsRaw || {}; } catch { metrics = {}; }
    const states = list(statesRaw);
    const domainOf = (entity: Record<string, any>) => text(entity.entity_id).split(".")[0];
    const friendly = (entity: Record<string, any>, fallback = "Device") => text(entity.attributes?.friendly_name, fallback);
    const stateNumber = (entity: Record<string, any> | undefined) => finite(entity?.state);
    const vacuumEntity = states.find(entity => domainOf(entity) === "vacuum");
    const vacuumStem = text(vacuumEntity?.entity_id).split(".")[1];
    const vacuumRelated = (pattern: RegExp) => states.find(entity => vacuumStem && text(entity.entity_id).includes(vacuumStem) && pattern.test(text(entity.entity_id)));
    const battery = vacuumRelated(/battery_level/);
    const cleaningProgress = vacuumRelated(/cleaning_progress/);
    const cleaningTime = vacuumRelated(/cleaning_time/);
    const cleaningArea = vacuumRelated(/cleaning_area/);
    const sweepMopStatus = vacuumRelated(/sweep_mop_status/);
    const waterTank = vacuumRelated(/water_tank_status/);
    const sewageTank = vacuumRelated(/sewage_tank_status/);
    const serverTodo = states.find(entity => text(entity.entity_id) === "todo.server" || (domainOf(entity) === "todo" && /^server$/i.test(friendly(entity, ""))));
    const problemClasses = new Set(["problem", "safety", "smoke", "gas", "moisture", "tamper"]);
    const problems = states.filter(entity => domainOf(entity) === "binary_sensor" && entity.state === "on" && problemClasses.has(text(entity.attributes?.device_class)))
      .map(entity => ({ name: friendly(entity, "Home alert"), kind: text(entity.attributes?.device_class, "problem") })).slice(0, 8);
    const activeMedia = states.filter(entity => domainOf(entity) === "media_player" && !["off", "idle", "standby", "unavailable", "unknown"].includes(text(entity.state)))
      .map(entity => ({ name: friendly(entity, "Media player"), state: text(entity.state), title: text(entity.attributes?.media_title), artist: text(entity.attributes?.media_artist), app: text(entity.attributes?.app_name) })).slice(0, 4);
    const people = states.filter(entity => domainOf(entity) === "person")
      .map(entity => ({ name: friendly(entity, "Person"), state: text(entity.state, "unknown") })).slice(0, 12);
    const named = (domain: string, name: RegExp) => states.find(entity => domainOf(entity) === domain && name.test(friendly(entity, "")));
    const acOn = named("scene", /^turn on ac$/i);
    const acOff = named("scene", /^turn off ac$/i);
    const mortien = named("switch", /^mortien$/i);
    const domains = states.reduce<Record<string, number>>((counts, entity) => {
      const domain = text(entity.entity_id).split(".")[0];
      if (domain) counts[domain] = (counts[domain] || 0) + 1;
      return counts;
    }, {});
    const summary = {
      peopleHome: finite(metrics.peopleHome), lightsOn: finite(metrics.lightsOn),
      switchesOn: finite(metrics.switchesOn), automations: finite(metrics.automationsOn),
      vacuumState: text(vacuumEntity?.state, "unavailable"),
      serverTodos: stateNumber(serverTodo), problems: problems.length,
    };
    return {
      summary,
      details: {
        metrics: { ...summary, totalEntities: states.length },
        system: { location: text(configRaw?.location_name), version: text(configRaw?.version), timeZone: text(configRaw?.time_zone) },
        vacuum: vacuumEntity ? {
          name: friendly(vacuumEntity, "Robot vacuum"), state: text(vacuumEntity.state),
          battery: stateNumber(battery), progress: stateNumber(cleaningProgress),
          cleaningTime: stateNumber(cleaningTime), cleaningArea: stateNumber(cleaningArea),
          activity: text(sweepMopStatus?.state), waterTank: text(waterTank?.state), sewageTank: text(sewageTank?.state),
        } : null,
        serverTodos: stateNumber(serverTodo), problems, activeMedia, people,
        routines: {
          acOn: { available: !!acOn, label: "AC on" },
          acOff: { available: !!acOff, label: "AC off" },
          mortien: { available: !!mortien, label: "Mortien", state: text(mortien?.state, "unavailable") },
        },
        domains,
      },
      partial,
    };
  }

  private dockhandHeaders(): Record<string, string> {
    const key = this.config.services.dockhand.key;
    return key ? { Authorization: `Bearer ${key}` } : {};
  }

  private async dockhand(): Promise<Result> {
    const cfg = this.config.services.dockhand;
    const { values: [raw, schedulesRaw], partial } = await this.settled([
      upstream<any>(cfg.url, "/api/dashboard/stats", { headers: this.dockhandHeaders(), timeoutMs: this.timeoutMs }),
      upstream<any>(cfg.url, "/api/schedules", { headers: this.dockhandHeaders(), timeoutMs: this.timeoutMs }),
    ]);
    const environments = list(raw).map(environment => ({
      name: text(environment.environment?.name || environment.name, "Docker"),
      containers: {
        total: finite(environment.containers?.total), running: finite(environment.containers?.running),
        stopped: finite(environment.containers?.stopped), paused: finite(environment.containers?.paused),
        restarting: finite(environment.containers?.restarting), unhealthy: finite(environment.containers?.unhealthy),
        pendingUpdates: finite(environment.containers?.pendingUpdates),
      },
      metrics: {
        cpuPercent: finite(environment.metrics?.cpuPercent), memoryPercent: finite(environment.metrics?.memoryPercent),
        memoryUsed: finite(environment.metrics?.memoryUsed), memoryTotal: finite(environment.metrics?.memoryTotal),
      },
      images: { total: finite(environment.images?.total), totalSize: finite(environment.images?.totalSize) },
      volumes: { total: finite(environment.volumes?.total), totalSize: finite(environment.volumes?.totalSize) },
      networks: { total: finite(environment.networks?.total) },
      stacks: {
        total: finite(environment.stacks?.total), running: finite(environment.stacks?.running),
        stopped: finite(environment.stacks?.stopped), partial: finite(environment.stacks?.partial),
      },
      events: { total: finite(environment.events?.total), today: finite(environment.events?.today) },
      topContainers: list(environment.topContainers).slice(0, 10).map(container => ({
        name: text(container.name), status: text(container.status), cpu: finite(container.cpuPercent),
        memory: finite(container.memoryUsage), memoryPercent: finite(container.memoryPercent),
      })),
    }));
    const totals = environments.reduce((sum, item) => ({
      total: sum.total + item.containers.total, running: sum.running + item.containers.running,
      stopped: sum.stopped + item.containers.stopped, unhealthy: sum.unhealthy + item.containers.unhealthy,
    }), { total: 0, running: 0, stopped: 0, unhealthy: 0 });
    const schedules = Array.isArray(schedulesRaw?.schedules) ? schedulesRaw.schedules : records(schedulesRaw);
    const schedule = schedules[0] || {};
    const scanDetails = schedule.lastExecution?.details || {};
    const resultDetails = schedule.recentExecutions?.[0]?.details || scanDetails;
    const outcome = resultDetails.summary || {};
    const updates = {
      scanned: finite(scanDetails.scanned ?? scanDetails.containersScanned ?? scanDetails.updatesFound),
      found: finite(scanDetails.updatesFound),
      updated: finite(outcome.updated ?? resultDetails.updated),
      failed: finite(outcome.failed ?? resultDetails.failed ?? scanDetails.errors),
    };
    return {
      summary: { containers: totals.total, running: totals.running, scanned: updates.scanned, updated: updates.updated, failed: updates.failed },
      details: { environments, updates },
      partial,
    };
  }

  private async proxmox(): Promise<Result> {
    const cfg = this.config.services.proxmox;
    const headers = { Authorization: `PVEAPIToken=${cfg.tokenId}=${cfg.tokenSecret}` };
    const dispatcher = cfg.tlsInsecure ? insecureProxmoxAgent : undefined;
    const node = encodeURIComponent(cfg.node);
    const { values: [statusRaw, vmRaw, lxcRaw, storageRaw, updatesRaw, tasksRaw], partial } = await this.settled([
      upstream<any>(cfg.url, `/api2/json/nodes/${node}/status`, { headers, dispatcher, timeoutMs: this.timeoutMs }),
      upstream<any>(cfg.url, `/api2/json/nodes/${node}/qemu`, { headers, dispatcher, timeoutMs: this.timeoutMs }),
      upstream<any>(cfg.url, `/api2/json/nodes/${node}/lxc`, { headers, dispatcher, timeoutMs: this.timeoutMs }),
      upstream<any>(cfg.url, `/api2/json/nodes/${node}/storage`, { headers, dispatcher, timeoutMs: this.timeoutMs }),
      upstream<any>(cfg.url, `/api2/json/nodes/${node}/apt/update`, { headers, dispatcher, timeoutMs: this.timeoutMs }),
      upstream<any>(cfg.url, `/api2/json/nodes/${node}/tasks?limit=25`, { headers, dispatcher, timeoutMs: this.timeoutMs }),
    ]);
    const status = statusRaw?.data || {};
    let vms = list(vmRaw?.data).map(x => ({ id: finite(x.vmid), name: text(x.name), status: text(x.status), cpu: finite(x.cpu), memory: finite(x.mem), maxMemory: finite(x.maxmem), networkIn: finite(x.netin), networkOut: finite(x.netout) }));
    let lxc = list(lxcRaw?.data).map(x => ({ id: finite(x.vmid), name: text(x.name), status: text(x.status), cpu: finite(x.cpu), memory: finite(x.mem), maxMemory: finite(x.maxmem), networkIn: finite(x.netin), networkOut: finite(x.netout) }));
    const runningGuests = [...vms.map((guest, index) => ({ guest, index, kind: "qemu" as const })), ...lxc.map((guest, index) => ({ guest, index, kind: "lxc" as const }))]
      .filter(item => item.guest.status === "running");
    const liveStatuses = await Promise.allSettled(runningGuests.map(item =>
      upstream<any>(cfg.url, `/api2/json/nodes/${node}/${item.kind}/${item.guest.id}/status/current`, { headers, dispatcher, timeoutMs: this.timeoutMs })));
    liveStatuses.forEach((result, index) => {
      if (result.status !== "fulfilled") return;
      const item = runningGuests[index]; const current = result.value?.data || {};
      const guest = { ...item.guest, cpu: finite(current.cpu, item.guest.cpu), memory: finite(current.mem, item.guest.memory), maxMemory: finite(current.maxmem, item.guest.maxMemory) };
      if (item.kind === "qemu") vms[item.index] = guest;
      else lxc[item.index] = guest;
    });
    const storage = list(storageRaw?.data).map(x => ({ name: text(x.storage), type: text(x.type), active: !!x.active, used: finite(x.used), total: finite(x.total), available: finite(x.avail) }));
    const updates = list(updatesRaw?.data).map(x => ({ package: text(x.Package), current: text(x.OldVersion), available: text(x.Version) }));
    const tasks = list(tasksRaw?.data).map(x => ({ type: text(x.type), status: text(x.status), user: text(x.user), startTime: finite(x.starttime), endTime: finite(x.endtime) }));
    let processes: Record<string, unknown>[] = []; let interfaces: Record<string, unknown>[] = [];
    let glancesPartial = false;
    if (cfg.glancesUrl) {
      const glances = await Promise.allSettled([
        upstream<any>(cfg.glancesUrl, "/api/4/processlist", { timeoutMs: this.timeoutMs }),
        upstream<any>(cfg.glancesUrl, "/api/4/network", { timeoutMs: this.timeoutMs }),
      ]);
      processes = glances[0].status === "fulfilled" ? list(glances[0].value).slice(0, 100).map(x => ({ pid: finite(x.pid), name: text(x.name), user: text(x.username), cpu: finite(x.cpu_percent), memory: finite(x.memory_percent), status: text(x.status) })) : [];
      interfaces = glances[1].status === "fulfilled" ? list(glances[1].value).map(x => ({ name: text(x.interface_name), received: finite(x.bytes_recv), sent: finite(x.bytes_sent), receiveRate: finite(x.bytes_recv_rate_per_sec), sendRate: finite(x.bytes_sent_rate_per_sec) })) : [];
      glancesPartial = glances.some(result => result.status === "rejected");
    }
    return { summary: { cpu: finite(status.cpu) * 100, memory: finite(status.memory?.used), storage: storage.reduce((sum, x) => sum + x.used, 0), guests: vms.length + lxc.length }, details: { node: { status: text(status.status, "unknown"), cpu: finite(status.cpu), memory: { used: finite(status.memory?.used), total: finite(status.memory?.total) }, load: list(status.loadavg).map(finite), uptime: finite(status.uptime), kernel: text(status.kversion) }, vms, lxc, storage, updates, tasks, processes, interfaces, network: { in: [...vms, ...lxc].reduce((sum, x) => sum + x.networkIn, 0), out: [...vms, ...lxc].reduce((sum, x) => sum + x.networkOut, 0) } }, partial: partial || glancesPartial || liveStatuses.some(result => result.status === "rejected") };
  }

  async searchSeerr(query: string) {
    const cfg = this.config.services.seerr; const raw = await upstream<any>(cfg.url, `/api/v1/search?query=${encodeURIComponent(query)}&page=1&language=en`, { headers: this.keyHeader(cfg.key), timeoutMs: this.timeoutMs });
    return records(raw).filter(x => x.mediaType === "movie" || x.mediaType === "tv").slice(0, 12).map(x => ({ id: finite(x.id), mediaType: text(x.mediaType), title: text(x.title || x.name), releaseDate: text(x.releaseDate || x.firstAirDate), status: finite(x.mediaInfo?.status), posterPath: text(x.posterPath) }));
  }

  async seerrMedia(mediaType: "movie" | "tv", id: number) {
    const cfg = this.config.services.seerr;
    const raw = await upstream<any>(cfg.url, `/api/v1/${mediaType}/${id}`, { headers: this.keyHeader(cfg.key), timeoutMs: this.timeoutMs });
    return {
      id: finite(raw.id), mediaType, title: text(raw.title || raw.name), overview: text(raw.overview),
      releaseDate: text(raw.releaseDate || raw.firstAirDate), status: text(raw.status),
      runtime: finite(raw.runtime), seasons: list(raw.seasons).map(season => ({
        number: finite(season.seasonNumber), name: text(season.name), episodes: finite(season.episodeCount),
        airDate: text(season.airDate), status: finite(list(raw.mediaInfo?.seasons).find(info => finite(info.seasonNumber) === finite(season.seasonNumber))?.status),
      })),
    };
  }

  async action(service: string, action: string, body: Record<string, any>) {
    if (service === "jellyfin") return this.jellyfinAction(action, body);
    if (service === "seerr") return this.seerrAction(action, body);
    if (service === "radarr" || service === "sonarr") return this.arrAction(service, action, body);
    if (service === "bazarr") return this.bazarrAction(action, body);
    if (service === "qbittorrent") return this.qbitAction(action, body);
    if (service === "adguard") return this.adguardAction(action, body);
    if (service === "speedtest") return this.speedtestAction(action);
    if (service === "homeassistant") return this.homeassistantAction(action, body);
    if (service === "prowlarr") return this.prowlarrAction(action);
    throw new Error("Action is not allowed");
  }

  private async arrAction(service: "radarr" | "sonarr", action: string, body: Record<string, any>) {
    if (action !== "search") throw new Error("Action is not allowed");
    const cfg = this.config.services[service];
    const all = body.all === true;
    const id = finite(body.id);
    if (!all && !id) throw new Error("Invalid search target");
    const payload = service === "radarr"
      ? all ? { name: "MissingMoviesSearch" } : { name: "MoviesSearch", movieIds: [id] }
      : all ? { name: "MissingEpisodeSearch" } : { name: "EpisodeSearch", episodeIds: [id] };
    await upstream(cfg.url, "/api/v3/command", { method: "POST", headers: this.keyHeader(cfg.key), body: payload, timeoutMs: this.timeoutMs });
    return { accepted: true };
  }

  private async bazarrAction(action: string, body: Record<string, any>) {
    if (action !== "search") throw new Error("Action is not allowed");
    const cfg = this.config.services.bazarr;
    const withKey = (path: string) => `${path}${path.includes("?") ? "&" : "?"}apikey=${encodeURIComponent(cfg.key)}`;
    if (body.all === true) {
      await Promise.all([
        upstream(cfg.url, withKey("/api/movies?action=search-wanted"), { method: "PATCH", timeoutMs: this.timeoutMs }),
        upstream(cfg.url, withKey("/api/series?action=search-wanted"), { method: "PATCH", timeoutMs: this.timeoutMs }),
      ]);
      return { accepted: true, scope: "all" };
    }
    const id = finite(body.id);
    if (body.kind === "movie" && id) {
      await upstream(cfg.url, withKey(`/api/movies?action=search-missing&radarrid=${id}`), { method: "PATCH", timeoutMs: this.timeoutMs });
      return { accepted: true, count: 1 };
    }
    const seriesId = finite(body.seriesId);
    const languages = Array.isArray(body.languages) ? body.languages.slice(0, 20) : [];
    if (body.kind !== "episode" || !id || !seriesId || !languages.length) throw new Error("Invalid subtitle search target");
    await Promise.all(languages.map(language => {
      const code = text(language?.code);
      if (!/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(code)) throw new Error("Invalid subtitle language");
      const path = `/api/episodes/subtitles?seriesid=${seriesId}&episodeid=${id}&language=${encodeURIComponent(code)}&forced=${language?.forced === true}&hi=${language?.hi === true}`;
      return upstream(cfg.url, withKey(path), { method: "PATCH", timeoutMs: this.timeoutMs });
    }));
    return { accepted: true, count: languages.length };
  }

  private async jellyfinAction(action: string, body: Record<string, any>) {
    const cfg = this.config.services.jellyfin; const headers = { Authorization: `MediaBrowser Token="${cfg.key}"` };
    const sessionId = identifier(body.sessionId); const libraryId = identifier(body.libraryId);
    const paths: Record<string, { path: string; payload?: unknown }> = {
      refresh: { path: "/Library/Refresh" }, refreshLibrary: { path: `/Items/${libraryId}/Refresh`, payload: { Recursive: true, ImageRefreshMode: "Default", MetadataRefreshMode: "Default", ReplaceAllImages: false, ReplaceAllMetadata: false } },
      pause: { path: `/Sessions/${sessionId}/Playing/Pause` }, resume: { path: `/Sessions/${sessionId}/Playing/Unpause` }, stop: { path: `/Sessions/${sessionId}/Playing/Stop` },
      message: { path: `/Sessions/${sessionId}/Message`, payload: { Header: "Dashboard", Text: text(body.message), TimeoutMs: 10_000 } },
    };
    if (action === "groupMessage") {
      const message = text(body.message); if (!message) throw new Error("Invalid message");
      const sessions = list(await upstream<any>(cfg.url, "/Sessions", { headers, timeoutMs: this.timeoutMs }));
      await Promise.all(sessions.map(session => upstream(cfg.url, `/Sessions/${identifier(session.Id)}/Message`, {
        method: "POST", headers, body: { Header: "Dashboard", Text: message, TimeoutMs: 10_000 }, timeoutMs: this.timeoutMs,
      })));
      return { accepted: true, count: sessions.length };
    }
    const target = paths[action]; if (!target || ((action !== "refresh") && !(sessionId || libraryId))) throw new Error("Action is not allowed");
    await upstream(cfg.url, target.path, { method: "POST", headers, body: target.payload, timeoutMs: this.timeoutMs });
    return { accepted: true };
  }
  private async seerrAction(action: string, body: Record<string, any>) {
    const cfg = this.config.services.seerr; const headers = this.keyHeader(cfg.key);
    if (action === "approve" || action === "decline") {
      const requestId = finite(body.requestId); if (!requestId) throw new Error("Invalid request");
      await upstream(cfg.url, `/api/v1/request/${requestId}/${action}`, { method: "POST", headers, timeoutMs: this.timeoutMs }); return { accepted: true };
    }
    if (action === "request") {
      const mediaType = body.mediaType === "tv" ? "tv" : body.mediaType === "movie" ? "movie" : "";
      const mediaId = finite(body.mediaId); if (!mediaType || !mediaId) throw new Error("Invalid request");
      const payload: Record<string, unknown> = { mediaType, mediaId };
      if (mediaType === "tv") {
        const seasons = Array.isArray(body.seasons) ? [...new Set(body.seasons.map(finite).filter(number => number > 0))].slice(0, 100) : [];
        if (!seasons.length) throw new Error("Select at least one season");
        payload.seasons = seasons;
      }
      await upstream(cfg.url, "/api/v1/request", { method: "POST", headers, body: payload, timeoutMs: this.timeoutMs }); return { accepted: true };
    }
    throw new Error("Action is not allowed");
  }
  private async qbitAction(action: string, body: Record<string, any>) {
    const allowed: Record<string, string> = { pause: "pause", resume: "resume", recheck: "recheck", delete: "delete" };
    if (!allowed[action]) throw new Error("Action is not allowed");
    const hashes = Array.isArray(body.hashes) ? body.hashes.map(identifier).filter(x => /^[a-f0-9]{40}$/i.test(x)).slice(0, 100) : [];
    if (!hashes.length) throw new Error("Invalid torrent selection");
    if (action === "delete" && body.confirm !== "DELETE") throw new Error("Deletion confirmation is required");
    if (action === "delete" && body.deleteFiles === true && body.confirmFiles !== "DELETE FILES") throw new Error("File deletion confirmation is required");
    const cfg = this.config.services.qbittorrent; const cookie = await this.qbitSession();
    const form = new URLSearchParams({ hashes: hashes.join("|") });
    if (action === "delete") form.set("deleteFiles", body.deleteFiles === true ? "true" : "false");
    await upstream(cfg.url, `/api/v2/torrents/${allowed[action]}`, { method: "POST", headers: { Cookie: cookie, Referer: cfg.url }, form, timeoutMs: this.timeoutMs });
    return { accepted: true, count: hashes.length };
  }
  private async adguardAction(action: string, body: Record<string, any>) {
    const cfg = this.config.services.adguard; const headers = { Authorization: `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64")}` };
    const booleanActions: Record<string, string> = { protection: "/control/protection", safeBrowsing: "/control/safebrowsing/enable", parental: "/control/parental/enable" };
    if (action === "pause") {
      const duration = finite(body.duration); if (![60, 300, 600, 1800, 3600].includes(duration)) throw new Error("Invalid pause duration");
      await upstream(cfg.url, "/control/protection", { method: "POST", headers, body: { enabled: false, duration: duration * 1000 }, timeoutMs: this.timeoutMs }); return { accepted: true };
    }
    const path = booleanActions[action]; if (!path || typeof body.enabled !== "boolean") throw new Error("Action is not allowed");
    const resolvedPath = action === "protection" ? path : body.enabled ? path : path.replace("/enable", "/disable");
    await upstream(cfg.url, resolvedPath, { method: "POST", headers, body: action === "protection" ? { enabled: body.enabled, duration: 0 } : {}, timeoutMs: this.timeoutMs });
    return { accepted: true };
  }
  private async speedtestAction(action: string) {
    if (action !== "run") throw new Error("Action is not allowed");
    const cfg = this.config.services.speedtest;
    await upstream(cfg.url, "/api/v1/speedtests/run", { method: "POST", headers: { Authorization: `Bearer ${cfg.key}` }, body: {}, timeoutMs: this.timeoutMs });
    return { accepted: true };
  }

  private async homeassistantAction(action: string, body: Record<string, any>) {
    if (action === "routine") return this.homeassistantRoutine(body);
    if (action !== "vacuum") throw new Error("Action is not allowed");
    const command = text(body.command);
    const services: Record<string, string> = { start: "start", pause: "pause", dock: "return_to_base" };
    if (!services[command]) throw new Error("Invalid vacuum command");
    const cfg = this.config.services.homeassistant;
    const headers = { Authorization: `Bearer ${cfg.key}` };
    const states = list(await upstream<any>(cfg.url, "/api/states", { headers, timeoutMs: this.timeoutMs }));
    const vacuum = states.find(entity => text(entity.entity_id).startsWith("vacuum."));
    const entityId = identifier(vacuum?.entity_id);
    if (!entityId) throw new Error("No vacuum is available");
    await upstream(cfg.url, `/api/services/vacuum/${services[command]}`, { method: "POST", headers, body: { entity_id: entityId }, timeoutMs: this.timeoutMs });
    return { accepted: true };
  }

  private async homeassistantRoutine(body: Record<string, any>) {
    const name = text(body.name);
    if (!["acOn", "acOff", "mortienToggle"].includes(name)) throw new Error("Invalid Home Assistant routine");
    const cfg = this.config.services.homeassistant;
    const headers = { Authorization: `Bearer ${cfg.key}` };
    const states = list(await upstream<any>(cfg.url, "/api/states", { headers, timeoutMs: this.timeoutMs }));
    const friendly = (entity: Record<string, any>) => text(entity.attributes?.friendly_name);
    const find = (domain: string, expected: RegExp) => states.find(entity => text(entity.entity_id).startsWith(`${domain}.`) && expected.test(friendly(entity)));
    const entity = name === "acOn" ? find("scene", /^turn on ac$/i)
      : name === "acOff" ? find("scene", /^turn off ac$/i)
        : find("switch", /^mortien$/i);
    const entityId = identifier(entity?.entity_id);
    if (!entityId) throw new Error("Home Assistant routine is unavailable");
    const service = name === "mortienToggle" ? (text(entity?.state) === "on" ? "turn_off" : "turn_on") : "turn_on";
    const domain = name === "mortienToggle" ? "switch" : "scene";
    await upstream(cfg.url, `/api/services/${domain}/${service}`, { method: "POST", headers, body: { entity_id: entityId }, timeoutMs: this.timeoutMs });
    return { accepted: true };
  }

  private async prowlarrAction(action: string) {
    if (action !== "sync") throw new Error("Action is not allowed");
    const cfg = this.config.services.prowlarr;
    await upstream(cfg.url, "/api/v1/command", { method: "POST", headers: this.keyHeader(cfg.key), body: { name: "ApplicationIndexerSync" }, timeoutMs: this.timeoutMs });
    return { accepted: true };
  }
}
