/**
 * P1.3 tests: FTS5-backed search (lib/videos.ts searchVideos + triggers).
 *
 * Covers: title/partial/creator/filename matching, case-insensitivity,
 * empty query, pagination, user isolation, special characters, short-token
 * LIKE fallback, and trigger-driven index sync (rename/reassign/delete).
 * Runs against an isolated DB built from the repo migrations (FTS included).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from './helpers/test-db';

const db = createTestDatabase('search-fts-unit');
process.env.DATABASE_URL = db.url;

let prisma: typeof import('@/lib/db')['prisma'];
let videos: typeof import('@/lib/videos');
let MEGA_ACCOUNT_STATUSES: typeof import('@/lib/megaAccounts')['MEGA_ACCOUNT_STATUSES'];
let searchVideos: typeof videos.searchVideos;

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

async function makeVideo(
  accountId: number | null,
  slug: string,
  title: string,
  opts?: { filename?: string; creatorId?: number },
) {
  return prisma.video.create({
    data: {
      megaAccountId: accountId,
      megaFilename: opts?.filename ?? `${title}.mp4`,
      title,
      slug,
      creatorId: opts?.creatorId ?? null,
      creatorAssignment: opts?.creatorId ? 'auto' : 'none',
      fileSize: BigInt(1000),
      mimeType: 'video/mp4',
    },
  });
}

let userA!: { id: string };
let userB!: { id: string };
let starCreatorId = 0;

before(async () => {
  ({ prisma } = await import('@/lib/db'));
  videos = await import('@/lib/videos');
  ({ MEGA_ACCOUNT_STATUSES } = await import('@/lib/megaAccounts'));
  ({ searchVideos } = videos);

  userA = await makeUser('fts-a@example.com');
  userB = await makeUser('fts-b@example.com');
  const accA = await makeAccount(userA.id, 'a@example.com', MEGA_ACCOUNT_STATUSES.SYNCED);
  const accADisc = await makeAccount(userA.id, 'a-old@example.com', MEGA_ACCOUNT_STATUSES.DISCONNECTED);
  const accB = await makeAccount(userB.id, 'b@example.com', MEGA_ACCOUNT_STATUSES.SYNCED);

  const star = await prisma.creator.create({
    data: { userId: userA.id, name: 'Star Creator', slug: 'star-creator' },
  });
  starCreatorId = star.id;

  await makeVideo(accA.id, 'fts-alpha', 'Alpha Adventures');
  await makeVideo(accA.id, 'fts-beta', 'Beta Clips Collection');
  await makeVideo(accA.id, 'fts-galaxy', 'Galaxy Tour', {
    filename: 'Star Creator - Galaxy Tour.mp4',
    creatorId: star.id,
  });
  await makeVideo(accA.id, 'fts-deep', 'Deep Sea Documentary', {
    filename: 'underwater-footage-final.mp4',
  });
  await makeVideo(accADisc.id, 'fts-disc', 'Disconnected Alpha Video');
  await makeVideo(accB.id, 'fts-bsecret', 'Bee Secret Alpha Project');
  await makeVideo(null, 'fts-pub', 'Public Alpha Reel');
});

test('title substring (incl. mid-word partial) matches', async () => {
  const r = await searchVideos('Adventures', 1, userA.id);
  assert.ok(r.items.some((v) => v.slug === 'fts-alpha'));
  const partial = await searchVideos('ventur', 1, userA.id);
  assert.ok(partial.items.some((v) => v.slug === 'fts-alpha'), 'mid-word substring preserved');
});

test('search is case-insensitive', async () => {
  const lower = await searchVideos('alpha', 1, userA.id);
  const upper = await searchVideos('ALPHA', 1, userA.id);
  assert.deepEqual(
    upper.items.map((v) => v.slug).sort(),
    lower.items.map((v) => v.slug).sort(),
  );
  assert.ok(lower.items.some((v) => v.slug === 'fts-alpha'));
});

test('creator name search finds the creator videos', async () => {
  const r = await searchVideos('Star Creator', 1, userA.id);
  assert.ok(r.items.some((v) => v.slug === 'fts-galaxy'));
});

test('MEGA filename-only token matches', async () => {
  const r = await searchVideos('underwater-footage', 1, userA.id);
  assert.ok(r.items.some((v) => v.slug === 'fts-deep'));
});

test('empty query returns the empty result shape', async () => {
  for (const q of ['', '   ']) {
    const r = await searchVideos(q, 1, userA.id);
    assert.equal(r.total, 0);
    assert.deepEqual(r.items, []);
  }
});

test('pagination partitions without overlap', async () => {
  const first = await searchVideos('Alpha', 1, userA.id);
  assert.ok(first.total >= 2, 'several Alpha videos visible to A');
  const seen = new Set<number>();
  for (let p = 1; p <= first.totalPages; p++) {
    const r = await searchVideos('Alpha', p, userA.id);
    assert.equal(r.total, first.total);
    for (const v of r.items) {
      assert.ok(!seen.has(v.id), `duplicate ${v.id} across pages`);
      seen.add(v.id);
    }
  }
  assert.equal(seen.size, first.total);
});

test('user isolation holds (private, disconnected, logged-out)', async () => {
  const a = await searchVideos('Alpha', 1, userA.id);
  const slugsA = a.items.map((v) => v.slug);
  assert.ok(!slugsA.includes('fts-bsecret'), 'A never sees B videos');
  assert.ok(!slugsA.includes('fts-disc'), 'disconnected excluded');
  assert.ok(slugsA.includes('fts-pub'), 'public catalog visible');

  const b = await searchVideos('Alpha', 1, userB.id);
  assert.ok(b.items.some((v) => v.slug === 'fts-bsecret'));
  assert.ok(!b.items.some((v) => v.slug === 'fts-alpha'));

  const anon = await searchVideos('Alpha', 1, undefined);
  assert.ok(anon.items.some((v) => v.slug === 'fts-pub'));
  assert.ok(!anon.items.some((v) => v.slug === 'fts-alpha'));
});

test('special characters never break the query', async () => {
  for (const q of ['"quoted"', '(paren)', 'a*b', 'star-creator', 'Galaxy (Tour)']) {
    const r = await searchVideos(q, 1, userA.id);
    assert.ok(Array.isArray(r.items), `${q} returns a valid shape`);
  }
  const dash = await searchVideos('underwater-footage', 1, userA.id);
  assert.ok(dash.items.some((v) => v.slug === 'fts-deep'));
});

test('multi-word queries use implicit OR (never phrase/AND)', async () => {
  // 'Alpha' matches fts-alpha + fts-pub; 'Galaxy' matches fts-galaxy.
  // Implicit OR must return all of them (a phrase query would match none).
  const r = await searchVideos('Alpha Galaxy', 1, userA.id);
  const found = r.items.map((v) => v.slug);
  assert.ok(found.includes('fts-alpha'), 'alpha term matches');
  assert.ok(found.includes('fts-galaxy'), 'galaxy term matches');
});

test('short-token queries match inline via LIKE without regressing', async () => {
  // 'Al' (2 chars) cannot use trigrams but must still find Alpha (LIKE path).
  const r = await searchVideos('Al', 1, userA.id);
  assert.ok(r.items.some((v) => v.slug === 'fts-alpha'));
});

test('no-match query is fast and empty', async () => {
  const r = await searchVideos('ZebraUnicornXyz', 1, userA.id);
  assert.equal(r.total, 0);
  assert.deepEqual(r.items, []);
});

test('index follows title renames via trigger', async () => {
  // A sync rename updates title AND filename together; the trigger must
  // refresh both indexed columns (the old filename alone must not linger).
  await prisma.video.update({
    where: { slug: 'fts-beta' },
    data: { title: 'Renamed Zephyr Film', megaFilename: 'Renamed Zephyr Film.mp4' },
  });
  const fresh = await searchVideos('Zephyr', 1, userA.id);
  assert.ok(fresh.items.some((v) => v.slug === 'fts-beta'), 'new title searchable');
  const stale = await searchVideos('Beta Clips Collection', 1, userA.id);
  assert.ok(!stale.items.some((v) => v.slug === 'fts-beta'), 'old title gone from index');
  // Restore for other tests (order-independent file, but be tidy).
  await prisma.video.update({
    where: { slug: 'fts-beta' },
    data: { title: 'Beta Clips Collection', megaFilename: 'Beta Clips Collection.mp4' },
  });
});

test('index follows creator renames and unassignment via triggers', async () => {
  await prisma.creator.update({ where: { id: starCreatorId }, data: { name: 'Nova Performer' } });
  const renamed = await searchVideos('Nova Performer', 1, userA.id);
  assert.ok(renamed.items.some((v) => v.slug === 'fts-galaxy'), 'renamed creator searchable');
  // The old name still lives in the MEGA filename ('Star Creator - Galaxy
  // Tour.mp4'), so it must STILL match via the filename column - exactly
  // like the LIKE path does. The creator column itself moved on (proven by
  // the unassignment assertion below).
  const oldName = await searchVideos('Star Creator', 1, userA.id);
  assert.ok(oldName.items.some((v) => v.slug === 'fts-galaxy'), 'filename match preserved');

  await prisma.video.update({
    where: { slug: 'fts-galaxy' },
    data: { creatorId: null, creatorAssignment: 'none' },
  });
  const unassigned = await searchVideos('Nova Performer', 1, userA.id);
  assert.ok(!unassigned.items.some((v) => v.slug === 'fts-galaxy'), 'unassigned video leaves creator index');
});

test('index drops deleted videos via trigger', async () => {
  const tmp = await makeVideo(null, 'fts-tmp', 'Temporary indexed film');
  assert.ok((await searchVideos('Temporary indexed', 1, undefined)).items.some((v) => v.slug === 'fts-tmp'));
  await prisma.video.delete({ where: { id: tmp.id } });
  assert.ok(!(await searchVideos('Temporary indexed', 1, undefined)).items.some((v) => v.slug === 'fts-tmp'));
});

// BUG-002 regression: prove that eligible queries actually execute through
// the FTS5 path. The LIKE fallback is correct but must not mask a broken
// FTS implementation.
test('eligible search actually uses the FTS5 path (not just the LIKE fallback)', async () => {
  const probe = await makeVideo(null, 'fts-path-probe', 'FTS Path Probe Title');
  try {
    await prisma.$executeRaw`UPDATE "VideoSearch" SET "title" = 'FTS_PATH_PROBE_MARKER_ONLY' WHERE rowid = ${probe.id}`;

    const result = await searchVideos('FTS_PATH_PROBE_MARKER_ONLY', 1, undefined);
    assert.ok(
      result.items.some((v) => v.slug === 'fts-path-probe'),
      'FTS5 must be queried: the marker string exists only in VideoSearch, not in Video.title',
    );
  } finally {
    await prisma.$executeRaw`UPDATE "VideoSearch" SET "title" = 'FTS Path Probe Title' WHERE rowid = ${probe.id}`;
    await prisma.video.delete({ where: { id: probe.id } });
  }
});
