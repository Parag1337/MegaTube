/**
 * Short-TTL in-process memo for authentication user resolution
 * (localhost performance investigation).
 *
 * Measured: an authenticated page load issues ~50 auth lookups (1 per page
 * request + 2 per thumbnail request x 24 thumbnails). Against a remote
 * database each lookup is a network round trip (~400ms measured on the
 * deployed DATABASE_URL), so the burst dominates page-load latency.
 *
 * Design:
 *   - TTL result cache keyed by session token / Clerk user id. Values are
 *     immutable identifiers (id, email, createdAt) - never permissions.
 *   - In-flight promise sharing: 24 concurrent thumbnail requests miss the
 *     TTL cache simultaneously, so they must share ONE lookup promise.
 *   - Logout/invalidation clears the entry for the logged-out token. The
 *     remaining window is the TTL itself: a server-side session deletion
 *     that does not go through logout() (e.g. direct DB write) stays valid
 *     for at most AUTH_MEMO_TTL_MS (default 10s, 0 disables the memo).
 *     This mirrors the existing tolerance to cookie-based state and is
 *     documented in docs/LOCALHOST-PERFORMANCE-INVESTIGATION.md.
 *
 * No secrets are stored: only the UserRecord projection the app already
 * returns from getCurrentUser.
 */

export interface MemoValue<T> {
  value: T;
  expiresAt: number;
}

export class TtlMemo<T> {
  private cache = new Map<string, MemoValue<T>>();
  private inflight = new Map<string, Promise<T>>();
  private readonly ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  /** Resolve via memo; concurrent callers share one in-flight promise. */
  async resolve(key: string, lookup: () => Promise<T>): Promise<T> {
    if (this.ttlMs <= 0) return lookup();
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > now) return hit.value;

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = lookup()
      .then((value) => {
        if (this.inflight.get(key) === promise) this.inflight.delete(key);
        this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
        return value;
      })
      .catch((err) => {
        if (this.inflight.get(key) === promise) this.inflight.delete(key);
        throw err;
      });
    this.inflight.set(key, promise);
    return promise;
  }

  /** Invalidate one key (logout). */
  invalidate(key: string): void {
    this.cache.delete(key);
    // An in-flight lookup for a key being invalidated may still resolve; its
    // TTL entry then lives at most TTL_MS - acceptable per the contract
    // above (documented).
  }

  /** Drop every cached entry (test isolation). */
  clear(): void {
    this.cache.clear();
    this.inflight.clear();
  }

  get ttl(): number {
    return this.ttlMs;
  }
}

export function authMemoTtlMs(): number {
  const raw = Number(process.env.AUTH_MEMO_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 10_000;
}
