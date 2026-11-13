/**
 * Regression: a claimed preview job must never be left `generating` when the
 * post-claim pre-generation code throws.
 *
 * Production hit this with `megaAccount: { userId: { not: null } }` inside
 * loadJobVideo(): Prisma rejected the query, the error escaped runJob() before
 * the heartbeat existed, and the worker immediately claimed another row. The
 * result was a whole backlog stuck in `generating` until lease recovery.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDatabase } from '../unit/helpers/test-db';

const db = createTestDatabase('preview-worker-failure');
process.env.DATABASE_URL = db.url;
const previewDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megatube-preview-worker-failure-'));
process.env.PREVIEW_CACHE_DIR = previewDir;
process.env.PG_KEEPALIVE_MIN = '0';
process.env.PREVIEW_WORKER_DISABLED = '1';

let prisma: typeof import('@/lib/db').prisma;
let jobs: typeof import('@/lib/preview/jobs');
let worker: typeof import('@/lib/preview/worker');
let userId: string;
let accountId: number;
let videoId: number;

before(async () => {
  ({ prisma } = await import('@/lib/db'));
  jobs = await import('@/lib/preview/jobs');
  worker = await import('@/lib/preview/worker');

  const user = await prisma.user.create({
    data: { email: `preview-worker-failure-${Date.now()}@example.com`, passwordHash: 'x' },
  });
  userId = user.id;
  const account = await prisma.megaAccount.create({
    data: {
      userId,
      label: 'test',
      megaEmail: `mega-${Date.now()}@example.com`,
      encryptedSession: 'v1.test',
      status: 'CONNECTED',
    },
  });
  accountId = account.id;
  const video = await prisma.video.create({
    data: {
      megaAccountId: accountId,
      megaNodeId: 'node-failure',
      megaFilename: 'failure.mp4',
      title: 'Failure video',
      slug: `failure-video-${Date.now()}`,
      fileSize: BigInt(1234),
      mimeType: 'video/mp4',
      duration: 120,
    },
  });
  videoId = video.id;
});

after(async () => {
  await prisma.$disconnect().catch(() => {});
  fs.rmSync(previewDir, { recursive: true, force: true });
});

process.once('exit', () => db.close());

test('a pre-generation exception finalizes the claimed job instead of abandoning it', async () => {
  const ensured = await jobs.ensurePreviewJob({
    videoId,
    sourceFingerprint: 'node-failure:1234',
  });
  assert.ok(ensured.jobId);

  const claimed = await jobs.claimNextPreviewJob(worker.previewWorkerId(), 60_000);
  assert.ok(claimed);
  assert.equal(claimed.id, ensured.jobId);

  await worker.runClaimedPreviewJob(claimed, {
    loadVideo: async () => {
      throw new Error('Invalid `prisma.video.findFirst()` invocation: Unknown argument `not`');
    },
  });

  const row = await prisma.previewGenerationJob.findUnique({ where: { id: claimed.id } });
  assert.equal(row?.status, 'failed', 'the row must not be left generating for lease recovery');
  assert.equal(row?.lockedBy, null);
  assert.equal(row?.leaseExpiresAt, null);
  assert.equal(row?.attempts, 0, 'no generation attempt started, so none is fabricated');
  assert.equal(row?.errorCode, 'internal');
  assert.match(row?.lastError ?? '', /Invalid `prisma\.video\.findFirst\(\)`/);
});

test('the worker video lookup uses a valid MegaAccount relation filter', async () => {
  const failed = await prisma.previewGenerationJob.findFirst({ where: { videoId } });
  assert.ok(failed);
  await prisma.previewGenerationJob.update({
    where: { id: failed.id },
    data: {
      status: 'pending',
      lockedBy: null,
      leaseExpiresAt: null,
      nextRetryAt: new Date(),
      errorCode: null,
      lastError: null,
      attempts: 0,
      recoveryCount: 0,
    },
  });

  const claimed = await jobs.claimNextPreviewJob(worker.previewWorkerId(), 60_000);
  assert.ok(claimed);
  // The fixture deliberately has no fileKeyEncrypted. A valid query reaches
  // that validation and reports source_unavailable; the old
  // `megaAccount: { userId: { not: null } }` filter throws before it.
  await worker.runClaimedPreviewJob(claimed);

  const row = await prisma.previewGenerationJob.findUnique({ where: { id: claimed.id } });
  assert.equal(row?.status, 'failed');
  assert.equal(row?.errorCode, 'source_unavailable');
});
