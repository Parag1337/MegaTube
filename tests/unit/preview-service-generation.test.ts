/**
 * Phase 5.1 remediation: generation orchestration through a real local
 * warm-cache source and real ffmpeg.
 *
 * Pins the wiring the audit called out:
 *  - unknown DB duration is probed from the warm cache before planning;
 *  - scenes are marked estimated only when selection really is estimated;
 *  - publication is fenced (a lost claim never renames the artifact);
 *  - an aborted job is classified as job_timeout and writes no failed
 *    sidecar that could clobber a newer worker.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const previewDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megatube-preview-generation-'));
process.env.PREVIEW_CACHE_DIR = previewDir;
process.env.PREVIEW_FFMPEG_TIMEOUT_MS = '30000';

const hasFfmpeg = (() => {
  try {
    const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
    return spawnSync(ffmpeg, ['-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();

let svc: typeof import('@/lib/preview/service');
let cache: typeof import('@/lib/preview/cache');
let ffmpeg: typeof import('@/lib/preview/ffmpeg');
let PreviewQueue: typeof import('@/lib/preview/queue').PreviewQueue;

before(async () => {
  svc = await import('@/lib/preview/service');
  cache = await import('@/lib/preview/cache');
  ffmpeg = await import('@/lib/preview/ffmpeg');
  ({ PreviewQueue } = await import('@/lib/preview/queue'));
});

after(() => {
  fs.rmSync(previewDir, { recursive: true, force: true });
});

function videoRow(id: number, fileSize: number, duration: number | null = null) {
  return {
    id,
    megaNodeId: `node-${id}`,
    fileKeyEncrypted: 'v1.fake',
    mimeType: 'video/mp4',
    fileSize: BigInt(fileSize),
    duration,
    mp4Faststart: true,
    megaAccount: { id: 1, userId: 'user-1', status: 'CONNECTED', encryptedSession: 'v1.session' },
  };
}

function depsFor(warmPath: string) {
  return {
    loadVideo: async () => null,
    decryptFileKey: () => Buffer.alloc(16),
    sourceDeps: {
      fetchCiphertext: async () => {
        throw new Error('unexpected MEGA fetch');
      },
      withSession: async () => {
        throw new Error('unexpected MEGA session');
      },
      getDownloadUrl: async () => {
        throw new Error('unexpected MEGA URL');
      },
      readWarmCache: async () => ({ path: warmPath, size: fs.statSync(warmPath).size }),
    },
    readWarmCache: async () => ({ path: warmPath, size: fs.statSync(warmPath).size }),
    queue: new PreviewQueue(1, 1),
    now: () => Date.now(),
  } as unknown as import('@/lib/preview/service').PreviewServiceDeps;
}

function metaDepsFor(
  video: ReturnType<typeof videoRow>,
  warmPath: string,
): import('@/lib/preview/service').PreviewServiceDeps {
  const deps = depsFor(warmPath);
  deps.loadVideo = async (_userId, id) => (id === video.id ? video : null);
  return deps;
}

async function waitForTimeline(
  videoId: number,
  timeoutMs = 60_000,
): Promise<import('@/lib/preview/types').PreviewSidecar> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sidecar = await cache.readSidecar(videoId);
    if (sidecar?.timeline) return sidecar;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeline sidecar did not appear for video ${videoId}`);
}

async function makeFixture(target: string, seconds = 6): Promise<void> {
  const run = await ffmpeg.encodeMontage({
    inputs: [],
    width: 320,
    height: 180,
    fps: 24,
    bitrateKbps: 400,
    outPath: target,
    timeoutMs: 1,
  });
  // encodeMontage rejects an empty input list before invoking ffmpeg; build
  // the fixture with a direct lavfi encode instead.
  assert.equal(run.ok, false);
  const encoded = await ffmpeg.runFfmpeg(
    [
      '-f', 'lavfi', '-i', `testsrc2=s=320x180:r=24:d=${seconds}`,
      '-c:v', 'libopenh264',
      '-pix_fmt', 'yuv420p',
      '-b:v', '500k',
      '-rc_mode', 'bitrate',
      // Explicit GOP so `-discard nokey` has keyframes to sample in the
      // timeline tests (libopenh264's default GOP is long).
      '-g', '24',
      '-movflags', '+faststart',
      '-f', 'mp4',
      '-y', target,
    ],
    60_000,
  );
  assert.equal(encoded.code, 0, encoded.stderrTail);
}

test(
  'generation: probes duration, publishes a real montage, marks scenes exact',
  { skip: hasFfmpeg ? false : 'ffmpeg not installed', timeout: 120_000 },
  async () => {
    const warmPath = path.join(previewDir, 'warm-source.mp4');
    await makeFixture(warmPath);
    const video = videoRow(9201, fs.statSync(warmPath).size, null);
    const result = await svc.generateHoverForWorker(video, depsFor(warmPath), {
      guardPublish: async () => true,
    });
    assert.equal(result.ok, true, result.detail);
    assert.ok(fs.existsSync(cache.clipPath(video.id)), 'clip published');

    const sidecar = JSON.parse(fs.readFileSync(cache.sidecarPath(video.id), 'utf8'));
    assert.equal(sidecar.status, 'ready');
    assert.equal(sidecar.hover.estimated, false);
    assert.ok(sidecar.hover.scenes.length >= 1);
    assert.ok(sidecar.durationSeconds > 0, 'duration was probed from the local source');
    assert.ok(
      sidecar.hover.scenes.every((s: { estimated?: boolean }) => s.estimated === false),
      'known-duration scenes are not marked estimated',
    );
    assert.ok(sidecar.metrics.totalMs >= 0);
    assert.ok(sidecar.timeline, 'hover generation also emitted a window-reuse timeline');
    assert.equal(sidecar.timeline.times?.[0], 0, 'first cold cell covers from 0');
    assert.equal(sidecar.timeline.count, sidecar.timeline.times?.length);
    assert.ok(fs.existsSync(cache.spritePath(video.id)), 'timeline sprite published with hover');
  },
);

test(
  'generation: publication fencing blocks a worker that lost its claim',
  { skip: hasFfmpeg ? false : 'ffmpeg not installed', timeout: 120_000 },
  async () => {
    const warmPath = path.join(previewDir, 'warm-source-2.mp4');
    await makeFixture(warmPath);
    const video = videoRow(9202, fs.statSync(warmPath).size, 6);
    const result = await svc.generateHoverForWorker(video, depsFor(warmPath), {
      guardPublish: async () => false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'lease_lost');
    assert.equal(fs.existsSync(cache.clipPath(video.id)), false, 'no artifact rename');
    assert.equal(fs.existsSync(cache.sidecarPath(video.id)), false, 'no ready sidecar');
  },
);

test(
  'generation: a pre-aborted job is a timeout and never writes a failure sidecar',
  { skip: hasFfmpeg ? false : 'ffmpeg not installed', timeout: 60_000 },
  async () => {
    const warmPath = path.join(previewDir, 'warm-source-3.mp4');
    await makeFixture(warmPath);
    const video = videoRow(9203, fs.statSync(warmPath).size, 6);
    const controller = new AbortController();
    controller.abort();
    const result = await svc.generateHoverForWorker(video, depsFor(warmPath), {
      signal: controller.signal,
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'job_timeout');
    assert.equal(
      fs.existsSync(cache.sidecarPath(video.id)),
      false,
      'an aborted run must not clobber a newer sidecar',
    );
  },
);

test(
  'timeline: warm-cache source produces a dense sprite and matching VTT',
  { skip: hasFfmpeg ? false : 'ffmpeg not installed', timeout: 120_000 },
  async () => {
    const warmPath = path.join(previewDir, 'warm-timeline.mp4');
    await makeFixture(warmPath, 20);
    const video = videoRow(9204, fs.statSync(warmPath).size, 20);
    const deps = metaDepsFor(video, warmPath);
    const meta = await svc.handlePreviewMeta('user-1', '9204', { want: 'timeline' }, deps);
    assert.equal(meta.status, 200);
    const sidecar = await waitForTimeline(9204);
    assert.equal(sidecar.timeline?.count, 5);
    assert.equal(sidecar.timeline?.times, undefined, 'warm sprite uses the regular grid');
    assert.ok(fs.existsSync(cache.spritePath(9204)), 'sprite published');

    const probe = await ffmpeg.probeMedia(cache.spritePath(9204), 30_000);
    assert.equal(probe?.width, 1600);
    assert.equal(probe?.height, 90);

    const vtt = await svc.handlePreviewVtt('user-1', '9204', {}, deps);
    assert.equal(vtt.status, 200);
    const text = await vtt.text();
    assert.equal((text.match(/-->/g) ?? []).length, 5);
    assert.match(text, /#xywh=640,0,160,90/);
  },
);

test(
  'timeline helpers: extract frames from windows and tile them',
  { skip: hasFfmpeg ? false : 'ffmpeg not installed', timeout: 120_000 },
  async () => {
    const source = path.join(previewDir, 'helper-source.mp4');
    await makeFixture(source, 6);
    const frameDir = path.join(previewDir, 'helper-frames');
    fs.mkdirSync(frameDir, { recursive: true });
    const frames: string[] = [];
    for (const [i, seek] of [0.5, 2, 3.5, 5].entries()) {
      const out = path.join(frameDir, `f${i}.jpg`);
      const result = await ffmpeg.extractFrameJpeg({
        inputPath: source,
        seekSec: seek,
        tileW: 160,
        tileH: 90,
        outPath: out,
        timeoutMs: 30_000,
      });
      assert.equal(result.ok, true, result.detail);
      frames.push(out);
    }
    const sheet = path.join(frameDir, 'sheet.jpg');
    const tiled = await ffmpeg.encodeSpriteFromFrames({
      imagePaths: frames,
      tileW: 160,
      tileH: 90,
      cols: 2,
      rows: 2,
      outPath: sheet,
      timeoutMs: 30_000,
    });
    assert.equal(tiled.ok, true, tiled.detail);
    const probe = await ffmpeg.probeMedia(sheet, 30_000);
    assert.equal(probe?.width, 320);
    assert.equal(probe?.height, 180);
  },
);
