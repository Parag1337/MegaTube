/**
 * REAL-MEGA integration test: full private-library sync cycle.
 *
 * Environment-gated: runs ONLY when MEGA_TEST_EMAIL and MEGA_TEST_PASSWORD
 * are set. Performs real network calls against live MEGA: login, upload of a
 * small probe file, node-tree sync, rename, deletion, and session
 * revocation -> REAUTH_REQUIRED handling.
 *
 * The probe file is created in the test account, removed at the end, and
 * nothing secret (credentials, sids, keys) is printed.
 *
 * Both phases run inside ONE top-level test so they execute sequentially in
 * one process (they share the DATABASE_URL process env + Prisma client).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const EMAIL = process.env.MEGA_TEST_EMAIL ?? '';
const PASSWORD = process.env.MEGA_TEST_PASSWORD ?? '';
const SKIP_REASON =
  !EMAIL || !PASSWORD
    ? 'MEGA_TEST_EMAIL/MEGA_TEST_PASSWORD not set - real-MEGA sync test skipped'
    : false;

test('real MEGA: full private sync cycle + dead-session handling', { skip: SKIP_REASON }, async () => {
  const { createTestDatabase } = await import('../unit/helpers/test-db');
  const {
    loginToMega,
    openMegaSession,
    closeMegaSession,
    logoutMegaSession,
  } = await import('@/lib/mega/account');
  const { evictAllMegaSessions } = await import('@/lib/sync/session-cache');

  // ======================================================================
  // Phase A: upload -> sync -> idempotent resync -> rename -> sync ->
  //          delete -> sync
  // ======================================================================
  const db = createTestDatabase('mega-sync-integration');
  process.env.DATABASE_URL = db.url;
  process.env.MEGA_SESSION_ENCRYPTION_KEY = 'ab'.repeat(32);
  evictAllMegaSessions();

  const { prisma } = await import('@/lib/db');
  const accounts = await import('@/lib/megaAccounts');
  const { syncMegaAccount } = await import('@/lib/sync/syncAccount');

  const user = await prisma.user.create({
    data: {
      email: `sync-it-${Date.now()}@example.com`,
      passwordHash: 'pbkdf2:sha256:100000:00000000000000000000000000000000:000000000000000000000000000000000000000000000000000000000000000000',
    },
  });

  try {
    const material = await loginToMega(EMAIL, PASSWORD);
    const account = await accounts.createMegaAccount({
      userId: user.id,
      label: 'integration',
      email: material.email,
      material,
    });
    const accountId = account.id;

    // Live session for upload/rename/delete operations.
    const live = await openMegaSession(material);
    try {
      const stamp = Date.now();
      const probeName = `sync-probe-${stamp}.mp4`;
      const probe = crypto.randomBytes(32 * 1024);

      const file = await (live as unknown as {
        upload: (
          opt: Record<string, unknown>,
          buffer: Buffer,
        ) => Promise<{ nodeId: string; rename: (name: string) => Promise<void>; delete: (permanent: boolean) => Promise<void> }>;
      }).upload({ name: probeName, size: probe.length, allowUploadBuffering: true }, probe);
      assert.ok(file, 'upload must return the created node');
      const nodeId = file.nodeId;
      assert.ok(nodeId, 'uploaded node must have a handle');

      // --- 1. first sync discovers and creates the video row -------------
      const first = await syncMegaAccount(accountId);
      assert.ok(first, 'first sync must complete');
      assert.equal(first.added, 1, 'probe file must be added');
      assert.equal(first.total, 1);

      let row = await prisma.video.findFirst({ where: { megaAccountId: accountId } });
      assert.ok(row, 'video row must exist after sync');
      assert.equal(row.megaNodeId, nodeId);
      assert.equal(row.megaFilename, probeName);
      assert.equal(row.fileSize, BigInt(probe.length));
      assert.ok(row.mimeType === 'video/mp4');
      assert.ok(row.slug.length > 0);
      assert.ok(row.fileKeyEncrypted && row.fileKeyEncrypted.startsWith('v1.'), 'file key must be stored encrypted');

      // --- 2. second sync is idempotent (no adds/updates/deletes) --------
      const second = await syncMegaAccount(accountId);
      assert.ok(second);
      assert.equal(second.added, 0, 'idempotent: nothing added');
      assert.equal(second.updated, 0, 'idempotent: nothing updated');
      assert.equal(second.removed, 0, 'idempotent: nothing removed');
      assert.equal(second.unchanged, 1, 'idempotent: probe unchanged');

      // --- 3. rename in MEGA -> sync picks up the new name ---------------
      const renamed = `sync-probe-renamed-${stamp}.mp4`;
      await file.rename(renamed);
      const third = await syncMegaAccount(accountId);
      assert.ok(third);
      assert.equal(third.updated, 1, 'rename must produce exactly one update');
      row = await prisma.video.findFirst({ where: { megaAccountId: accountId } });
      assert.ok(row, 'video row must still exist after rename');
      assert.equal(row!.megaNodeId, nodeId, 'same node handle keeps identity across rename');
      assert.equal(row!.megaFilename, renamed);
      assert.equal(row!.title, renamed.replace(/\.mp4$/i, ''));

      // --- 4. delete in MEGA -> sync removes the row ----------------------
      await file.delete(true);
      const fourth = await syncMegaAccount(accountId);
      assert.ok(fourth);
      assert.equal(fourth.removed, 1, 'deleted file must be removed');
      assert.equal(fourth.total, 0);
      const count = await prisma.video.count({ where: { megaAccountId: accountId } });
      assert.equal(count, 0, 'no video rows remain after delete');

      const acc = await accounts.getMegaAccountForUser(accountId, user.id);
      assert.equal(acc?.status, accounts.MEGA_ACCOUNT_STATUSES.SYNCED);
      assert.equal(acc?.videoCount, 0);
    } finally {
      closeMegaSession(live);
    }
  } finally {
    evictAllMegaSessions();
  }

  // ======================================================================
  // Phase B: dead MEGA session -> sync engine marks REAUTH_REQUIRED
  // (never auto-retries a dead session)
  //
  // Note: the Prisma client is cached process-wide and stays bound to
  // Phase A's temp database, so this phase reuses that database (still a
  // throwaway temp file).
  // ======================================================================
  evictAllMegaSessions();

  try {
    const user2 = await prisma.user.create({
      data: {
        email: `reauth-it-${Date.now()}@example.com`,
        passwordHash: 'pbkdf2:sha256:100000:00000000000000000000000000000000:000000000000000000000000000000000000000000000000000000000000000000',
      },
    });

    const material = await loginToMega(EMAIL, PASSWORD);
    const account = await accounts.createMegaAccount({
      userId: user2.id,
      label: 'reauth-probe',
      email: material.email,
      material,
    });

    // Kill the session on MEGA's side.
    const live = await openMegaSession(material);
    await logoutMegaSession(live);

    // The sync engine must fail over to REAUTH_REQUIRED, not retry forever.
    const result = await syncMegaAccount(account.id);
    assert.equal(result, null, 'sync with a dead session must not report success');
    const acc = await accounts.getMegaAccountForUser(account.id, user2.id);
    assert.equal(acc?.status, accounts.MEGA_ACCOUNT_STATUSES.REAUTH_REQUIRED);
    assert.ok(acc?.lastSyncError && acc.lastSyncError.length > 0, 'safe reauth message stored');
  } finally {
    evictAllMegaSessions();
    db.close();
  }
});
