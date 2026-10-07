(() => {
  "use strict";

  const API = "/api/widget-gateway/v1";
  const services = [
    "calendar", "jellyfin", "immich", "seerr", "radarr", "sonarr", "bazarr",
    "prowlarr", "qbittorrent", "tdarr", "proxmox", "adguard", "speedtest",
    "authentik", "homeassistant", "dockhand",
  ];
  const labels = {
    qbittorrent: "qBittorrent",
    calendar: "Media Calendar",
    homeassistant: "Home Assistant",
    authentik: "Authentik",
    dockhand: "Dockhand",
  };
  const state = new WeakMap();
  const refreshTimers = new WeakMap();

  const escapeHtml = (value) => String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");

  const formatBytes = (value) => {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) return "—";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let scaled = amount; let index = 0;
    while (scaled >= 1024 && index < units.length - 1) { scaled /= 1024; index += 1; }
    return `${scaled.toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
  };

  const formatValue = (value, key = "") => {
    if (value === null || value === undefined || value === "") return "—";
    if (typeof value === "boolean") return value ? "On" : "Off";
    if (typeof value === "number") {
      if (/usage|storage|memory|size|free|network|download|upload/i.test(key) && value >= 1024) {
        return formatBytes(value);
      }
      if (/cpu|progress|blockedPct/i.test(key)) return `${value.toFixed(1)}%`;
      return value.toLocaleString();
    }
    return escapeHtml(value);
  };

  function cardFor(id) {
    const direct = document.getElementById(`widget-${id}`);
    if (direct) return direct.closest("li") || direct;
    const expected = (labels[id] || id).toLowerCase();
    return Array.from(document.querySelectorAll(".service-card")).map(card => card.closest("li") || card)
      .find(card => (card.querySelector(".service-name")?.textContent || "").trim().toLowerCase() === expected);
  }

  function nativeCardFor(item) {
    if (!item) return null;
    return item.matches(".service-card") ? item : item.querySelector(".service-card");
  }

  const iconPaths = {
    activity: "M4 12h3l2-6 4 12 2-6h5",
    calendar: "M5 3v3m10-3v3M4 8h16M5 5h14a1 1 0 0 1 1 1v14H4V6a1 1 0 0 1 1-1Z",
    check: "m5 12 4 4L19 6",
    clock: "M12 7v5l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
    database: "M4 6c0-2 16-2 16 0v12c0 2-16 2-16 0V6Zm0 0c0 2 16 2 16 0M4 12c0 2 16 2 16 0",
    download: "M12 3v12m-5-5 5 5 5-5M5 21h14",
    film: "M4 5h16v14H4V5Zm4 0v14m8-14v14M4 9h4m8 0h4M4 15h4m8 0h4",
    globe: "M3 12h18M12 3a15 15 0 0 1 0 18m0-18a15 15 0 0 0 0 18M4.5 7h15m-15 10h15",
    message: "M4 5h16v12H8l-4 4V5Z",
    pause: "M8 5v14m8-14v14",
    play: "m8 5 11 7-11 7V5Z",
    refresh: "M20 7v5h-5M4 17v-5h5m10.5-4A8 8 0 0 0 6 6l-2 6m16 0-2 6a8 8 0 0 1-13.5-1",
    search: "m21 21-4.4-4.4m2.4-5.1a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z",
    server: "M4 4h16v6H4V4Zm0 10h16v6H4v-6Zm3-7h.01M7 17h.01",
    shield: "M12 3 20 6v5c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10V6l8-3Z",
    stop: "M6 6h12v12H6z",
    upload: "M12 21V9m-5 5 5-5 5 5M5 3h14",
    users: "M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m7-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8 4a4 4 0 0 1 4 4v2m-3-10a4 4 0 0 0 0-8",
    warning: "M12 3 2 21h20L12 3Zm0 6v5m0 3h.01",
    x: "m6 6 12 12M18 6 6 18",
  };

  const icon = (name) => `<svg class="wg-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${iconPaths[name] || iconPaths.activity}"/></svg>`;
  const list = (value) => Array.isArray(value) ? value : [];
  const pct = (value, total = 1) => Math.max(0, Math.min(100, total ? Number(value || 0) / Number(total) * 100 : 0));
  const titleCase = (value) => String(value || "").replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").replace(/\b\w/g, char => char.toUpperCase());
  const formatDate = (value, includeTime = false) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Date unavailable";
    return new Intl.DateTimeFormat(undefined, includeTime
      ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric", year: date.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined }).format(date);
  };
  const formatResultTime = (value) => {
    const date = new Date(String(value || "").replace(" ", "T"));
    if (Number.isNaN(date.getTime())) return "Last test unavailable";
    const today = new Date();
    const sameDay = date.toDateString() === today.toDateString();
    const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
    return `Last test ${sameDay ? "today" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date)}, ${time}`;
  };
  const dateKey = (value) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };
  const arrEpisodeTitle = (item) => [item.showTitle, item.episodeNumber, item.episodeTitle]
    .filter(Boolean).join(" · ") || item.title || "Untitled episode";
  const formatDuration = (seconds) => {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value <= 0) return "—";
    const days = Math.floor(value / 86400); const hours = Math.floor(value % 86400 / 3600);
    return days ? `${days}d ${hours}h` : `${hours}h ${Math.floor(value % 3600 / 60)}m`;
  };
  const empty = (message) => `<div class="wg-empty-state">${icon("check")}<span>${escapeHtml(message)}</span></div>`;
  const badge = (label, tone = "neutral") => `<span class="wg-badge wg-${tone}">${escapeHtml(label)}</span>`;
  const progress = (value, tone = "cyan") => `<span class="wg-progress"><i class="wg-progress-${tone}" style="width:${Math.max(0, Math.min(100, Number(value) || 0))}%"></i></span>`;
  const stat = (label, value, iconName = "activity", tone = "cyan", note = "") => `
    <div class="wg-stat wg-tone-${tone}">${icon(iconName)}<span><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong>${note ? `<em>${escapeHtml(note)}</em>` : ""}</span></div>`;
  const section = (title, body, iconName = "activity", note = "", actions = "") => `
    <section class="wg-section"><div class="wg-section-head">${icon(iconName)}<span><h4>${escapeHtml(title)}</h4>${note ? `<small>${escapeHtml(note)}</small>` : ""}</span>${actions ? `<span class="wg-section-actions">${actions}</span>` : ""}</div>${body}</section>`;
  const switchSection = (kind, title, note, body, iconName, views, active, extra = "") => `
    <section class="wg-section wg-switch-section"><div class="wg-section-head">${icon(iconName)}<button type="button" class="wg-section-cycle" data-${kind}-cycle title="Click to cycle views"><h4>${escapeHtml(title)}</h4><small>${escapeHtml(note)}</small></button>
      <span class="wg-section-actions"><span class="wg-view-tabs">${views.map(view => `<button type="button" class="${view.id === active ? "is-active" : ""}" data-${kind}-view="${escapeHtml(view.id)}">${escapeHtml(view.label)}</button>`).join("")}</span>${extra}</span></div>${body}</section>`;
  const actionButton = (service, action, label, payload = {}, options = {}) => `
    <button type="button" class="wg-action wg-action-${options.tone || "primary"}" data-service="${service}" data-action="${action}"
      data-payload="${escapeHtml(JSON.stringify(payload))}">${icon(options.icon || "activity")}<span>${escapeHtml(label)}</span></button>`;
  const pagedList = (items, render, name, emptyMessage) => {
    if (!items.length) return empty(emptyMessage);
    const pages = Math.ceil(items.length / 5);
    const rows = items.map((item, index) => `<div data-page-item ${index >= 5 ? "hidden" : ""}>${render(item)}</div>`).join("");
    return `<div class="wg-paged-list" data-paged-list="${escapeHtml(name)}" data-page="1" data-pages="${pages}">${rows}
      <div class="wg-pagination" ${pages === 1 ? "hidden" : ""}><button type="button" data-page-direction="-1" disabled>Previous</button><span>Page 1 of ${pages}</span><button type="button" data-page-direction="1">Next</button></div></div>`;
  };
  const availabilityMark = (available) => `<span class="wg-availability wg-availability-${available ? "yes" : "no"}" title="${available ? "Available" : "Waiting for download"}" aria-label="${available ? "Available" : "Missing"}">${icon(available ? "check" : "download")}</span>`;
  const seerrRequestUrl = (id) => {
    const href = nativeCardFor(cardFor("seerr"))?.querySelector("a[href]")?.href;
    if (!href) return "#";
    const url = new URL(href, window.location.origin);
    url.pathname = `/requests/${encodeURIComponent(id)}`;
    url.search = "";
    url.hash = "";
    return url.href;
  };
  const arrReleaseUrl = (source, slug) => {
    const href = nativeCardFor(cardFor(source))?.querySelector("a[href]")?.href;
    if (!href || !slug) return "";
    const url = new URL(href, window.location.origin);
    url.pathname = `/${source === "radarr" ? "movie" : "series"}/${encodeURIComponent(slug)}`;
    url.search = "";
    url.hash = "";
    return url.href;
  };

  const statusTone = (status) => /running|active|enabled|available|approved|ok|completed|continuing/i.test(String(status))
    ? "success" : /pending|queued|paused|processing|unknown|warn/i.test(String(status)) ? "warning" : /failed|error|declined|stopped|deleted|disabled/i.test(String(status)) ? "danger" : "neutral";

  function jellyfinView(data) {
    const counts = data.counts || {}; const sessions = list(data.sessions);
    const sessionsBody = sessions.map(session => {
      const played = pct(session.positionTicks, session.runtimeTicks);
      return `<article class="wg-media-row"><div class="wg-row-main"><span class="wg-avatar">${icon("play")}</span><span><strong>${escapeHtml(session.series || session.item)}</strong>
        ${session.series ? `<small>${escapeHtml(session.item)}</small>` : ""}<small>${escapeHtml(session.user)} · ${escapeHtml(session.device || session.client)}</small></span>
        ${badge(session.paused ? "Paused" : "Playing", session.paused ? "warning" : "success")}</div>
        <div class="wg-playback">${progress(played)}<small>${Math.round(played)}%</small></div>
        <div class="wg-inline-actions">${actionButton("jellyfin", session.paused ? "resume" : "pause", session.paused ? "Resume" : "Pause", { sessionId: session.id }, { icon: session.paused ? "play" : "pause" })}
          ${actionButton("jellyfin", "stop", "Stop", { sessionId: session.id }, { icon: "stop", tone: "danger" })}</div>
        <label class="wg-message-box">${icon("message")}<input data-session-message="${escapeHtml(session.id)}" maxlength="500" placeholder="Message ${escapeHtml(session.user)}"><button type="button" data-send-session="${escapeHtml(session.id)}">Send</button></label></article>`;
    }).join("") || empty("Nothing is playing right now.");
    return `<div class="wg-stat-grid">${stat("Movies", Number(counts.movies || 0).toLocaleString(), "film", "violet")}${stat("Series", Number(counts.series || 0).toLocaleString(), "film", "cyan")}
      ${stat("Episodes", Number(counts.episodes || 0).toLocaleString(), "play", "blue")}${stat("Active streams", String(sessions.length), "users", sessions.length ? "green" : "slate")}</div>
      ${section("Now playing", sessionsBody, "play", `${sessions.length} active`, actionButton("jellyfin", "refresh", "Scan libraries", {}, { icon: "refresh" }))}`;
  }

  function immichView(data) {
    const totals = data.totals || {}; const users = list(data.users);
    const mediaTotal = Number(totals.photoUsage || 0) + Number(totals.videoUsage || 0);
    const userRows = pagedList(users, user => {
      const quota = Number(user.quotaSize || 0); const usage = Number(user.usage || 0);
      return `<div class="wg-list-row wg-list-stack"><span><strong>${escapeHtml(user.name || "User")}</strong><b>${formatBytes(usage)}</b></span>
        ${quota > 0 ? `${progress(pct(usage, quota), usage > quota ? "red" : "cyan")}<small>${Math.round(pct(usage, quota))}% of ${formatBytes(quota)} · ${Number(user.photos || 0).toLocaleString()} photos · ${Number(user.videos || 0).toLocaleString()} videos</small>` :
        `<small>${Number(user.photos || 0).toLocaleString()} photos · ${Number(user.videos || 0).toLocaleString()} videos</small>`}</div>`;
    }, "immich-users", "No user storage records were returned.");
    return `<div class="wg-stat-grid">${stat("Total storage", formatBytes(totals.usage), "database", "violet")}${stat("Photos", Number(totals.photos || 0).toLocaleString(), "film", "cyan")}
      ${stat("Videos", Number(totals.videos || 0).toLocaleString(), "play", "blue")}${stat("Users", String(users.length), "users", "green")}</div>
      ${section("Storage mix", `<div class="wg-split-bar"><i style="width:${pct(totals.photoUsage, mediaTotal)}%"></i><b></b></div>
        <div class="wg-legend"><span><i class="wg-dot-photo"></i>Photos <b>${formatBytes(totals.photoUsage)}</b></span><span><i class="wg-dot-video"></i>Videos <b>${formatBytes(totals.videoUsage)}</b></span></div>`, "database")}
      ${section("User storage", userRows, "users", `${users.length} accounts`)}`;
  }

  const requestStatus = (value) => ({ 1: "Pending", 2: "Approved", 3: "Declined", 4: "Processing", 5: "Available" })[Number(value)] || "Unknown";
  function seerrView(data) {
    const requests = list(data.requests); const pending = requests.filter(item => Number(item.status) === 1);
    const requestRow = (request, actionable = false) => `<div class="wg-list-row wg-request-row"><a href="${escapeHtml(seerrRequestUrl(request.id))}" target="_blank" rel="noopener noreferrer">
      ${request.posterPath ? `<img src="https://image.tmdb.org/t/p/w92${escapeHtml(request.posterPath)}" alt="">` : icon(request.type === "tv" ? "play" : "film")}
      <span><strong>${escapeHtml(request.title === "Media request" ? titleCase(`${request.type} request`) : request.title)}</strong>
      <small>Requested by ${escapeHtml(request.requestedBy || "Unknown")} · ${formatDate(request.createdAt)}</small></span></a>
      <span class="wg-row-end">${badge(requestStatus(request.status), statusTone(requestStatus(request.status)))}
      ${actionable ? `${actionButton("seerr", "approve", "Approve", { requestId: request.id }, { icon: "check", tone: "success" })}${actionButton("seerr", "decline", "Decline", { requestId: request.id }, { icon: "x", tone: "danger" })}` : ""}</span></div>`;
    return `<div class="wg-search-panel"><label class="wg-search">${icon("search")}<input type="search" minlength="2" maxlength="100" placeholder="Search for a movie or series"><button type="button" data-search>Search</button></label><div class="wg-search-results"></div></div>
      <div class="wg-seerr-requests">${section("Requests", pagedList(requests, item => requestRow(item, Number(item.status) === 1), "seerr-requests", "No requests found."), "warning", `${pending.length} awaiting review`)}</div>`;
  }

  function arrView(id, data) {
    const missing = list(data.missing); const queue = list(data.queue); const library = list(data.library);
    const monitored = library.filter(item => item.monitored).length;
    const missingRow = item => {
      const title = id === "sonarr" ? arrEpisodeTitle(item) : item.title || "Untitled";
      return `<div class="wg-list-row"><span>${icon("warning")}<span><strong>${escapeHtml(title)}</strong><small>${item.airDateUtc ? `Expected ${formatDate(item.airDateUtc)}` : "Release date unavailable"}</small></span></span>
        ${actionButton(id, "search", "Search", { id: item.id }, { icon: "search", tone: "success" })}</div>`;
    };
    const searchAll = actionButton(id, "search", "Search all", { all: true }, { icon: "search", tone: "success" });
    const focus = section("Missing & wanted", pagedList(missing, missingRow, `${id}-missing`, `No missing ${id === "radarr" ? "movies" : "episodes"}.`), "warning", `${missing.length} records`, searchAll);
    return `<div class="wg-stat-grid">${stat(id === "radarr" ? "Movies" : "Series", library.length.toLocaleString(), "film", "violet")}${stat("Monitored", monitored.toLocaleString(), "activity", "cyan")}
      ${stat("Missing", missing.length.toLocaleString(), "warning", missing.length ? "amber" : "green")}${stat("Queued", queue.length.toLocaleString(), "download", queue.length ? "blue" : "slate")}</div>${focus}`;
  }

  function bazarrView(data) {
    const wantedMovies = list(data.wantedMovies); const wantedEpisodes = list(data.wantedEpisodes);
    const missingLibraries = [...list(data.movies), ...list(data.series)].filter(item => Number(item.missing) > 0);
    const wanted = [...wantedMovies.map(item => ({ ...item, kind: "Movie" })), ...wantedEpisodes.map(item => ({ ...item, kind: "Episode" }))];
    const recordsBody = pagedList(wanted, item => {
      const kind = item.kind === "Movie" ? "movie" : "episode";
      const subtitleCount = list(item.missingSubtitles).length;
      return `<div class="wg-list-row"><span>${icon("warning")}<span><strong>${escapeHtml(item.title || "Untitled")}</strong><small>${escapeHtml(item.episodeTitle ? `${item.episode} · ${item.episodeTitle}` : item.kind)} · ${subtitleCount} missing</small></span></span>
        ${actionButton("bazarr", "search", "Search", { id: item.id, seriesId: item.seriesId, kind, languages: item.missingSubtitles }, { icon: "search", tone: "success" })}</div>`;
    }, "bazarr-wanted", "No subtitles are currently wanted.");
    return `<div class="wg-stat-grid">${stat("Wanted", String(wanted.length), "warning", wanted.length ? "amber" : "green")}${stat("Affected titles", String(missingLibraries.length), "film", missingLibraries.length ? "amber" : "slate")}
      ${stat("Movie requests", String(wantedMovies.length), "film", "violet")}${stat("Episode requests", String(wantedEpisodes.length), "play", "blue")}</div>
      ${section("Wanted subtitles", recordsBody, "warning", `${wanted.length} records`, actionButton("bazarr", "search", "Search all", { all: true }, { icon: "search", tone: "success" }))}`;
  }

  function prowlarrView(data) {
    const stats = data.statistics || {}; const indexers = list(data.indexers); const perIndexer = list(data.perIndexer);
    const statFor = name => perIndexer.find(item => item.name === name);
    const indexerBody = pagedList(indexers, item => {
      const performance = statFor(item.name);
      const sub = item.failing
        ? `Cooling down${item.disabledTill ? ` until ${formatDate(item.disabledTill, true)}` : ""}`
        : `${titleCase(item.protocol)} · ${Number(performance?.grabs || 0).toLocaleString()} grabs`;
      return `<div class="wg-list-row"><span>${icon(item.failing ? "warning" : "globe")}<span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(sub)}</small></span></span>${badge(item.failing ? "Failing" : item.enabled ? "Enabled" : "Disabled", item.failing ? "warning" : item.enabled ? "success" : "danger")}</div>`;
    }, "prowlarr-indexers", "No indexers configured.");
    const failing = indexers.filter(item => item.failing).length;
    return `<div class="wg-stat-grid">${stat("Queries", Number(stats.queries || 0).toLocaleString(), "search", "cyan")}${stat("Grabs", Number(stats.grabs || 0).toLocaleString(), "download", "green")}
      ${stat("Failing now", String(failing), "warning", failing ? "red" : "slate")}${stat("Failed grabs", Number(stats.failedGrabs || 0).toLocaleString(), "warning", stats.failedGrabs ? "red" : "slate")}</div>
      ${section("Indexer health", indexerBody, "globe", `${indexers.filter(item => item.enabled).length} of ${indexers.length} enabled`, actionButton("prowlarr", "sync", "Sync apps", {}, { icon: "refresh" }))}`;
  }

  function qbitView(data) {
    const transfer = data.transfer || {}; const torrents = list(data.torrents);
    const torrentsBody = torrents.map(item => `<article class="wg-torrent-row"><input type="checkbox" class="wg-torrent" value="${escapeHtml(item.hash)}" aria-label="Select ${escapeHtml(item.name)}">
      <span class="wg-row-copy"><span><strong>${escapeHtml(item.name)}</strong>${badge(titleCase(item.state), statusTone(item.state))}</span>${progress(Number(item.progress || 0) * 100)}
      <small>${Math.round(Number(item.progress || 0) * 100)}% · ${formatBytes(item.size)} · ↓ ${formatBytes(item.dlspeed)}/s · ↑ ${formatBytes(item.upspeed)}/s</small></span></article>`).join("") || empty("No torrents are currently loaded.");
    return `<div class="wg-stat-grid">${stat("Download", `${formatBytes(transfer.download)}/s`, "download", "cyan")}${stat("Upload", `${formatBytes(transfer.upload)}/s`, "upload", "violet")}
      ${stat("Free space", formatBytes(transfer.freeSpace), "database", "green")}${stat("Torrents", String(torrents.length), "activity", "blue")}</div>
      <div class="wg-toolbar">${actionButton("qbittorrent", "pause", "Pause", {}, { icon: "pause" })}${actionButton("qbittorrent", "resume", "Resume", {}, { icon: "play", tone: "success" })}
      ${actionButton("qbittorrent", "recheck", "Recheck", {}, { icon: "refresh" })}${actionButton("qbittorrent", "delete", "Delete", {}, { icon: "x", tone: "danger" })}<small>Select torrents below first</small></div>
      ${section("Torrent activity", `<div class="wg-user-list">${torrentsBody}</div>`, "download", "Live speed and progress")}`;
  }

  function tdarrView(data) {
    const stats = data.statistics || {}; const queue = data.queue || {}; const nodes = list(data.nodes);
    const nodesBody = nodes.map(node => `<div class="wg-list-row"><span>${icon("server")}<span><strong>${escapeHtml(node.name)}</strong><small>${Number(node.workers || 0)} workers</small></span></span>${badge(node.paused ? "Paused" : titleCase(node.status || "Online"), node.paused ? "warning" : statusTone(node.status || "active"))}</div>`).join("") || empty("No Tdarr nodes are reporting.");
    return `<div class="wg-stat-grid">${stat("Files scanned", Number(stats.files || 0).toLocaleString(), "film", "violet")}${stat("Transcoded", Number(stats.transcoded || 0).toLocaleString(), "check", "green")}
      ${stat("Transcode queue", Number(queue.transcode || 0).toLocaleString(), "activity", queue.transcode ? "blue" : "slate")}${stat("Errors", Number(queue.errors || 0).toLocaleString(), "warning", queue.errors ? "red" : "slate")}</div>
      ${section("Worker nodes", nodesBody, "server", `${nodes.length} connected`)}`;
  }

  function calendarView(data, requestedMonth = new Date()) {
    const events = list(data.events).filter(item => Number.isFinite(Date.parse(item.date)))
      .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    const today = new Date();
    const monthStart = new Date(requestedMonth.getFullYear(), requestedMonth.getMonth(), 1);
    const gridStart = new Date(monthStart);
    const leadingDays = (gridStart.getDay() + 6) % 7;
    gridStart.setDate(gridStart.getDate() - leadingDays);
    const cells = Math.ceil((leadingDays + new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate()) / 7) * 7;
    const eventCounts = events.reduce((counts, item) => {
      const key = dateKey(item.date);
      counts[key] ||= { total: 0, radarr: 0, sonarr: 0 };
      counts[key].total += 1;
      counts[key][item.source] += 1;
      return counts;
    }, {});
    const currentMonth = today.getFullYear() === monthStart.getFullYear() && today.getMonth() === monthStart.getMonth();
    const firstRelease = events.find(item => {
      const date = new Date(item.date);
      return date.getFullYear() === monthStart.getFullYear() && date.getMonth() === monthStart.getMonth();
    });
    const selected = currentMonth ? dateKey(today) : dateKey(firstRelease?.date || monthStart);
    const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
      .map(day => `<span class="wg-calendar-weekday">${day}</span>`).join("");
    const days = Array.from({ length: cells }, (_, index) => {
      const date = new Date(gridStart);
      date.setDate(gridStart.getDate() + index);
      const key = dateKey(date);
      const count = eventCounts[key] || { total: 0, radarr: 0, sonarr: 0 };
      const indicators = `${count.radarr ? `<i class="wg-calendar-dot wg-calendar-radarr" title="${count.radarr} Radarr"></i>` : ""}${count.sonarr ? `<i class="wg-calendar-dot wg-calendar-sonarr" title="${count.sonarr} Sonarr"></i>` : ""}`;
      if (date.getMonth() !== monthStart.getMonth()) return `<span class="wg-calendar-day wg-calendar-outside" aria-disabled="true" aria-label="${escapeHtml(formatDate(date))}, ${count.total} releases">
        <span>${date.getDate()}</span>${count.total ? `<b>${count.total}</b><span class="wg-calendar-dots">${indicators}</span>` : ""}</span>`;
      const classes = [
        "wg-calendar-day",
        key === dateKey(today) ? "wg-calendar-today" : "",
        key === selected ? "wg-calendar-selected" : "",
      ].filter(Boolean).join(" ");
      return `<button type="button" class="${classes}" data-calendar-date="${key}" aria-label="${escapeHtml(formatDate(date))}, ${count.total} releases">
        <span>${date.getDate()}</span>${count.total ? `<b>${count.total}</b><span class="wg-calendar-dots">${indicators}</span>` : ""}</button>`;
    }).join("");
    return `<section class="wg-calendar-shell">
      <div class="wg-calendar-head"><span>${icon("calendar")}<span><h4>${escapeHtml(new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(monthStart))}</h4></span></span>
        <span class="wg-calendar-controls"><button type="button" data-calendar-nav="-1" aria-label="Previous month">‹</button><button type="button" data-calendar-today>Today</button><button type="button" data-calendar-nav="1" aria-label="Next month">›</button></span></div>
      <div class="wg-calendar-grid">${weekdays}${days}</div>
      <div class="wg-calendar-releases" data-calendar-releases>${calendarReleases(events, selected)}</div>
    </section>`;
  }

  function calendarReleases(events, selected) {
    const releases = events.filter(item => dateKey(item.date) === selected);
    const heading = formatDate(`${selected}T12:00:00`);
    const body = releases.map(item => {
      const title = item.type === "episode" ? arrEpisodeTitle(item) : item.title || "Untitled movie";
      const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(item.date));
      const source = item.source === "radarr" ? "radarr" : "sonarr";
      const availability = availabilityMark(item.available);
      const releaseUrl = arrReleaseUrl(source, item.slug);
      const content = `<span>${icon(item.type === "movie" ? "film" : "play")}<span><strong>${escapeHtml(title)}</strong><small>${badge(titleCase(source), source)} ${availability}</small></span></span><time>${escapeHtml(time)}</time>`;
      return releaseUrl
        ? `<a class="wg-list-row wg-calendar-release wg-calendar-release-${source} wg-release-link" href="${escapeHtml(releaseUrl)}" target="_blank" rel="noopener noreferrer" title="Open in ${titleCase(source)}">${content}</a>`
        : `<div class="wg-list-row wg-calendar-release wg-calendar-release-${source}">${content}</div>`;
    }).join("") || empty("No Sonarr or Radarr releases on this date.");
    return section(heading, body, "calendar", `${releases.length} release${releases.length === 1 ? "" : "s"}`);
  }

  function adguardView(data) {
    const stats = data.statistics || {}; const controls = data.controls || {};
    const control = (name, enabled, action, label) => `<div class="wg-control-row"><span>${icon("shield")}<span><strong>${escapeHtml(name)}</strong><small>${enabled ? "Active and protecting traffic" : "Currently turned off"}</small></span></span>
      <span>${actionButton("adguard", action, enabled ? "Turn off" : "Turn on", { enabled: !enabled }, { icon: enabled ? "x" : "check", tone: enabled ? "danger" : "success" })}</span></div>`;
    const pauseRemaining = Number(controls.pauseRemainingMs || 0);
    const pauseControl = pauseRemaining > 0
      ? `<span class="wg-compact-actions"><small data-adguard-countdown data-pause-until="${Date.now() + pauseRemaining}">Paused</small>${actionButton("adguard", "protection", "Enable now", { enabled: true }, { icon: "play", tone: "success" })}</span>`
      : `<span class="wg-compact-actions"><select class="wg-compact-select" data-adguard-duration aria-label="Pause duration"><option value="60">1 min</option><option value="300" selected>5 min</option><option value="600">10 min</option><option value="1800">30 min</option><option value="3600">1 hour</option></select><button type="button" class="wg-action wg-action-warning" data-adguard-pause>${icon("pause")}<span>Pause</span></button></span>`;
    return `<div class="wg-stat-grid">${stat("DNS queries", Number(stats.queries || 0).toLocaleString(), "activity", "cyan")}${stat("Blocked", Number(stats.blocked || 0).toLocaleString(), "shield", "green")}
      ${stat("Block rate", `${Number(stats.blockedPct || 0).toFixed(1)}%`, "warning", "violet")}${stat("Average response", `${(Number(stats.latency || 0) * 1000).toFixed(1)} ms`, "clock", "blue")}</div>
      ${section("Protection controls", `${control("DNS protection", !!controls.protection, "protection")}${control("Safe browsing", !!controls.safeBrowsing, "safeBrowsing")}${control("Parental filtering", !!controls.parental, "parental")}
        <div class="wg-control-row"><span>${icon("clock")}<span><strong>Temporary pause</strong><small>${pauseRemaining > 0 ? "Protection resumes automatically" : "Choose how long to disable protection"}</small></span></span>${pauseControl}</div>`, "shield", "Changes apply immediately")}`;
  }

  function authentikView(data) {
    const activity = data.activity || {}; const users = list(data.users); const outposts = list(data.outposts);
    const outpostBody = outposts.map(outpost => `<div class="wg-list-row"><span>${icon("shield")}<span><strong>${escapeHtml(outpost.name || "Outpost")}</strong><small>${escapeHtml(titleCase(outpost.type || "proxy"))}</small></span></span>${badge(outpost.managed ? "Managed" : "Configured", "neutral")}</div>`).join("") || empty("No outposts were returned.");
    return `<div class="wg-stat-grid">${stat("Successful logins", Number(activity.logins || 0).toLocaleString(), "check", "green")}${stat("Failed logins", Number(activity.failed || 0).toLocaleString(), "warning", activity.failed ? "red" : "slate")}
      ${stat("Active users", String(users.length), "users", "cyan")}${stat("Outposts", String(outposts.length), "shield", "violet")}</div>
      ${section("Outposts", outpostBody, "shield", "Configured access gateways")}`;
  }

  function homeassistantView(data, view = "controls") {
    const metrics = data.metrics || {}; const system = data.system || {}; const vacuum = data.vacuum || {}; const routines = data.routines || {};
    const problems = list(data.problems); const media = list(data.activeMedia); const people = list(data.people); const peopleHome = people.filter(person => person.state === "home");
    const vacuumState = titleCase(vacuum.state || "Unavailable");
    const vacuumTone = /clean|return/i.test(vacuum.state) ? "cyan" : /error|unavailable/i.test(vacuum.state) ? "red" : "green";
    const vacuumActions = /cleaning|returning/i.test(String(vacuum.state))
      ? `${actionButton("homeassistant", "vacuum", "Pause", { command: "pause" }, { icon: "pause" })}${actionButton("homeassistant", "vacuum", "Dock", { command: "dock" }, { icon: "server" })}`
      : `${actionButton("homeassistant", "vacuum", /paused/i.test(String(vacuum.state)) ? "Resume" : "Start", { command: "start" }, { icon: "play", tone: "success" })}${!/docked/i.test(String(vacuum.state)) ? actionButton("homeassistant", "vacuum", "Dock", { command: "dock" }, { icon: "server" }) : ""}`;
    const vacuumNote = [vacuum.activity && titleCase(vacuum.activity), Number(vacuum.battery) ? `${Number(vacuum.battery)}% battery` : "", Number(vacuum.progress) ? `${Number(vacuum.progress)}% complete` : ""].filter(Boolean).join(" · ");
    const routineButton = (name, label, options) => actionButton("homeassistant", "routine", label, { name }, options);
    const controlRows = `<div class="wg-control-row"><span>${icon("activity")}<span><strong>Air conditioner</strong><small>Run the saved Home Assistant scenes</small></span></span><span class="wg-compact-actions">${routines.acOn?.available ? routineButton("acOn", "On", { icon: "play", tone: "success" }) : ""}${routines.acOff?.available ? routineButton("acOff", "Off", { icon: "stop", tone: "danger" }) : ""}</span></div>
      <div class="wg-control-row"><span>${icon("shield")}<span><strong>Mortien</strong><small>${titleCase(routines.mortien?.state || "Unavailable")}</small></span></span>${routines.mortien?.available ? routineButton("mortienToggle", routines.mortien.state === "on" ? "Turn off" : "Turn on", { icon: routines.mortien.state === "on" ? "x" : "play", tone: routines.mortien.state === "on" ? "danger" : "success" }) : badge("Unavailable", "warning")}</div>`;
    const vacuumRows = `<div class="wg-control-row"><span>${icon("activity")}<span><strong>${escapeHtml(vacuum.name || "Robot vacuum")}</strong><small>${escapeHtml(vacuumNote || vacuumState)}</small></span></span><span class="wg-compact-actions">${vacuumActions}</span></div>
      <div class="wg-kv-grid"><span>State <b>${escapeHtml(vacuumState)}</b></span><span>Battery <b>${Number(vacuum.battery || 0)}%</b></span><span>Progress <b>${Number(vacuum.progress || 0)}%</b></span><span>Area <b>${Number(vacuum.cleaningArea || 0).toLocaleString()}</b></span></div>`;
    const statusRows = `${people.map(person => `<div class="wg-list-row"><span>${icon("users")}<span><strong>${escapeHtml(person.name)}</strong><small>${person.state === "home" ? "At home" : escapeHtml(titleCase(person.state))}</small></span></span>${badge(person.state === "home" ? "Home" : "Away", person.state === "home" ? "success" : "neutral")}</div>`).join("")}
      ${media.map(item => `<div class="wg-list-row"><span>${icon("play")}<span><strong>${escapeHtml(item.title || item.name)}</strong><small>${escapeHtml([item.artist, item.app, item.name].filter(Boolean).join(" · "))}</small></span></span>${badge(titleCase(item.state), "success")}</div>`).join("")}
      ${problems.map(item => `<div class="wg-list-row"><span>${icon("warning")}<span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(titleCase(item.kind))}</small></span></span>${badge("Needs attention", "danger")}</div>`).join("")}` || empty("No people, active media, or home alerts were returned.");
    const views = [{ id: "controls", label: "Controls" }, { id: "vacuum", label: "Vacuum" }, { id: "status", label: "Status" }];
    const viewBody = view === "vacuum" ? vacuumRows : view === "status" ? statusRows : controlRows;
    const viewTitle = view === "vacuum" ? "Vacuum" : view === "status" ? "Home status" : "Quick controls";
    return `<div class="wg-stat-grid">${stat("People home", String(peopleHome.length), "users", peopleHome.length ? "green" : "slate", peopleHome.map(person => person.name).join(", ") || "Everyone away")}${stat("Lights on", String(Number(metrics.lightsOn || 0)), "activity", metrics.lightsOn ? "amber" : "slate")}
      ${stat("Switches on", String(Number(metrics.switchesOn || 0)), "shield", metrics.switchesOn ? "cyan" : "slate")}${stat("Home alerts", String(problems.length), "warning", problems.length ? "red" : "green", `${Number(data.serverTodos || 0)} server tasks`)}</div>
      ${switchSection("ha", viewTitle, `${Number(metrics.automations || 0)} automations · HA ${system.version || "—"}`, viewBody, "activity", views, view)}`;
  }

  function dockhandView(data) {
    const environments = list(data.environments); const updates = data.updates || {};
    const body = environments.map(environment => {
      const containers = environment.containers || {}; const metrics = environment.metrics || {}; const stacks = environment.stacks || {};
      return `<div class="wg-stat-grid">${stat("CPU", `${Number(metrics.cpuPercent || 0).toFixed(1)}%`, "activity", "cyan")}${stat("Memory", `${Number(metrics.memoryPercent || 0).toFixed(1)}%`, "database", "violet", `${formatBytes(metrics.memoryUsed)} used`)}
        ${stat("Stacks", `${Number(stacks.running || 0)} / ${Number(stacks.total || 0)}`, "server", "green")}${stat("Containers", String(containers.total || 0), "server", "blue")}</div>
        <div class="wg-kv-grid"><span>Running <b>${Number(containers.running || 0).toLocaleString()}</b></span><span>Stopped <b>${Number(containers.stopped || 0).toLocaleString()}</b></span><span>Unhealthy <b>${Number(containers.unhealthy || 0).toLocaleString()}</b></span></div>`;
    }).join("") || empty("No Docker environments were returned.");
    const updateBody = `<div class="wg-stat-grid">${stat("Scanned", Number(updates.scanned || 0).toLocaleString(), "search", "cyan")}${stat("Updates found", Number(updates.found || 0).toLocaleString(), "download", updates.found ? "amber" : "slate")}
      ${stat("Updated", Number(updates.updated || 0).toLocaleString(), "check", "green")}${stat("Failed", Number(updates.failed || 0).toLocaleString(), "warning", updates.failed ? "red" : "slate")}</div>`;
    return `<div class="wg-dockhand-environments">${body}</div>
      ${section("Update results", updateBody, "download", "Latest scan outcome")}`;
  }

  function speedtestView(data, unit = "mbps") {
    const latest = data.latest || {}; const history = list(data.history);
    const divisor = unit === "megabytes" ? 1_000_000 : 125_000;
    const unitLabel = unit === "megabytes" ? "MBps" : "Mbps";
    const rate = value => `${(Number(value || 0) / divisor).toFixed(1)} ${unitLabel}`;
    const tests = history.filter(item => Number(item.download) > 0 || Number(item.upload) > 0).slice(0, 12).reverse();
    const maximum = Math.max(1, ...tests.flatMap(item => [Number(item.download || 0), Number(item.upload || 0)])) / divisor;
    const bars = tests.map(item => {
      const download = Number(item.download || 0) / divisor;
      const upload = Number(item.upload || 0) / divisor;
      const date = new Date(String(item.createdAt).replace(" ", "T"));
      const label = Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
      return `<div class="wg-chart-test"><div class="wg-chart-bars"><i class="wg-chart-download" style="height:${pct(download, maximum)}%" title="Download ${download.toFixed(1)} ${unitLabel}"></i><i class="wg-chart-upload" style="height:${pct(upload, maximum)}%" title="Upload ${upload.toFixed(1)} ${unitLabel}"></i></div><small>${escapeHtml(label)}</small></div>`;
    }).join("");
    const chart = tests.length ? `<div class="wg-speed-chart" data-speed-toggle title="Switch between Mbps and MBps"><div class="wg-chart-y"><span>${maximum.toFixed(1)} ${unitLabel}</span><span>${(maximum / 2).toFixed(1)}</span><span>0</span></div><div class="wg-chart-plot">${bars}</div></div>
      <div class="wg-chart-legend" data-speed-toggle title="Switch between Mbps and MBps"><span><i class="wg-chart-download"></i>Download</span><span><i class="wg-chart-upload"></i>Upload</span></div>` : empty("No speed test history.");
    const rateTile = (label, value, iconName, tone) => `<button type="button" class="wg-stat wg-speed-toggle wg-tone-${tone}" data-speed-toggle title="Switch between Mbps and MBps">${icon(iconName)}<span><small>${label}</small><strong>${rate(value)}</strong></span></button>`;
    return `<div class="wg-stat-grid">${rateTile("Download", latest.download, "download", "cyan")}${rateTile("Upload", latest.upload, "upload", "violet")}
      ${stat("Ping", `${Number(latest.ping || 0).toFixed(1)} ms`, "activity", "green", formatResultTime(latest.createdAt))}<button type="button" class="wg-stat wg-stat-action wg-tone-green wg-action" data-service="speedtest" data-action="run" data-payload="{}">${icon("play")}<span><small>${escapeHtml(latest.serverName || "Unknown server")}</small><strong>Run speed test</strong></span></button></div>
      ${section("Speed history", chart, "activity", `Tests on X axis · ${unitLabel} on Y axis`)}`;
  }

  function proxmoxView(data, view = "activity") {
    const node = data.node || {}; const memory = node.memory || {}; const guests = [...list(data.vms).map(item => ({ ...item, kind: "VM" })), ...list(data.lxc).map(item => ({ ...item, kind: "LXC" }))];
    const updates = list(data.updates); const storage = list(data.storage).filter(item => item.active); const tasks = list(data.tasks);
    const running = guests.filter(item => item.status === "running");
    const storageUsed = storage.reduce((sum, item) => sum + Number(item.used || 0), 0); const storageTotal = storage.reduce((sum, item) => sum + Number(item.total || 0), 0);
    const warnings = tasks.filter(item => /warn|error|fail/i.test(item.status));
    const guestMetric = (label, usage, iconName, tone, note) => `<div class="wg-guest-stat wg-tone-${tone}">${icon(iconName)}<span><small>${escapeHtml(label)}</small><strong>${usage.toFixed(1)}%</strong><em>${escapeHtml(note)}</em>${progress(usage, usage >= 90 ? "red" : "cyan")}</span></div>`;
    const guestDetail = guest => {
      const cpuUsage = pct(Number(guest.cpu || 0) * 100, 100); const memoryUsage = pct(guest.memory, guest.maxMemory);
      const memoryTone = memoryUsage >= 90 ? "red" : memoryUsage >= 75 ? "amber" : "violet";
      return `<article class="wg-guest-card"><header><span>${icon("server")}<span><strong>${escapeHtml(guest.name || `${guest.kind} ${guest.id}`)}</strong><small>${escapeHtml(guest.kind)} ${Number(guest.id) || ""} · running</small></span></span>${badge("Live", "success")}</header><div class="wg-guest-stat-grid">
        ${guestMetric("CPU", cpuUsage, "activity", cpuUsage >= 85 ? "red" : "cyan", `${Number(guest.cpu || 0) ? "Current guest load" : "Idle"}`)}
        ${guestMetric("RAM", memoryUsage, "database", memoryTone, `${formatBytes(guest.memory)} of ${formatBytes(guest.maxMemory)}`)}</div></article>`;
    };
    const activityRows = pagedList(running, guestDetail, "proxmox-running", "No guests are currently running.");
    const guestRows = pagedList(guests, guest => `<div class="wg-list-row"><span>${icon("server")}<span><strong>${escapeHtml(guest.name || `${guest.kind} ${guest.id}`)}</strong><small>${escapeHtml(guest.kind)} ${Number(guest.id) || ""} · ${formatBytes(guest.maxMemory)} assigned</small></span></span>${badge(titleCase(guest.status), statusTone(guest.status))}</div>`, "proxmox-guests", "No VM or LXC guests returned.");
    const storageRows = storage.map(item => { const usage = pct(item.used, item.total); return `<div class="wg-list-row wg-list-stack"><span><strong>${escapeHtml(item.name)}</strong><b>${Math.round(usage)}% used</b></span>${progress(usage, usage > 85 ? "red" : "cyan")}<small>${formatBytes(item.used)} of ${formatBytes(item.total)} · ${escapeHtml(titleCase(item.type))}</small></div>`; }).join("") || empty("No active storage pools returned.");
    const views = [{ id: "activity", label: "Activity" }, { id: "guests", label: "Guests" }, { id: "storage", label: "Storage" }];
    const viewBody = view === "guests" ? guestRows : view === "storage" ? storageRows : activityRows;
    const viewTitle = view === "guests" ? "All guests" : view === "storage" ? "Storage pools" : "Node activity";
    const warningText = warnings.length ? warnings.slice(0, 5).map(item => `${titleCase(item.type)}: ${item.status}`).join("\n") : "No warning or failed tasks";
    const alertCounter = `<span class="wg-live-counter" title="Visible cards update from the 30 second server cache; background cards slow down automatically">${icon("refresh")}<b>Live</b></span><span class="wg-alert-counter ${warnings.length ? "has-alerts" : ""}" title="${escapeHtml(warningText)}" aria-label="${warnings.length} task warnings">${icon(warnings.length ? "warning" : "check")}<b>${warnings.length}</b></span>`;
    return `<div class="wg-stat-grid wg-stat-grid-3">${stat("CPU", `${(Number(node.cpu || 0) * 100).toFixed(1)}%`, "activity", "cyan", `Load ${list(node.load).slice(0, 3).join(" · ") || "—"}`)}${stat("Memory", `${Math.round(pct(memory.used, memory.total))}%`, "database", "violet", `${formatBytes(memory.used)} of ${formatBytes(memory.total)}`)}
      ${stat("Storage", `${Math.round(pct(storageUsed, storageTotal))}%`, "server", pct(storageUsed, storageTotal) > 85 ? "red" : "green", `${formatBytes(storageUsed)} of ${formatBytes(storageTotal)}`)}</div>
      ${switchSection("proxmox", viewTitle, `${running.length}/${guests.length} guests running · ${storage.length} pools · ${updates.length} updates`, viewBody, "server", views, view, alertCounter)}`;
  }

  function genericView(data) {
    const safeEntries = Object.entries(data || {}).filter(([key, value]) => !/(^id$|hash|token|userId|sessionId)/i.test(key) && !Array.isArray(value));
    return section("Overview", `<div class="wg-kv-grid">${safeEntries.map(([key, value]) => `<span>${escapeHtml(titleCase(key))}<b>${formatValue(value, key)}</b></span>`).join("")}</div>`, "activity");
  }

  function renderDetails(id, data) {
    if (id === "jellyfin") return jellyfinView(data);
    if (id === "immich") return immichView(data);
    if (id === "seerr") return seerrView(data);
    if (id === "radarr" || id === "sonarr") return arrView(id, data);
    if (id === "bazarr") return bazarrView(data);
    if (id === "prowlarr") return prowlarrView(data);
    if (id === "qbittorrent") return qbitView(data);
    if (id === "tdarr") return tdarrView(data);
    if (id === "calendar") return calendarView(data);
    if (id === "adguard") return adguardView(data);
    if (id === "authentik") return authentikView(data);
    if (id === "homeassistant") return homeassistantView(data);
    if (id === "dockhand") return dockhandView(data);
    if (id === "speedtest") return speedtestView(data);
    if (id === "proxmox") return proxmoxView(data);
    return genericView(data);
  }

  async function requestAction(panel, service, action, payload) {
    if (service === "qbittorrent") {
      payload.hashes = Array.from(panel.querySelectorAll(".wg-torrent:checked")).map(input => input.value);
      if (!payload.hashes.length) throw new Error("Select at least one torrent.");
      if (action === "delete") {
        if (!window.confirm("Delete the selected torrents? Downloaded files will be kept.")) return;
        payload.confirm = "DELETE";
        payload.deleteFiles = false;
      }
    }
    const response = await fetch(`${API}/actions/${encodeURIComponent(service)}/${encodeURIComponent(action)}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Dashboard-CSRF": "1" },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error?.message || "Action failed.");
    await load(panel, service, true);
  }

  async function searchSeerr(panel) {
    const input = panel.querySelector(".wg-search input");
    const output = panel.querySelector(".wg-search-results");
    const query = input?.value.trim();
    if (!query || query.length < 2) return;
    output.textContent = "Searching…";
    const response = await fetch(`${API}/seerr/search?q=${encodeURIComponent(query)}`, { credentials: "same-origin" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || "Search failed.");
    const mediaStatus = value => ({ 3: "Processing", 4: "Partially available", 5: "Available" })[Number(value)] || "";
    const results = (result.data?.results || []).slice(0, 6);
    panel.querySelector(".wg-panel-body")?.classList.add("wg-seerr-searching");
    output.innerHTML = results.length ? `<div class="wg-search-results-head"><span>${results.length} results</span><button type="button" data-clear-search>Back to requests</button></div><div class="wg-poster-grid">${results.map(item => {
      const status = mediaStatus(item.status);
      const control = status ? badge(status, status === "Available" ? "success" : "warning")
        : item.mediaType === "tv"
          ? `<button type="button" class="wg-action wg-action-success" data-seerr-select data-media-type="tv" data-media-id="${Number(item.id)}">${icon("check")}<span>Choose seasons</span></button>`
          : actionButton("seerr", "request", "Request", { mediaType: item.mediaType, mediaId: item.id }, { icon: "check", tone: "success" });
      return `<article class="wg-poster-card">${item.posterPath ? `<img src="https://image.tmdb.org/t/p/w185${escapeHtml(item.posterPath)}" alt="${escapeHtml(item.title)} poster">` : `<span class="wg-poster-placeholder">${icon(item.mediaType === "tv" ? "play" : "film")}</span>`}
        <span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(titleCase(item.mediaType))}${item.releaseDate ? ` · ${escapeHtml(formatDate(item.releaseDate))}` : ""}</small></span>
        ${control}</article>`;
    }).join("")}</div>` : empty("No matching movies or series.");
  }

  async function showSeerrPicker(panel, mediaType, mediaId) {
    const output = panel.querySelector(".wg-search-results");
    if (!output) return;
    output.innerHTML = `<div class="wg-loading">Loading seasons…</div>`;
    const response = await fetch(`${API}/seerr/media/${encodeURIComponent(mediaType)}/${encodeURIComponent(mediaId)}`, { credentials: "same-origin" });
    const envelope = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(envelope.error?.message || "Series details are unavailable.");
    const media = envelope.data || {};
    const seasons = list(media.seasons).filter(season => Number(season.number) > 0);
    const unavailable = status => [3, 4, 5].includes(Number(status));
    const choices = seasons.map(season => `<label class="wg-season-choice${unavailable(season.status) ? " wg-season-choice-disabled" : ""}"><input type="checkbox" data-season-number="${Number(season.number)}" ${unavailable(season.status) ? "disabled" : ""}><span><strong>Season ${Number(season.number)}</strong><small>${Number(season.episodes || 0)} episodes${unavailable(season.status) ? " · already requested" : ""}</small></span></label>`).join("");
    const selectable = seasons.filter(season => !unavailable(season.status)).length;
    output.innerHTML = `<div class="wg-picker-head"><button type="button" data-seerr-back>‹ Results</button><span><strong>${escapeHtml(media.title || "Series")}</strong><small>${selectable} requestable season${selectable === 1 ? "" : "s"}</small></span>${selectable ? `<button type="button" data-season-all>Select all</button>` : ""}</div>
      <div class="wg-season-grid">${choices || empty("No seasons were returned.")}</div>
      ${selectable ? `<div class="wg-picker-actions"><small>Select only the seasons you want.</small><button type="button" class="wg-action wg-action-success" data-request-seasons data-media-id="${Number(media.id || mediaId)}" data-media-title="${escapeHtml(media.title || "this series")}">${icon("check")}<span>Request selected</span></button></div>` : empty("All regular seasons are already requested.")}`;
    syncCardHeights();
  }

  const remainingLabel = milliseconds => {
    const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
    if (seconds < 60) return `${seconds}s remaining`;
    const minutes = Math.ceil(seconds / 60);
    return `${minutes}m remaining`;
  };

  function updateAdguardCountdowns() {
    document.querySelectorAll("[data-adguard-countdown]").forEach(element => {
      const remaining = Number(element.dataset.pauseUntil || 0) - Date.now();
      if (remaining > 0) {
        element.textContent = remainingLabel(remaining);
        return;
      }
      element.textContent = "Pause ending…";
      const panel = element.closest(".wg-details");
      if (panel && !panel.dataset.pauseRefresh) {
        panel.dataset.pauseRefresh = "1";
        window.setTimeout(() => { delete panel.dataset.pauseRefresh; load(panel, "adguard", true); }, 1200);
      }
    });
  }

  function updatePagedList(root, requestedPage = 1) {
    if (!root) return;
    const visible = Array.from(root.querySelectorAll("[data-page-item]")).filter(item => item.dataset.searchHidden !== "1");
    const pages = Math.max(1, Math.ceil(visible.length / 5));
    const page = Math.max(1, Math.min(pages, requestedPage));
    root.dataset.page = String(page);
    root.dataset.pages = String(pages);
    root.querySelectorAll("[data-page-item]").forEach(item => { item.hidden = true; });
    visible.forEach((item, index) => { item.hidden = Math.floor(index / 5) !== page - 1; });
    const pagination = root.querySelector(".wg-pagination");
    if (!pagination) return;
    pagination.hidden = pages === 1;
    const buttons = pagination.querySelectorAll("[data-page-direction]");
    buttons[0].disabled = page === 1;
    buttons[1].disabled = page === pages;
    pagination.querySelector("span").textContent = visible.length ? `Page ${page} of ${pages}` : "No matches";
  }

  let heightTimer;
  function syncCardHeights() {
    window.clearTimeout(heightTimer);
    heightTimer = window.setTimeout(() => {
      const items = services.map(cardFor).filter(item => item?.dataset.widgetGatewayMounted);
      items.forEach(item => { item.style.height = ""; });
      document.documentElement.style.setProperty("--wg-card-height", "auto");
      if (!items.length || window.matchMedia("(max-width: 720px)").matches) return;
      window.requestAnimationFrame(() => {
        const groups = new Map();
        items.forEach(item => {
          const list = item.closest("ul");
          if (!groups.has(list)) groups.set(list, new Map());
          const top = Math.round(item.getBoundingClientRect().top);
          const rows = groups.get(list);
          if (!rows.has(top)) rows.set(top, []);
          rows.get(top).push(item);
        });
        groups.forEach(rows => rows.forEach(row => {
          const tallest = Math.max(...row.map(item => nativeCardFor(item)?.scrollHeight || item.scrollHeight || 0));
          row.forEach(item => { item.style.height = `${Math.ceil(tallest + 4)}px`; });
        }));
      });
    }, 80);
  }

  async function loadCalendarMonth(panel, month) {
    const monthStart = new Date(month.getFullYear(), month.getMonth(), 1);
    const gridStart = new Date(monthStart);
    gridStart.setDate(gridStart.getDate() - ((gridStart.getDay() + 6) % 7));
    const gridEnd = new Date(gridStart);
    gridEnd.setDate(gridEnd.getDate() + 42);
    panel.setAttribute("aria-busy", "true");
    try {
      const response = await fetch(`${API}/calendar?from=${encodeURIComponent(gridStart.toISOString())}&to=${encodeURIComponent(gridEnd.toISOString())}`, { credentials: "same-origin" });
      const envelope = await response.json();
      if (!response.ok) throw new Error(envelope.error?.message || "Calendar is unavailable.");
      const data = envelope.data || { events: [] };
      state.set(panel, { data, calendarMonth: monthStart });
      panel.innerHTML = `<div class="wg-panel-body">${calendarView(data, monthStart)}</div>`;
      syncCardHeights();
    } finally {
      panel.removeAttribute("aria-busy");
    }
  }

  async function load(panel, id, refresh = false) {
    panel.setAttribute("aria-busy", "true");
    if (!refresh) panel.innerHTML = `<div class="wg-loading">Loading ${escapeHtml(labels[id] || id)} details…</div>`;
    try {
      const response = await fetch(`${API}/widgets/${encodeURIComponent(id)}/details`, { credentials: "same-origin" });
      const envelope = await response.json();
      if (!response.ok) throw new Error(envelope.error?.message || "Details are unavailable.");
      const data = envelope.data || {}; const current = state.get(panel) || {};
      const calendarMonth = id === "calendar" ? new Date() : undefined;
      const next = { ...current, data, calendarMonth, loadedAt: Date.now() };
      state.set(panel, next);
      const content = id === "calendar" ? calendarView(data, calendarMonth)
        : id === "proxmox" ? proxmoxView(data, next.proxmoxView || "activity") : renderDetails(id, data);
      panel.innerHTML = `<div class="wg-panel-body">${content}</div>`;
    } catch (error) {
      panel.innerHTML = `<div class="wg-error">${icon("warning")}<span><strong>Data unavailable</strong><small>${escapeHtml(error.message)}</small></span></div>`;
    } finally {
      panel.removeAttribute("aria-busy");
      syncCardHeights();
    }
  }

  function scheduleDynamicRefresh(panel) {
    window.clearTimeout(refreshTimers.get(panel));
    const delay = document.hidden ? 60000 : panel.dataset.wgVisible === "0" ? 60000 : 15000;
    const timer = window.setTimeout(async () => {
      if (!panel.isConnected) return;
      if (!document.hidden) await load(panel, "proxmox", true);
      scheduleDynamicRefresh(panel);
    }, delay);
    refreshTimers.set(panel, timer);
  }

  function mount(id) {
    const item = cardFor(id);
    if (!item || item.dataset.widgetGatewayMounted) return;
    const nativeCard = nativeCardFor(item);
    if (!nativeCard) return;
    item.dataset.widgetGatewayMounted = id;
    nativeCard.classList.add("wg-native-card");
    nativeCard.querySelector(".service-container")?.classList.add("wg-native-summary");
    const panel = document.createElement("div");
    panel.className = "wg-details";
    panel.dataset.widget = id;
    nativeCard.append(panel);
    nativeCard.classList.add("wg-card-expanded");
    item.classList.add("wg-expanded");
    const groupList = item.closest("ul");
    groupList?.classList.add("wg-group-expanded");
    groupList?.parentElement?.classList.add("wg-service-group-spacing");
    load(panel, id).then(() => { if (id === "proxmox") scheduleDynamicRefresh(panel); });
  }

  document.addEventListener("click", event => {
    const link = event.target.closest(".wg-release-link");
    if (!link) return;
    event.preventDefault();
    event.stopPropagation();
    window.open(link.href, "_blank", "noopener,noreferrer");
  }, true);

  document.addEventListener("click", async event => {
    const panel = event.target.closest(".wg-details");
    if (!panel) return;
    const pageButton = event.target.closest("[data-page-direction]");
    if (pageButton) {
      const listRoot = pageButton.closest("[data-paged-list]");
      updatePagedList(listRoot, Number(listRoot?.dataset.page || 1) + Number(pageButton.dataset.pageDirection));
      syncCardHeights();
      return;
    }
    const calendarNav = event.target.closest("[data-calendar-nav]");
    if (calendarNav) {
      const current = state.get(panel)?.calendarMonth || new Date();
      const target = new Date(current.getFullYear(), current.getMonth() + Number(calendarNav.dataset.calendarNav), 1);
      try { await loadCalendarMonth(panel, target); } catch (error) { window.alert(error.message); }
      return;
    }
    if (event.target.closest("[data-calendar-today]")) {
      try { await loadCalendarMonth(panel, new Date()); } catch (error) { window.alert(error.message); }
      return;
    }
    if (event.target.closest("[data-speed-toggle]")) {
      const current = state.get(panel) || {};
      current.speedUnit = current.speedUnit === "megabytes" ? "mbps" : "megabytes";
      state.set(panel, current);
      const body = panel.querySelector(".wg-panel-body");
      if (body) body.innerHTML = speedtestView(current.data || {}, current.speedUnit);
      syncCardHeights();
      return;
    }
    const proxmoxViewButton = event.target.closest("[data-proxmox-view]");
    if (proxmoxViewButton) {
      const current = state.get(panel) || {};
      current.proxmoxView = proxmoxViewButton.dataset.proxmoxView;
      state.set(panel, current);
      const body = panel.querySelector(".wg-panel-body");
      if (body) body.innerHTML = proxmoxView(current.data || {}, current.proxmoxView);
      syncCardHeights();
      return;
    }
    if (event.target.closest("[data-proxmox-cycle]")) {
      const current = state.get(panel) || {}; const views = ["activity", "guests", "storage"];
      current.proxmoxView = views[(views.indexOf(current.proxmoxView || "activity") + 1) % views.length];
      state.set(panel, current);
      const body = panel.querySelector(".wg-panel-body");
      if (body) body.innerHTML = proxmoxView(current.data || {}, current.proxmoxView);
      syncCardHeights();
      return;
    }
    const haViewButton = event.target.closest("[data-ha-view]");
    if (haViewButton) {
      const current = state.get(panel) || {};
      current.haView = haViewButton.dataset.haView;
      state.set(panel, current);
      const body = panel.querySelector(".wg-panel-body");
      if (body) body.innerHTML = homeassistantView(current.data || {}, current.haView);
      syncCardHeights();
      return;
    }
    if (event.target.closest("[data-ha-cycle]")) {
      const current = state.get(panel) || {}; const views = ["controls", "vacuum", "status"];
      current.haView = views[(views.indexOf(current.haView || "controls") + 1) % views.length];
      state.set(panel, current);
      const body = panel.querySelector(".wg-panel-body");
      if (body) body.innerHTML = homeassistantView(current.data || {}, current.haView);
      syncCardHeights();
      return;
    }
    const calendarDay = event.target.closest("[data-calendar-date]");
    if (calendarDay) {
      const selected = calendarDay.dataset.calendarDate;
      panel.querySelectorAll(".wg-calendar-day").forEach(day => day.classList.toggle("wg-calendar-selected", day === calendarDay));
      const output = panel.querySelector("[data-calendar-releases]");
      if (output) output.innerHTML = calendarReleases(list(state.get(panel)?.data?.events), selected);
      syncCardHeights();
      return;
    }
    if (event.target.closest("[data-search]")) {
      try { await searchSeerr(panel); } catch (error) { panel.querySelector(".wg-search-results").textContent = error.message; }
      return;
    }
    const seerrSelect = event.target.closest("[data-seerr-select]");
    if (seerrSelect) {
      try { await showSeerrPicker(panel, seerrSelect.dataset.mediaType, seerrSelect.dataset.mediaId); }
      catch (error) { panel.querySelector(".wg-search-results").textContent = error.message; }
      return;
    }
    if (event.target.closest("[data-seerr-back]")) {
      try { await searchSeerr(panel); } catch (error) { panel.querySelector(".wg-search-results").textContent = error.message; }
      return;
    }
    if (event.target.closest("[data-season-all]")) {
      const choices = Array.from(panel.querySelectorAll("[data-season-number]:not(:disabled)"));
      const select = choices.some(choice => !choice.checked);
      choices.forEach(choice => { choice.checked = select; });
      event.target.closest("[data-season-all]").textContent = select ? "Clear" : "Select all";
      return;
    }
    const seasonRequest = event.target.closest("[data-request-seasons]");
    if (seasonRequest) {
      const seasons = Array.from(panel.querySelectorAll("[data-season-number]:checked")).map(input => Number(input.dataset.seasonNumber)).filter(number => number > 0);
      if (!seasons.length) { window.alert("Select at least one season."); return; }
      if (!window.confirm(`Request ${seasons.length} season${seasons.length === 1 ? "" : "s"} of ${seasonRequest.dataset.mediaTitle}?`)) return;
      seasonRequest.disabled = true;
      try { await requestAction(panel, "seerr", "request", { mediaType: "tv", mediaId: Number(seasonRequest.dataset.mediaId), seasons }); }
      catch (error) { window.alert(error.message); seasonRequest.disabled = false; }
      return;
    }
    if (event.target.closest("[data-clear-search]")) {
      panel.querySelector(".wg-search-results").innerHTML = "";
      panel.querySelector(".wg-panel-body")?.classList.remove("wg-seerr-searching");
      return;
    }
    if (event.target.closest("[data-send-group]")) {
      const input = panel.querySelector("[data-group-message]");
      const message = input?.value.trim();
      if (!message) return;
      try { await requestAction(panel, "jellyfin", "groupMessage", { message }); }
      catch (error) { window.alert(error.message); }
      return;
    }
    const adguardPause = event.target.closest("[data-adguard-pause]");
    if (adguardPause) {
      const duration = Number(panel.querySelector("[data-adguard-duration]")?.value || 300);
      adguardPause.disabled = true;
      try { await requestAction(panel, "adguard", "pause", { duration }); }
      catch (error) { window.alert(error.message); adguardPause.disabled = false; }
      return;
    }
    const sessionSend = event.target.closest("[data-send-session]");
    if (sessionSend) {
      const sessionId = sessionSend.dataset.sendSession;
      const input = panel.querySelector(`[data-session-message="${CSS.escape(sessionId)}"]`);
      const message = input?.value.trim();
      if (!message) return;
      try { await requestAction(panel, "jellyfin", "message", { sessionId, message }); }
      catch (error) { window.alert(error.message); }
      return;
    }
    const button = event.target.closest(".wg-action");
    if (!button) return;
    button.disabled = true;
    try { await requestAction(panel, button.dataset.service, button.dataset.action, JSON.parse(button.dataset.payload || "{}")); }
    catch (error) { window.alert(error.message); button.disabled = false; }
  });

  window.addEventListener("resize", syncCardHeights);
  document.addEventListener("visibilitychange", () => {
    document.querySelectorAll('.wg-details[data-widget="proxmox"]').forEach(panel => {
      if (!document.hidden && Date.now() - Number(state.get(panel)?.loadedAt || 0) >= 15000) load(panel, "proxmox", true);
      scheduleDynamicRefresh(panel);
    });
  });
  const visibilityObserver = new IntersectionObserver(entries => entries.forEach(entry => {
    const panel = entry.target;
    panel.dataset.wgVisible = entry.isIntersecting ? "1" : "0";
    if (panel.dataset.widget === "proxmox") scheduleDynamicRefresh(panel);
  }), { threshold: 0.1 });
  window.setInterval(updateAdguardCountdowns, 1000);
  document.addEventListener("click", syncCardHeights);
  const observer = new MutationObserver(() => {
    services.forEach(mount);
    document.querySelectorAll(".wg-details:not([data-visibility-observed])").forEach(panel => {
      panel.dataset.visibilityObserved = "1";
      visibilityObserver.observe(panel);
    });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  services.forEach(mount);
  document.querySelectorAll(".wg-details").forEach(panel => {
    panel.dataset.visibilityObserved = "1";
    visibilityObserver.observe(panel);
  });
})();
