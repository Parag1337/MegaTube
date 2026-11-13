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
// Deterministic recovery-backoff bounds for the accounting test.
process.env.PREVIEW_JOB_RECOVERY_BASE_MS = '1000';
process.env.PREVIEW_JOB_RECOVERY_MAX_MS = '10000';
process.env.PREVIEW_JOB_RECOVERY_JITTER_MS = '0';
process.env.PREVIEW_JOB_MAX_RECOVERIES = '4';

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

test('database sessions use UTC so TIMESTAMP deadlines stay comparable', async () => {
  const rows = await prisma.$queryRaw<Array<{ tz: string }>>`SELECT current_setting('TimeZone') AS tz`;
  assert.equal(rows[0]?.tz, 'UTC');
});

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

test('claims are atomic and only one worker owns the single generation slot', async () => {
  const first = await jobs.claimNextPreviewJob('worker-a', 60_000);
  assert.ok(first);
  const second = await jobs.claimNextPreviewJob('worker-b', 60_000);
  assert.equal(second, null, 'a live lease blocks every other worker, not just the same job');

  const firstRow = await prisma.previewGenerationJob.findUnique({ where: { id: first.id } });
  assert.equal(firstRow?.lockedBy, 'worker-a');
  assert.equal(firstRow?.status, 'generating');
  assert.equal(firstRow?.stage, 'claimed');
  assert.equal(firstRow?.claimCount, 1, 'claiming is counted separately from generation attempts');
  assert.equal(firstRow?.attempts, 0, 'a claim must not consume a generation attempt');

  const attempts = await jobs.beginPreviewGenerationAttempt(first.id, 'worker-a', first.claimCount, 60_000);
  assert.equal(attempts, 1);
  const afterBegin = await prisma.previewGenerationJob.findUnique({ where: { id: first.id } });
  assert.equal(afterBegin?.stage, 'acquiring');
  assert.equal(afterBegin?.attempts, 1);
  assert.equal(afterBegin?.claimCount, 1);
});

test('completion requires the worker that owns the lease', async () => {
  const job = await prisma.previewGenerationJob.findFirst({
    where: { status: 'generating', lockedBy: 'worker-a' },
  });
  assert.ok(job);
  const ok = await jobs.completePreviewJob(job.id, 'worker-a', 321, {
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
  const again = await jobs.completePreviewJob(job.id, 'worker-b', 1, {
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
  const job = await jobs.claimNextPreviewJob('worker-b', 60_000);
  assert.ok(job);
  const outcome = await jobs.failPreviewJob(job.id, 'worker-b', 'download_timeout', 'MEGA timed out', {
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

test('attempt exhaustion preserves the specific failure code and message', async () => {
  const ensured = await jobs.ensurePreviewJob({
    videoId: videoIds[2],
    sourceFingerprint: `exhaust-${Date.now()}`,
  });
  assert.ok(ensured.jobId);
  const jobId = ensured.jobId;
  const maxAttempts = config.previewJobMaxAttempts();
  await prisma.previewGenerationJob.update({
    where: { id: jobId },
    data: {
      status: 'generating',
      lockedBy: 'worker-exhaust',
      attempts: maxAttempts,
      maxAttempts,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    },
  });

  const outcome = await jobs.failPreviewJob(
    jobId,
    'worker-exhaust',
    'encode_failed',
    'ffmpeg exited 1: encoder rejected the frame',
    { retryable: true },
  );
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.willRetry, false);

  const row = await prisma.previewGenerationJob.findUnique({ where: { id: jobId } });
  assert.equal(row?.status, 'failed');
  assert.equal(row?.errorCode, 'encode_failed', 'specific code must survive exhaustion');
  assert.match(row?.lastError ?? '', /encoder rejected the frame/);
  assert.notEqual(row?.errorCode, 'max_attempts');
  assert.equal(row?.attempts, maxAttempts);
  assert.equal(jobs.autoRetryBlockedError(row?.errorCode), false);
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

test('a generating row without a lease is recovered instead of blocking the slot', async () => {
  const job = await prisma.previewGenerationJob.findFirst({ where: { status: 'pending' } });
  assert.ok(job);
  await prisma.previewGenerationJob.update({
    where: { id: job.id },
    data: {
      status: 'generating',
      lockedBy: 'dead-worker-no-lease',
      leaseExpiresAt: null,
      attempts: 1,
      recoveryCount: 0,
    },
  });
  await jobs.recoverExpiredPreviewLeases();
  const row = await prisma.previewGenerationJob.findUnique({ where: { id: job.id } });
  assert.equal(row?.status, 'pending');
  assert.equal(row?.errorCode, 'lease_expired');
  assert.equal(row?.lockedBy, null);
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

test('dashboard statistics are served from the single-flight cache', async () => {
  jobs.__resetPreviewStatsCacheForTests();
  await jobs.getPreviewLibraryStats(userId);
  await jobs.getPreviewLibraryStats(userId);
  const metrics = jobs.previewStatsCacheMetrics();
  assert.equal(metrics.refreshes, 1, 'the second poll is a memory hit');
  assert.ok(metrics.hits >= 1);
  // Normal job/artifact mutations invalidate the snapshot without throwing.
  jobs.invalidatePreviewStatsCache();
  await jobs.getPreviewLibraryStats(userId);
});

function jobMetrics(): Parameters<typeof jobs.completePreviewJob>[3] {
  return {
    transferBytes: 0,
    acquisitionMs: 0,
    ffmpegMs: 0,
    totalMs: 0,
    outputBytes: 0,
    scenes: [],
    sourceKind: 'test',
    generationVersion: config.previewGenerationVersion(),
  };
}

test('claimCount fences stale workers from heartbeat, completion and failure', async () => {
  const ensured = await jobs.ensurePreviewJob({
    videoId: videoIds[2],
    sourceFingerprint: `fence-${Date.now()}`,
  });
  assert.ok(ensured.jobId);
  const jobId = ensured.jobId;
  await prisma.previewGenerationJob.update({
    where: { id: jobId },
    data: {
      status: 'generating',
      lockedBy: 'worker-fence',
      claimCount: 2,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    },
  });

  // A worker holding claim #1 lost the row when claim #2 was taken.
  assert.equal(await jobs.heartbeatPreviewJob(jobId, 'worker-fence', 60_000, 1), false);
  assert.equal(await jobs.setPreviewJobStage(jobId, 'worker-fence', 'encoding', 1), false);
  assert.equal(await jobs.assertPreviewJobOwnership(jobId, 'worker-fence', 1, 60_000), false);
  assert.equal(await jobs.completePreviewJob(jobId, 'worker-fence', 1, jobMetrics(), 1), false);
  const staleFail = await jobs.failPreviewJob(jobId, 'worker-fence', 'internal', 'stale worker', {
    claimCount: 1,
  });
  assert.equal(staleFail.willRetry, false);
  const stillGenerating = await prisma.previewGenerationJob.findUnique({ where: { id: jobId } });
  assert.equal(stillGenerating?.status, 'generating', 'stale failure did not mutate the row');

  // The current claim can still renew and publish.
  assert.equal(await jobs.assertPreviewJobOwnership(jobId, 'worker-fence', 2, 60_000), true);
  assert.equal(await jobs.completePreviewJob(jobId, 'worker-fence', 0, jobMetrics(), 2), true);
});

test('expired-lease recovery is counted separately and backs off exponentially', async () => {
  const ensured = await jobs.ensurePreviewJob({
    videoId: videoIds[2],
    sourceFingerprint: `recovery-${Date.now()}`,
  });
  assert.ok(ensured.jobId);
  const jobId = ensured.jobId;
  const expire = (recoveryCount: number): Promise<unknown> =>
    prisma.previewGenerationJob.update({
      where: { id: jobId },
      data: {
        status: 'generating',
        lockedBy: 'dead-worker',
        leaseExpiresAt: new Date(Date.now() - 1_000),
        attempts: 1,
        recoveryCount,
      },
    });

  await expire(0);
  const firstAt = Date.now();
  await jobs.recoverExpiredPreviewLeases();
  const first = await prisma.previewGenerationJob.findUnique({ where: { id: jobId } });
  assert.equal(first?.status, 'pending');
  assert.equal(first?.recoveryCount, 1);
  assert.equal(first?.attempts, 1, 'recovery does not consume or reset generation attempts');
  assert.equal(first?.errorCode, 'lease_expired');
  const firstDelay = (first?.nextRetryAt?.getTime() ?? 0) - firstAt;
  assert.ok(firstDelay >= 900 && firstDelay <= 5_000, `first backoff ${firstDelay}ms`);

  await expire(1);
  const secondAt = Date.now();
  await jobs.recoverExpiredPreviewLeases();
  const second = await prisma.previewGenerationJob.findUnique({ where: { id: jobId } });
  assert.equal(second?.recoveryCount, 2);
  const secondDelay = (second?.nextRetryAt?.getTime() ?? 0) - secondAt;
  assert.ok(secondDelay >= 1_900 && secondDelay <= 7_000, `second backoff ${secondDelay}ms`);
  assert.ok(secondDelay > firstDelay, 'backoff grows');

  // One more expiry exhausts the recovery budget: terminal, never reclaimed.
  await expire(3);
  await jobs.recoverExpiredPreviewLeases();
  const exhausted = await prisma.previewGenerationJob.findUnique({ where: { id: jobId } });
  assert.equal(exhausted?.status, 'failed');
  assert.equal(exhausted?.errorCode, 'worker_recovery_exhausted');
  assert.equal(exhausted?.recoveryCount, 4);
  assert.equal(exhausted?.attempts, 1);
  assert.equal(jobs.autoRetryBlockedError(exhausted?.errorCode), true);
});
