/**
 * User-scoped access tests for linked MEGA accounts.
 *
 * Runs against a fresh temporary SQLite DB (schema replayed from migrations)
 * so the real app database is never touched.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from './helpers/test-db';

const db = createTestDatabase('mega-accounts-unit');
process.env.DATABASE_URL = db.url;
process.env.MEGA_SESSION_ENCRYPTION_KEY = 'ab'.repeat(32);

let prisma: typeof import('@/lib/db')['prisma'];
let accounts: typeof import('@/lib/megaAccounts');
let tryDecryptSecretJson: typeof import('@/lib/mega/envelope')['tryDecryptSecretJson'];
let listLibraryVideosForUser: typeof import('@/lib/videos')['listLibraryVideosForUser'];
let countLibraryVideosForUser: typeof import('@/lib/videos')['countLibraryVideosForUser'];

before(async () => {
  ({ prisma } = await import('@/lib/db'));
  accounts = await import('@/lib/megaAccounts');
  ({ tryDecryptSecretJson } = await import('@/lib/mega/envelope'));
  ({ listLibraryVideosForUser, countLibraryVideosForUser } = await import('@/lib/videos'));
});

after(() => {
  db.close();
});

const SID = Buffer.alloc(43, 7).toString('base64url');
const MASTER = Buffer.alloc(16, 1).toString('base64url');

function makeMaterial(email: string, user: string) {
  return {
    v: 1 as const,
    sid: SID,
    masterKey: MASTER,
    rsa: null,
    user,
    name: 'Test',
    email,
  };
}

async function makeUser(suffix: string) {
  return prisma.user.create({
    data: {
      email: `user-${suffix}@example.com`,
      passwordHash: 'pbkdf2:sha256:100000:00000000000000000000000000000000:000000000000000000000000000000000000000000000000000000000000000000',
    },
  });
}

async function link(userId: string, label: string, email: string, megaUser: string) {
  return accounts.createMegaAccount({
    userId,
    label,
    email,
    material: makeMaterial(email, megaUser),
  });
}

test('user A cannot see or touch user B MEGA account', async () => {
  const a = await makeUser('iso-a');
  const b = await makeUser('iso-b');
  const acc = await link(a.id, 'Acc A', 'mega-iso-a@example.com', 'UisoA');

  assert.equal(await accounts.getMegaAccountForUser(acc.id, b.id), null, 'cross-user fetch must return null');
  assert.deepEqual(await accounts.listMegaAccountsForUser(b.id), [], 'cross-user list must be empty');

  await assert.rejects(() => accounts.disconnectMegaAccount(acc.id, b.id), /not-found/);
  await assert.rejects(
    () => accounts.replaceMegaAccountSession(acc.id, b.id, makeMaterial('mega-iso-a@example.com', 'UisoA')),
    /not-found/,
  );

  // Owner access works; material is encrypted at rest (never plaintext sid)
  const row = await accounts.getMegaAccountForUser(acc.id, a.id);
  assert.ok(row);
  assert.ok(row.encryptedSession.startsWith('v1.'));
  assert.ok(!row.encryptedSession.includes(SID), 'raw sid must not appear in the stored blob');
  assert.ok(!row.encryptedSession.includes(MASTER), 'raw master key must not appear in the stored blob');
  const decrypted = tryDecryptSecretJson(row.encryptedSession) as { user: string } | null;
  assert.ok(decrypted);
  assert.equal(decrypted.user, 'UisoA');
});

test('disconnect clears material; re-link reuses the row', async () => {
  const u = await makeUser('rel');
  const acc = await link(u.id, 'L', 'mega-rel@example.com', 'Urel');
  assert.equal(acc.status, accounts.MEGA_ACCOUNT_STATUSES.CONNECTED);

  await accounts.disconnectMegaAccount(acc.id, u.id);
  const afterDisconnect = await prisma.megaAccount.findUniqueOrThrow({ where: { id: acc.id } });
  assert.equal(afterDisconnect.status, accounts.MEGA_ACCOUNT_STATUSES.DISCONNECTED);
  assert.equal(afterDisconnect.encryptedSession, '');

  const relinked = await accounts.createMegaAccount({
    userId: u.id,
    label: 'L2',
    email: 'mega-rel@example.com',
    material: makeMaterial('mega-rel@example.com', 'Urel2'),
  });
  assert.equal(relinked.id, acc.id, 're-link must reuse the disconnected row');
  assert.equal(relinked.status, accounts.MEGA_ACCOUNT_STATUSES.CONNECTED);
});

test('linking an already-linked email is rejected', async () => {
  const u = await makeUser('dup');
  await link(u.id, 'L', 'mega-dup@example.com', 'Udup');
  await assert.rejects(
    () => link(u.id, 'L', 'mega-dup@example.com', 'Udup'),
    /already-linked/,
  );
});

test('concurrent sync claim: only one worker can win', async () => {
  const u = await makeUser('claim');
  const acc = await link(u.id, 'L', 'mega-claim@example.com', 'Uclaim');

  assert.equal(await accounts.claimSyncStart(acc.id), true, 'first claim wins');
  const racing = await Promise.all([
    accounts.claimSyncStart(acc.id),
    accounts.claimSyncStart(acc.id),
    accounts.claimSyncStart(acc.id),
  ]);
  assert.equal(racing.filter(Boolean).length, 0, 'no claim can win while SYNCING');

  await accounts.markSyncCompleted(acc.id, 0);
  assert.equal(await accounts.claimSyncStart(acc.id), true, 'claim works again after completion');
});

test('failure counters: error increments, completion resets', async () => {
  const u = await makeUser('counter');
  const acc = await link(u.id, 'L', 'mega-counter@example.com', 'Ucounter');
  assert.equal(acc.consecutiveSyncFailures, 0);

  await accounts.markAccountError(acc.id, 'safe message only');
  const r1 = await prisma.megaAccount.findUniqueOrThrow({ where: { id: acc.id } });
  assert.equal(r1.consecutiveSyncFailures, 1);
  assert.equal(r1.status, accounts.MEGA_ACCOUNT_STATUSES.ERROR);
  assert.equal(r1.lastSyncError, 'safe message only');

  await accounts.markSyncCompleted(acc.id, 3);
  const r2 = await prisma.megaAccount.findUniqueOrThrow({ where: { id: acc.id } });
  assert.equal(r2.consecutiveSyncFailures, 0);
  assert.equal(r2.videoCount, 3);
  assert.equal(r2.status, accounts.MEGA_ACCOUNT_STATUSES.SYNCED);
});

test('user A cannot access user B private videos', async () => {
  const a = await makeUser('vid-a');
  const b = await makeUser('vid-b');
  const accA = await link(a.id, 'A', 'mega-vid-a@example.com', 'UvidA');

  await prisma.video.create({
    data: {
      megaAccountId: accA.id,
      megaNodeId: 'nodeA1',
      megaFilename: 'private-a.mp4',
      title: 'Private A',
      slug: `private-a-${accA.id}`,
      fileSize: BigInt(123),
      creatorAssignment: 'none',
    },
  });

  const libA = await listLibraryVideosForUser(a.id);
  assert.equal(libA.total, 1, 'owner sees the private video');
  assert.equal(await countLibraryVideosForUser(a.id), 1);

  const libB = await listLibraryVideosForUser(b.id);
  assert.equal(libB.total, 0, 'other user must NOT see the private video');
  assert.equal(await countLibraryVideosForUser(b.id), 0);
});

test('videos of a disconnected account are hidden from the owner', async () => {
  const u = await makeUser('hide');
  const acc = await link(u.id, 'L', 'mega-hide@example.com', 'Uhide');
  await prisma.video.create({
    data: {
      megaAccountId: acc.id,
      megaNodeId: 'nodeH1',
      megaFilename: 'hidden.mp4',
      title: 'Hidden',
      slug: `hidden-${acc.id}`,
      fileSize: BigInt(1),
      creatorAssignment: 'none',
    },
  });
  assert.equal((await listLibraryVideosForUser(u.id)).total, 1);

  await accounts.disconnectMegaAccount(acc.id, u.id);
  assert.equal((await listLibraryVideosForUser(u.id)).total, 0, 'disconnected -> hidden');
});

test('listAccountsWithSessionsForUser excludes disconnected accounts', async () => {
  const u = await makeUser('sess');
  const acc = await link(u.id, 'L', 'mega-sess@example.com', 'Usess');
  assert.equal((await accounts.listAccountsWithSessionsForUser(u.id)).length, 1);

  await accounts.disconnectMegaAccount(acc.id, u.id);
  assert.equal((await accounts.listAccountsWithSessionsForUser(u.id)).length, 0);
});

test('markAccountReauthRequired updates status and error fields', async () => {
  const u = await makeUser('reauth');
  const acc = await link(u.id, 'L', 'mega-reauth@example.com', 'Ureauth');
  assert.equal(acc.status, accounts.MEGA_ACCOUNT_STATUSES.CONNECTED);

  await accounts.markAccountReauthRequired(acc.id, 'session expired');
  const row = await prisma.megaAccount.findUniqueOrThrow({ where: { id: acc.id } });
  assert.equal(row.status, accounts.MEGA_ACCOUNT_STATUSES.REAUTH_REQUIRED);
  assert.equal(row.lastSyncError, 'session expired');
  assert.ok(row.lastSyncErrorAt !== null);
});

test('REAUTH_REQUIRED accounts are excluded from syncable list', async () => {
  const u = await makeUser('syncable');
  const acc = await link(u.id, 'L', 'mega-syncable@example.com', 'Usyncable');
  assert.equal((await accounts.listSyncableAccountsForUser(u.id)).length, 1);

  await accounts.markAccountReauthRequired(acc.id, 'test');
  assert.equal((await accounts.listSyncableAccountsForUser(u.id)).length, 0);
});

test('REAUTH_REQUIRED account cannot be re-linked via createMegaAccount (use reauth flow)', async () => {
  const u = await makeUser('re-link');
  const acc = await link(u.id, 'L', 'mega-re-link@example.com', 'Urelink');
  await accounts.markAccountReauthRequired(acc.id, 'test');

  await assert.rejects(
    () =>
      accounts.createMegaAccount({
        userId: u.id,
        label: 'L2',
        email: 'mega-re-link@example.com',
        material: makeMaterial('mega-re-link@example.com', 'Urelink2'),
      }),
    /already-linked/,
    'REAUTH_REQUIRED must not be re-linked via create; use reauth flow instead',
  );
});

test('disconnectMegaAccount works on REAUTH_REQUIRED account', async () => {
  const u = await makeUser('dis-reauth');
  const acc = await link(u.id, 'L', 'mega-dis-reauth@example.com', 'Udisreauth');
  await accounts.markAccountReauthRequired(acc.id, 'test');

  await accounts.disconnectMegaAccount(acc.id, u.id);
  const row = await prisma.megaAccount.findUniqueOrThrow({ where: { id: acc.id } });
  assert.equal(row.status, accounts.MEGA_ACCOUNT_STATUSES.DISCONNECTED);
  assert.equal(row.encryptedSession, '');
});

test('videos of a REAUTH_REQUIRED account remain visible to the owner', async () => {
  const u = await makeUser('reauth-vid');
  const acc = await link(u.id, 'L', 'mega-reauth-vid@example.com', 'UreauthVid');
  await prisma.video.create({
    data: {
      megaAccountId: acc.id,
      megaNodeId: 'nodeR1',
      megaFilename: 'reauth-vid.mp4',
      title: 'Reauth Vid',
      slug: `reauth-vid-${acc.id}`,
      fileSize: BigInt(1),
      creatorAssignment: 'none',
    },
  });
  assert.equal((await listLibraryVideosForUser(u.id)).total, 1);

  await accounts.markAccountReauthRequired(acc.id, 'test');
  assert.equal((await listLibraryVideosForUser(u.id)).total, 1, 'REAUTH_REQUIRED videos stay visible');
});

test('stale video rows are preserved when account becomes REAUTH_REQUIRED', async () => {
  const u = await makeUser('stale');
  const acc = await link(u.id, 'L', 'mega-stale@example.com', 'Ustale');
  await prisma.video.create({
    data: {
      megaAccountId: acc.id,
      megaNodeId: 'nodeS1',
      megaFilename: 'stale.mp4',
      title: 'Stale',
      slug: `stale-${acc.id}`,
      fileSize: BigInt(1),
      creatorAssignment: 'none',
    },
  });

  await accounts.markAccountReauthRequired(acc.id, 'test');
  const count = await prisma.video.count({ where: { megaAccountId: acc.id } });
  assert.equal(count, 1, 'stale video rows must not be deleted on reauth');
});
