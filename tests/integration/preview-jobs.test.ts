/**
 * Phase 5.1: durable preview-generation backlog against real PostgreSQL.
 *
 * Pins the reliability contract: idempotent insertion, SKIP LOCKED claiming
 * without duplicate simultaneous work, lease-expiry recovery, retry/backoff,
 * terminal retry, pause, artifact verification (ephemeral cache), and the
 * dashboard counts. No MEGA and no ffmpeg run here.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDatabase } from '../unit/helpers/test-db';

const db = createTestDatabase('preview-jobs');
process.env.DATABASE_URL = db.url;
const previewDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megatube-preview-jobs-'));
process.env.PREVIEW_CACHE_DIR = previewDir;
// No pool keepalive: the throwaway database is dropped in after(), and a
// background ping would surface as "terminating connection" noise.
process.env.PG_KEEPALIVE_MIN = '0';
// Enqueue helpers wake the real worker; this test drives the queue directly.
process.env.PREVIEW_WORKER_DISABLED = '1';

let prisma: typeof import('@/lib/db').prisma;
let jobs: typeof import('@/lib/preview/jobs');
let config: typeof import('@/lib/preview/config');
let userId: string;
let accountId: number;
let videoIds: number[];

before(async () => {
  ({ prisma } = await import('@/lib/db'));
  jobs = await import('@/lib/preview/jobs');
  config = await import('@/lib/preview/config');

  const user = await prisma.user.create({
    data: { email: `preview-jobs-${Date.now()}@example.com`, passwordHash: 'x' },
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

  videoIds = [];
  for (let i = 0; i < 5; i++) {
    const video = await prisma.video.create({
      data: {
        megaAccountId: accountId,
        megaNodeId: `node-${i}`,
        megaFilename: `video-${i}.mp4`,
        title: `Video ${i}`,
        slug: `video-${i}-${Date.now()}`,
        fileSize: BigInt(1000 + i),
        mimeType: 'video/mp4',
        duration: 120,
      },
    });
    videoIds.push(video.id);
  }
});

after(async () => {
  await prisma.$disconnect().catch(() => {});
  fs.rmSync(previewDir, { recursive: true, force: true });
});

// Drop the throwaway database only when the process is leaving: the pg pool
// may still hold idle sockets, and killing them mid-run would surface as
// uncaught "terminating connection" noise after the test file finished.
process.once('exit', () => db.close());

test('idempotent insertion: duplicate ensures and sync events converge on one job', async () => {
  const fingerprint = `node-0:1000`;
  const first = await jobs.ensurePreviewJob({
    videoId: videoIds[0],
    sourceFingerprint: fingerprint,
    priority: 10,
  });
  assert.equal(first.enqueued, true);
  const second = await jobs.ensurePreviewJob({
    videoId: videoIds[0],
    sourceFingerprint: fingerprint,
    priority: 10,
  });
  assert.equal(second.jobId, first.jobId);
  assert.equal(second.status, 'pending', 'the existing job is reported, not recreated');

  const count = await prisma.previewGenerationJob.count({
    where: { videoId: videoIds[0], kind: 'hover' },
  });
  assert.equal(count, 1);
});

test('bulk scan enqueues one durable job per video lacking an artifact', async () => {
  const result = await jobs.ensureMissingPreviewJobs({
    userId,
    priority: config.previewPriorityManual(),
    verifyArtifacts: true,
  });
  assert.equal(result.scanned, 5);
  assert.ok(result.enqueued >= 4, `enqueued ${result.enqueued}`);
  const rows = await prisma.previewGenerationJob.findMany({
    where: { video: { megaAccountId: accountId } },
    orderBy: { createdAt: 'asc' },
  });
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => r.idempotencyKey.includes(config.previewGenerationVersion())));
  assert.ok(rows.every((r) => r.status === 'pending'));
});

test('claims are atomic and never hand the same job to two workers', async () => {
  const first = await jobs.claimNextPreviewJob('worker-a', 60_000);
  const second = await jobs.claimNextPreviewJob('worker-b', 60_000);
  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.videoId, second.videoId);

  const firstRow = await prisma.previewGenerationJob.findUnique({ where: { id: first.id } });
  assert.equal(firstRow?.lockedBy, 'worker-a');
  assert.equal(firstRow?.status, 'generating');
  assert.equal(firstRow?.stage, 'acquiring');
  assert.equal(firstRow?.attempts, 1);
});

test('completion requires the worker that owns the lease', async () => {
  const job = await prisma.previewGenerationJob.findFirst({
    where: { status: 'generating', lockedBy: 'worker-b' },
  });
  assert.ok(job);
  const ok = await jobs.completePreviewJob(job.id, 'worker-b', 321, {
    transferBytes: 1000,
    acquisitionMs: 10,
    ffmpegMs: 20,
    totalMs: 30,
    outputBytes: 321,
    scenes: [],
    sourceKind: 'local-mp4',
    generationVersion: config.previewGenerationVersion(),
  });
  assert.equal(ok, true);
  const row = await prisma.previewGenerationJob.findUnique({ where: { id: job.id } });
  assert.equal(row?.status, 'completed');
  assert.equal(row?.artifactBytes, 321);
  // The wrong worker must never be able to publish.
  const again = await jobs.completePreviewJob(job.id, 'worker-a', 1, {
    transferBytes: 0,
    acquisitionMs: 0,
    ffmpegMs: 0,
    totalMs: 0,
    outputBytes: 0,
    scenes: [],
    sourceKind: 'local-mp4',
    generationVersion: config.previewGenerationVersion(),
  });
  assert.equal(again, false);
});

test('transient failure returns to pending with bounded backoff', async () => {
  const job = await prisma.previewGenerationJob.findFirst({
    where: { status: 'generating', lockedBy: 'worker-a' },
  });
  assert.ok(job);
  const outcome = await jobs.failPreviewJob(job.id, 'worker-a', 'download_timeout', 'MEGA timed out', {
    retryable: true,
  });
  assert.equal(outcome.willRetry, true);
  assert.equal(outcome.status, 'pending');
  const row = await prisma.previewGenerationJob.findUnique({ where: { id: job.id } });
  assert.equal(row?.status, 'pending');
  assert.equal(row?.errorCode, 'download_timeout');
  assert.ok(row?.nextRetryAt && row.nextRetryAt.getTime() > Date.now(), 'backoff is in the future');
  assert.equal(row?.lockedBy, null);
});

test('expired worker leases are recovered automatically', async () => {
  const job = await prisma.previewGenerationJob.findFirst({ where: { status: 'pending' } });
  assert.ok(job);
  await prisma.previewGenerationJob.update({
    where: { id: job.id },
    data: {
      status: 'generating',
      lockedBy: 'dead-worker',
      leaseExpiresAt: new Date(Date.now() - 60_000),
      attempts: 1,
    },
  });
  const recovered = await jobs.recoverExpiredPreviewLeases();
  assert.ok(recovered >= 1);
  const row = await prisma.previewGenerationJob.findUnique({ where: { id: job.id } });
  assert.equal(row?.status, 'pending');
  assert.equal(row?.lockedBy, null);
  assert.equal(row?.errorCode, 'lease_expired');
});

test('unsupported classification is terminal and does not retry', async () => {
  const claimed = await jobs.claimNextPreviewJob('worker-c', 60_000);
  assert.ok(claimed);
  const outcome = await jobs.failPreviewJob(
    claimed.id,
    'worker-c',
    'unsupported_codec',
    'unknown decoder',
    { unsupported: true },
  );
  assert.equal(outcome.status, 'unsupported');
  assert.equal(outcome.willRetry, false);
  const row = await prisma.previewGenerationJob.findUnique({ where: { id: claimed.id } });
  assert.equal(row?.status, 'unsupported');
});

test('manually retrying a terminal job requeues it exactly once', async () => {
  const unsupported = await prisma.previewGenerationJob.findFirst({
    where: { status: 'unsupported' },
  });
  assert.ok(unsupported);
  const first = await jobs.retryPreviewJobs({
    userId,
    jobIds: [unsupported.id],
    includeUnsupported: true,
  });
  assert.equal(first.retried, 1);
  const row = await prisma.previewGenerationJob.findUnique({ where: { id: unsupported.id } });
  assert.equal(row?.status, 'pending');
  assert.equal(row?.attempts, 0);
});

test('a missing artifact on disk is detected and requeued (ephemeral cache)', async () => {
  const videoId = videoIds[4];
  // Simulate a completed current-version preview that vanished from disk.
  const version = config.previewGenerationVersion();
  const fingerprint = `node-4:1004`;
  const existing = await prisma.previewGenerationJob.findUnique({
    where: {
      idempotencyKey: jobs.previewJobKey(videoId, fingerprint, version),
    },
  });
  assert.ok(existing);
  await prisma.previewGenerationJob.update({
    where: { id: existing.id },
    data: { status: 'completed', completedAt: new Date() },
  });
  assert.equal(
    await jobs.previewHoverArtifactValid(videoId, { megaNodeId: 'node-4', sourceSize: 1004 }),
    false,
    'no sidecar/clip on disk',
  );

  const result = await jobs.ensureMissingPreviewJobs({
    userId,
    verifyArtifacts: true,
    forceTerminal: true,
  });
  assert.ok(result.enqueued >= 1);
  const row = await prisma.previewGenerationJob.findUnique({ where: { id: existing.id } });
  assert.equal(row?.status, 'pending');
  assert.equal(row?.errorCode, 'artifact_missing');
});

test('a valid artifact is skipped instead of regenerated', async () => {
  const videoId = videoIds[3];
  const version = config.previewGenerationVersion();
  const fingerprint = 'node-3:1003';
  const sidecar = {
    version: 2,
    videoId,
    megaNodeId: 'node-3',
    sourceSize: 1003,
    durationSeconds: 120,
    status: 'ready',
    hover: {
      startSec: 12,
      durationSec: 6,
      width: 640,
      height: 360,
      bytes: 4,
      estimated: false,
      generationVersion: version,
      scenes: [{ startSec: 12, durationSec: 6, sourceSeekSec: 12 }],
      faststart: true,
    },
    timeline: null,
    attempts: 0,
    lastError: null,
    failedAt: null,
    lastAccessedAt: new Date().toISOString(),
    metrics: null,
    generationVersion: version,
  };
  fs.writeFileSync(path.join(previewDir, `${videoId}.json`), JSON.stringify(sidecar));
  fs.writeFileSync(path.join(previewDir, `${videoId}.preview.mp4`), Buffer.alloc(4, 1));

  const key = jobs.previewJobKey(videoId, fingerprint, version);
  await prisma.previewGenerationJob.update({
    where: { idempotencyKey: key },
    data: { status: 'completed', completedAt: new Date() },
  });

  const before = await prisma.previewGenerationJob.findUnique({ where: { idempotencyKey: key } });
  const result = await jobs.ensureMissingPreviewJobs({ userId, verifyArtifacts: true });
  assert.ok(result.skippedComplete >= 1);
  const after = await prisma.previewGenerationJob.findUnique({ where: { idempotencyKey: key } });
  assert.equal(after?.status, 'completed');
  assert.equal(after?.updatedAt.getTime(), before?.updatedAt.getTime(), 'no rewrite');
});

test('pausing a user stops claims without losing the backlog', async () => {
  await prisma.user.update({ where: { id: userId }, data: { previewPaused: true } });
  const claim = await jobs.claimNextPreviewJob('worker-d', 60_000);
  assert.equal(claim, null, 'paused users hand out no work');
  const pending = await prisma.previewGenerationJob.count({
    where: { status: { in: ['pending', 'queued'] } },
  });
  assert.ok(pending > 0, 'durable backlog remains');
  await prisma.user.update({ where: { id: userId }, data: { previewPaused: false } });
  const resumed = await jobs.claimNextPreviewJob('worker-d', 60_000);
  assert.ok(resumed, 'work resumes when unpaused');
});

test('sync enqueue respects the automatic-generation setting and stays idempotent', async () => {
  const video = await prisma.video.create({
    data: {
      megaAccountId: accountId,
      megaNodeId: 'node-sync',
      megaFilename: 'sync.mp4',
      title: 'Sync video',
      slug: `sync-video-${Date.now()}`,
      fileSize: BigInt(5000),
      mimeType: 'video/mp4',
      duration: 300,
    },
  });

  await prisma.user.update({ where: { id: userId }, data: { previewAutoGenerate: false } });
  const disabled = await jobs.enqueueSyncPreviewJobs(userId, accountId);
  assert.equal(disabled, null, 'disabled automatic generation enqueues nothing');
  assert.equal(
    await prisma.previewGenerationJob.count({ where: { videoId: video.id } }),
    0,
  );

  await prisma.user.update({ where: { id: userId }, data: { previewAutoGenerate: true } });
  const enabled = await jobs.enqueueSyncPreviewJobs(userId, accountId);
  assert.ok(enabled);
  const firstCount = await prisma.previewGenerationJob.count({ where: { videoId: video.id } });
  assert.equal(firstCount, 1, 'missing previews are discovered during sync');

  // A duplicate sync event converges on the same durable job.
  await jobs.enqueueSyncPreviewJobs(userId, accountId);
  assert.equal(
    await prisma.previewGenerationJob.count({ where: { videoId: video.id } }),
    1,
  );

  // Scoped to this account: another user's backlog is never touched.
  await prisma.video.delete({ where: { id: video.id } });
});

test('dashboard statistics come from the database and the disk', async () => {
  const stats = await jobs.getPreviewLibraryStats(userId);
  assert.equal(stats.totalVideos, 5);
  assert.equal(stats.completedPreviews, 1);
  assert.equal(stats.missingPreviews, 4);
  assert.equal(stats.currentGenerationVersion, config.previewGenerationVersion());
  assert.ok(stats.pending + stats.generating + stats.queued > 0);
  assert.equal(stats.autoGenerate, true);
  assert.equal(stats.paused, false);
  assert.ok(stats.previewBytes > 0, 'artifact bytes are counted');
});
