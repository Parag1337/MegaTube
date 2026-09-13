/**
 * P1.5 tests: media disk-cache management (lib/media/cache.ts).
 *
 * Size cap + LRU eviction, live-job/stream/temp protection, stale reclaim,
 * access tracking, warm-cache validity after eviction, and config parsing.
 * All against an isolated MEDIA_CACHE_DIR - never the real 5GB library.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'megatube-cache-'));
process.env.MEDIA_CACHE_DIR = dir;
process.env.MEDIA_CACHE_TOUCH_INTERVAL_MS = '0';
process.env.MEDIA_CACHE_EVICTION_GRACE_MS = '0';

let cache: typeof import('@/lib/media/cache');
let remux: typeof import('@/lib/media/remux');

before(async () => {
  cache = await import('@/lib/media/cache');
  remux = await import('@/lib/media/remux');
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeEntry(videoId: number, size: number, opts?: { lastAccessedAt?: string; noSidecar?: boolean; badSize?: boolean }) {
  const mp4 = path.join(dir, `${videoId}.mp4`);
  fs.writeFileSync(mp4, Buffer.alloc(size, videoId % 256));
  if (!opts?.noSidecar) {
    fs.writeFileSync(
      path.join(dir, `${videoId}.json`),
      JSON.stringify({
        megaNodeId: `node-${videoId}`,
        sourceSize: size,
        outputSize: opts?.badSize ? size + 1 : size,
        ...(opts?.lastAccessedAt ? { lastAccessedAt: opts.lastAccessedAt } : {}),
      }),
    );
  }
}

function exists(videoId: number): boolean {
  return fs.existsSync(path.join(dir, `${videoId}.mp4`));
}

function clean() {
  for (const n of fs.readdirSync(dir)) fs.rmSync(path.join(dir, n), { force: true });
}

const OLD = new Date(Date.now() - 3600_000).toISOString();
const NEW = new Date().toISOString();

test('under budget: nothing evicted', async () => {
  clean();
  writeEntry(1, 100, { lastAccessedAt: OLD });
  writeEntry(2, 100, { lastAccessedAt: OLD });
  const r = await cache.evictMediaCache({ maxBytes: 10_000 });
  assert.equal(r.evicted, 0);
  assert.ok(exists(1) && exists(2));
});

test('over budget: least-recently-used entry evicted first', async () => {
  clean();
  writeEntry(1, 100, { lastAccessedAt: NEW }); // recently watched - keep
  writeEntry(2, 100, { lastAccessedAt: OLD }); // LRU victim
  writeEntry(3, 100, { lastAccessedAt: NEW }); // keep (fits after evicting 2)
  const r = await cache.evictMediaCache({ maxBytes: 200 });
  assert.equal(r.evicted, 1);
  assert.ok(!exists(2), 'LRU entry deleted');
  assert.ok(exists(1) && exists(3));
  assert.ok(!fs.existsSync(path.join(dir, '2.json')), 'sidecar deleted with entry');
  // Warm-cache validation still intact for survivors.
  const warm = await remux.readRemuxCache(1, 'node-1', 100);
  assert.ok(warm, 'survivor still a valid warm cache');
  assert.equal(await remux.readRemuxCache(2, 'node-2', 100), null, 'evicted entry is a clean miss');
});

test('active streams are never evicted mid-serve', async () => {
  clean();
  writeEntry(1, 100, { lastAccessedAt: OLD });
  writeEntry(2, 100, { lastAccessedAt: OLD });
  const release = cache.trackCacheStream(1);
  assert.equal(cache.activeCacheReaders(1), 1);
  const r = await cache.evictMediaCache({ maxBytes: 0 });
  assert.ok(exists(1), 'streamed file protected');
  assert.ok(!exists(2));
  assert.equal(r.evicted, 1);
  release();
  assert.equal(cache.activeCacheReaders(1), 0);
  const r2 = await cache.evictMediaCache({ maxBytes: 0 });
  assert.ok(!exists(1), 'released file evictable again');
  assert.equal(r2.evicted, 1);
});

test('live remux jobs are protected (via protector hook)', async () => {
  clean();
  writeEntry(1, 100, { lastAccessedAt: OLD });
  writeEntry(2, 100, { lastAccessedAt: OLD });
  const r = await cache.evictMediaCache({ maxBytes: 0, isProtected: (id) => id === 2 });
  assert.ok(exists(2), 'protected job entry survives');
  assert.ok(!exists(1));
  assert.equal(r.evicted, 1);
});

test('temp/partial files are never considered for eviction', async () => {
  clean();
  for (const n of ['7.part.mp4', '7.ts.part', '7.live.spool', 'notes.txt', '7.json']) {
    fs.writeFileSync(path.join(dir, n), 'x'.repeat(50));
  }
  writeEntry(8, 100, { lastAccessedAt: OLD });
  const r = await cache.evictMediaCache({ maxBytes: 0 });
  for (const n of ['7.part.mp4', '7.ts.part', '7.live.spool', 'notes.txt', '7.json']) {
    assert.ok(fs.existsSync(path.join(dir, n)), `${n} untouched`);
  }
  assert.ok(!exists(8));
  assert.equal(r.evicted, 1);
});

test('stale entries (bad sidecar) reclaimed even under budget', async () => {
  clean();
  writeEntry(1, 100, { lastAccessedAt: NEW });
  writeEntry(2, 100, { lastAccessedAt: NEW, badSize: true }); // corrupt: size mismatch
  writeEntry(3, 100, { noSidecar: true }); // corrupt: no sidecar
  const r = await cache.evictMediaCache({ maxBytes: 10_000 });
  assert.equal(r.reclaimedStale, 2);
  assert.ok(exists(1), 'valid entry kept');
  assert.ok(!exists(2) && !exists(3));
});

test('touch records access and survives restarts via the sidecar', async () => {
  clean();
  writeEntry(1, 100);
  await cache.touchRemuxCache(1);
  const sidecar = JSON.parse(fs.readFileSync(path.join(dir, '1.json'), 'utf8'));
  assert.ok(typeof sidecar.lastAccessedAt === 'string', 'lastAccessedAt persisted');
  assert.ok(sidecar.megaNodeId === 'node-1' && sidecar.outputSize === 100, 'validation fields intact');
  // A "restart" loses only the in-memory throttle map: the timestamp read
  // back from disk still orders this entry as recently used.
  const r = await cache.evictMediaCache({ maxBytes: 100, now: Date.now() + 1000 });
  assert.equal(r.evicted, 0, 'just-touched entry is newest, survives at exactly budget');
});

test('mtime fallback orders entries without sidecar timestamps', async () => {
  clean();
  writeEntry(1, 100); // no lastAccessedAt -> mtime fallback
  writeEntry(2, 100, { lastAccessedAt: OLD });
  // Make entry 1 older than entry 2's explicit timestamp.
  const past = new Date(Date.now() - 7200_000);
  fs.utimesSync(path.join(dir, '1.mp4'), past, past);
  const r = await cache.evictMediaCache({ maxBytes: 100 });
  assert.ok(!exists(1), 'mtime-oldest evicted first');
  assert.ok(exists(2));
  assert.equal(r.evicted, 1);
});

test('fresh files inside the grace window are never evicted', async () => {
  clean();
  // Entry 1 is a valid but LRU-old entry: the natural victim.
  writeEntry(1, 100, { lastAccessedAt: new Date(Date.now() - 7200_000).toISOString() });
  // Entry 2 is a mid-publish file (mp4 present, sidecar not yet written):
  // stale by definition, but its mtime is NOW so the grace window must
  // protect it even though the cache is over budget.
  writeEntry(2, 100, { noSidecar: true });
  const realGrace = process.env.MEDIA_CACHE_EVICTION_GRACE_MS;
  process.env.MEDIA_CACHE_EVICTION_GRACE_MS = String(60_000);
  try {
    const r = await cache.evictMediaCache({ maxBytes: 100 });
    assert.ok(exists(2), 'in-flight publish protected by grace');
    assert.ok(!exists(1), 'LRU victim evicted instead');
    assert.equal(r.evicted, 1);
    assert.equal(r.reclaimedStale, 0, 'stale reclaim skipped inside grace');
  } finally {
    process.env.MEDIA_CACHE_EVICTION_GRACE_MS = realGrace;
  }
});

test('config parsing: suffixes and safe fallbacks', () => {
  const real = process.env.MEDIA_CACHE_MAX_BYTES;
  try {
    process.env.MEDIA_CACHE_MAX_BYTES = '2GB';
    assert.equal(cache.mediaCacheMaxBytes(), 2 * 1024 ** 3);
    process.env.MEDIA_CACHE_MAX_BYTES = '512MB';
    assert.equal(cache.mediaCacheMaxBytes(), 512 * 1024 ** 2);
    process.env.MEDIA_CACHE_MAX_BYTES = '1048576';
    assert.equal(cache.mediaCacheMaxBytes(), 1048576);
    process.env.MEDIA_CACHE_MAX_BYTES = 'bogus';
    assert.equal(cache.mediaCacheMaxBytes(), cache.DEFAULT_CACHE_MAX_BYTES);
    process.env.MEDIA_CACHE_MAX_BYTES = '-5';
    assert.equal(cache.mediaCacheMaxBytes(), cache.DEFAULT_CACHE_MAX_BYTES);
    delete process.env.MEDIA_CACHE_MAX_BYTES;
    assert.equal(cache.mediaCacheMaxBytes(), cache.DEFAULT_CACHE_MAX_BYTES);
  } finally {
    if (real === undefined) delete process.env.MEDIA_CACHE_MAX_BYTES;
    else process.env.MEDIA_CACHE_MAX_BYTES = real;
  }
});

// ---------------------------------------------------------------------------
// P1-C: temp pressure accounting + orphan reclaim (never victims).
// ---------------------------------------------------------------------------
test('P1-C: temp bytes count toward pressure but temps are never victims', async () => {
  clean();
  fs.writeFileSync(path.join(dir, '7.ts.part'), Buffer.alloc(100));
  fs.writeFileSync(path.join(dir, '7.live.spool'), Buffer.alloc(50));
  writeEntry(8, 100, { lastAccessedAt: OLD });
  // Finals (100) + temps (150) = 250 > 200: pressure fires, but only the
  // finished entry can be a victim.
  const r = await cache.evictMediaCache({ maxBytes: 200 });
  assert.equal(r.tempBytes, 150, 'temp footprint reported');
  assert.equal(r.totalBytes, 150, 'surviving temps stay counted (never victims, always pressure)');
  assert.ok(!exists(8), 'finished entry evicted under temp-inclusive pressure');
  assert.ok(
    fs.existsSync(path.join(dir, '7.ts.part')) && fs.existsSync(path.join(dir, '7.live.spool')),
    'active temps untouched',
  );
  assert.equal(r.evicted, 1);
});

test('P1-C: old unprotected temp orphans reclaimed; fresh/protected/future kept', async () => {
  clean();
  const now = Date.now();
  const old = new Date(now - 3 * 3600_000);
  const future = new Date(now + 3600_000);
  fs.writeFileSync(path.join(dir, '9.ts.part'), Buffer.alloc(10));
  fs.utimesSync(path.join(dir, '9.ts.part'), old, old);
  fs.writeFileSync(path.join(dir, '10.ts.part'), Buffer.alloc(10)); // fresh: active download shape
  fs.writeFileSync(path.join(dir, '11.live.spool'), Buffer.alloc(10));
  fs.utimesSync(path.join(dir, '11.live.spool'), old, old);
  fs.writeFileSync(path.join(dir, '12.part.mp4'), Buffer.alloc(10));
  fs.utimesSync(path.join(dir, '12.part.mp4'), future, future);
  const r = await cache.evictMediaCache({ maxBytes: 10_000_000, isProtected: (id) => id === 11, now });
  assert.equal(r.reclaimedTempOrphans, 1, 'exactly the old unprotected orphan');
  assert.ok(!fs.existsSync(path.join(dir, '9.ts.part')), 'orphan removed');
  assert.ok(fs.existsSync(path.join(dir, '10.ts.part')), 'fresh temp kept (active job shape)');
  assert.ok(fs.existsSync(path.join(dir, '11.live.spool')), 'protected temp kept despite age');
  assert.ok(fs.existsSync(path.join(dir, '12.part.mp4')), 'future-mtime temp never touched');
});

test('P1-B: repeated touches always leave a valid sidecar (atomic replace)', async () => {
  clean();
  writeEntry(1, 100);
  await cache.touchRemuxCache(1);
  await cache.touchRemuxCache(1);
  const sidecar = JSON.parse(fs.readFileSync(path.join(dir, '1.json'), 'utf8'));
  assert.equal(sidecar.outputSize, 100, 'validation fields intact after retouch');
  assert.ok(typeof sidecar.lastAccessedAt === 'string');
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')).length, 0, 'no temp residue');
});
