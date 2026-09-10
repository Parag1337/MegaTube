/**
 * Scheduler tests: verify which accounts are considered DUE for automatic
 * synchronization.
 *
 * Runs against a fresh temporary SQLite DB.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from './helpers/test-db';

const db = createTestDatabase('sync-scheduler-unit');
process.env.DATABASE_URL = db.url;
process.env.MEGA_SESSION_ENCRYPTION_KEY = 'ab'.repeat(32);

let prisma: typeof import('@/lib/db')['prisma'];
let accounts: typeof import('@/lib/megaAccounts');
let getDueAccounts: typeof import('@/lib/sync/scheduler')['_getDueAccountsForTests'];
let resetSchedulerFlag: typeof import('@/lib/sync/scheduler')['_resetSchedulerFlagForTests'];

before(async () => {
  ({ prisma } = await import('@/lib/db'));
  accounts = await import('@/lib/megaAccounts');
  const scheduler = await import('@/lib/sync/scheduler');
  getDueAccounts = scheduler._getDueAccountsForTests;
  resetSchedulerFlag = scheduler._resetSchedulerFlagForTests;
});

after(() => {
  db.close();
});

async function makeUser(suffix: string) {
  return prisma.user.create({
    data: {
      email: `sched-${suffix}@example.com`,
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
    user: 'Usched',
    name: 'Test',
    email,
  };
  return accounts.createMegaAccount({ userId, label, email, material });
}

test('CONNECTED accounts with a session are always due', async () => {
  resetSchedulerFlag();
  const u = await makeUser('conn');
  const acc = await link(u.id, 'Connected', 'sched-conn@example.com');
  assert.equal(acc.status, accounts.MEGA_ACCOUNT_STATUSES.CONNECTED);

  const due = await getDueAccounts();
  const ids = due.map((a) => a.id);
  assert.ok(ids.includes(acc.id), 'CONNECTED account must be due');
});

test('SYNCED accounts without lastSyncCompletedAt are due', async () => {
  resetSchedulerFlag();
  const u = await makeUser('synced-null');
  const acc = await link(u.id, 'SyncedNull', 'sched-synced-null@example.com');
  await prisma.megaAccount.update({
    where: { id: acc.id },
    data: { status: accounts.MEGA_ACCOUNT_STATUSES.SYNCED, lastSyncCompletedAt: null },
  });

  const due = await getDueAccounts();
  assert.ok(due.some((a) => a.id === acc.id), 'SYNCED with null timestamp must be due');
});

test('REAUTH_REQUIRED accounts are never due', async () => {
  resetSchedulerFlag();
  const u = await makeUser('reauth');
  const acc = await link(u.id, 'Reauth', 'sched-reauth@example.com');
  await accounts.markAccountReauthRequired(acc.id, 'test');

  const due = await getDueAccounts();
  assert.ok(!due.some((a) => a.id === acc.id), 'REAUTH_REQUIRED must not be due');
});

test('DISCONNECTED accounts are never due', async () => {
  resetSchedulerFlag();
  const u = await makeUser('disconn');
  const acc = await link(u.id, 'Disconn', 'sched-disconn@example.com');
  await accounts.disconnectMegaAccount(acc.id, u.id);

  const due = await getDueAccounts();
  assert.ok(!due.some((a) => a.id === acc.id), 'DISCONNECTED must not be due');
});

test('ERROR accounts with elapsed backoff are due', async () => {
  resetSchedulerFlag();
  const u = await makeUser('err');
  const acc = await link(u.id, 'Err', 'sched-err@example.com');
  const past = new Date(Date.now() - 10 * 60 * 1000);
  await prisma.megaAccount.update({
    where: { id: acc.id },
    data: {
      status: accounts.MEGA_ACCOUNT_STATUSES.ERROR,
      lastSyncError: 'test error',
      lastSyncErrorAt: past,
      consecutiveSyncFailures: 1,
    },
  });

  const due = await getDueAccounts();
  assert.ok(due.some((a) => a.id === acc.id), 'ERROR with elapsed backoff must be due');
});
