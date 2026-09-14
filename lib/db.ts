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

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const databaseUrl = process.env.DATABASE_URL;

function createClient(): PrismaClient {
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set (expected a postgresql:// connection string).',
    );
  }
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
