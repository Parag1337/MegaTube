/**
 * Dashboard statistics are DB-derived, not hardcoded, and never hide failed
 * jobs. These cases pin the two production questions directly:
 *   - an empty schema shows zero videos and zero jobs;
 *   - after import, Total/Missing/Failed reflect the actual rows.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDatabase } from '../unit/helpers/test-db';

const db = createTestDatabase('preview-stats-accuracy');
process.env.DATABASE_URL = db.url;
const previewDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megatube-preview-stats-'));
process.env.PREVIEW_CACHE_DIR = previewDir;
process.env.PG_KEEPALIVE_MIN = '0';
process.env.PREVIEW_WORKER_DISABLED = '1';

let prisma: typeof import('@/lib/db').prisma;
let jobs: typeof import('@/lib/preview/jobs');
let config: typeof import('@/lib/preview/config');
let userId: string;
let accountId: number;

before(async () => {
  ({ prisma } = await import('@/lib/db'));
  jobs = await import('@/lib/preview/jobs');
  config = await import('@/lib/preview/config');

  const user = await prisma.user.create({
    data: { email: `preview-stats-${Date.now()}@example.com`, passwordHash: 'x' },
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
});

after(async () => {
  await prisma.$disconnect().catch(() => {});
  fs.rmSync(previewDir, { recursive: true, force: true });
});

process.once('exit', () => db.close());

async function addVideo(slug: string): Promise<number> {
  const video = await prisma.video.create({
    data: {
      megaAccountId: accountId,
      megaNodeId: `node-${slug}`,
      megaFilename: `${slug}.mp4`,
      title: slug,
      slug: `${slug}-${Date.now()}`,
      fileSize: BigInt(1000),
      mimeType: 'video/mp4',
      duration: 60,
    },
  });
  return video.id;
}

async function addFailedJob(videoId: number): Promise<void> {
  const version = config.previewGenerationVersion();
  const fingerprint = `node-failed-${videoId}:1000`;
  await prisma.previewGenerationJob.create({
    data: {
      videoId,
      kind: 'hover',
      sourceFingerprint: fingerprint,
      generationVersion: version,
      idempotencyKey: jobs.previewJobKey(videoId, fingerprint, version),
      status: 'failed',
      attempts: 3,
      maxAttempts: 3,
      nextRetryAt: new Date(),
      queuedAt: new Date(),
      errorCode: 'max_attempts',
      lastError: 'Preview generation exhausted its attempt budget.',
    },
  });
}

test('an empty database reports zero videos and zero jobs', async () => {
  jobs.__resetPreviewStatsCacheForTests();
  const stats = await jobs.getPreviewLibraryStats(userId);
  assert.equal(stats.totalVideos, 0);
  assert.equal(stats.completedPreviews, 0);
  assert.equal(stats.missingPreviews, 0);
  assert.equal(stats.pending, 0);
  assert.equal(stats.queued, 0);
  assert.equal(stats.generating, 0);
  assert.equal(stats.failed, 0);
  assert.equal(stats.unsupported, 0);
  assert.equal(stats.previewBytes, 0);
});

test('imported videos and failed jobs are counted from the database', async () => {
  const first = await addVideo('failed-a');
  const second = await addVideo('failed-b');
  await addFailedJob(first);
  await addFailedJob(second);

  jobs.__resetPreviewStatsCacheForTests();
  const stats = await jobs.getPreviewLibraryStats(userId);
  assert.equal(stats.totalVideos, 2);
  assert.equal(stats.completedPreviews, 0);
  assert.equal(stats.missingPreviews, 2);
  assert.equal(stats.failed, 2, 'failed jobs are shown, never replaced with zero');
  assert.equal(stats.pending, 0);
  assert.equal(stats.generating, 0);
});

test('another user’s videos and failed jobs never leak into the dashboard', async () => {
  const other = await prisma.user.create({
    data: { email: `preview-stats-other-${Date.now()}@example.com`, passwordHash: 'x' },
  });
  const otherAccount = await prisma.megaAccount.create({
    data: {
      userId: other.id,
      label: 'other',
      megaEmail: `other-${Date.now()}@example.com`,
      encryptedSession: 'v1.test',
      status: 'CONNECTED',
    },
  });
  const otherVideo = await prisma.video.create({
    data: {
      megaAccountId: otherAccount.id,
      megaNodeId: 'node-other',
      megaFilename: 'other.mp4',
      title: 'Other',
      slug: `other-${Date.now()}`,
      fileSize: BigInt(1000),
      mimeType: 'video/mp4',
      duration: 60,
    },
  });
  await addFailedJob(otherVideo.id);

  jobs.__resetPreviewStatsCacheForTests();
  const stats = await jobs.getPreviewLibraryStats(userId);
  assert.equal(stats.totalVideos, 2);
  assert.equal(stats.failed, 2);
});
