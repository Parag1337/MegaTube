/**
 * Phase 5.1 remediation: short-lived single-flight cache for dashboard
 * statistics.
 *
 * The Settings panel polls `/api/preview/admin/stats` every ~5 seconds. The
 * underlying statistics require filesystem verification of every preview
 * artifact, so computing them on every poll is O(library) disk work. This
 * module provides:
 *
 *  - a TTL cache (default 20 s) so most polls are pure memory reads;
 *  - single-flight refresh so concurrent polls perform one scan, not N;
 *  - explicit invalidation when an artifact is published, removed or evicted;
 *  - a minimum refresh interval that keeps an invalidation storm (e.g. a
 *    400-video backlog completing one job at a time) from turning into the
 *    same per-poll scan the cache exists to avoid.
 *
 * Staleness is bounded by the TTL and is acceptable for a dashboard; it is
 * never used for generation decisions, which read the sidecar/job row
 * directly.
 */

export interface StatsCacheMetrics {
  hits: number;
  misses: number;
  refreshes: number;
  coalesced: number;
  invalidations: number;
}

const entries = new Map<string, { at: number; value: unknown }>();
const invalidatedAt = new Map<string, number>();
const inflight = new Map<string, Promise<unknown>>();

const metrics: StatsCacheMetrics = {
  hits: 0,
  misses: 0,
  refreshes: 0,
  coalesced: 0,
  invalidations: 0,
};

export interface StatsCacheOptions {
  ttlMs: number;
  /** Explicit invalidations cannot force a refresh faster than this. */
  minRefreshMs: number;
  now?: () => number;
}

export async function getCachedStats<T>(
  key: string,
  options: StatsCacheOptions,
  loader: () => Promise<T>,
): Promise<T> {
  const now = options.now?.() ?? Date.now();
  const entry = entries.get(key);
  const invalidated = invalidatedAt.get(key) ?? 0;
  const fresh = entry !== undefined && now - entry.at < options.ttlMs && invalidated <= entry.at;
  if (fresh) {
    metrics.hits++;
    return entry.value as T;
  }
  if (entry !== undefined) {
    const sinceRefresh = now - entry.at;
    const invalidatedButThrottled =
      invalidated > entry.at && sinceRefresh < options.minRefreshMs;
    if (invalidatedButThrottled) {
      metrics.hits++;
      return entry.value as T;
    }
  }

  const pending = inflight.get(key);
  if (pending) {
    metrics.coalesced++;
    return pending as Promise<T>;
  }

  metrics.misses++;
  const refresh = loader()
    .then((value) => {
      entries.set(key, { at: options.now?.() ?? Date.now(), value });
      invalidatedAt.delete(key);
      metrics.refreshes++;
      return value;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, refresh as Promise<unknown>);
  return refresh;
}

/**
 * Mark cached statistics stale. With no key, every user entry is marked.
 * The next request refreshes once the minimum refresh interval has elapsed;
 * until then the previous result is served (bounded staleness).
 */
export function invalidatePreviewStatsCache(key?: string): void {
  metrics.invalidations++;
  if (key === undefined) {
    const now = Date.now();
    for (const k of entries.keys()) invalidatedAt.set(k, now);
    for (const k of inflight.keys()) invalidatedAt.set(k, now);
    return;
  }
  invalidatedAt.set(key, Date.now());
}

export function previewStatsCacheMetrics(): StatsCacheMetrics {
  return { ...metrics };
}

/** Test hook: drop all cached values and counters. */
export function __resetPreviewStatsCacheForTests(): void {
  entries.clear();
  invalidatedAt.clear();
  inflight.clear();
  metrics.hits = 0;
  metrics.misses = 0;
  metrics.refreshes = 0;
  metrics.coalesced = 0;
  metrics.invalidations = 0;
}
