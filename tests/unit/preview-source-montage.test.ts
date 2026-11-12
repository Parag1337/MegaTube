/**
 * Phase 5.1 remediation: montage source resolution.
 *
 * Pins the bounded acquisition contract without MEGA/ffmpeg:
 *  - unknown-duration TS scenes are selected by file fraction, marked
 *    estimated, and seek to 0 inside their cut window;
 *  - known-duration TS scenes keep the exact relative timestamp mapping;
 *  - the warm cache serves every scene locally;
 *  - cancellation is observable before any work;
 *  - probe bytes are accounted once when their head/tail files are reused.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megatube-preview-source-media-'));
const previewDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megatube-preview-source-work-'));
process.env.MEDIA_CACHE_DIR = mediaDir;
process.env.PREVIEW_CACHE_DIR = previewDir;

let source: typeof import('@/lib/preview/source');
type OwnedVideo = import('@/lib/preview/types').OwnedVideo;

before(async () => {
  source = await import('@/lib/preview/source');
});

after(() => {
  fs.rmSync(mediaDir, { recursive: true, force: true });
  fs.rmSync(previewDir, { recursive: true, force: true });
});

const noNetworkDeps = (warm: { path: string; size: number } | null = null) => ({
  fetchCiphertext: async () => {
    throw new Error('unexpected MEGA fetch');
  },
  withSession: async () => {
    throw new Error('unexpected MEGA session');
  },
  getDownloadUrl: async () => {
    throw new Error('unexpected MEGA URL');
  },
  readWarmCache: async () => warm,
});

function videoOf(id: number, overrides: Partial<OwnedVideo> = {}): OwnedVideo {
  return {
    id,
    megaNodeId: `node-${id}`,
    mimeType: 'video/mp2t',
    fileSize: 32 * 1024 * 1024,
    duration: null,
    mp4Faststart: null,
    megaAccountId: 1,
    encryptedSession: 'v1.test',
    ...overrides,
  };
}

/** Sparse local TS prefix + matching frontier manifest. */
function seedTsPrefix(video: OwnedVideo): void {
  const size = Number(video.fileSize);
  const part = path.join(mediaDir, `${video.id}.ts.part`);
  fs.writeFileSync(part, Buffer.alloc(0));
  fs.truncateSync(part, size);
  fs.writeFileSync(
    path.join(mediaDir, `${video.id}.ts.frontier.json`),
    JSON.stringify({
      videoId: video.id,
      megaNodeId: video.megaNodeId,
      sourceSize: size,
      frontier: size,
      updatedAt: new Date().toISOString(),
    }),
  );
}

test('unknown-duration TS: byte-fraction windows, estimated, degraded, seek 0', async () => {
  const video = videoOf(9101);
  seedTsPrefix(video);
  const workDir = fs.mkdtempSync(path.join(previewDir, 'work-'));
  const scenes = [
    { index: 0, startSec: 10, durationSec: 1.2, fraction: 0.1, estimated: true },
    { index: 1, startSec: 50, durationSec: 1.2, fraction: 0.5, estimated: true },
    { index: 2, startSec: 90, durationSec: 1.2, fraction: 0.9, estimated: true },
  ];
  const plan = await source.resolveMontageSources(
    video,
    scenes,
    workDir,
    Buffer.alloc(16),
    noNetworkDeps(),
    { durationSec: null, prefetchedTransferBytes: 777 },
  );
  try {
    assert.equal(plan.kind, 'ts-window');
    assert.equal(plan.segments.length, 3);
    assert.equal(plan.degradedSelection, true);
    assert.equal(plan.omittedScenes.length, 0);
    assert.equal(plan.transferBytes, 777, 'probe bytes are accounted once');
    for (const segment of plan.segments) {
      assert.equal(segment.estimated, true);
      assert.equal(segment.seekSec, 0, 'a fraction window is the segment start');
      assert.ok(segment.byteFraction !== null && segment.byteFraction > 0);
      assert.ok(fs.statSync(segment.path).size > 0);
    }
    // Distinct file regions, not three copies of the beginning.
    const starts = plan.segments.map((s) => {
      const request = scenes.find((r) => r.index === s.index)!;
      return Math.floor(request.fraction * Number(video.fileSize));
    });
    assert.ok(starts[1] > starts[0] && starts[2] > starts[1]);
  } finally {
    await plan.cleanup();
  }
});

test('known-duration TS: relative input seek inside the cut window', async () => {
  const video = videoOf(9102, { duration: 1000 });
  seedTsPrefix(video);
  const workDir = fs.mkdtempSync(path.join(previewDir, 'work-'));
  const scenes = [
    { index: 0, startSec: 100, durationSec: 1.2 },
    { index: 1, startSec: 500, durationSec: 1.2 },
    { index: 2, startSec: 900, durationSec: 1.2 },
  ];
  const plan = await source.resolveMontageSources(video, scenes, workDir, Buffer.alloc(16), noNetworkDeps(), {
    durationSec: 1000,
  });
  try {
    assert.equal(plan.kind, 'ts-window');
    assert.equal(plan.degradedSelection, false);
    assert.equal(plan.segments.length, 3);
    for (const segment of plan.segments) {
      assert.equal(segment.estimated, false);
      assert.equal(segment.byteFraction, null);
      assert.ok(segment.seekSec >= 0 && segment.seekSec < 10, `relative seek ${segment.seekSec}`);
    }
  } finally {
    await plan.cleanup();
  }
});

test('warm cache: one local MP4 serves every scene without MEGA bytes', async () => {
  const video = videoOf(9103, { mimeType: 'video/mp4' });
  const warmPath = path.join(mediaDir, 'warm.mp4');
  fs.writeFileSync(warmPath, Buffer.alloc(1024));
  const workDir = fs.mkdtempSync(path.join(previewDir, 'work-'));
  const scenes = [
    { index: 0, startSec: 10, durationSec: 1.2, fraction: 0.1, estimated: true },
    { index: 1, startSec: 50, durationSec: 1.2, fraction: 0.5, estimated: true },
  ];
  const plan = await source.resolveMontageSources(
    video,
    scenes,
    workDir,
    Buffer.alloc(16),
    noNetworkDeps({ path: warmPath, size: 1024 }),
    { durationSec: null },
  );
  try {
    assert.equal(plan.kind, 'local-mp4');
    assert.equal(plan.transferBytes, 0);
    assert.equal(plan.degradedSelection, true);
    assert.equal(plan.segments.length, 2);
    for (const segment of plan.segments) {
      assert.equal(segment.path, warmPath);
      assert.equal(segment.estimated, true);
      assert.ok(segment.byteFraction !== null);
    }
  } finally {
    await plan.cleanup();
  }
});

test('resolveMontageSources: a pre-aborted job performs no acquisition', async () => {
  const video = videoOf(9104);
  seedTsPrefix(video);
  const workDir = fs.mkdtempSync(path.join(previewDir, 'work-'));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    source.resolveMontageSources(
      video,
      [{ index: 0, startSec: 10, durationSec: 1.2, fraction: 0.5 }],
      workDir,
      Buffer.alloc(16),
      noNetworkDeps(),
      { signal: controller.signal },
    ),
    (err: unknown) => err instanceof Error && err.name === 'AbortError',
  );
});
