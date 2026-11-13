/**
 * Delete All Previews: isolation and live-work safety against real PostgreSQL.
 *
 * Pins the destructive-action contract:
 *  - only the authenticated user's videos are touched;
 *  - a job in `generating` keeps its video, artifacts and queue row;
 *  - a preview currently being streamed keeps its artifacts;
 *  - only artifacts that actually exist are counted;
 *  - the operation is idempotent and releases skipped videos once idle.
 *
 * Uses a throwaway database and an isolated PREVIEW_CACHE_DIR. No real user
 * data, MEGA traffic or ffmpeg.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDatabase } from '../unit/helpers/test-db';

const db = createTestDatabase('preview-delete-all');
process.env.DATABASE_URL = db.url;
const previewDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megatube-preview-delete-all-'));
process.env.PREVIEW_CACHE_DIR = previewDir;
process.env.PREVIEW_WORKER_DISABLED = '1';
// Force multiple cursor batches through the five fixture videos so the
// batching path (lock/delete/cleanup per batch) is exercised, not just the
// single-batch happy path.
process.env.PREVIEW_DELETE_ALL_BATCH_SIZE = '2';
process.env.PG_KEEPALIVE_MIN = '0';

let prisma: typeof import('@/lib/db').prisma;
let jobs: typeof import('@/lib/preview/jobs');
let cache: typeof import('@/lib/preview/cache');
let userA: { id: string };
let videoPendingA: number;
let videoGeneratingA: number;
let videoStreamingA: number;
let videoOtherA: number;
let videoOtherB: number;
let releaseStream: () => void;
const artifactBytes = new Map<number, number>();

before(async () => {
  ({ prisma } = await import('@/lib/db'));
  jobs = await import('@/lib/preview/jobs');
  cache = await import('@/lib/preview/cache');

  const a = await prisma.user.create({
    data: { email: `delete-all-a-${Date.now()}@example.com`, passwordHash: 'x' },
  });
  const b = await prisma.user.create({
    data: { email: `delete-all-b-${Date.now()}@example.com`, passwordHash: 'x' },
  });
  userA = a;

  const accountA = await prisma.megaAccount.create({
    data: {
      userId: a.id,
      label: 'a',
      megaEmail: `mega-a-${Date.now()}@example.com`,
      encryptedSession: 'v1.test',
      status: 'CONNECTED',
    },
  });
  const accountB = await prisma.megaAccount.create({
    data: {
      userId: b.id,
      label: 'b',
      megaEmail: `mega-b-${Date.now()}@example.com`,
      encryptedSession: 'v1.test',
      status: 'CONNECTED',
    },
  });

  const makeVideo = async (accountId: number, suffix: string): Promise<number> => {
    const video = await prisma.video.create({
      data: {
        megaAccountId: accountId,
        megaNodeId: `node-${suffix}`,
        megaFilename: `${suffix}.mp4`,
        title: suffix,
        slug: `delete-all-${suffix}-${Date.now()}`,
        fileSize: BigInt(1000),
        mimeType: 'video/mp4',
        duration: 120,
      },
    });
    return video.id;
  };

  videoPendingA = await makeVideo(accountA.id, 'pending-a');
  videoGeneratingA = await makeVideo(accountA.id, 'generating-a');
  videoStreamingA = await makeVideo(accountA.id, 'streaming-a');
  videoOtherA = await makeVideo(accountA.id, 'other-a');
  videoOtherB = await makeVideo(accountB.id, 'other-b');

  const makeJob = async (videoId: number, status: string): Promise<void> => {
    await prisma.previewGenerationJob.create({
      data: {
        videoId,
        sourceFingerprint: `node-${videoId}:1000`,
        generationVersion: 'test-version',
        idempotencyKey: `delete-all-${videoId}`,
        status,
        ...(status === 'generating'
          ? {
              lockedBy: 'worker-live',
              leaseExpiresAt: new Date(Date.now() + 60_000),
            }
          : {}),
      },
    });
  };
  await makeJob(videoPendingA, 'pending');
  await makeJob(videoGeneratingA, 'generating');
  await makeJob(videoStreamingA, 'pending');
  await makeJob(videoOtherA, 'pending');
  await makeJob(videoOtherB, 'pending');

  for (const videoId of [
    videoPendingA,
    videoGeneratingA,
    videoStreamingA,
    videoOtherA,
    videoOtherB,
  ]) {
    fs.writeFileSync(
      path.join(previewDir, `${videoId}.json`),
      JSON.stringify({ version: 2, videoId, status: 'ready' }),
    );
    fs.writeFileSync(path.join(previewDir, `${videoId}.preview.mp4`), Buffer.alloc(10, 1));
    fs.writeFileSync(path.join(previewDir, `${videoId}.sprite.jpg`), Buffer.alloc(5, 1));
    artifactBytes.set(
      videoId,
      artifacts(videoId).reduce((sum, file) => sum + fs.statSync(file).size, 0),
    );
  }

  releaseStream = cache.trackPreviewStream(videoStreamingA);
});

after(async () => {
  releaseStream?.();
  await prisma.$disconnect().catch(() => {});
  fs.rmSync(previewDir, { recursive: true, force: true });
});

process.once('exit', () => db.close());

function artifacts(videoId: number): string[] {
  return [
    path.join(previewDir, `${videoId}.json`),
    path.join(previewDir, `${videoId}.preview.mp4`),
    path.join(previewDir, `${videoId}.sprite.jpg`),
  ];
}

test('delete-all removes only idle videos owned by the caller and reports accurate counts', async () => {
  const result = await jobs.deleteAllUserPreviews(userA.id);

  assert.equal(result.filesDeleted, 6, 'two idle videos × three artifacts');
  assert.equal(
    result.bytesFreed,
    (artifactBytes.get(videoPendingA) ?? 0) + (artifactBytes.get(videoOtherA) ?? 0),
    'only existing file bytes are counted',
  );
  assert.equal(result.jobsDeleted, 2, 'only deletable videos lose queue rows');
  assert.equal(result.skippedActiveVideos, 2, 'generating + actively streamed videos');

  for (const id of [videoPendingA, videoOtherA]) {
    assert.ok(artifacts(id).every((p) => !fs.existsSync(p)), `video ${id} artifacts removed`);
    assert.equal(
      await prisma.previewGenerationJob.count({ where: { videoId: id } }),
      0,
      `video ${id} job removed`,
    );
  }

  for (const id of [videoGeneratingA, videoStreamingA, videoOtherB]) {
    assert.ok(artifacts(id).every((p) => fs.existsSync(p)), `video ${id} artifacts preserved`);
    assert.equal(
      await prisma.previewGenerationJob.count({ where: { videoId: id } }),
      1,
      `video ${id} job preserved`,
    );
  }

  // Another user's queue row and files are untouched.
  assert.equal(
    await prisma.previewGenerationJob.count({ where: { videoId: videoOtherB } }),
    1,
  );
});

test('a second delete-all is idempotent and still protects live work', async () => {
  const result = await jobs.deleteAllUserPreviews(userA.id);
  assert.equal(result.filesDeleted, 0);
  assert.equal(result.bytesFreed, 0);
  assert.equal(result.jobsDeleted, 0);
  assert.equal(result.skippedActiveVideos, 2);
  assert.ok(artifacts(videoGeneratingA).every((p) => fs.existsSync(p)));
  assert.ok(artifacts(videoStreamingA).every((p) => fs.existsSync(p)));
});

test('a released stream becomes deletable while the live generation stays protected', async () => {
  releaseStream();
  const result = await jobs.deleteAllUserPreviews(userA.id);
  assert.equal(result.filesDeleted, 3);
  assert.equal(result.jobsDeleted, 1);
  assert.equal(result.skippedActiveVideos, 1);
  assert.ok(artifacts(videoStreamingA).every((p) => !fs.existsSync(p)));
  assert.ok(artifacts(videoGeneratingA).every((p) => fs.existsSync(p)));
});
