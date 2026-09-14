/**
 * Test-DB helper: creates a fresh, isolated PostgreSQL database per test
 * file by replaying every migration file in chronological order.
 *
 * Isolation rules:
 *   - NEVER touches data/database/app.db (the preserved SQLite rollback DB).
 *   - NEVER touches the normal development database ("megatube").
 *   - Each call creates a new database named megatube_test_<name>_<rand>
 *     on the local PostgreSQL server, applies all prisma/migrations/*.sql,
 *     and returns a postgresql:// URL for DATABASE_URL.
 *   - close() DROPs the throwaway database (WITH FORCE).
 *
 * The API stays SYNCHRONOUS like the old SQLite helper (call sites do
 * `const db = createTestDatabase('x')` at module scope and `db.close()`
 * inside sync after() hooks), so all database work runs through `psql`
 * via spawnSync. Connection parameters come from TEST_DATABASE_URL or
 * DATABASE_URL. The local dev role has CREATEDB, so no superuser needed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'prisma/migrations');

export function createTestDatabase(name: string): { url: string; close: () => void } {
  const baseUrl =
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://megatube:megatube-dev-only@localhost:5433/megatube?schema=public';

  const u = new URL(baseUrl);
  const host = u.hostname || 'localhost';
  const port = u.port || '5432';
  const user = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);

  // psql env: password via PGPASSWORD (never on the command line).
  const psqlEnv = {
    ...process.env,
    PGPASSWORD: password,
    PGHOST: host,
    PGPORT: port,
    PGUSER: user,
  };

  function psql(args: string[], database: string): void {
    const res = spawnSync('psql', ['-v', 'ON_ERROR_STOP=1', '-d', database, ...args], {
      env: psqlEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    if (res.status !== 0) {
      throw new Error(
        `psql ${args.join(' ')} failed (exit ${res.status}):\n${res.stderr ?? res.stdout ?? ''}`,
      );
    }
  }

  const safeName = name.replace(/[^a-zA-Z0-9_]/g, '_');
  const dbName = `megatube_test_${safeName}_${randomBytes(4).toString('hex')}`;

  // 1. Create the throwaway database (admin via the maintenance DB).
  psql(['-c', `CREATE DATABASE "${dbName}"`], 'postgres');

  // 2. Apply every migration in order.
  const migrations = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((d) => /^\d{14}_/.test(d))
    .sort();
  if (migrations.length === 0) {
    throw new Error(`No migrations found in ${MIGRATIONS_DIR}`);
  }
  for (const m of migrations) {
    psql(['-f', path.join(MIGRATIONS_DIR, m, 'migration.sql')], dbName);
  }

  const url = `${u.protocol}//${u.username}${password ? `:${u.password}` : ''}@${host}:${port}/${dbName}${u.search}`;

  let closed = false;
  return {
    url,
    close: () => {
      if (closed) return;
      closed = true;
      try {
        psql(['-c', `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`], 'postgres');
      } catch {
        // Test process teardown ordering must never fail the suite; any
        // leftover megatube_test_* databases are disposable by name.
      }
    },
  };
}
