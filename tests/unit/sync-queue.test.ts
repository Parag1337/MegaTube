/**
 * Sync queue tests: verify enqueueSync behavior for each account status.
 *
 * Runs against a fresh temporary SQLite DB.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from './helpers/test-db';

const db = createTestDatabase('sync-queue-unit');
process.env.DATABASE_URL = db.url;
process.env.MEGA_SESSION_ENCRYPTION_KEY = 'ab'.repeat(32);

let prisma: typeof import('@/lib/db')['prisma'];
let accounts: typeof import('@/lib/megaAccounts');
let enqueueSync: typeof import('@/lib/sync/queue')['enqueueSync'];
let isSyncPending: typeof import('@/lib/sync/queue')['isSyncPending'];
let waitForIdle: typeof import('@/lib/sync/queue')['waitForIdle'];
let MEGA_ACCOUNT_STATUSES: typeof import('@/lib/megaAccounts')['MEGA_ACCOUNT_STATUSES'];

before(async () => {
  ({ prisma } = await import('@/lib/db'));
  accounts = await import('@/lib/megaAccounts');
  ({ enqueueSync, isSyncPending, waitForIdle } = await import('@/lib/sync/queue'));
  ({ MEGA_ACCOUNT_STATUSES } = await import('@/lib/megaAccounts'));
});

after(async () => {
  await waitForIdle(30_000);
  db.close();
});

async function makeUser(suffix: string) {
  return prisma.user.create({
    data: {
      email: `queue-${suffix}@example.com`,
      passwordHash: 'pbkdf2:sha256:100000:00000000000000000000000000000000:000000000000000000000000000000000000000000000000000000000000000000',
    },
  });
}

async function link(userId: string, label: string, email: string) {
  const material = {
    v: 1 as const,
    sid: 'x'.repeat(58),
    masterKey: Buffer.alloc(16, 1).toString('base64url'),
    rsa: null,
    user: 'Uqueue',
    name: 'Test',
    email,
  };
  return accounts.createMegaAccount({ userId, label, email, material });
}

test('CONNECTED account can be enqueued', async () => {
  const u = await makeUser('conn');
  const acc = await link(u.id, 'Conn', 'queue-conn@example.com');
  const outcome = await enqueueSync(acc.id, 'manual');
  assert.equal(outcome, 'queued');
});

test('SYNCED account can be enqueued', async () => {
  const u = await makeUser('synced');
  const acc = await link(u.id, 'Synced', 'queue-synced@example.com');
  await prisma.megaAccount.update({
    where: { id: acc.id },
    data: { status: MEGA_ACCOUNT_STATUSES.SYNCED, lastSyncCompletedAt: new Date() },
  });
  const outcome = await enqueueSync(acc.id, 'manual');
  assert.equal(outcome, 'queued');
});

test('ERROR account can be enqueued', async () => {
  const u = await makeUser('err');
  const acc = await link(u.id, 'Err', 'queue-err@example.com');
  await accounts.markAccountError(acc.id, 'test');
  const outcome = await enqueueSync(acc.id, 'manual');
  assert.equal(outcome, 'queued');
});

test('REAUTH_REQUIRED account cannot be enqueued', async () => {
  const u = await makeUser('reauth');
  const acc = await link(u.id, 'Reauth', 'queue-reauth@example.com');
  await accounts.markAccountReauthRequired(acc.id, 'test');
  const outcome = await enqueueSync(acc.id, 'manual');
  assert.equal(outcome, 'not-eligible');
});

test('DISCONNECTED account cannot be enqueued', async () => {
  const u = await makeUser('disconn');
  const acc = await link(u.id, 'Disconn', 'queue-disconn@example.com');
  await accounts.disconnectMegaAccount(acc.id, u.id);
  const outcome = await enqueueSync(acc.id, 'manual');
  assert.equal(outcome, 'not-eligible');
});

test('duplicate enqueue returns already-pending', async () => {
  const u = await makeUser('dup');
  const acc = await link(u.id, 'Dup', 'queue-dup@example.com');
  await enqueueSync(acc.id, 'manual');
  const outcome = await enqueueSync(acc.id, 'manual');
  assert.equal(outcome, 'already-pending');
});

test('isSyncPending reflects queue state', async () => {
  const u = await makeUser('pending');
  const acc = await link(u.id, 'Pending', 'queue-pending@example.com');
  assert.equal(isSyncPending(acc.id), false);
  await enqueueSync(acc.id, 'manual');
  assert.equal(isSyncPending(acc.id), true);
});
