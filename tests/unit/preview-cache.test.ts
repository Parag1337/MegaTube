/**
 * Phase 5 tests: bounded preview store (lib/preview/cache.ts).
 * LRU eviction, stale reclaim, stream refcount protection, sidecar IO,
 * all against an isolated PREVIEW_CACHE_DIR — never the real store.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'megatube-preview-cache-'));
process.env.PREVIEW_CACHE_DIR = dir;
process.env.PREVIEW_TOUCH_INTERVAL_MS = '0';
process.env.PREVIEW_EVICTION_GRACE_MS = '0';

let cache: typeof import('@/lib/preview/cache');

type PreviewSidecar = import('@/lib/preview/types').PreviewSidecar;

before(async () => {
  cache = await import('@/lib/preview/cache');
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function clean() {
  for (const n of fs.readdirSync(dir)) fs.rmSync(path.join(dir, n), { force: true, recursive: true });
}

function writeEntry(
  videoId: number,
  opts?: { lastAccessedAt?: string; noSidecar?: boolean; noSprite?: boolean; noClip?: boolean },
) {
  if (!opts?.noClip) fs.writeFileSync(path.join(dir, `${videoId}.preview.mp4`), Buffer.alloc(100, 1));
  if (!opts?.noSprite) fs.writeFileSync(path.join(dir, `${videoId}.sprite.jpg`), Buffer.alloc(50, 2));
  if (!opts?.noSidecar) {
    const sidecar: PreviewSidecar = {
      version: 1,
      videoId,
      megaNodeId: `node-${videoId}`,
      sourceSize: 1000,
      durationSeconds: 100,
      status: 'ready',
      hover: { startSec: 25, durationSec: 8, width: 640, height: 360, bytes: 100, estimated: false },
      timeline: null,
      attempts: 1,
      lastError: null,
      failedAt: null,
      lastAccessedAt: opts?.lastAccessedAt ?? new Date().toISOString(),
      metrics: null,
    };
    fs.writeFileSync(path.join(dir, `${videoId}.json`), JSON.stringify(sidecar));
  }
}

test('sidecar round-trip: write + validated read', async () => {
  clean();
  const sidecar: PreviewSidecar = {
    version: 1,
    videoId: 1,
    megaNodeId: 'abc',
    sourceSize: 1234,
    durationSeconds: null,
    status: 'ready',
    hover: null,
    timeline: null,
    attempts: 0,
    lastError: null,
    failedAt: null,
    lastAccessedAt: new Date().toISOString(),
    metrics: null,
  };
  await cache.writeSidecarAtomic(sidecar);
  const read = await cache.readSidecar(1);
  assert.ok(read);
  assert.equal(read.megaNodeId, 'abc');
  // No tmp leftovers.
  assert.ok(!fs.readdirSync(dir).some((n) => n.endsWith('.tmp')));
});

test('sidecar validator rejects corrupt disk bytes', async () => {
  clean();
  fs.writeFileSync(path.join(dir, '2.json'), '{"version":2,"videoId":2}');
  assert.equal(await cache.readSidecar(2), null);
  fs.writeFileSync(path.join(dir, '3.json'), 'not json at all');
  assert.equal(await cache.readSidecar(3), null);
  assert.equal(await cache.readSidecar(999), null);
});

test('identity: node + size must match; size change invalidates', async () => {
  const a: PreviewSidecar = {
    version: 1,
    videoId: 1,
    megaNodeId: 'abc',
    sourceSize: 1234,
    durationSeconds: null,
    status: 'ready',
    hover: null,
    timeline: null,
    attempts: 0,
    lastError: null,
    failedAt: null,
    lastAccessedAt: new Date().toISOString(),
    metrics: null,
  };
  assert.ok(cache.identityMatches(a, { megaNodeId: 'abc', sourceSize: 1234 }));
  assert.equal(cache.identityMatches(a, { megaNodeId: 'abc', sourceSize: 999 }), false);
  assert.equal(cache.identityMatches(a, { megaNodeId: 'xyz', sourceSize: 1234 }), false);
});

test('eviction: under budget → nothing evicted', async () => {
  clean();
  writeEntry(1, { lastAccessedAt: new Date(Date.now() - 3600_000).toISOString() });
  writeEntry(2, { lastAccessedAt: new Date().toISOString() });
  const r = await cache.evictPreviewCache({ maxBytes: 10 * 1024 * 1024 });
  assert.equal(r.evicted, 0);
  assert.equal(r.entries, 2);
});

test('eviction: LRU victim loses both assets + sidecar', async () => {
  clean();
  writeEntry(1, { lastAccessedAt: new Date(Date.now() - 3600_000).toISOString() }); // old
  writeEntry(2, { lastAccessedAt: new Date().toISOString() }); // fresh
  const r = await cache.evictPreviewCache({ maxBytes: 200 });
  assert.equal(r.evicted, 1);
  assert.ok(!fs.existsSync(path.join(dir, '1.preview.mp4')));
  assert.ok(!fs.existsSync(path.join(dir, '1.json')), 'sidecar goes with the assets');
  assert.ok(fs.existsSync(path.join(dir, '2.preview.mp4')));
});

test('eviction: missing/corrupt sidecar → stale reclaim even under budget', async () => {
  clean();
  writeEntry(1, { noSidecar: true });
  const r = await cache.evictPreviewCache({ maxBytes: 10 * 1024 * 1024 });
  assert.equal(r.reclaimedStale, 1);
  assert.equal(r.evicted, 1);
  assert.ok(!fs.existsSync(path.join(dir, '1.preview.mp4')));
});

test('eviction: actively streamed ids are never victims', async () => {
  clean();
  writeEntry(1, { lastAccessedAt: new Date(Date.now() - 3600_000).toISOString() });
  writeEntry(2, { lastAccessedAt: new Date().toISOString() });
  const release = cache.trackPreviewStream(1);
  assert.equal(cache.activePreviewReaders(1), 1);
  const r = await cache.evictPreviewCache({ maxBytes: 200 });
  // Entry 2 is protected next-by-age... 1 is protected by refcount → 2 goes.
  assert.ok(fs.existsSync(path.join(dir, '1.preview.mp4')));
  assert.ok(!fs.existsSync(path.join(dir, '2.preview.mp4')));
  assert.equal(r.evicted, 1);
  release();
  assert.equal(cache.activePreviewReaders(1), 0);
  // Now 1 is evictable again (budget below its 150 B footprint).
  const r2 = await cache.evictPreviewCache({ maxBytes: 100 });
  assert.ok(!fs.existsSync(path.join(dir, '1.preview.mp4')));
  assert.equal(r2.evicted, 1);
  cache.__resetPreviewStoreStateForTests();
});

test('temp files are never eviction victims', async () => {
  clean();
  writeEntry(1);
  const tmp = path.join(dir, '1.tmp-abc123');
  fs.mkdirSync(tmp);
  fs.writeFileSync(path.join(tmp, 'clip.tmp.mp4'), Buffer.alloc(10_000_000, 3));
  const r = await cache.evictPreviewCache({ maxBytes: 10 });
  assert.equal(r.evicted, 1); // the real entry goes
  assert.ok(fs.existsSync(path.join(tmp, 'clip.tmp.mp4')), 'temp dir untouched');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('previewStoreStats reports entry sizes', async () => {
  clean();
  writeEntry(1);
  writeEntry(2, { noSprite: true });
  const stats = await cache.previewStoreStats();
  assert.equal(stats.entries, 2);
  assert.equal(stats.entryBytes, 100 + 50 + 100);
});

test('touchPreview: memory-only, throttled, flushed with one sidecar write', async () => {
  clean();
  writeEntry(7, { lastAccessedAt: '2020-01-01T00:00:00.000Z' });
  cache.__resetPreviewStoreStateForTests();
  const before = fs.readFileSync(path.join(dir, '7.json'), 'utf8');
  await cache.touchPreview(7);
  assert.equal(cache.pendingPreviewTouchCount(), 1);
  const firstTouch = cache.pendingPreviewTouchAt(7);
  assert.ok(firstTouch !== null);
  assert.equal(fs.readFileSync(path.join(dir, '7.json'), 'utf8'), before, 'no write on access');

  // Within the throttle window a second access updates nothing.
  process.env.PREVIEW_TOUCH_INTERVAL_MS = '60000';
  try {
    await cache.touchPreview(7);
    assert.equal(cache.pendingPreviewTouchAt(7), firstTouch);
  } finally {
    process.env.PREVIEW_TOUCH_INTERVAL_MS = '0';
  }

  const written = await cache.flushPreviewAccessTimes();
  assert.equal(written, 1);
  assert.equal(cache.pendingPreviewTouchCount(), 0);
  const after = JSON.parse(fs.readFileSync(path.join(dir, '7.json'), 'utf8')) as {
    lastAccessedAt: string;
  };
  assert.ok(Date.parse(after.lastAccessedAt) > Date.parse('2020-01-01T00:00:00.000Z'));
});
