/**
 * P2.2.1 Home feed tests: quota math, assignment, interleave, and measured
 * end-to-end source distribution on a seeded library.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from './helpers/test-db';

const db = createTestDatabase('p2-home-feed-unit');
process.env.DATABASE_URL = db.url;
process.env.VIDEOS_PER_PAGE = '24';

let prisma: typeof import('@/lib/db')['prisma'];
let homeFeed: typeof import('@/lib/homeFeed');
let MEGA_ACCOUNT_STATUSES: typeof import('@/lib/megaAccounts')['MEGA_ACCOUNT_STATUSES'];

after(() => {
  db.close();
});

before(async () => {
  ({ prisma } = await import('@/lib/db'));
  homeFeed = await import('@/lib/homeFeed');
  ({ MEGA_ACCOUNT_STATUSES } = await import('@/lib/megaAccounts'));
});

// ---------------------------------------------------------------- quotas ---

test('quotas: 24 with history = 4/2/4/7/7', () => {
  assert.deepEqual(homeFeed.calculateQuotas(24, true), {
    recent: 4,
    history: 2,
    related: 4,
    random: 7,
    variety: 7,
  });
});

test('quotas: 20 with history = 3/2/3/6/6', () => {
  assert.deepEqual(homeFeed.calculateQuotas(20, true), {
    recent: 3,
    history: 2,
    related: 3,
    random: 6,
    variety: 6,
  });
});

test('quotas: total always exactly page size', () => {
  for (const n of [1, 5, 7, 12, 24, 30, 48, 96]) {
    for (const h of [true, false]) {
      const q = homeFeed.calculateQuotas(n, h);
      assert.equal(q.recent + q.history + q.related + q.random + q.variety, n, `n=${n} h=${h}`);
    }
  }
});

test('quotas: no history redistributes to random + variety (4/0/4/8/8)', () => {
  assert.deepEqual(homeFeed.calculateQuotas(24, false), {
    recent: 4,
    history: 0,
    related: 4,
    random: 8,
    variety: 8,
  });
});

test('quotas: deterministic across calls', () => {
  assert.deepEqual(homeFeed.calculateQuotas(24, true), homeFeed.calculateQuotas(24, true));
});

// ------------------------------------------------------------- assign -----

const vid = (id: number) => ({ id });

test('assign: first-claim caps pools, no duplicates', () => {
  const pools = [
    { source: 'recent' as const, videos: [vid(1), vid(2), vid(3), vid(4), vid(5)] },
    { source: 'history' as const, videos: [vid(6), vid(7)] },
    { source: 'related' as const, videos: [vid(8), vid(9)] },
    { source: 'random' as const, videos: [vid(10), vid(11)] },
    { source: 'variety' as const, videos: [vid(12)] },
  ];
  const quotas = { recent: 2, history: 2, related: 2, random: 2, variety: 2 };
  const picks = homeFeed.assignQuotas(pools, quotas, 10);
  const ids = picks.map((p) => p.video.id);
  assert.equal(new Set(ids).size, ids.length);
  const bySource = (s: string) => picks.filter((p) => p.source === s).length;
  // Every pool exactly fills its quota: 2+2+2+2+1 (variety pool is short)
  // = 9, then pass 2 tops up from recent leftovers to reach 10.
  assert.equal(picks.length, 10);
  assert.equal(bySource('recent'), 3);
  assert.equal(bySource('history'), 2);
  assert.equal(bySource('related'), 2);
  assert.equal(bySource('random'), 2);
  assert.equal(bySource('variety'), 1);
});

test('assign: shortfall redistributes, page stays full when library allows', () => {
  const pools = [
    { source: 'recent' as const, videos: [vid(1)] },
    { source: 'history' as const, videos: [] },
    { source: 'related' as const, videos: [vid(2)] },
    { source: 'random' as const, videos: [vid(3), vid(4), vid(5), vid(6)] },
    { source: 'variety' as const, videos: [vid(7), vid(8), vid(9), vid(10)] },
  ];
  const quotas = { recent: 4, history: 2, related: 4, random: 7, variety: 7 };
  const picks = homeFeed.assignQuotas(pools, quotas, 24);
  // Only 10 unique videos exist: page holds all 10, none duplicated.
  assert.equal(picks.length, 10);
  assert.equal(new Set(picks.map((p) => p.video.id)).size, 10);
});

test('assign: respects taken ids from previous pages', () => {
  const pools = [
    { source: 'recent' as const, videos: [vid(1), vid(2)] },
    { source: 'history' as const, videos: [] },
    { source: 'related' as const, videos: [] },
    { source: 'random' as const, videos: [vid(1), vid(3)] },
    { source: 'variety' as const, videos: [] },
  ];
  const quotas = { recent: 2, history: 0, related: 0, random: 2, variety: 0 };
  const picks = homeFeed.assignQuotas(pools, quotas, 4, new Set([1, 2]));
  assert.deepEqual(picks.map((p) => p.video.id), [3]);
});

// ---------------------------------------------------------- interleave ----

test('interleave: round-robin spread, deterministic', () => {
  const buckets = [
    [{ id: 1 }, { id: 2 }, { id: 3 }],
    [{ id: 4 }],
    [],
    [{ id: 5 }, { id: 6 }],
    [{ id: 7 }],
  ];
  const once = homeFeed.interleaveBuckets(buckets).map((v) => v.id);
  const twice = homeFeed.interleaveBuckets(buckets).map((v) => v.id);
  assert.deepEqual(once, [1, 4, 5, 7, 2, 6, 3]);
  assert.deepEqual(twice, once);
});

// ---------------------------------------------------------- end to end ----

const PASSWORD_HASH =
  'pbkdf2:sha256:100000:00000000000000000000000000000000:000000000000000000000000000000000000000000000000000000000000000000';

async function makeUser(email: string) {
  return prisma.user.create({ data: { email, passwordHash: PASSWORD_HASH } });
}

/**
 * Seed a realistic library: several creator families with nested titles
 * (short base titles + longer titles containing them, so FTS title
 * matching has genuine cross-date matches) and staggered dates.
 *
 * Layout: `heads` are the newest videos (recent picks), `nests` are longer
 * titles containing a head title (title matches, deliberately older),
 * `fillers` pad the families across the date range.
 */
async function seedLibrary(
  userId: string,
  email: string,
  families: Array<{ creator: string; heads: string[]; nests: string[]; fillers: number }>,
) {
  const acc = await prisma.megaAccount.create({
    data: { userId, label: 'Acc', megaEmail: email, encryptedSession: 's', status: MEGA_ACCOUNT_STATUSES.SYNCED },
  });
  const base = Date.now();
  let tick = 0;
  const stamp = () => new Date(base - tick++ * 60000);
  // Heads first (newest), then nests, then fillers (oldest) per family.
  for (const fam of families) {
    const slugBase = fam.creator.toLowerCase().replace(/\s+/g, '-');
    const creator = await prisma.creator.create({
      data: { userId, name: fam.creator, slug: `${slugBase}-${email}` },
    });
    const mk = async (title: string, slugSuffix: string) => {
      await prisma.video.create({
        data: {
          megaAccountId: acc.id,
          megaFilename: `${title}.mp4`,
          title,
          slug: `feed-${slugBase}-${email}-${slugSuffix}`,
          creatorId: creator.id,
          creatorAssignment: 'auto',
          fileSize: BigInt(1000),
          mimeType: 'video/mp4',
          createdAt: stamp(),
        },
      });
    };
    for (const [i, h] of fam.heads.entries()) await mk(h, `head-${i}`);
    for (const [i, v] of fam.nests.entries()) await mk(v, `nest-${i}-${v.length}`);
    for (let i = 0; i < fam.fillers; i++) {
      await mk(`${fam.creator} Filler ${i}`, `fill-${i}`);
    }
  }
  return acc;
}

function counts(items: Array<{ source: string }>) {
  const c: Record<string, number> = { recent: 0, history: 0, related: 0, random: 0, variety: 0 };
  for (const i of items) c[i.source]++;
  return c;
}

async function watchOldest(userId: string, n: number) {
  const olds = await prisma.video.findMany({
    where: { megaAccount: { userId } },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: n,
  });
  for (const v of olds) {
    await prisma.watchHistory.create({ data: { userId, videoId: v.id, lastWatchedAt: new Date() } });
  }
}

test('end to end: 96-video library with history hits quotas exactly', async () => {
  const u = await makeUser('feed-a@example.com');
  await seedLibrary(u.id, 'feed-a@mega.test', [
    {
      creator: 'Alpha Star',
      heads: ['Alpha Tour', 'Alpha Trip'],
      nests: [
        'Alpha Tour Extended',
        'Alpha Tour Live',
        'Alpha Tour Remix',
        'Alpha Tour Acoustic',
        'Alpha Trip Extended',
        'Alpha Trip Live',
      ],
      fillers: 26,
    },
    {
      creator: 'Beta Star',
      heads: ['Beta Trip'],
      nests: ['Beta Trip Extended', 'Beta Trip Live', 'Beta Trip Remix'],
      fillers: 27,
    },
    {
      creator: 'Gamma Star',
      heads: ['Gamma Journey'],
      nests: ['Gamma Journey Extended', 'Gamma Journey Live'],
      fillers: 28,
    },
  ]);
  await watchOldest(u.id, 2);

  const feed = await homeFeed.buildHomeFeedPage(u.id, 1, 'home-feed-test-seed');
  assert.equal(feed.items.length, 24);
  assert.deepEqual(counts(feed.items), { recent: 4, history: 2, related: 4, random: 7, variety: 7 });
  assert.equal(new Set(feed.items.map((p) => p.video.id)).size, 24);
  assert.equal(feed.total, 96);
  assert.equal(feed.totalPages, 4);
});

test('end to end: page 2 does not repeat page 1', async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { email: 'feed-a@example.com' } });
  const p1 = await homeFeed.buildHomeFeedPage(u.id, 1, 'home-feed-test-seed');
  const p2 = await homeFeed.buildHomeFeedPage(u.id, 2, 'home-feed-test-seed');
  const ids1 = new Set(p1.items.map((p) => p.video.id));
  const overlap = p2.items.filter((p) => ids1.has(p.video.id));
  assert.equal(overlap.length, 0);
  assert.ok(p2.items.length > 0);
});

test('end to end: no-history user gets redistributed mix, full page', async () => {
  const u = await makeUser('feed-b@example.com');
  await seedLibrary(u.id, 'feed-b@mega.test', [
    {
      creator: 'Fresh Alpha',
      heads: ['Fresh Alpha Tour', 'Fresh Alpha Trip'],
      nests: [
        'Fresh Alpha Tour Extended',
        'Fresh Alpha Tour Live',
        'Fresh Alpha Trip Extended',
        'Fresh Alpha Trip Live',
        'Fresh Alpha Tour Remix',
      ],
      fillers: 19,
    },
    {
      creator: 'Fresh Beta',
      heads: ['Fresh Beta Trip'],
      nests: ['Fresh Beta Trip Extended', 'Fresh Beta Trip Live', 'Fresh Beta Trip Remix'],
      fillers: 19,
    },
    {
      creator: 'Fresh Gamma',
      heads: ['Fresh Gamma Journey'],
      nests: ['Fresh Gamma Journey Extended', 'Fresh Gamma Journey Live'],
      fillers: 20,
    },
  ]);
  const feed = await homeFeed.buildHomeFeedPage(u.id, 1, 'home-feed-test-seed');
  assert.equal(feed.items.length, 24);
  assert.deepEqual(counts(feed.items), { recent: 4, history: 0, related: 4, random: 8, variety: 8 });
});

test('end to end: small library shows all videos exactly once', async () => {
  const u = await makeUser('feed-c@example.com');
  await seedLibrary(u.id, 'feed-c@mega.test', [
    { creator: 'Tiny Star', heads: ['Tiny One', 'Tiny Two'], nests: [], fillers: 5 },
  ]);
  const feed = await homeFeed.buildHomeFeedPage(u.id, 1, 'home-feed-test-seed');
  assert.equal(feed.items.length, 7);
  assert.equal(new Set(feed.items.map((p) => p.video.id)).size, 7);
  assert.equal(feed.totalPages, 1);
});
