/**
 * Unit tests for lib/media/container.ts (symmetric container-truth probe).
 *
 * Covers the single source of truth for "what container does this media
 * actually contain?":
 *   - pure routing table (decideContainerRouting): stale mp4 + TS bytes ->
 *     remux + correct to mp2t; stale mp2t + MP4 bytes -> direct + correct to
 *     mp4; correct labels -> no write; unknown bytes -> safe fallback.
 *   - probeMediaContainer: 188-byte probe only, verdict caching by
 *     nodeId:size, single-flight, and "never worse" failure behavior.
 *   - needsRemuxForContainer: identical to the historical remux rule.
 *
 * No MEGA, no network, no database, no ffmpeg.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearContainerVerdictCacheForTests,
  decideContainerRouting,
  needsRemuxForContainer,
  observeContainerBytes,
  probeMediaContainer,
} from '@/lib/media/container';

function tsBytes(): Buffer {
  const b = Buffer.alloc(188 * 4);
  for (let i = 0; i < 4; i++) b[i * 188] = 0x47;
  return b;
}

function mp4Bytes(): Buffer {
  const b = Buffer.alloc(188, 0);
  b.writeUInt32BE(24, 0);
  b.write('ftyp', 4, 4, 'latin1');
  return b;
}

test('routing rule: only video/mp2t needs remux (== historical rule)', () => {
  assert.equal(needsRemuxForContainer('video/mp2t'), true);
  assert.equal(needsRemuxForContainer('video/mp4'), false);
  assert.equal(needsRemuxForContainer(null), false);
  assert.equal(needsRemuxForContainer(undefined), false);
});

test('decision table: stale mp4 label + TS bytes -> remux + correct to mp2t', () => {
  assert.deepEqual(
    decideContainerRouting('video/mp4', { kind: 'ts' }),
    { verdict: 'mp2t', correctedMimeType: 'video/mp2t' },
  );
});

test('decision table: stale mp2t label + MP4 bytes -> direct + correct to mp4', () => {
  assert.deepEqual(
    decideContainerRouting('video/mp2t', { kind: 'mp4' }),
    { verdict: 'mp4', correctedMimeType: 'video/mp4' },
  );
});

test('decision table: correct labels route without a write', () => {
  assert.deepEqual(
    decideContainerRouting('video/mp4', { kind: 'mp4' }),
    { verdict: 'mp4', correctedMimeType: null },
  );
  assert.deepEqual(
    decideContainerRouting('video/mp2t', { kind: 'ts' }),
    { verdict: 'mp2t', correctedMimeType: null },
  );
});

test('decision table: unknown bytes preserve the safe stored-label fallback', () => {
  assert.deepEqual(
    decideContainerRouting('video/mp4', { kind: 'unknown' }),
    { verdict: 'mp4', correctedMimeType: null },
  );
  assert.deepEqual(
    decideContainerRouting('video/mp2t', { kind: 'unknown' }),
    { verdict: 'mp2t', correctedMimeType: null },
  );
});

test('observeContainerBytes uses the existing sniffer (TS vs ftyp vs junk)', () => {
  assert.deepEqual(observeContainerBytes(tsBytes()), { kind: 'ts' });
  assert.deepEqual(observeContainerBytes(mp4Bytes()), { kind: 'mp4' });
  assert.deepEqual(observeContainerBytes(Buffer.alloc(188, 0x99)), { kind: 'unknown' });
});

test('probeMediaContainer: stale mp2t + MP4 plaintext -> direct verdict + correction', async () => {
  clearContainerVerdictCacheForTests();
  let fetches = 0;
  const res = await probeMediaContainer(
    { nodeId: 'node-x', downloadUrl: 'https://g.test/x', sourceSize: 1000, fileKey: Buffer.alloc(32), storedMimeType: 'video/mp2t' },
    {
      fetchCiphertext: async (url) => {
        fetches++;
        assert.match(url, /\/0-187$/);
        return new Response(Buffer.alloc(300), { status: 200 });
      },
      decryptPrefix: async () => mp4Bytes(),
    },
  );
  assert.equal(res.verdict, 'mp4');
  assert.equal(res.correctedMimeType, 'video/mp4');
  assert.equal(fetches, 1);
});

test('probeMediaContainer: verdict cached per nodeId:size (no second fetch)', async () => {
  clearContainerVerdictCacheForTests();
  let fetches = 0;
  const deps = {
    fetchCiphertext: async () => {
      fetches++;
      return new Response(Buffer.alloc(300), { status: 200 });
    },
    decryptPrefix: async () => tsBytes(),
  };
  const input = { nodeId: 'node-y', downloadUrl: 'https://g.test/y', sourceSize: 2000, fileKey: Buffer.alloc(32), storedMimeType: 'video/mp4' };
  const first = await probeMediaContainer(input, deps);
  const second = await probeMediaContainer(input, deps);
  assert.equal(first.verdict, 'mp2t');
  assert.equal(first.correctedMimeType, 'video/mp2t');
  assert.equal(second.fromCache, true);
  assert.equal(fetches, 1, 'second probe for the same MEGA node must not re-fetch');
});

test('probeMediaContainer: cached bytes re-decide per stored label (no cross-row correction leak)', async () => {
  clearContainerVerdictCacheForTests();
  let fetches = 0;
  const deps = {
    fetchCiphertext: async () => {
      fetches++;
      return new Response(Buffer.alloc(300), { status: 200 });
    },
    decryptPrefix: async () => tsBytes(),
  };
  const staleMp4 = { nodeId: 'node-dup', downloadUrl: 'https://g.test/dup', sourceSize: 2000, fileKey: Buffer.alloc(32), storedMimeType: 'video/mp4' };
  const first = await probeMediaContainer(staleMp4, deps);
  assert.equal(first.verdict, 'mp2t');
  assert.equal(first.correctedMimeType, 'video/mp2t');
  // Same MEGA file, duplicate row already labeled mp2t: same cached bytes,
  // verdict mp2t, but NO rewrite for this row.
  const alreadyTs = await probeMediaContainer({ ...staleMp4, storedMimeType: 'video/mp2t' }, deps);
  assert.equal(alreadyTs.verdict, 'mp2t');
  assert.equal(alreadyTs.correctedMimeType, null);
  assert.equal(alreadyTs.fromCache, true);
  assert.equal(fetches, 1);
});

test('probeMediaContainer: fetch failure throws so callers keep stored fallback', async () => {
  clearContainerVerdictCacheForTests();
  await assert.rejects(
    () =>
      probeMediaContainer(
        { nodeId: 'node-z', downloadUrl: 'https://g.test/z', sourceSize: 10, fileKey: Buffer.alloc(32), storedMimeType: 'video/mp4' },
        { fetchCiphertext: async () => new Response(null, { status: 500 }) },
      ),
    /container probe fetch failed/,
  );
});
