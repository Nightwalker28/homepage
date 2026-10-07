import Fastify, { LogController, type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { readConfig, type Config } from "./config.js";
import { ResponseCache } from "./cache.js";
import { Connectors, widgetIds, type WidgetId } from "./connectors.js";
import { UpstreamError } from "./http.js";

const widgetParams = {
  type: "object", additionalProperties: false, required: ["id"],
  properties: { id: { type: "string", enum: widgetIds } },
} as const;
const actionParams = {
  type: "object", additionalProperties: false, required: ["service", "action"],
  properties: {
    service: { type: "string", enum: ["jellyfin", "seerr", "radarr", "sonarr", "bazarr", "qbittorrent", "adguard", "speedtest", "homeassistant", "prowlarr"] },
    action: { type: "string", enum: ["refresh", "refreshLibrary", "pause", "resume", "stop", "message", "groupMessage", "approve", "decline", "request", "search", "recheck", "delete", "protection", "safeBrowsing", "parental", "run", "vacuum", "routine", "sync"] },
  },
} as const;

export async function buildApp(config: Config = readConfig()) {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || "info", base: undefined, redact: ["req.headers.authorization", "req.headers.cookie", "req.body.password", "res.headers.set-cookie"] },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 32_768,
  });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  const connectors = new Connectors(config);
  const cache = new ResponseCache(config.cacheTtlMs, config.staleTtlMs);

  const read = async (id: WidgetId, detail: "summary" | "details") => {
    const response = await cache.get(`${id}:result`, async () => {
      const result = await connectors.read(id);
      return { data: result, partial: result.partial };
    });
    return { data: response.data[detail], meta: response.meta };
  };

  app.setErrorHandler((error, request, reply) => {
    const err = error as Error & { statusCode?: number; validation?: unknown };
    request.log.warn({ err: { name: err.name, statusCode: err.statusCode } }, "request failed");
    const securityFailure = /Cross-origin|CSRF|Authentication/.test(err.message);
    const status = error instanceof UpstreamError ? 502 : err.validation ? 400 : err.message.includes("not allowed") || securityFailure ? 403 : /confirmation|Invalid|Select at least|content type|Unexpected action field/.test(err.message) ? 400 : 500;
    reply.code(status).send({ error: { code: status === 502 ? "UPSTREAM_UNAVAILABLE" : status === 403 ? "FORBIDDEN" : status === 400 ? "INVALID_REQUEST" : "INTERNAL_ERROR", message: status === 502 ? err.message : status === 500 ? "Request could not be completed" : err.message } });
  });

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/internal/v1/widgets/:id/summary", { schema: { params: widgetParams } }, async request => read((request.params as any).id, "summary"));
  app.get("/internal/v1/widgets/:id/health", { schema: { params: widgetParams } }, async request => {
    const response = await read((request.params as any).id, "summary");
    return { status: response.meta.stale || response.meta.partial ? "degraded" : "ok", updatedAt: response.meta.updatedAt };
  });
  app.get("/api/widget-gateway/v1/widgets/:id/details", { schema: { params: widgetParams } }, async request => read((request.params as any).id, "details"));
  app.get("/api/widget-gateway/v1/calendar", {
    schema: { querystring: { type: "object", additionalProperties: false, required: ["from", "to"], properties: { from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" } } } },
  }, async request => {
    const { from, to } = request.query as { from: string; to: string };
    const start = Date.parse(from); const end = Date.parse(to);
    if (end <= start || end - start > 93 * 86_400_000) throw new Error("Invalid calendar range");
    const result = await connectors.calendarRange(from, to);
    return { data: result.data, meta: { updatedAt: new Date().toISOString(), stale: false, partial: result.partial } };
  });
  app.get("/api/widget-gateway/v1/seerr/search", {
    schema: { querystring: { type: "object", additionalProperties: false, required: ["q"], properties: { q: { type: "string", minLength: 2, maxLength: 100 } } } },
  }, async request => ({ data: { results: await connectors.searchSeerr((request.query as any).q) }, meta: { updatedAt: new Date().toISOString(), stale: false, partial: false } }));
  app.get("/api/widget-gateway/v1/seerr/media/:type/:id", {
    schema: {
      params: {
        type: "object", additionalProperties: false, required: ["type", "id"],
        properties: { type: { type: "string", enum: ["movie", "tv"] }, id: { type: "integer", minimum: 1 } },
      },
    },
  }, async request => {
    const { type, id } = request.params as { type: "movie" | "tv"; id: number };
    return { data: await connectors.seerrMedia(type, id), meta: { updatedAt: new Date().toISOString(), stale: false, partial: false } };
  });

  const assertMutation = (request: FastifyRequest) => {
    const origin = request.headers.origin;
    const forwardedHost = String(request.headers["x-forwarded-host"] || request.headers.host || "");
    const expected = config.dashboardOrigin ? new URL(config.dashboardOrigin) : null;
    if (!origin || !expected || new URL(origin).origin !== expected.origin || forwardedHost.split(",")[0].trim() !== expected.host) throw new Error("Cross-origin request rejected");
    if (request.headers["content-type"]?.split(";")[0] !== "application/json") throw new Error("JSON content type is required");
    if (request.headers["x-dashboard-csrf"] !== "1") throw new Error("CSRF validation failed");
    if (!request.headers[config.authHeader]) throw new Error("Authentication is required");
  };
  const assertActionBody = (action: string, body: Record<string, unknown>) => {
    const allowed: Record<string, string[]> = {
      refresh: [], refreshLibrary: ["libraryId"], pause: ["sessionId", "duration", "hashes"],
      resume: ["sessionId", "hashes"], stop: ["sessionId"], message: ["sessionId", "message"],
      groupMessage: ["message"],
      approve: ["requestId"], decline: ["requestId"],
      request: ["mediaType", "mediaId", "seasons"], recheck: ["hashes"],
      search: ["id", "seriesId", "kind", "languages", "all"],
      delete: ["hashes", "confirm", "deleteFiles", "confirmFiles"],
      protection: ["enabled"], safeBrowsing: ["enabled"], parental: ["enabled"], run: [],
      vacuum: ["command"], routine: ["name"], sync: [],
    };
    const unexpected = Object.keys(body).find(key => !allowed[action]?.includes(key));
    if (unexpected) throw new Error(`Unexpected action field: ${unexpected}`);
  };
  app.post("/api/widget-gateway/v1/actions/:service/:action", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    schema: { params: actionParams, body: { type: "object", additionalProperties: true, maxProperties: 12 } },
  }, async request => {
    assertMutation(request);
    const { service, action } = request.params as { service: string; action: string };
    assertActionBody(action, request.body as Record<string, unknown>);
    const result = await connectors.action(service, action, request.body as Record<string, unknown>);
    cache.clear(`${service}:`);
    return { data: result, meta: { updatedAt: new Date().toISOString(), stale: false, partial: false } };
  });
  return app;
}
