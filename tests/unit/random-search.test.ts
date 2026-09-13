/**
 * Tests for the hidden #random search command (lib/videos.ts + search page
 * wiring contract).
 *
 *  1. "#random" activates random mode (exact command only).
 *  2. Normal searches are completely unaffected.
 *  3. #random returns all eligible videos.
 *  4. The ordering is actually randomized.
 *  5. Pagination creates no duplicates.
 *  6. Page 2 continues page 1's ordering.
 *  7. A new seed produces a different ordering.
 *  8. User isolation still works.
 *  9. Only the exact command triggers random mode.
 * 10. Near-miss queries remain normal text searches.
 *
 * Uses an isolated SQLite database built from the repo migrations plus the
 * two columns the checked-in migrations predate (Video.creatorAssignment,
 * Creator.userId) - applied test-locally so this file passes regardless of
 * the stale shared helper. No MEGA network, no app-code changes needed.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from './helpers/test-db';

const db = createTestDatabase('random-search-unit');
process.env.DATABASE_URL = db.url;

// NOTE: dynamic imports ONLY. A static `import ... from '@/lib/videos'` is
// hoisted above the `process.env.DATABASE_URL` assignment, so lib/db.ts
// captures the DEV database URL and every fixture row lands in the real
// library (this actually happened - see tests/unit/random-search.test.ts
// history). The same env-then-import order the other unit tests use.

let prisma: typeof import('@/lib/db')['prisma'];
let videos: typeof import('@/lib/videos');
let MEGA_ACCOUNT_STATUSES: typeof import('@/lib/megaAccounts')['MEGA_ACCOUNT_STATUSES'];
let isRandomSearchCommand: typeof videos.isRandomSearchCommand;
let listRandomVideos: typeof videos.listRandomVideos;
let searchVideos: typeof videos.searchVideos;
let shuffleWithSeed: typeof videos.shuffleWithSeed;
let perPage = 24;

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
    data: {
      userId,
      label: `Acc ${email}`,
      megaEmail: email,
      encryptedSession: 'test-session-blob',
      status,
    },
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

let userA!: { id: string };
let userB!: { id: string };
let privateA = 0;

before(async () => {
  ({ prisma } = await import('@/lib/db'));
  videos = await import('@/lib/videos');
  ({ MEGA_ACCOUNT_STATUSES } = await import('@/lib/megaAccounts'));
  ({ isRandomSearchCommand, listRandomVideos, searchVideos, shuffleWithSeed } = videos);

  userA = await makeUser('random-a@example.com');
  userB = await makeUser('random-b@example.com');
  const accA = await makeAccount(userA.id, 'a@example.com', MEGA_ACCOUNT_STATUSES.SYNCED);
  const accADisc = await makeAccount(userA.id, 'a-old@example.com', MEGA_ACCOUNT_STATUSES.DISCONNECTED);
  const accB = await makeAccount(userB.id, 'b@example.com', MEGA_ACCOUNT_STATUSES.SYNCED);

  for (let i = 1; i <= 30; i++) {
    await makeVideo(accA.id, `rand-a-${i}`, `Rand Video ${i}`);
    privateA++;
  }
  // Disconnected account: invisible everywhere.
  for (let i = 1; i <= 3; i++) {
    await makeVideo(accADisc.id, `rand-a-disc-${i}`, `Disc Video ${i}`);
  }
  // Another user's private videos: never visible to A.
  for (let i = 1; i <= 5; i++) {
    await makeVideo(accB.id, `rand-b-${i}`, `Bee Video ${i}`);
  }
  // Public catalog: visible to everyone.
  for (let i = 1; i <= 5; i++) {
    await makeVideo(null, `rand-pub-${i}`, `Pub Video ${i}`);
  }
  // Keyword fixtures for normal-search tests.
  await makeVideo(accA.id, 'rand-keyword', 'My random video');
  await makeVideo(accA.id, 'rand-tagged', '#random test clip');

  const probe = await listRandomVideos(userA.id, 1, 'probe');
  perPage = probe.perPage;
});

// 1. exact command activates random mode ------------------------------------
test('#random activates random mode and returns everything eligible', async () => {
  assert.equal(isRandomSearchCommand('#random'), true);
  const res = await listRandomVideos(userA.id, 1, 'seed-1');
  // 30 private + 5 public + 2 keyword fixtures (all visible to A).
  assert.equal(res.total, privateA + 5 + 2);
  assert.ok(res.items.length > 0);
});

// 9. only the exact command ---------------------------------------------------
test('only the exact command triggers random mode', () => {
  assert.equal(isRandomSearchCommand('#random'), true);
  assert.equal(isRandomSearchCommand(' #random '), true);
  assert.equal(isRandomSearchCommand('#random test'), false);
  assert.equal(isRandomSearchCommand('random'), false);
  assert.equal(isRandomSearchCommand('my #random video'), false);
  assert.equal(isRandomSearchCommand('#RANDOM'), false);
  assert.equal(isRandomSearchCommand(''), false);
});

// 2+10. normal searches unaffected --------------------------------------------
test('normal searches are unaffected and near-misses stay text searches', async () => {
  const keyword = await searchVideos('random', 1, userA.id);
  assert.ok(
    keyword.items.some((v) => v.slug === 'rand-keyword'),
    'plain keyword still matches by text',
  );
  const tagged = await searchVideos('#random test', 1, userA.id);
  assert.ok(
    tagged.items.some((v) => v.slug === 'rand-tagged'),
    '"#random test" stays a text search',
  );
  // A text search never returns the whole library.
  assert.ok(keyword.total < privateA + 7);
});

// 3. all eligible ---------------------------------------------------------------
test('#random returns all eligible videos', async () => {
  const res = await listRandomVideos(userA.id, 1, 'seed-1');
  const ids = new Set(res.items.map((v) => v.id));
  assert.equal(res.total, privateA + 7);
  // every page concatenated covers everything exactly once (see below).
  const all: number[] = [];
  for (let p = 1; p <= res.totalPages; p++) {
    const r = await listRandomVideos(userA.id, p, 'seed-1');
    all.push(...r.items.map((v) => v.id));
  }
  assert.equal(all.length, res.total);
});

// 4. actually randomized ----------------------------------------------------------
test('ordering is actually randomized', () => {
  const ids = Array.from({ length: 30 }, (_, i) => i);
  const differ = ['seed-1', 'seed-2', 'seed-3'].some((s) => {
    const o = shuffleWithSeed(ids, s);
    return o.some((v, i) => v !== ids[i]);
  });
  assert.ok(differ, 'shuffled order must differ from input order');
});

// 5+6. stable pagination, no duplicates ---------------------------------------------
test('pages partition one stable ordering without duplicates', async () => {
  const first = await listRandomVideos(userA.id, 1, 'stable-seed');
  const second = await listRandomVideos(userA.id, 2, 'stable-seed');
  assert.equal(first.items.length, perPage);
  const p1 = first.items.map((v) => v.id);
  const p2 = second.items.map((v) => v.id);
  assert.equal(new Set([...p1, ...p2]).size, p1.length + p2.length, 'no duplicates across pages');
  // Same seed, same call again -> identical pages (stable).
  const again = await listRandomVideos(userA.id, 1, 'stable-seed');
  assert.deepEqual(
    again.items.map((v) => v.id),
    p1,
    'page 1 is identical on repeat',
  );
  const again2 = await listRandomVideos(userA.id, 2, 'stable-seed');
  assert.deepEqual(
    again2.items.map((v) => v.id),
    p2,
    'page 2 continues page 1 ordering',
  );
});

// 7. new seed, new ordering ------------------------------------------------------------
test('a new seed produces a different ordering', async () => {
  const a = await listRandomVideos(userA.id, 1, 'seed-aaa');
  const orders = new Set([a.items.map((v) => v.id).join(',')]);
  let differed = false;
  for (const s of ['seed-bbb', 'seed-ccc', 'seed-ddd']) {
    const r = await listRandomVideos(userA.id, 1, s);
    if (!orders.has(r.items.map((v) => v.id).join(','))) {
      differed = true;
      break;
    }
  }
  assert.ok(differed, 'a new seed must reshuffle');
});

// 8. user isolation ---------------------------------------------------------------------
test('user isolation holds in random mode', async () => {
  const a = await listRandomVideos(userA.id, 1, 'iso');
  const allA: number[] = [];
  for (let p = 1; p <= a.totalPages; p++) {
    const r = await listRandomVideos(userA.id, p, 'iso');
    allA.push(...r.items.map((v) => v.id));
  }
  const bRows = await prisma.video.findMany({
    where: { slug: { startsWith: 'rand-b-' } },
    select: { id: true },
  });
  const bIds = new Set(bRows.map((v) => v.id));
  assert.ok(allA.every((id) => !bIds.has(id)), 'A never sees B videos');

  const b = await listRandomVideos(userB.id, 1, 'iso');
  // B: 5 private + 5 public.
  assert.equal(b.total, 10);
  const allB: number[] = [];
  for (let p = 1; p <= b.totalPages; p++) {
    const r = await listRandomVideos(userB.id, p, 'iso');
    allB.push(...r.items.map((v) => v.id));
  }
  const aRows = await prisma.video.findMany({
    where: { slug: { startsWith: 'rand-a-' } },
    select: { id: true },
  });
  const aIds = new Set(aRows.map((v) => v.id));
  assert.ok(allB.every((id) => !aIds.has(id)), 'B never sees A videos');

  // Disconnected-account videos are invisible to their own owner too.
  const discRows = await prisma.video.findMany({
    where: { slug: { startsWith: 'rand-a-disc-' } },
    select: { id: true },
  });
  const discIds = new Set(discRows.map((v) => v.id));
  assert.ok(allA.every((id) => !discIds.has(id)), 'disconnected excluded');
});

// Empty library ------------------------------------------------------------------
test('empty scope uses the existing empty result shape', async () => {
  const lonely = await makeUser('random-lonely@example.com');
  const res = await listRandomVideos(lonely.id, 1, 'seed');
  assert.equal(res.total, 5, 'only the public catalog is visible');
  assert.equal(res.totalPages, 1);
});

// BUG-004 regression: if a video is deleted between the ID shuffle and the
// row fetch, the page must refill from the remaining shuffled IDs instead of
// returning a sparse page.
test('BUG-004: deleted videos between shuffle and fetch do not produce sparse pages', async () => {
  const u = await makeUser('bug004@example.com');
  const acc = await makeAccount(u.id, 'bug004@mega.test', MEGA_ACCOUNT_STATUSES.SYNCED);

  // Create exactly perPage + 1 videos so page 1 has perPage items and page 2
  // has 1 item before deletion.
  const count = perPage + 1;
  for (let i = 1; i <= count; i++) {
    await makeVideo(acc.id, `bug004-${i}`, `Bug004 Video ${i}`);
  }

  const page1 = await listRandomVideos(u.id, 1, 'bug004-seed');
  assert.equal(page1.items.length, perPage, 'page 1 is full before deletion');

  const victimId = page1.items[0].id;
  await prisma.video.delete({ where: { id: victimId } });

  const after = await listRandomVideos(u.id, 1, 'bug004-seed');
  assert.equal(after.items.length, perPage, 'page 1 refills after a deletion');
  assert.ok(!after.items.some((v) => v.id === victimId), 'deleted video is not present');
});
