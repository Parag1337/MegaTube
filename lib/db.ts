/**
 * Shared Prisma client.
 *
 * Uses the PostgreSQL driver adapter (Prisma 7 standard SQL workflow).
 * DATABASE_URL points at local PostgreSQL for development/tests and at the
 * Render Managed PostgreSQL (Internal Database URL) in production. A single
 * instance is reused across the app.
 */

import { createHash } from 'node:crypto';
import { PrismaClient } from '../generated/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { perfTraceEnabled, startPerfTrace } from './observe';

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  /**
   * Opt-in per-query counter hook (benchmark harnesses / diagnostics).
   * Called synchronously from the pg pool's query wrapper — one call per
   * SQL statement, covering model operations, raw $queryRaw/$executeRaw and
   * implicit transaction statements. Set it from test/bench code, never in
   * request paths.
   */
  __dbQueryCounterHook?: (info: { sql: string }) => void;
};

/** Temporarily install the per-query counter (bench harnesses). Returns unset. */
export function withDbQueryCounter<T>(
  fn: (info: { sql: string }) => void,
  run: () => Promise<T>,
): Promise<T> {
  const key = '__dbQueryCounterHook' as const;
  const prev = globalForPrisma[key];
  globalForPrisma[key] = fn;
  return run().finally(() => {
    globalForPrisma[key] = prev;
  });
}

const databaseUrl = process.env.DATABASE_URL;

/**
 * Credential-free identity of the configured database.
 *
 * Web and worker logs can compare this value to prove they point at the same
 * host/port/database without printing any part of DATABASE_URL. Credentials,
 * query parameters and the password never enter the digest.
 */
export function databaseIdentityFingerprint(): string {
  if (!databaseUrl) return 'unset';
  try {
    const url = new URL(databaseUrl);
    const identity = `${url.hostname}:${url.port || '5432'}${url.pathname}`;
    return createHash('sha256').update(identity).digest('hex').slice(0, 12);
  } catch {
    return 'invalid';
  }
}

/** True when DATABASE_URL points somewhere other than this machine. */
export function isRemoteDatabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return !(host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.sock'));
  } catch {
    return false;
  }
}

/**
 * Connection warm-keepalive (localhost performance investigation).
 *
 * Measured against the remote DATABASE_URL actually in use: one round trip
 * costs ~400ms and establishing a NEW connection costs 4-5s. A page load
 * fans out dozens of queries, so a cold pool pays that connect cost N times
 * during the first burst after server start (and every idle period, if the
 * remote endpoint also suspends the compute). The pool itself keeps idle
 * connections open; what is missing is (a) warming at startup so the first
 * burst never pays connect costs, (b) a periodic ping so a remote endpoint
 * that suspends idle work stays awake, and (c) re-establishment after a
 * dropped connection.
 *
 * Config (all env-tunable, no behavioral effect on localhost):
 *   PG_KEEPALIVE_MIN          warm connections to maintain (default 2, 0=off)
 *   PG_KEEPALIVE_INTERVAL_MS  ping interval (default 60000)
 */
function startPoolKeepalive(pool: Pool, poolMax: number): void {
  const min = Number(process.env.PG_KEEPALIVE_MIN ?? 2);
  const intervalMs = Number(process.env.PG_KEEPALIVE_INTERVAL_MS ?? 60_000);
  if (!min || min <= 0 || !intervalMs || intervalMs <= 0) return;

  let running = false;
  const warmOnce = async (label: string) => {
    if (running) return;
    running = true;
    try {
      const established = pool.totalCount - pool.waitingCount;
      const need = Math.max(0, Math.min(min, poolMax) - established);
      // Each ping checks out a connection; established connections stay in
      // the pool afterwards (pg never closes idle clients by default).
      await Promise.all(
        Array.from({ length: Math.max(need, 1) }, () =>
          pool.query('SELECT 1').catch(() => {}),
        ),
      );
    } catch {
      // Keepalive must never crash the app; the next interval retries.
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void warmOnce('interval'), intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  // Warm immediately at startup: the first page load must not pay 4-5s
  // connection establishment per concurrent query.
  void warmOnce('startup');
}

function createClient(): PrismaClient {
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set (expected a postgresql:// connection string).',
    );
  }
  // Phase 2 perf: a page load fans out to ~50 concurrent queries (24 thumb
  // requests x auth+video lookups plus the page's own queries). The pg
  // default pool (max 10) queues them in ~5 waves; 25 lets a full page run
  // in ~2 waves. 25 lets a full page run in ~2 waves; safe on the Render
  // Managed PostgreSQL limit (max_connections=100). Overridable for
  // diagnosis via PG_POOL_MAX. Measured, not blind: burst-thumb timings
  // (see Phase 2 report).
  const poolMax = Number(process.env.PG_POOL_MAX) || 25;
  // Remote endpoints make each connection expensive (4-5s measured against
  // the previous remote provider; Render internal-network connections are
  // cheap but the hold is harmless there), but pg's default
  // idleTimeoutMillis (10s) evicts idle connections long before the
  // keepalive's next ping - the warm-connection
  // goal would be defeated. For remote DATABASE_URLs, hold connections a
  // little longer than the keepalive interval so the warmed ones persist
  // (bounded staleness, not forever-idle sockets). Local DBs keep pg's
  // default: connections are cheap there.
  const keepaliveIntervalMs = Number(process.env.PG_KEEPALIVE_INTERVAL_MS ?? 60_000);
  const remote = isRemoteDatabaseUrl(databaseUrl);
  const pool = new Pool({
    connectionString: databaseUrl,
    max: poolMax,
    // Prisma maps TIMESTAMP columns to UTC dates. Pin every session to UTC so
    // DB-side defaults/`now()` can never store local wall-clock time into
    // those columns (a non-UTC server would otherwise skew leases/retries).
    options: '-c timezone=UTC',
    ...(remote
      ? { idleTimeoutMillis: Math.max(keepaliveIntervalMs + 5_000, 65_000) }
      : {}),
  });
  startPoolKeepalive(pool, poolMax);

  // DX guard: a remote DATABASE_URL (e.g. a cloud provider) turns every query
  // into a WAN round trip. Development against a remote database is a common
  // cause of "localhost feels slow" - surface it once, with the escape hatch
  // (.env.local override), instead of silently absorbing the latency.
  if (process.env.NODE_ENV === 'development' && isRemoteDatabaseUrl(databaseUrl)) {
    console.warn(
      '[db] DATABASE_URL points at a remote host; every query pays network round-trip latency. ' +
        'For local development create .env.local with a local PostgreSQL URL.',
    );
  }

  const globalRef = globalForPrisma as unknown as {
    __dbQueryCounterHook?: (info: { sql: string }) => void;
  };
  // Phase 3 instrumentation: count queries where they actually execute —
  // the pg pool. Every Prisma query (model operations AND raw
  // $queryRaw/$executeRaw, plus implicit transaction statements) goes
  // through pool.query, so this counts synchronously and reliably, unlike
  // the engine's async 'query' log events which can land after the
  // measuring window (observed under-counting on concurrent waves).
  // Overhead when no hook is installed: one property read per query.
  const poolQuery = pool.query.bind(pool);
  (pool as unknown as { query: typeof pool.query }).query = ((...args: Parameters<typeof pool.query>) => {
    const hook = globalRef.__dbQueryCounterHook;
    if (hook) {
      const first = args[0] as string | { text?: string } | undefined;
      hook({ sql: typeof first === 'string' ? first : (first?.text ?? '') });
    }
    return poolQuery(...args);
  }) as typeof pool.query;

  const adapter = new PrismaPg(pool);
  const client = new PrismaClient({ adapter });

  if (perfTraceEnabled()) {
    // PERF_TRACE: per-query duration logging (model, action, ms - never
    // argument values, which could contain user data) plus pool gauges for
    // saturation evidence. Zero cost when disabled.
    startPerfTrace(pool);
    const traced = client.$extends({
      query: {
        $allModels: {
          $allOperations: async ({ model, operation, args, query }) => {
            const t0 = performance.now();
            const result = await query(args);
            const ms = Math.round((performance.now() - t0) * 10) / 10;
            const minMs = Number(process.env.PERF_TRACE_MIN_QUERY_MS) || 0;
            if (ms >= minMs) {
              console.log(
                JSON.stringify({ t: 'dbq', model, op: operation, ms }),
              );
            }
            return result;
          },
        },
      },
    });
    return traced as unknown as PrismaClient;
  }

  return client;
}

export const prisma = globalForPrisma.prisma ?? createClient();

// Global dedup in ALL runtimes (not just dev): PERF_TRACE measured the
// production (Turbopack) build instantiating TWO lib/db module instances,
// i.e. two pg pools (max 25 conns each), two MEGA session caches and two
// auth memos - the second pool sat idle while the first served every query.
// Sharing one client across module instances keeps connection counts and
// caches unified. (Dev keeps the same semantics it always had; HMR still
// requires a dev-server restart after schema changes.)
globalForPrisma.prisma = prisma;
