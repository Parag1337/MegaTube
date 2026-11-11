/**
 * Unit tests for lib/media/cache.ts mediaCacheStats() — the read-only
 * diagnostics scan backing GET /api/media/stats.
 *
 * Contract under test:
 *   - valid entries (<id>.mp4 + sidecar with matching megaNodeId/outputSize)
 *     count toward entries/entryBytes;
 *   - entries with a missing/mismatched sidecar count as stale (unservable
 *     until eviction reclaims them) and never as valid;
 *   - temp files (*.ts.part / *.live.spool / *.part.mp4) count toward the
 *     temp footprint only;
 *   - the scan is STRICTLY read-only: files on disk are byte-identical and
 *     identically named after the call (a diagnostics endpoint must never
 *     mutate the cache it reports on).
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://megatube:megatube-dev-only@localhost:5433/megatube?schema=public';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const MEDIA_CACHE_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'media-cache-stats-'));
process.env.MEDIA_CACHE_DIR = MEDIA_CACHE_TMP;

import type { mediaCacheStats as MediaCacheStatsFn } from '@/lib/media/cache';

let mediaCacheStats: typeof MediaCacheStatsFn;
before(async () => {
  ({ mediaCacheStats } = await import('@/lib/media/cache'));
});

after(() => {
  fs.rmSync(MEDIA_CACHE_TMP, { recursive: true, force: true });
});

function writeEntry(videoId: number, size: number, opts?: { sidecar?: object | null }): void {
  const mp4 = path.join(MEDIA_CACHE_TMP, `${videoId}.mp4`);
  fs.writeFileSync(mp4, crypto.randomBytes(size));
  if (opts?.sidecar === null) return; // stale: no sidecar at all
  const sidecar =
    opts?.sidecar ?? { megaNodeId: `node-${videoId}`, sourceSize: size * 2, outputSize: size };
  fs.writeFileSync(path.join(MEDIA_CACHE_TMP, `${videoId}.json`), JSON.stringify(sidecar));
}

function snapshot(): Map<string, { size: number; content: string }> {
  const out = new Map<string, { size: number; content: string }>();
  for (const name of fs.readdirSync(MEDIA_CACHE_TMP)) {
    const p = path.join(MEDIA_CACHE_TMP, name);
    const st = fs.statSync(p);
    if (!st.isFile()) continue;
    out.set(name, { size: st.size, content: fs.readFileSync(p, 'base64') });
  }
  return out;
}

test('mediaCacheStats: valid, stale and temp files are classified independently', async () => {
  writeEntry(101, 500); // valid
  writeEntry(102, 300, { sidecar: null }); // stale: no sidecar
  writeEntry(103, 400, { sidecar: { megaNodeId: 'other-node', sourceSize: 1, outputSize: 999 } }); // stale: mismatch
  fs.writeFileSync(path.join(MEDIA_CACHE_TMP, '104.ts.part'), crypto.randomBytes(700));
  fs.writeFileSync(path.join(MEDIA_CACHE_TMP, '104.live.spool'), crypto.randomBytes(200));

  const stats = await mediaCacheStats();
  assert.equal(stats.entries, 1);
  assert.equal(stats.entryBytes, 500);
  assert.equal(stats.staleEntries, 2);
  assert.equal(stats.staleBytes, 700);
  assert.equal(stats.tempFiles, 2);
  assert.equal(stats.tempBytes, 900);
  assert.equal(stats.maxBytes > 0, true);
  assert.ok(stats.dir.startsWith(os.tmpdir()));
});

test('mediaCacheStats: empty/missing directory yields an empty zeroed report', async () => {
  const prev = process.env.MEDIA_CACHE_DIR;
  process.env.MEDIA_CACHE_DIR = path.join(MEDIA_CACHE_TMP, 'does-not-exist');
  try {
    const stats = await mediaCacheStats();
    assert.deepEqual(
      {
        entries: stats.entries,
        entryBytes: stats.entryBytes,
        staleEntries: stats.staleEntries,
        staleBytes: stats.staleBytes,
        tempFiles: stats.tempFiles,
        tempBytes: stats.tempBytes,
      },
      { entries: 0, entryBytes: 0, staleEntries: 0, staleBytes: 0, tempFiles: 0, tempBytes: 0 },
    );
  } finally {
    process.env.MEDIA_CACHE_DIR = prev;
  }
});

test('mediaCacheStats: the scan never mutates the cache directory', async () => {
  const before = snapshot();
  await mediaCacheStats();
  const after = snapshot();
  assert.deepEqual(
    [...after.entries()].sort(([a], [b]) => a.localeCompare(b)),
    [...before.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
});
