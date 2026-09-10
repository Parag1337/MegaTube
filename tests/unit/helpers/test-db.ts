/**
 * Test-DB helper: creates a fresh SQLite database with the full app schema
 * by replaying every migration file in chronological order.
 *
 * Returns a Prisma-compatible `file:` URL (relative to the project root,
 * which is also the cwd when tests run).
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'prisma/migrations');
const TEST_DIR = path.resolve(process.cwd(), 'data/test');

function removeDbFiles(file: string): void {
  for (const ext of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(file + ext);
    } catch {
      // not present
    }
  }
}

export function createTestDatabase(name: string): { url: string; close: () => void } {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const file = path.join(TEST_DIR, `${name}.db`);
  removeDbFiles(file);

  const db = new Database(file);
  const migrations = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((d) => /^\d{14}_/.test(d))
    .sort();
  if (migrations.length === 0) {
    throw new Error(`No migrations found in ${MIGRATIONS_DIR}`);
  }
  for (const m of migrations) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, m, 'migration.sql'), 'utf8');
    db.exec(sql);
  }
  db.close();

  return {
    url: `file:./data/test/${name}.db`,
    close: () => removeDbFiles(file),
  };
}
