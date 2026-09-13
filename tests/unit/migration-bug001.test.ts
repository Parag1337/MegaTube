/**
 * BUG-001 regression: the creator_user_ownership migration must succeed on a
 * database that already contains Creator rows (the original INSERT omitted
 * userId, causing NOT NULL constraint failures).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const TEST_DIR = path.resolve(process.cwd(), 'data/test');
const MIGRATIONS_DIR = path.resolve(process.cwd(), 'prisma/migrations');

function removeDbFiles(file: string): void {
  for (const ext of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(file + ext);
    } catch {
      // not present
    }
  }
}

test('creator_user_ownership migration succeeds with pre-existing Creator rows', async () => {
  const name = 'bug001-migration-unit';
  const file = path.join(TEST_DIR, `${name}.db`);
  removeDbFiles(file);

  // Apply only the migrations BEFORE creator_user_ownership so we have a
  // populated Creator table when the target migration runs.
  const db = new Database(file);
  const migrations = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((d) => /^\d{14}_/.test(d))
    .sort();

  const target = '20260911000000_creator_user_ownership';
  const targetIdx = migrations.indexOf(target);
  assert.ok(targetIdx >= 0, 'target migration must exist');

  for (let i = 0; i < targetIdx; i++) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, migrations[i], 'migration.sql'), 'utf8');
    db.exec(sql);
  }

  // Seed a user, mega account, video, and creator in the pre-migration schema.
  db.prepare(
    `INSERT INTO "User" ("id", "email", "passwordHash", "createdAt", "updatedAt") VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
  ).run('user-bug001', 'bug001@example.com', 'hash');
  db.prepare(
    `INSERT INTO "MegaAccount" ("userId", "label", "megaEmail", "encryptedSession", "status", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  ).run('user-bug001', 'Acc', 'bug001@mega.test', 'session', 'CONNECTED');
  const accountId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare(
    `INSERT INTO "Creator" ("name", "slug", "createdAt", "updatedAt") VALUES (?, ?, datetime('now'), datetime('now'))`,
  ).run('Bug Creator', 'bug-creator');
  const creatorId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare(
    `INSERT INTO "Video" ("megaFilename", "title", "slug", "creatorId", "megaAccountId", "fileSize", "mimeType", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  ).run('Bug Creator - Video.mp4', 'Video', 'bug-video', creatorId, accountId, 1000, 'video/mp4');

  // Apply the target migration.
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, target, 'migration.sql'), 'utf8');
  db.exec(sql);
  db.close();

  // Reopen and verify the schema and data survived.
  const db2 = new Database(file);
  const creator = db2.prepare('SELECT id, userId, name, slug FROM Creator WHERE id = ?').get(creatorId);
  assert.equal(creator.userId, 'user-bug001', 'existing creator must be re-owned by the video owner');
  assert.equal(creator.name, 'Bug Creator');
  assert.equal(creator.slug, 'bug-creator');

  const video = db2.prepare('SELECT id, creatorId FROM Video WHERE id = ?').get(1);
  assert.equal(video.creatorId, creatorId, 'Video -> Creator relationship must be preserved');

  const tables = db2.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='Creator'").get();
  assert.ok(tables.sql.includes('"userId" TEXT NOT NULL'), 'new schema must include userId');

  const indexes = db2.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='Creator_userId_slug_key'").get();
  assert.ok(indexes, 'unique index on (userId, slug) must exist');

  db2.close();
  removeDbFiles(file);
});
