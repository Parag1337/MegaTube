/**
 * Phase A / P-02: failed/unpublished preview artifact cleanup.
 *
 * Every test uses an isolated PREVIEW_CACHE_DIR. No real user previews,
 * PostgreSQL queue rows or media files are touched.
 */

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'megatube-preview-cleanup-'));
process.env.PREVIEW_CACHE_DIR = dir;
process.env.PREVIEW_TOUCH_INTERVAL_MS = '0';

type CacheModule = typeof import('@/lib/preview/cache');
type SourceModule = typeof import('@/lib/preview/source');
type ServiceModule = typeof import('@/lib/preview/service');
type ConfigModule = typeof import('@/lib/preview/config');
type PreviewSidecar = import('@/lib/preview/types').PreviewSidecar;

let cache: CacheModule;
let source: SourceModule;
let svc: ServiceModule;
let config: ConfigModule;

before(async () => {
  cache = await import('@/lib/preview/cache');
  source = await import('@/lib/preview/source');
  svc = await import('@/lib/preview/service');
  config = await import('@/lib/preview/config');
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  cache.__resetPreviewStoreStateForTests();
  for (const name of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
});

function age(target: string, ms: number): void {
  const t = new Date(Date.now() - ms);
  fs.utimesSync(target, t, t);
}

function writeSidecar(
  videoId: number,
  opts?: {
    status?: 'ready' | 'failed';
    hover?: boolean;
    timeline?: boolean;
    version?: string;
    megaNodeId?: string;
  },
): PreviewSidecar {
  const sidecar: PreviewSidecar = {
    version: 2,
    videoId,
    megaNodeId: opts?.megaNodeId ?? `node-${videoId}`,
    sourceSize: 1000,
    durationSeconds: 100,
    status: opts?.status ?? 'ready',
    hover:
      opts?.hover === false
        ? null
        : {
            startSec: 10,
            durationSec: 6,
            width: 640,
            height: 360,
            bytes: 100,
            estimated: false,
            generationVersion: opts?.version ?? config.previewGenerationVersion(),
            scenes: [],
            faststart: true,
          },
    timeline: opts?.timeline
      ? { tileW: 160, tileH: 90, cols: 10, rows: 1, intervalSec: 4, count: 7 }
      : null,
    attempts: 0,
    lastError: null,
    failedAt: null,
    lastAccessedAt: new Date().toISOString(),
    metrics: null,
    generationVersion: opts?.version ?? config.previewGenerationVersion(),
  };
  fs.writeFileSync(path.join(dir, `${videoId}.json`), JSON.stringify(sidecar));
  return sidecar;
}

function writeAsset(videoId: number, kind: 'clip' | 'sprite', ageMs = 2 * 3600_000): string {
  const file = path.join(dir, `${videoId}.${kind === 'clip' ? 'preview.mp4' : 'sprite.jpg'}`);
  fs.writeFileSync(file, Buffer.alloc(kind === 'clip' ? 100 : 50, 1));
  age(file, ageMs);
  return file;
}

function videoRow(id: number, overrides: Partial<svc.PreviewVideoRow> = {}): svc.PreviewVideoRow {
  return {
    id,
    megaNodeId: `node-${id}`,
    fileKeyEncrypted: 'v1.fake',
    mimeType: 'video/mp4',
    fileSize: 1000n,
    duration: 100,
    mp4Faststart: true,
    megaAccount: { id: 1, userId: 'user-1', status: 'CONNECTED', encryptedSession: 'sess' },
    ...overrides,
  };
}

function failingDeps(): svc.PreviewServiceDeps {
  return {
    loadVideo: async () => null,
    decryptFileKey: () => Buffer.alloc(16, 1),
    sourceDeps: {
      fetchCiphertext: async () => {
        throw new Error('unexpected fetch');
      },
      withSession: async () => {
        throw new Error('unexpected MEGA session');
      },
      getDownloadUrl: async () => {
        throw new Error('unexpected MEGA URL');
      },
      readWarmCache: async () => null,
    },
    readWarmCache: async () => null,
    queue: {
      has: () => false,
      enqueue: async () => 'completed',
      enqueueNow: () => 'started',
      snapshot: () => ({ running: 0, queued: 0, maxConcurrent: 1, maxQueue: 8 }),
    } as unknown as svc.PreviewServiceDeps['queue'],
    now: () => Date.now(),
  };
}

function workDirNames(videoId: number): string[] {
  return fs.readdirSync(dir).filter((n) => n.startsWith(`${videoId}.tmp-`));
}

// ---------------------------------------------------------------------------
// Failed / aborted generation leaves no temp artifacts
// ---------------------------------------------------------------------------

test('failed generation removes its per-job work directory', async () => {
  const outcome = await svc.generateHoverForWorker(videoRow(101), failingDeps());
  assert.equal(outcome.ok, false);
  assert.deepEqual(workDirNames(101), [], 'no temp work dir remains');
});

test('aborted/deadline generation removes temp artifacts and writes no failed sidecar', async () => {
  const controller = new AbortController();
  controller.abort(new Error('preview job deadline exceeded'));
  const outcome = await svc.generateHoverForWorker(videoRow(102), failingDeps(), {
    signal: controller.signal,
  });
  assert.equal(outcome.ok, false);
  assert.deepEqual(workDirNames(102), [], 'no temp work dir remains');
  assert.equal(fs.existsSync(path.join(dir, '102.json')), false, 'aborted run does not clobber state');
});

test('stale work dirs and interrupted atomic temp files are reclaimed after grace', async () => {
  const work = path.join(dir, '103.tmp-crashed');
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, 'montage.tmp.mp4'), Buffer.alloc(256, 1));
  age(work, 2 * 3600_000);

  const atomicTmp = path.join(dir, '103.json.999.tmp');
  fs.writeFileSync(atomicTmp, '{"partial":true}');
  age(atomicTmp, 2 * 3600_000);

  const result = await cache.cleanupFailedPreviewArtifacts({ graceMs: 0 });
  assert.ok(result.removedWorkDirs >= 1);
  assert.ok(result.removedTempFiles >= 1);
  assert.equal(fs.existsSync(work), false);
  assert.equal(fs.existsSync(atomicTmp), false);
});

// ---------------------------------------------------------------------------
// Active work / active streams are protected
// ---------------------------------------------------------------------------

test('a live generation work dir is never cleaned even when old', async () => {
  const work = await source.createWorkDir(104);
  fs.writeFileSync(path.join(work, 'montage.tmp.mp4'), Buffer.alloc(256, 1));
  age(work, 2 * 3600_000);
  assert.equal(cache.isPreviewWorkDirActive(work), true);

  const result = await cache.cleanupFailedPreviewArtifacts({ graceMs: 0 });
  assert.equal(fs.existsSync(work), true, 'active job dir preserved');
  assert.ok(result.skippedActive >= 1);

  await source.removeWorkDir(work);
  assert.equal(cache.isPreviewWorkDirActive(work), false);
  await cache.cleanupFailedPreviewArtifacts({ graceMs: 0 });
  assert.equal(fs.existsSync(work), false, 'released dir reclaimed');
});

test('an actively streamed unservable clip is never cleaned mid-stream', async () => {
  writeSidecar(105, { status: 'failed', hover: false });
  const clip = writeAsset(105, 'clip');
  const release = cache.trackPreviewStream(105);
  try {
    const result = await cache.cleanupFailedPreviewArtifacts({ graceMs: 0 });
    assert.equal(fs.existsSync(clip), true);
    assert.ok(result.skippedActive >= 1);
  } finally {
    release();
  }
  await cache.cleanupFailedPreviewArtifacts({ graceMs: 0 });
  assert.equal(fs.existsSync(clip), false, 'unservable clip reclaimed after the stream ends');
});

// ---------------------------------------------------------------------------
// Valid artifacts and metadata are preserved
// ---------------------------------------------------------------------------

test('valid published preview + sprite + sidecar survive cleanup', async () => {
  writeSidecar(106, { hover: true, timeline: true });
  const clip = writeAsset(106, 'clip');
  const sprite = writeAsset(106, 'sprite');

  const result = await cache.cleanupFailedPreviewArtifacts({ graceMs: 0 });
  assert.equal(result.removedOrphanClips, 0);
  assert.equal(result.removedOrphanSprites, 0);
  assert.equal(fs.existsSync(clip), true);
  assert.equal(fs.existsSync(sprite), true);
  assert.equal(fs.existsSync(path.join(dir, '106.json')), true);
});

test('failed hover cleans only its clip and preserves timeline sprite + sidecar', async () => {
  writeSidecar(107, { status: 'failed', hover: false, timeline: true });
  const clip = writeAsset(107, 'clip');
  const sprite = writeAsset(107, 'sprite');

  const result = await cache.cleanupFailedPreviewArtifacts({ graceMs: 0 });
  assert.equal(result.removedOrphanClips, 1);
  assert.equal(result.removedOrphanSprites, 0);
  assert.equal(fs.existsSync(clip), false);
  assert.equal(fs.existsSync(sprite), true, 'timeline artifact still referenced by the sidecar');
  assert.equal(fs.existsSync(path.join(dir, '107.json')), true, 'valid timeline metadata preserved');
});

test('a sidecar that references no timeline does not protect an orphan sprite', async () => {
  writeSidecar(108, { status: 'failed', hover: false, timeline: false });
  const sprite = writeAsset(108, 'sprite');
  await cache.cleanupFailedPreviewArtifacts({ graceMs: 0 });
  assert.equal(fs.existsSync(sprite), false);
  assert.equal(fs.existsSync(path.join(dir, '108.json')), true);
});

// ---------------------------------------------------------------------------
// Orphan age / grace behavior, idempotence, bounded scope, failure isolation
// ---------------------------------------------------------------------------

test('old orphaned assets without a sidecar are reclaimed', async () => {
  const clip = writeAsset(109, 'clip');
  const sprite = writeAsset(109, 'sprite');
  const result = await cache.cleanupFailedPreviewArtifacts({ graceMs: 0 });
  assert.ok(result.removedOrphanClips >= 1);
  assert.ok(result.removedOrphanSprites >= 1);
  assert.equal(fs.existsSync(clip), false);
  assert.equal(fs.existsSync(sprite), false);
});

test('recent orphaned assets are preserved until the grace period elapses', async () => {
  const clip = writeAsset(110, 'clip', 0);
  const result = await cache.cleanupFailedPreviewArtifacts({ graceMs: 30 * 60_000 });
  assert.equal(result.removedOrphanClips, 0);
  assert.equal(fs.existsSync(clip), true);

  age(clip, 31 * 60_000);
  await cache.cleanupFailedPreviewArtifacts({ graceMs: 30 * 60_000 });
  assert.equal(fs.existsSync(clip), false);
});

test('repeated cleanup passes are idempotent and safe', async () => {
  const clip = writeAsset(111, 'clip');
  const first = await cache.cleanupFailedPreviewArtifacts({ graceMs: 0 });
  const second = await cache.cleanupFailedPreviewArtifacts({ graceMs: 0 });
  assert.ok(first.removedOrphanClips >= 1);
  assert.equal(second.removedOrphanClips, 0);
  assert.equal(second.removedWorkDirs, 0);
  assert.equal(fs.existsSync(clip), false);
});

test('cleanup is bounded to known preview patterns in the preview dir', async () => {
  const unrelated = path.join(dir, 'notes.txt');
  const nested = path.join(dir, 'not-a-preview');
  fs.writeFileSync(unrelated, 'keep me');
  fs.mkdirSync(nested);

  await cache.cleanupFailedPreviewArtifacts({ graceMs: 0 });
  assert.equal(fs.existsSync(unrelated), true);
  assert.equal(fs.existsSync(nested), true);
});

test('cleanup failures are counted, swallowed, and never crash the caller', async () => {
  const clip = writeAsset(112, 'clip');
  const result = await cache.cleanupFailedPreviewArtifacts({
    graceMs: 0,
    remove: async () => {
      throw new Error('simulated EACCES');
    },
  });
  assert.ok(result.failures >= 1);
  assert.equal(fs.existsSync(clip), true, 'failed deletion leaves the file for the next pass');

  // A subsequent normal pass still succeeds.
  const retry = await cache.cleanupFailedPreviewArtifacts({ graceMs: 0 });
  assert.ok(retry.removedOrphanClips >= 1);
  assert.equal(fs.existsSync(clip), false);
});

test('maxEntries bounds one pass without touching the rest of the filesystem', async () => {
  for (const id of [113, 114, 115]) writeAsset(id, 'clip');
  const result = await cache.cleanupFailedPreviewArtifacts({ graceMs: 0, maxEntries: 2 });
  assert.equal(result.scannedEntries, 2);
  // Exactly two passes are needed to reconsider all three entries.
  const second = await cache.cleanupFailedPreviewArtifacts({ graceMs: 0, maxEntries: 2 });
  assert.ok(result.removedOrphanClips + second.removedOrphanClips >= 2);
});
