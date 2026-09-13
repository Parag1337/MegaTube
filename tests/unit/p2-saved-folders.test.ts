/**
 * P2.1 corrections regression tests: Saved Video folders + Clear Watchlist.
 *
 * Covers (isolated DB built from the repo migrations):
 *   folders: create / duplicate / invalid / list counts / rename /
 *     rename-duplicate / move into folder / move back to uncategorized /
 *     filtered listing / delete returns videos to uncategorized (never
 *     unsaves) / isolation across users
 *   watchlist: clear removes all + reports count, leaves saved/history alone
 *   migration: pre-folder saved rows survive with NULL folderId; folderId
 *     column + SavedFolder table exist on fresh DBs
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createTestDatabase } from './helpers/test-db';

const db = createTestDatabase('p2-saved-folders-unit');
process.env.DATABASE_URL = db.url;
process.env.VIDEOS_PER_PAGE = '5';

let prisma: typeof import('@/lib/db')['prisma'];
let personal: typeof import('@/lib/personal');
let foldersLib: typeof import('@/lib/savedFolders');
let MEGA_ACCOUNT_STATUSES: typeof import('@/lib/megaAccounts')['MEGA_ACCOUNT_STATUSES'];

after(() => {
  db.close();
});

const PASSWORD_HASH =
  'pbkdf2:sha256:100000:00000000000000000000000000000000:000000000000000000000000000000000000000000000000000000000000000000';

async function makeUser(email: string) {
  return prisma.user.create({ data: { email, passwordHash: PASSWORD_HASH } });
}

async function makeAccount(userId: string, email: string, status: string) {
  return prisma.megaAccount.create({
    data: { userId, label: `Acc ${email}`, megaEmail: email, encryptedSession: 's', status },
  });
}

async function makeVideo(accountId: number | null, slug: string, title: string) {
  return prisma.video.create({
    data: {
      megaAccountId: accountId,
      megaFilename: `${title}.mp4`,
      title,
      slug,
      creatorAssignment: 'none',
      fileSize: BigInt(1000),
      mimeType: 'video/mp4',
    },
  });
}

before(async () => {
  ({ prisma } = await import('@/lib/db'));
  personal = await import('@/lib/personal');
  foldersLib = await import('@/lib/savedFolders');
  ({ MEGA_ACCOUNT_STATUSES } = await import('@/lib/megaAccounts'));
});

test('folders: create, duplicate rejected, invalid rejected', async () => {
  const u = await makeUser('p2f-a@example.com');
  const created = await foldersLib.createSavedFolder(u.id, 'Tour Videos');
  assert.ok(created && !('duplicate' in created));
  assert.equal(created.name, 'Tour Videos');
  assert.deepEqual(await foldersLib.createSavedFolder(u.id, 'Tour Videos'), { duplicate: true });
  assert.deepEqual(await foldersLib.createSavedFolder(u.id, '  Tour Videos  '), { duplicate: true });
  assert.equal(await foldersLib.createSavedFolder(u.id, '   '), null);
  assert.equal(await foldersLib.createSavedFolder(u.id, ''), null);
  assert.equal(await foldersLib.createSavedFolder(u.id, 'x'.repeat(101)), null);
  // Same name is fine for a different user.
  const other = await makeUser('p2f-b@example.com');
  const otherCreated = await foldersLib.createSavedFolder(other.id, 'Tour Videos');
  assert.ok(otherCreated && !('duplicate' in otherCreated));
});

test('folders: list has counts in creation order', async () => {
  const u = await makeUser('p2f-c@example.com');
  const acc = await makeAccount(u.id, 'p2f-c@mega.test', MEGA_ACCOUNT_STATUSES.SYNCED);
  const v1 = await makeVideo(acc.id, 'p2f-c1', 'C One');
  const v2 = await makeVideo(acc.id, 'p2f-c2', 'C Two');
  const f1 = await foldersLib.createSavedFolder(u.id, 'First');
  const f2 = await foldersLib.createSavedFolder(u.id, 'Second');
  assert.ok(f1 && !('duplicate' in f1) && f2 && !('duplicate' in f2));
  await personal.saveVideo(u.id, v1.id);
  await personal.saveVideo(u.id, v2.id);
  await foldersLib.moveSavedVideo(u.id, v1.id, f1.id);
  const list = await foldersLib.listSavedFolders(u.id);
  assert.deepEqual(list.map((f) => f.name), ['First', 'Second']);
  assert.deepEqual(list.map((f) => f.videoCount), [1, 0]);
});

test('folders: rename ok / not-found / invalid / duplicate', async () => {
  const u = await makeUser('p2f-d@example.com');
  const f = await foldersLib.createSavedFolder(u.id, 'Old Name');
  assert.ok(f && !('duplicate' in f));
  await foldersLib.createSavedFolder(u.id, 'Taken');
  assert.equal(await foldersLib.renameSavedFolder(u.id, f.id, 'New Name'), 'ok');
  assert.equal(await foldersLib.renameSavedFolder(u.id, f.id, '   '), 'invalid');
  assert.equal(await foldersLib.renameSavedFolder(u.id, f.id, 'Taken'), 'duplicate');
  assert.equal(await foldersLib.renameSavedFolder(u.id, 987654321, 'Ghost'), 'not-found');
  const other = await makeUser('p2f-d2@example.com');
  assert.equal(await foldersLib.renameSavedFolder(other.id, f.id, 'Hijack'), 'not-found');
  const row = await prisma.savedFolder.findUniqueOrThrow({ where: { id: f.id } });
  assert.equal(row.name, 'New Name');
});

test('folders: move into folder, filter listing, move back out', async () => {
  const u = await makeUser('p2f-e@example.com');
  const acc = await makeAccount(u.id, 'p2f-e@mega.test', MEGA_ACCOUNT_STATUSES.SYNCED);
  const v1 = await makeVideo(acc.id, 'p2f-e1', 'E One');
  const v2 = await makeVideo(acc.id, 'p2f-e2', 'E Two');
  const f = await foldersLib.createSavedFolder(u.id, 'Building Videos');
  assert.ok(f && !('duplicate' in f));
  await personal.saveVideo(u.id, v1.id);
  await personal.saveVideo(u.id, v2.id);

  assert.equal(await foldersLib.moveSavedVideo(u.id, v1.id, f.id), 'ok');
  assert.equal(await foldersLib.moveSavedVideo(u.id, 987654321, f.id), 'not-found');
  assert.equal(await foldersLib.moveSavedVideo(u.id, v2.id, 987654321), 'not-found');

  const inFolder = await personal.listSavedVideos(u.id, 1, { kind: 'folder', folderId: f.id });
  assert.deepEqual(inFolder.items.map((v) => v.slug), ['p2f-e1']);
  assert.equal(inFolder.items[0].folderId, f.id);

  const uncategorized = await personal.listSavedVideos(u.id, 1, { kind: 'uncategorized' });
  assert.deepEqual(uncategorized.items.map((v) => v.slug), ['p2f-e2']);

  const all = await personal.listSavedVideos(u.id, 1, { kind: 'all' });
  assert.equal(all.total, 2);

  // Move back out; default (no filter) still lists everything.
  assert.equal(await foldersLib.moveSavedVideo(u.id, v1.id, null), 'ok');
  const back = await personal.listSavedVideos(u.id, 1);
  assert.equal(back.total, 2);
  assert.ok(back.items.every((v) => v.folderId === null));
});

test('folders: delete returns videos to uncategorized, never unsaves', async () => {
  const u = await makeUser('p2f-f@example.com');
  const acc = await makeAccount(u.id, 'p2f-f@mega.test', MEGA_ACCOUNT_STATUSES.SYNCED);
  const v1 = await makeVideo(acc.id, 'p2f-f1', 'F One');
  const v2 = await makeVideo(acc.id, 'p2f-f2', 'F Two');
  const f = await foldersLib.createSavedFolder(u.id, 'Temp');
  assert.ok(f && !('duplicate' in f));
  await personal.saveVideo(u.id, v1.id);
  await personal.saveVideo(u.id, v2.id);
  await foldersLib.moveSavedVideo(u.id, v1.id, f.id);

  const deleted = await foldersLib.deleteSavedFolder(u.id, f.id);
  assert.deepEqual(deleted, { movedBack: 1 });
  assert.equal(await prisma.savedFolder.count({ where: { userId: u.id } }), 0);
  // Both videos still saved and uncategorized.
  assert.equal(await personal.isVideoSaved(u.id, v1.id), true);
  assert.equal(await personal.isVideoSaved(u.id, v2.id), true);
  const all = await personal.listSavedVideos(u.id, 1, { kind: 'all' });
  assert.equal(all.total, 2);
  assert.ok(all.items.every((v) => v.folderId === null));

  assert.equal(await foldersLib.deleteSavedFolder(u.id, 987654321), null);
  const other = await makeUser('p2f-f2@example.com');
  const g = await foldersLib.createSavedFolder(u.id, 'Mine');
  assert.ok(g && !('duplicate' in g));
  assert.equal(await foldersLib.deleteSavedFolder(other.id, g.id), null);
  assert.equal(await prisma.savedFolder.count({ where: { id: g.id } }), 1);
});

test('folders: isolation - another user folder matches nothing', async () => {
  const a = await makeUser('p2f-g@example.com');
  const b = await makeUser('p2f-h@example.com');
  const accA = await makeAccount(a.id, 'p2f-g@mega.test', MEGA_ACCOUNT_STATUSES.SYNCED);
  const v = await makeVideo(accA.id, 'p2f-g1', 'G One');
  const f = await foldersLib.createSavedFolder(a.id, 'Private');
  assert.ok(f && !('duplicate' in f));
  await personal.saveVideo(a.id, v.id);
  await foldersLib.moveSavedVideo(a.id, v.id, f.id);
  // B sees no folders and the folder filter matches nothing for B.
  assert.deepEqual(await foldersLib.listSavedFolders(b.id), []);
  assert.deepEqual((await personal.listSavedVideos(b.id, 1, { kind: 'folder', folderId: f.id })).items, []);
  assert.equal(await foldersLib.moveSavedVideo(b.id, v.id, f.id), 'not-found');
});

test('watchlist: clear removes all, counts, leaves saved/history alone', async () => {
  const u = await makeUser('p2f-i@example.com');
  const acc = await makeAccount(u.id, 'p2f-i@mega.test', MEGA_ACCOUNT_STATUSES.SYNCED);
  const v1 = await makeVideo(acc.id, 'p2f-i1', 'I One');
  const v2 = await makeVideo(acc.id, 'p2f-i2', 'I Two');
  await personal.addToWatchlist(u.id, v1.id);
  await personal.addToWatchlist(u.id, v2.id);
  await personal.saveVideo(u.id, v1.id);
  await personal.recordWatch(u.id, v1.id);

  assert.equal(await personal.clearWatchlist(u.id), 2);
  assert.equal((await personal.listWatchlist(u.id, 1)).total, 0);
  assert.equal(await personal.clearWatchlist(u.id), 0);
  // Saved + history untouched.
  assert.equal((await personal.listSavedVideos(u.id, 1)).total, 1);
  assert.equal((await personal.listHistory(u.id, 1)).total, 1);
  // Other users untouched.
  const other = await makeUser('p2f-i2@example.com');
  const accO = await makeAccount(other.id, 'p2f-i2@mega.test', MEGA_ACCOUNT_STATUSES.SYNCED);
  const vo = await makeVideo(accO.id, 'p2f-i3', 'I Three');
  await personal.addToWatchlist(other.id, vo.id);
  assert.equal(await personal.clearWatchlist(u.id), 0);
  assert.equal((await personal.listWatchlist(other.id, 1)).total, 1);
});

test('migration: pre-folder saved rows survive with NULL folderId', async () => {
  const dir = path.resolve(process.cwd(), 'prisma/migrations');
  const all = (await import('node:fs')).readdirSync(dir).filter((d: string) => /^\d{14}_/.test(d)).sort();
  const target = '20260912030000_p2_saved_folders';
  assert.ok(all.includes(target));
  const file = path.join(path.resolve(process.cwd(), 'data/test'), 'p2-folders-existing.db');
  const fssync = await import('node:fs');
  try {
    fssync.rmSync(file, { force: true });
  } catch { /* not present */ }
  const raw = new Database(file);
  try {
    for (const m of all) {
      if (m === target) break;
      raw.exec(fssync.readFileSync(path.join(dir, m, 'migration.sql'), 'utf8'));
    }
    raw.prepare(`INSERT INTO "User" ("id","email","passwordHash","createdAt","updatedAt") VALUES (?,?,?,?,?)`).run(
      'legacy-u', 'legacy-folders@example.com', 'hash', '2026-01-01 00:00:00', '2026-01-01 00:00:00',
    );
    raw.prepare(
      `INSERT INTO "MegaAccount" ("userId","label","megaEmail","encryptedSession","status","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?)`,
    ).run('legacy-u', 'Acc', 'legacy-folders@mega.test', 's', 'CONNECTED', '2026-01-01 00:00:00', '2026-01-01 00:00:00');
    const legacyAcc = (raw.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;
    raw.prepare(
      `INSERT INTO "Video" ("megaFilename","title","slug","megaAccountId","fileSize","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?)`,
    ).run('Old Clip.mp4', 'Old Clip', 'legacy-saved-clip', legacyAcc, 1000, '2026-01-02 00:00:00', '2026-01-02 00:00:00');
    const legacyVideo = (raw.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;
    raw.prepare(`INSERT INTO "SavedVideo" ("userId","videoId","createdAt") VALUES (?,?,?)`).run(
      'legacy-u', legacyVideo, '2026-01-03 00:00:00',
    );
    raw.exec(fssync.readFileSync(path.join(dir, target, 'migration.sql'), 'utf8'));
    const row = raw.prepare('SELECT "userId","videoId","folderId" FROM "SavedVideo"').get() as {
      userId: string; videoId: number; folderId: number | null;
    } | undefined;
    assert.ok(row, 'pre-existing saved row must survive');
    assert.equal(row.userId, 'legacy-u');
    assert.equal(row.videoId, legacyVideo);
    assert.equal(row.folderId, null);
    assert.ok(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SavedFolder'").get());
  } finally {
    raw.close();
  }
  try {
    fssync.rmSync(file, { force: true });
  } catch { /* cleanup */ }
});
