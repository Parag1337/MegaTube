/**
 * Shared Prisma client.
 *
 * Uses the better-sqlite3 driver adapter (Prisma 7 standard SQL workflow).
 * A single instance is reused across the app; switch the adapter + provider
 * to move to PostgreSQL later.
 */

import { PrismaClient } from '../generated/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const databaseUrl =
  process.env.DATABASE_URL ?? 'file:./data/database/app.db';

function createClient(): PrismaClient {
  const adapter = new PrismaBetterSqlite3({ url: databaseUrl });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}