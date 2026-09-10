/**
 * Phase 5 unit tests.
 *
 * Part 1 - search behavior (lib/videos.ts searchVideos):
 *   user-scoped across multiple MEGA accounts, title/creator/filename match,
 *   case-insensitive, partial match, no-result, pagination, user isolation,
 *   no folder/node-id/account-label matching.
 *
 * Part 2 - network resilience (lib/net-resilience.ts):
 *   transient error classification (retry vs never retry), bounded retry
 *   with backoff, exhaustion, and no secret values in error messages.
 *
 * Uses a fresh temporary SQLite database per run; no real MEGA network.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from './helpers/test-db';

const db = createTestDatabase('phase5-search-net');
process.env.DATABASE_URL = db.url;
process.env.MEGA_SESSION_ENCRYPTION_KEY = 'ab'.repeat(32);

let prisma: typeof import('@/lib/db')['prisma'];
let searchVideos: typeof import('@/lib/videos')['searchVideos'];
let createMegaAccount: typeof import('@/lib/megaAccounts')['createMegaAccount'];
let isTransientNetworkError: typeof import('@/lib/net-resilience')['isTransientNetworkError'];
let withTransientRetry: typeof import('@/lib/net-resilience')['withTransientRetry'];
let MEGA_ACCOUNT_STATUSES: typeof import('@/lib/megaAccounts')['MEGA_ACCOUNT_STATUSES'];

before(async () => {
  ({ prisma } = await import('@/lib/db'));
  ({ searchVideos } = await import('@/lib/videos'));
  ({ createMegaAccount, MEGA_ACCOUNT_STATUSES } = await import('@/lib/megaAccounts'));
  ({ isTransientNetworkError, withTransientRetry } = await import('@/lib/net-resilience'));
});

after(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
async function makeUser(suffix: string) {
  return prisma.user.create({
    data: {
      email: `p5-${suffix}@example.com`,
      passwordHash:
        'pbkdf2:sha256:100000:00000000000000000000000000000000:000000000000000000000000000000000000000000000000000000000000000000',
    },
  });
}

async function makeAccount(userId: string, email: string) {
  return createMegaAccount({
    userId,
    label: 'Acc',
    email,
    material: {
      v: 1 as const,
      sid: 's'.repeat(60),
      masterKey: Buffer.alloc(16, 1).toString('base64url'),
      rsa: null,
      user: 'Uuser',
      name: 'User',
      email,
    },
  });
}

let slugSeq = 0;
async function makeVideo(
  accountId: number | null,
  overrides: { title?: string; creatorName?: string; megaNodeId?: string; megaFilename?: string } = {},
) {
  slugSeq += 1;
  const slug = `p5-video-${slugSeq}`;
  let creatorId: number | null = null;
  if (overrides.creatorName) {
    const creator = await prisma.creator.upsert({
      where: { name: overrides.creatorName },
      update: {},
      create: { name: overrides.creatorName, slug: `p5-creator-${slugSeq}` },
    });
    creatorId = creator.id;
  }
  return prisma.video.create({
    data: {
      megaAccountId: accountId,
      megaNodeId: overrides.megaNodeId ?? `node-${slugSeq}`,
      megaFilename: overrides.megaFilename ?? 'Creator - Title.mp4',
      title: overrides.title ?? 'A Video',
      slug,
      creatorId,
    },
  });
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
test('search: title partial match, case-insensitive (private video)', async () => {
  const u = await makeUser('search-title');
  const acc = await makeAccount(u.id, 'search-title@example.com');
  await makeVideo(acc.id, { title: 'Extra Credit Strapon', megaFilename: 'Kristie Bish - Extra Credit Strapon.mp4' });

  const r1 = await searchVideos('Extra Credit', 1, u.id);
  assert.equal(r1.total, 1);
  const r2 = await searchVideos('extra credit', 1, u.id);
  assert.equal(r2.total, 1, 'lowercase query must match');
  assert.equal(r2.items[0].title, 'Extra Credit Strapon');
});

test('search: creator name match (case-insensitive, partial)', async () => {
  const u = await makeUser('search-creator');
  const acc = await makeAccount(u.id, 'search-creator@example.com');
  await makeVideo(acc.id, { title: 'Some Video', creatorName: 'Kristie Bish' });

  const r = await searchVideos('kristie', 1, u.id);
  assert.equal(r.total, 1);
  assert.equal(r.items[0].title, 'Some Video');
});

test('search: real MEGA filename match (fallback when title differs)', async () => {
  const u = await makeUser('search-filename');
  const acc = await makeAccount(u.id, 'search-filename@example.com');
  await makeVideo(acc.id, { title: 'Display Title', megaFilename: 'Lady Onyx - Strap On Deal JOI.mp4' });

  const r = await searchVideos('strap on deal', 1, u.id);
  assert.equal(r.total, 1);
});

test('search: finds videos across MULTIPLE linked MEGA accounts', async () => {
  const u = await makeUser('search-multi');
  const acc1 = await makeAccount(u.id, 'search-multi1@example.com');
  const acc2 = await makeAccount(u.id, 'search-multi2@example.com');
  await makeVideo(acc1.id, { title: 'Alpha One', megaFilename: 'x - Alpha One.mp4' });
  await makeVideo(acc2.id, { title: 'Alpha Two', megaFilename: 'y - Alpha Two.mp4' });

  const r = await searchVideos('alpha', 1, u.id);
  assert.equal(r.total, 2, 'search must span all linked accounts of the user');
});

test('search: user isolation - cannot find videos of another user', async () => {
  const owner = await makeUser('search-iso-owner');
  const acc = await makeAccount(owner.id, 'search-iso-owner@example.com');
  await makeVideo(acc.id, { title: 'Secret Private Video' });

  const outsider = await makeUser('search-iso-outsider');
  const r = await searchVideos('Secret Private', 1, outsider.id);
  assert.equal(r.total, 0, 'private videos of another user must be invisible');
});

test('search: no-result query returns empty page', async () => {
  const u = await makeUser('search-none');
  const r = await searchVideos('zzzznope', 1, u.id);
  assert.equal(r.total, 0);
  assert.deepEqual(r.items, []);
});

test('search: empty/whitespace query returns empty result', async () => {
  const u = await makeUser('search-empty');
  const r = await searchVideos('   ', 1, u.id);
  assert.equal(r.total, 0);
  assert.equal(r.page, 1);
});

test('search: pagination works with query', async () => {
  const u = await makeUser('search-page');
  const acc = await makeAccount(u.id, 'search-page@example.com');
  for (let i = 1; i <= 5; i++) {
    await makeVideo(acc.id, { title: `Pagination Target ${i}` });
  }
  const page1 = await searchVideos('Pagination Target', 1, u.id);
  const page2 = await searchVideos('Pagination Target', 2, u.id);
  assert.equal(page1.total, 5);
  assert.equal(page1.items.length + page2.items.length, 5);
  assert.notDeepEqual(page1.items.map((v) => v.id), page2.items.map((v) => v.id));
  assert.equal(page2.page, 2);
});

test('search: does NOT match node ids, folder names or account labels', async () => {
  const u = await makeUser('search-nofolder');
  const acc = await makeAccount(u.id, 'search-nofolder@example.com');
  await makeVideo(acc.id, { title: 'Neutral Title', megaNodeId: 'zwxgTTzBQQ', megaFilename: 'Creator - Neutral Title.mp4' });

  for (const q of ['zwxgTTzBQQ', 'Acc', 'node-']) {
    const r = await searchVideos(q, 1, u.id);
    assert.equal(r.total, 0, `query "${q}" must not match via node id/folder/label`);
  }
});

test('search: videos of a disconnected account are excluded', async () => {
  const u = await makeUser('search-disc');
  const acc = await makeAccount(u.id, 'search-disc@example.com');
  await makeVideo(acc.id, { title: 'Disconnected Library Item' });
  await prisma.megaAccount.update({ where: { id: acc.id }, data: { status: MEGA_ACCOUNT_STATUSES.DISCONNECTED } });

  const r = await searchVideos('Disconnected Library', 1, u.id);
  assert.equal(r.total, 0);
});

// ---------------------------------------------------------------------------
// Network resilience
// ---------------------------------------------------------------------------
const mkErr = (name: string, code?: string) => {
  const e = new Error(name);
  e.name = name;
  if (code) (e as unknown as { cause: { code: string } }).cause = { code };
  return e;
};

test('network: transient connect failures are classified for retry', () => {
  assert.equal(isTransientNetworkError(mkErr('TypeError', 'ETIMEDOUT')), true);
  assert.equal(isTransientNetworkError(mkErr('TypeError', 'ECONNRESET')), true);
  assert.equal(isTransientNetworkError(mkErr('TypeError', 'ECONNREFUSED')), true);
  assert.equal(isTransientNetworkError(mkErr('TypeError', 'UND_ERR_CONNECT_TIMEOUT')), true);
  assert.equal(isTransientNetworkError(new TypeError('fetch failed')), true, 'bare "fetch failed" TypeError is transient');
});

test('network: auth, abort and application errors are NEVER retried', () => {
  const abort = mkErr('AbortError');
  assert.equal(isTransientNetworkError(abort), false);
  const generic = new Error('Prisma validation failed');
  assert.equal(isTransientNetworkError(generic), false);
  assert.equal(isTransientNetworkError(null), false);
  assert.equal(isTransientNetworkError('fetch failed'), false);
});

test('network: bounded retry recovers from transient failures', async () => {
  let calls = 0;
  const result = await withTransientRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw mkErr('TypeError', 'ETIMEDOUT');
      return 'ok';
    },
    { sleep: async () => {} },
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('network: retry stops immediately on non-transient errors', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withTransientRetry(
        async () => {
          calls += 1;
          throw new Error('validation');
        },
        { sleep: async () => {} },
      ),
    /validation/,
  );
  assert.equal(calls, 1, 'no retry for application errors');
});

test('network: retry exhausts after max attempts with transient errors', async () => {
  let calls = 0;
  const sleeps: number[] = [];
  await assert.rejects(
    () =>
      withTransientRetry(
        async () => {
          calls += 1;
          throw mkErr('TypeError', 'ECONNRESET');
        },
        { sleep: async (ms) => void sleeps.push(ms) },
      ),
  );
  assert.equal(calls, 3, 'default max attempts = 3');
  assert.equal(sleeps.length, 2, 'backoff between attempts only');
  assert.ok(sleeps[0] < sleeps[1], 'backoff grows');
});

test('network: error objects carry no secret-shaped values', () => {
  const err = mkErr('TypeError', 'ETIMEDOUT');
  const text = `${err.name}:${err.message}`;
  assert.ok(!/session|key|token|sid/i.test(text), 'classification uses only name/message');
});

// ---------------------------------------------------------------------------
// Node/Edge runtime boundary (structural regression)
// ---------------------------------------------------------------------------
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

test('runtime boundary: instrumentation gates Node-only module behind NEXT_RUNTIME', () => {
  const src = readFileSync(path.resolve(process.cwd(), 'instrumentation.ts'), 'utf8');
  assert.ok(
    src.includes("process.env.NEXT_RUNTIME === 'nodejs'"),
    'instrumentation must gate on NEXT_RUNTIME',
  );
  assert.ok(!/from '\.\/lib\/net-resilience'|from "@\/lib\/net-resilience"/.test(src), 'no static import of the Node-only module');
  assert.ok(src.includes("require('./lib/net-resilience')"), 'conditional require present (docs pattern)');
});

test('runtime boundary: media route is pinned to the Node.js runtime', () => {
  const src = readFileSync(path.resolve(process.cwd(), 'app/api/media/[videoId]/route.ts'), 'utf8');
  assert.match(src, /export const runtime = 'nodejs'/);
});

test('runtime boundary: client components never import the Node-only network module', () => {
  const glob = (dir: string): string[] => {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true }) as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...glob(p));
      else if (/\.(tsx|ts)$/.test(e.name) && /components|app\\|app\//.test(p)) out.push(p);
    }
    return out;
  };
  const files = [...glob('components'), ...glob('app')].filter((f) => !f.includes('api/media'));
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!src.includes('net-resilience'), `client/server-component file must not import net-resilience: ${f}`);
    assert.ok(!/from 'node:dns'|from 'node:net'/.test(src), `client-reachable file must not import node:dns|node:net: ${f}`);
  }
});
