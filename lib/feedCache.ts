/**
 * Phase 2 perf: tiny in-process TTL cache for recomputed server data.
 *
 * WHY IT IS SAFE
 * - Keys always include the website user id: entries can never leak
 *   between users (user A's key never matches user B's lookup).
 * - Home pages embed the daily seed in the key, so rotation never serves
 *   stale days.
 * - Staleness is bounded by TTL (30s) AND precise invalidation: history
 *   writes (recordWatch/remove/clear), creator mutations, and sync
 *   completion call invalidateUserFeedData(userId). Watchlist/saved
 *   mutations are intentionally NOT invalidated - they do not appear in
 *   the cached data.
 * - Bounded size (simple oldest-first eviction past MAX_ENTRIES) so a
 *   many-user instance cannot grow memory without bound.
 * - No Redis, no new service, no architecture change: a Map in the server
 *   process, exactly like the existing in-process session/progress maps.
 */

const CACHE_TTL_MS = 30_000;
const MAX_ENTRIES = 300;

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

const cache = new Map<string, CacheEntry<unknown>>();

export function homeFeedCacheKey(userId: string, page: number, seed: string): string {
  return `home:${userId}:${page}:${seed}`;
}

/** Video-page recommendation pools for one (user, video) pair. */
export function videoPoolsCacheKey(userId: string, videoId: number): string {
  return `pools:${userId}:${videoId}`;
}

/**
 * Phase 3A: per-page taken-id lists for Home feed reconstruction. Page N
 * excludes pages 1..N-1; caching those id sets means a first visit to page
 * N only fetches page N's own pools instead of rebuilding every previous
 * page's pools. Same TTL/invalidation as feed pages.
 */
export function homeTakenCacheKey(userId: string, page: number, seed: string): string {
  return `hometaken:${userId}:${page}:${seed}`;
}

export function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value as T;
}

export function setCached<T>(key: string, value: T): void {
  if (cache.size >= MAX_ENTRIES && !cache.has(key)) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
}

/** Back-compat aliases for the home-feed call sites. */
export const getHomeFeedCached = getCached;
export const setHomeFeedCached = setCached;

/**
 * Drop a user's cached feed/pool data (home pages, taken sets, video
 * pools). Without a userId, everything (used by tests). Never throws.
 */
export function invalidateUserFeedData(userId?: string): void {
  try {
    if (userId === undefined) {
      cache.clear();
      return;
    }
    for (const key of cache.keys()) {
      if (
        key.startsWith(`home:${userId}:`) ||
        key.startsWith(`hometaken:${userId}:`) ||
        key.startsWith(`pools:${userId}:`)
      ) {
        cache.delete(key);
      }
    }
  } catch {
    // ignore - caching is advisory
  }
}

/** Back-compat alias. */
export const invalidateHomeFeed = invalidateUserFeedData;

/** Drop one video's cached pools (e.g. after its creator assignment changes). */
export function invalidateVideoPools(userId: string, videoId: number): void {
  try {
    cache.delete(videoPoolsCacheKey(userId, videoId));
  } catch {
    // ignore - caching is advisory
  }
}
