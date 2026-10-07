import { fetch as undiciFetch, type Dispatcher } from "undici";

export class UpstreamError extends Error {
  constructor(public readonly status: number, message = "Upstream request failed") {
    super(message);
  }
}

export type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  form?: URLSearchParams;
  timeoutMs: number;
  dispatcher?: Dispatcher;
};

export async function upstream<T>(baseUrl: string, path: string, options: RequestOptions): Promise<T> {
  if (!baseUrl) throw new UpstreamError(503, "Service is not configured");
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const headers: Record<string, string> = { Accept: "application/json", ...options.headers };
  let body: string | undefined;
  if (options.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = options.form.toString();
  } else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  let response: any;
  try {
    const request = {
      method: options.method || "GET",
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs),
    } as RequestInit;
    response = options.dispatcher
      ? await undiciFetch(url, { ...request, dispatcher: options.dispatcher } as any)
      : await fetch(url, request);
  } catch {
    throw new UpstreamError(503, "Service is temporarily unavailable");
  }
  if (!response.ok) throw new UpstreamError(response.status, "Service returned an error");
  if (response.status === 204 || response.headers.get("content-length") === "0") return null as T;
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("json")) return (await response.text()) as T;
  try {
    return await response.json() as T;
  } catch {
    throw new UpstreamError(502, "Service returned malformed data");
  }
}

export const list = (value: unknown): Record<string, any>[] => Array.isArray(value) ? value : [];
export const records = (value: unknown): Record<string, any>[] => {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    for (const key of ["results", "records", "data"]) if (Array.isArray(object[key])) return object[key] as Record<string, any>[];
  }
  return [];
};
export const finite = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
export const text = (value: unknown, fallback = "") => typeof value === "string" ? value.slice(0, 500) : fallback;
export const identifier = (value: unknown) => typeof value === "string" || typeof value === "number" ? String(value).slice(0, 128) : "";
