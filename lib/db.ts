/**
 * Shared Prisma client.
 *
 * Uses the PostgreSQL driver adapter (Prisma 7 standard SQL workflow).
 * DATABASE_URL points at local PostgreSQL for development/tests and at
 * Neon (pooled URL) in production. A single instance is reused across
 * the app.
 */

import { PrismaClient } from '../generated/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const databaseUrl = process.env.DATABASE_URL;

function createClient(): PrismaClient {
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set (expected a postgresql:// connection string).',
    );
  }
  // Phase 2 perf: a page load fans out to ~50 concurrent queries (24 thumb
  // requests x auth+video lookups plus the page's own queries). The pg
  // default pool (max 10) queues them in ~5 waves; 25 lets a full page run
  // in ~2 waves. Safe: DATABASE_URL is the Neon pooled (PgBouncer)
  // endpoint, which multiplexes client connections. Overridable for
  // diagnosis via PG_POOL_MAX. Measured, not blind: burst-thumb timings
  // (see Phase 2 report).
  const poolMax = Number(process.env.PG_POOL_MAX) || 25;
  const pool = new Pool({ connectionString: databaseUrl, max: poolMax });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
