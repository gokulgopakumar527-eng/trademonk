/**
 * Small in-memory TTL cache with in-flight request coalescing.
 * Per server instance only (serverless instances do not share it), so it protects the upstream
 * rate limit from bursts but is not a source of truth. Only SUCCESSFUL results are cached;
 * failures are cached very briefly (negative TTL) to avoid hammering a failing provider.
 */
interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class TtlCache<V> {
  private readonly store = new Map<string, Entry<V>>();
  private readonly inflight = new Map<string, Promise<V>>();

  constructor(
    private readonly maxEntries = 500,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  /** Return cached value, or run `load` once even if many callers ask concurrently. */
  async getOrLoad(key: string, ttlFor: (v: V) => number, load: () => Promise<V>): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = load()
      .then((v) => {
        const ttl = ttlFor(v);
        if (ttl > 0) this.set(key, v, ttl);
        return v;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  clear(): void {
    this.store.clear();
    this.inflight.clear();
  }
}
