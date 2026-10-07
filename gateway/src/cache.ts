type Entry<T> = { value: T; updatedAt: string; expiresAt: number; staleUntil: number; partial: boolean };
export type Envelope<T> = { data: T; meta: { updatedAt: string; stale: boolean; partial: boolean } };

export class ResponseCache {
  private entries = new Map<string, Entry<unknown>>();
  private pending = new Map<string, Promise<Envelope<unknown>>>();

  constructor(private ttlMs: number, private staleTtlMs: number) {}

  async get<T>(key: string, load: () => Promise<{ data: T; partial?: boolean }>): Promise<Envelope<T>> {
    const now = Date.now();
    const cached = this.entries.get(key) as Entry<T> | undefined;
    if (cached && cached.expiresAt > now) return { data: cached.value, meta: { updatedAt: cached.updatedAt, stale: false, partial: cached.partial } };
    const existing = this.pending.get(key) as Promise<Envelope<T>> | undefined;
    if (existing) return existing;
    const request = (async () => {
      try {
        const loaded = await load();
        const updatedAt = new Date().toISOString();
        this.entries.set(key, { value: loaded.data, updatedAt, expiresAt: now + this.ttlMs, staleUntil: now + this.staleTtlMs, partial: !!loaded.partial });
        return { data: loaded.data, meta: { updatedAt, stale: false, partial: !!loaded.partial } };
      } catch (error) {
        if (cached && cached.staleUntil > now) return { data: cached.value, meta: { updatedAt: cached.updatedAt, stale: true, partial: true } };
        throw error;
      } finally {
        this.pending.delete(key);
      }
    })();
    this.pending.set(key, request as Promise<Envelope<unknown>>);
    return request;
  }

  clear(prefix: string) {
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key);
  }
}
