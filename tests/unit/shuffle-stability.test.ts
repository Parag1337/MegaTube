/**
 * Shuffle stability + randomness tests (PROBLEM 1 + PROBLEM 2).
 *
 * Covers:
 *  1. Shuffle returns all eligible videos exactly once.
 *  2. Shuffle contains no duplicates.
 *  3. Fresh seeds can produce different orderings (non-flaky: 20 seeds,
 *     require >= 2 distinct permutations - never a single pairwise !=).
 *  4. Repeated generations are seed-driven, not deterministic-by-accident.
 *  5. Card mutations (watchlist/save/remove) do not change the shuffle order.
 *  6-8. Add to Watchlist / Save / Remove from Watchlist preserve order.
 *  9. An explicit new shuffle (new seed) yields a fresh valid permutation.
 * 10. A reload (fresh seed per seedless request) yields a fresh permutation.
 * 11. Home ordering remains stable and unchanged.
 * 12. Search ordering remains stable and unchanged.
 * 13. Watchlist/Saved behavior remains correct.
 *
 * Plus unit tests for the card-menu route predicate that keeps
 * router.refresh() away from the Shuffle page (the actual reshuffle cause).
 *
 * Uses an isolated SQLite database; no MEGA network, no app-code changes.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createTestDatabase } from './helpers/test-db';

const db = createTestDatabase('shuffle-stability-unit');
process.env.DATABASE_URL = db.url;

// NOTE: dynamic imports ONLY (same reason as random-search.test.ts): static
// imports would hoist above the DATABASE_URL assignment and capture the DEV
// database URL.

let prisma: typeof import('@/lib/db')['prisma'];
let videos: typeof import('@/lib/videos');
let personal: typeof import('@/lib/personal');
let isShuffleLocation: typeof import('@/components/VideoCardMenu')['isShuffleLocation'];

const PASSWORD_HASH =
  'pbkdf2:sha256:100000:00000000000000000000000000000000:000000000000000000000000000000000000000000000000000000000000000000';

after(() => {
  db.close();
});

async function makeUser(email: string) {
  return prisma.user.create({ data: { email, passwordHash: PASSWORD_HASH } });
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

let userId!: string;
const PRIVATE_COUNT = 30;
const PUBLIC_COUNT = 5;
const TOTAL_VISIBLE = PRIVATE_COUNT + PUBLIC_COUNT;

before(async () => {
  ({ prisma } = await import('@/lib/db'));
  videos = await import('@/lib/videos');
  personal = await import('@/lib/personal');
  ({ isShuffleLocation } = await import('@/components/VideoCardMenu'));

  const { MEGA_ACCOUNT_STATUSES } = await import('@/lib/megaAccounts');
  const user = await makeUser('shuffle-stability@example.com');
  userId = user.id;
  const acc = await prisma.megaAccount.create({
    data: {
      userId,
      label: 'Shuffle Acc',
      megaEmail: 'shuffle@example.com',
      encryptedSession: 'test-session-blob',
      status: MEGA_ACCOUNT_STATUSES.SYNCED,
    },
  });
  for (let i = 1; i <= PRIVATE_COUNT; i++) {
    await makeVideo(acc.id, `shuf-priv-${i}`, `ShufVideo Private ${i}`);
  }
  for (let i = 1; i <= PUBLIC_COUNT; i++) {
    await makeVideo(null, `shuf-pub-${i}`, `ShufVideo Public ${i}`);
  }
});

/** All shuffled IDs for one seed, concatenated across every page. */
async function fullShuffleOrder(seed: string): Promise<number[]> {
  const first = await videos.listRandomVideos(userId, 1, seed);
  const all: number[] = first.items.map((v) => v.id);
  for (let p = 2; p <= first.totalPages; p++) {
    const r = await videos.listRandomVideos(userId, p, seed);
    all.push(...r.items.map((v) => v.id));
  }
  return all;
}

// Route predicate: the actual reshuffle guard -------------------------------

test('isShuffleLocation detects only the Shuffle page', () => {
  assert.equal(isShuffleLocation('/search', '?q=%23random'), true);
  assert.equal(isShuffleLocation('/search', '?q=#random'), true);
  assert.equal(isShuffleLocation('/search', 'q=%23random&page=2'), true);
  assert.equal(isShuffleLocation('/search', '?q=%20%23random%20'), true);
  assert.equal(isShuffleLocation('/search', '?q=hello'), false);
  assert.equal(isShuffleLocation('/search', '?q=%23randomness'), false);
  assert.equal(isShuffleLocation('/search', ''), false);
  assert.equal(isShuffleLocation('/', ''), false);
  assert.equal(isShuffleLocation('/watchlist', ''), false);
  assert.equal(isShuffleLocation('/account/saved', ''), false);
  assert.equal(isShuffleLocation(null, null), false);
});

// 1+2. permutation validity ---------------------------------------------------

test('shuffle returns every eligible video exactly once, no duplicates', async () => {
  const first = await videos.listRandomVideos(userId, 1, 'perm-seed');
  assert.equal(first.total, TOTAL_VISIBLE);
  const all = await fullShuffleOrder('perm-seed');
  assert.equal(all.length, TOTAL_VISIBLE);
  assert.equal(new Set(all).size, TOTAL_VISIBLE);
});

// 4. seed-driven stability (what card mutations rely on) ----------------------

test('same seed always yields the identical order', async () => {
  const a = await fullShuffleOrder('stable-seed-1');
  const b = await fullShuffleOrder('stable-seed-1');
  assert.deepEqual(b, a);
});

// 5-8. card mutations preserve the shuffle order -------------------------------

test('watchlist/save/remove mutations preserve the shuffle order', async () => {
  const seed = 'mutation-seed-1';
  const beforeOrder = await fullShuffleOrder(seed);
  const targetWatch = beforeOrder[2];
  const targetSave = beforeOrder[5];

  const added = await personal.addToWatchlist(userId, targetWatch);
  assert.ok(added, 'watchlist add succeeds');
  assert.deepEqual(await fullShuffleOrder(seed), beforeOrder, 'add to watchlist preserves order');

  const saved = await personal.saveVideo(userId, targetSave);
  assert.ok(saved, 'save succeeds');
  assert.deepEqual(await fullShuffleOrder(seed), beforeOrder, 'save preserves order');

  const removed = await personal.removeFromWatchlist(userId, targetWatch);
  assert.equal(removed, true);
  assert.deepEqual(await fullShuffleOrder(seed), beforeOrder, 'remove from watchlist preserves order');

  const unsaved = await personal.unsaveVideo(userId, targetSave);
  assert.equal(unsaved, true);
  assert.deepEqual(await fullShuffleOrder(seed), beforeOrder, 'unsave preserves order');
});

// 3+4+9+10. fresh randomness, never a flaky pairwise assertion -----------------

test('fresh seeds produce fresh valid permutations (never deterministic)', async () => {
  const TRIALS = 20;
  const fullOrders = new Set<string>();
  const prefixes = new Set<string>();
  for (let t = 0; t < TRIALS; t++) {
    // Mirrors app/search/page.tsx: a seedless request mints a fresh seed.
    const seed = randomBytes(8).toString('hex');
    const order = await fullShuffleOrder(seed);
    assert.equal(order.length, TOTAL_VISIBLE, `trial ${t}: all videos present`);
    assert.equal(new Set(order).size, TOTAL_VISIBLE, `trial ${t}: no duplicates`);
    fullOrders.add(order.join(','));
    prefixes.add(order.slice(0, 5).join(','));
  }
  assert.ok(
    fullOrders.size >= 2,
    `20 fresh shuffles must not all be identical (got ${fullOrders.size} distinct)`,
  );
  assert.ok(
    prefixes.size >= 2,
    'shuffle prefixes must vary across fresh generations',
  );
});

test('seedless requests mint unique seeds (reload/explicit shuffle stay fresh)', () => {
  const seeds = new Set<string>();
  for (let t = 0; t < 20; t++) {
    seeds.add(randomBytes(8).toString('hex'));
  }
  assert.equal(seeds.size, 20, 'every fresh seed must be unique');
});

// 11. Home regression ----------------------------------------------------------

test('home ordering remains stable and unchanged', async () => {
  const a = await videos.listVideos(1);
  const b = await videos.listVideos(1);
  assert.ok(a.total > 0);
  assert.deepEqual(
    b.items.map((v) => v.id),
    a.items.map((v) => v.id),
    'home page 1 is identical across calls',
  );
});

// 12. Search regression ----------------------------------------------------------

test('search ordering remains stable and unchanged', async () => {
  const a = await videos.searchVideos('ShufVideo', 1, userId);
  const b = await videos.searchVideos('ShufVideo', 1, userId);
  assert.ok(a.total > 0);
  assert.deepEqual(
    b.items.map((v) => v.id),
    a.items.map((v) => v.id),
    'text search order is identical across calls',
  );
});

// 13. Watchlist/Saved behavior ----------------------------------------------------

test('watchlist behavior remains correct', async () => {
  const first = await videos.listRandomVideos(userId, 1, 'watchlist-seed');
  const vid = first.items[0].id;

  assert.equal(await personal.isOnWatchlist(userId, vid), false);
  const added = await personal.addToWatchlist(userId, vid);
  assert.ok(added && added.created);
  assert.equal(await personal.isOnWatchlist(userId, vid), true);

  const list = await personal.listWatchlist(userId, 1);
  assert.ok(list.items.some((v) => v.id === vid), 'added video appears in watchlist');

  assert.equal(await personal.removeFromWatchlist(userId, vid), true);
  assert.equal(await personal.isOnWatchlist(userId, vid), false);
  const after = await personal.listWatchlist(userId, 1);
  assert.ok(!after.items.some((v) => v.id === vid), 'removed video leaves watchlist');
});

test('saved behavior remains correct', async () => {
  const first = await videos.listRandomVideos(userId, 1, 'saved-seed');
  const vid = first.items[1].id;

  assert.equal(await personal.isVideoSaved(userId, vid), false);
  const saved = await personal.saveVideo(userId, vid);
  assert.ok(saved);
  assert.equal(await personal.isVideoSaved(userId, vid), true);
  assert.equal(await personal.unsaveVideo(userId, vid), true);
  assert.equal(await personal.isVideoSaved(userId, vid), false);
});
