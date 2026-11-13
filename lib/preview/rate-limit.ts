/**
 * Phase A / P-01: per-process rate limiting for preview endpoints.
 *
 * The limiter is intentionally small and dependency-free:
 *  - fixed-window counters in a bounded in-memory Map;
 *  - keyed by the SERVER-DERIVED authenticated user id + endpoint scope —
 *    never by a query parameter, video id or `want` value, so changing the
 *    URL cannot dodge a limit;
 *  - no database access (the limit check must not add load);
 *  - per-process only: each Next.js instance keeps its own counters and a
 *    restart clears them. This is documented in the Phase A report.
 *
 * Expensive preview work is owner-scoped and authenticated before a limit is
 * consumed (route handlers call `getCurrentUser()` first). Unauthenticated
 * requests therefore receive 401 from the existing service auth matrix and
 * never reach preview work.
 */

import { NextResponse } from 'next/server';

export type PreviewRateLimitScope =
  | 'meta'
  | 'asset'
  | 'admin-generate'
  | 'admin-retry'
  | 'admin-settings'
  | 'admin-stats'
  | 'admin-delete-all';

export interface PreviewRateLimitConfig {
  /** Requests allowed per fixed window. */
  limit: number;
  /** Fixed window length in milliseconds. */
  windowMs: number;
}

const WINDOW_MS = 60_000;

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(Math.floor(raw), min), max);
}

/**
 * Conservative defaults, documented in the Phase A report:
 *  - meta: 600/min = one request for every video in a ~600-video library in
 *    one minute; a single cold hover polls at 0.5 req/s, so normal use is an
 *    order of magnitude below the cap.
 *  - asset: 1200/min (20 req/s) for clip range requests, sprites and VTT.
 *  - admin generate: 4/min (whole-library scan) — stops button/script spam.
 *  - admin retry: 10/min; admin settings: 30/min; admin stats: 120/min
 *    (the dashboard polls every ~5 s = 12/min).
 */
export function previewRateLimitConfig(scope: PreviewRateLimitScope): PreviewRateLimitConfig {
  switch (scope) {
    case 'meta':
      return { limit: intEnv('PREVIEW_RATE_LIMIT_META_PER_MINUTE', 600, 1, 100_000), windowMs: WINDOW_MS };
    case 'asset':
      return { limit: intEnv('PREVIEW_RATE_LIMIT_ASSET_PER_MINUTE', 1200, 1, 100_000), windowMs: WINDOW_MS };
    case 'admin-generate':
      return {
        limit: intEnv('PREVIEW_RATE_LIMIT_ADMIN_GENERATE_PER_MINUTE', 4, 1, 10_000),
        windowMs: WINDOW_MS,
      };
    case 'admin-retry':
      return {
        limit: intEnv('PREVIEW_RATE_LIMIT_ADMIN_RETRY_PER_MINUTE', 10, 1, 10_000),
        windowMs: WINDOW_MS,
      };
    case 'admin-settings':
      return {
        limit: intEnv('PREVIEW_RATE_LIMIT_ADMIN_SETTINGS_PER_MINUTE', 30, 1, 10_000),
        windowMs: WINDOW_MS,
      };
    case 'admin-stats':
      return {
        limit: intEnv('PREVIEW_RATE_LIMIT_ADMIN_STATS_PER_MINUTE', 120, 1, 10_000),
        windowMs: WINDOW_MS,
      };
    case 'admin-delete-all':
      return {
        limit: intEnv('PREVIEW_RATE_LIMIT_ADMIN_DELETE_ALL_PER_MINUTE', 2, 1, 100),
        windowMs: WINDOW_MS,
      };
  }
}

/** Kill switch for tests/emergency operations; defaults to enabled. */
export function previewRateLimitsDisabled(): boolean {
  return process.env.PREVIEW_RATE_LIMIT_DISABLED === '1';
}

/** Hard cap on tracked user/scope buckets (prevents unbounded memory). */
export function previewRateLimitMaxKeys(): number {
  return intEnv('PREVIEW_RATE_LIMIT_MAX_KEYS', 10_000, 100, 1_000_000);
}

export interface PreviewRateLimitDecision {
  allowed: boolean;
  scope: PreviewRateLimitScope;
  limit: number;
  remaining: number;
  /** Seconds until the current window resets; 0 when allowed. */
  retryAfterSec: number;
  resetAt: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

function pruneExpired(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

function enforceKeyBudget(now: number): void {
  const maxKeys = previewRateLimitMaxKeys();
  if (buckets.size <= maxKeys) return;
  // Drop expired windows first, then the oldest insertion order. Bounded
  // memory matters more than preserving a stale counter for one user.
  pruneExpired(now);
  while (buckets.size > maxKeys) {
    const oldest = buckets.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    buckets.delete(oldest);
  }
}

/**
 * Consume one token for `userId` + `scope`. Pure in-memory; never throws.
 * `now` is injectable so tests can exercise window reset without sleeping.
 */
export function consumePreviewRateLimit(
  userId: string,
  scope: PreviewRateLimitScope,
  now: number = Date.now(),
): PreviewRateLimitDecision {
  const config = previewRateLimitConfig(scope);
  if (previewRateLimitsDisabled()) {
    return {
      allowed: true,
      scope,
      limit: config.limit,
      remaining: config.limit,
      retryAfterSec: 0,
      resetAt: now + config.windowMs,
    };
  }

  // The route layer only calls this with an authenticated id. If that ever
  // changes, a shared anonymous bucket is safer than a missing key.
  const identity = userId.length > 0 ? userId : 'anonymous';
  const key = `${scope}:${identity}`;

  let bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + config.windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;

  enforceKeyBudget(now);

  const allowed = bucket.count <= config.limit;
  return {
    allowed,
    scope,
    limit: config.limit,
    remaining: Math.max(0, config.limit - bucket.count),
    retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    resetAt: bucket.resetAt,
  };
}

/** HTTP 429 response with a standards-compliant `Retry-After` header. */
export function previewRateLimitResponse(decision: PreviewRateLimitDecision): NextResponse {
  return NextResponse.json(
    {
      error: 'Too many preview requests. Please retry shortly.',
      scope: decision.scope,
      retryAfter: decision.retryAfterSec,
    },
    {
      status: 429,
      headers: {
        'Retry-After': String(decision.retryAfterSec),
        'Cache-Control': 'no-store',
        'X-RateLimit-Limit': String(decision.limit),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(Math.ceil(decision.resetAt / 1000)),
      },
    },
  );
}

/**
 * Route-handler guard: returns a 429 response when the limit is exceeded,
 * otherwise `null` so the handler can continue. Call after authentication.
 */
export function enforcePreviewRateLimit(
  userId: string,
  scope: PreviewRateLimitScope,
  now: number = Date.now(),
): NextResponse | null {
  const decision = consumePreviewRateLimit(userId, scope, now);
  return decision.allowed ? null : previewRateLimitResponse(decision);
}

/** Test hook: clear all buckets (also useful for long-lived dev reloads). */
export function __resetPreviewRateLimitsForTests(): void {
  buckets.clear();
}

/** Test/diagnostic hook: number of tracked user+scope counters. */
export function previewRateLimitBucketCount(): number {
  return buckets.size;
}
