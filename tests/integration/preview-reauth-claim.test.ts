/**
 * A MEGA account that needs re-authentication must not receive preview work.
 *
 * The durable backlog stays pending (nothing is lost), but claiming skips the
 * account so the worker cannot burn attempts against a session that is known
 * to be invalid. Once the owner reconnects, the same job is claimable.
 *
 * Throwaway PostgreSQL database; no MEGA or ffmpeg.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from '../unit/helpers/test-db';

const db = createTestDatabase('preview-reauth-claim');
process.env.DATABASE_URL = db.url;
process.env.PREVIEW_WORKER_DISABLED = '1';
process.env.PG_KEEPALIVE_MIN = '0';

let prisma: typeof import('@/lib/db').prisma;
let jobs: typeof import('@/lib/preview/jobs');
let accountId: number;
let jobId: number;

before(async () => {
  ({ prisma } = await import('@/lib/db'));
  jobs = await import('@/lib/preview/jobs');

  const user = await prisma.user.create({
    data: { email: `reauth-claim-${Date.now()}@example.com`, passwordHash: 'x' },
  });
  const account = await prisma.megaAccount.create({
    data: {
      userId: user.id,
      label: 'reauth',
      megaEmail: `reauth-${Date.now()}@example.com`,
      encryptedSession: 'v1.test',
      status: 'REAUTH_REQUIRED',
    },
  });
  accountId = account.id;
  const video = await prisma.video.create({
    data: {
      megaAccountId: account.id,
      megaNodeId: 'node-reauth',
      megaFilename: 'reauth.mp4',
      title: 'Reauth',
      slug: `reauth-${Date.now()}`,
      fileSize: BigInt(1000),
      mimeType: 'video/mp4',
      duration: 120,
    },
  });
  const job = await prisma.previewGenerationJob.create({
    data: {
      videoId: video.id,
      sourceFingerprint: `node-${video.id}:1000`,
      generationVersion: 'test-version',
      idempotencyKey: `reauth-${video.id}`,
      status: 'pending',
    },
  });
  jobId = job.id;
});

after(async () => {
  await prisma.$disconnect().catch(() => {});
});

process.once('exit', () => db.close());

test('REAUTH_REQUIRED accounts hand out no work and keep the job pending', async () => {
  assert.equal(await jobs.claimNextPreviewJob('worker-reauth', 60_000), null);
  const row = await prisma.previewGenerationJob.findUnique({ where: { id: jobId } });
  assert.equal(row?.status, 'pending');
  assert.equal(row?.claimCount, 0);
  assert.equal(row?.lockedBy, null);
});

test('DISCONNECTED accounts are skipped the same way', async () => {
  await prisma.megaAccount.update({
    where: { id: accountId },
    data: { status: 'DISCONNECTED' },
  });
  assert.equal(await jobs.claimNextPreviewJob('worker-disconnected', 60_000), null);
  const row = await prisma.previewGenerationJob.findUnique({ where: { id: jobId } });
  assert.equal(row?.status, 'pending');
});

test('the same durable job is claimed after the account reconnects', async () => {
  await prisma.megaAccount.update({
    where: { id: accountId },
    data: { status: 'CONNECTED' },
  });
  const claimed = await jobs.claimNextPreviewJob('worker-reconnected', 60_000);
  assert.ok(claimed);
  assert.equal(claimed.id, jobId);
  assert.equal(claimed.claimCount, 1);
  const row = await prisma.previewGenerationJob.findUnique({ where: { id: jobId } });
  assert.equal(row?.status, 'generating');
  assert.equal(row?.lockedBy, 'worker-reconnected');
});
