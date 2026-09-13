/**
 * Unit tests for resumable MEGA source acquisition (Phase 1).
 *
 * - Part A: pure frontier-manifest logic (no MEGA, no ffmpeg): atomicity,
 *   validation, reconcile/heal rules, alignment, backoff bounds, status
 *   classification.
 * - Part B: job-level resume behavior with a fake MEGA boundary serving
 *   GENUINE megajs CTR ciphertext: failure preserves N bytes, resume starts
 *   at N (never 0), second failure preserves the newest frontier, stale URLs
 *   refresh, permanent failure keeps the prefix, restart recovers state.
 *
 * What is NOT covered here (needs real TS + ffmpeg): full end-to-end cache
 * publish. That path is covered by the media-route cold-pipeline tests, which
 * must keep passing unchanged for fresh videos.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'source-acq-unit-'));
process.env.MEDIA_CACHE_DIR = path.join(tmpRoot, 'cache');
fs.mkdirSync(process.env.MEDIA_CACHE_DIR, { recursive: true });
// Fast resume loops in tests (production defaults are ~800ms..15s).
process.env.MEDIA_RESUME_BACKOFF_MS = '5';

import { encrypt } from 'megajs';
import {
  alignDown16,
  frontierManifestPath,
  isResumeableUpstreamStatus,
  loadSourceFrontier,
  maxSourceFetchAttempts,
  MAX_SOURCE_FETCH_ATTEMPTS,
  reconcileSourcePrefix,
  resumeBackoffMs,
  resumeRequestParams,
  storeSourceFrontierAtomic,
  tsPartPath,
} from '@/lib/media/source-acquisition';
import {
  appendCipherRangeBody,
  cleanupOrphanedTempFiles,
  getOrCreateLiveRemuxJob,
  getRemuxSlotStats,
  hasLiveRemuxJob,
} from '@/lib/media/remux';

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Part A: pure frontier logic
// ---------------------------------------------------------------------------

test('resumeRequestParams: fresh start requests 0-.., resume aligns down + skips', () => {
  assert.deepEqual(resumeRequestParams(0, 4096), { rangeStart: 0, decryptStart: 0, skipBytes: 0 });
  // 1000 is not 16-aligned: re-request from 992, skip 8 after decryption.
  assert.deepEqual(resumeRequestParams(1000, 4096), { rangeStart: 992, decryptStart: 992, skipBytes: 8 });
  assert.equal(alignDown16(992) % 16, 0);
  // Already aligned: no skip.
  assert.deepEqual(resumeRequestParams(992, 4096), { rangeStart: 992, decryptStart: 992, skipBytes: 0 });
  // Clamp: never beyond the source.
  const clamped = resumeRequestParams(5000, 4096);
  assert.ok(clamped.rangeStart <= 4096);
});

test('frontier manifest: atomic round-trip with no tmp residue', async () => {
  const vid = 71101;
  await storeSourceFrontierAtomic({ videoId: vid, megaNodeId: 'n1', sourceSize: 4096, frontier: 1000, updatedAt: '' });
  const loaded = await loadSourceFrontier(vid);
  assert.ok(loaded);
  assert.equal(loaded!.frontier, 1000);
  assert.equal(loaded!.megaNodeId, 'n1');
  assert.ok(Date.parse(loaded!.updatedAt) > 0, 'updatedAt stamped on write');
  const dir = path.dirname(frontierManifestPath(vid));
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')).length, 0, 'no tmp residue');
});

test('frontier manifest: corrupt / mismatched state loads as null', async () => {
  const vid = 71102;
  fs.writeFileSync(frontierManifestPath(vid), '{"bogus":true}');
  assert.equal(await loadSourceFrontier(vid), null, 'garbage object');
  fs.writeFileSync(frontierManifestPath(vid), '{"megaNodeId":');
  assert.equal(await loadSourceFrontier(vid), null, 'truncated JSON');
  fs.writeFileSync(
    frontierManifestPath(vid),
    JSON.stringify({ videoId: 99999, megaNodeId: 'n', sourceSize: 10, frontier: 5, updatedAt: '' }),
  );
  assert.equal(await loadSourceFrontier(vid), null, 'wrong videoId');
  fs.writeFileSync(
    frontierManifestPath(vid),
    JSON.stringify({ videoId: vid, megaNodeId: 'n', sourceSize: 10, frontier: 11, updatedAt: '' }),
  );
  assert.equal(await loadSourceFrontier(vid), null, 'frontier beyond size');
});

test('reconcile: missing file -> frontier 0', async () => {
  const out = await reconcileSourcePrefix(71103, 'node-a', 4096);
  assert.deepEqual(out, { frontier: 0, resumed: false });
});

test('reconcile: file without manifest is adopted (crash self-heal)', async () => {
  const vid = 71104;
  fs.writeFileSync(tsPartPath(vid), Buffer.alloc(1000, 7));
  const out = await reconcileSourcePrefix(vid, 'node-a', 4096);
  assert.deepEqual(out, { frontier: 1000, resumed: true });
  assert.equal((await loadSourceFrontier(vid))?.frontier, 1000, 'manifest healed up');
});

test('reconcile: manifest ahead of file trusts the FILE (never claims ghosts)', async () => {
  const vid = 71105;
  fs.writeFileSync(tsPartPath(vid), Buffer.alloc(400, 7));
  await storeSourceFrontierAtomic({ videoId: vid, megaNodeId: 'node-a', sourceSize: 4096, frontier: 3000, updatedAt: '' });
  const out = await reconcileSourcePrefix(vid, 'node-a', 4096);
  assert.deepEqual(out, { frontier: 400, resumed: true });
  assert.equal((await loadSourceFrontier(vid))?.frontier, 400, 'manifest healed down');
});

test('reconcile: identity mismatch discards prefix + manifest', async () => {
  const vid = 71106;
  fs.writeFileSync(tsPartPath(vid), Buffer.alloc(1000, 7));
  await storeSourceFrontierAtomic({ videoId: vid, megaNodeId: 'node-OLD', sourceSize: 4096, frontier: 1000, updatedAt: '' });
  const out = await reconcileSourcePrefix(vid, 'node-NEW', 4096);
  assert.deepEqual(out, { frontier: 0, resumed: false });
  assert.equal(fs.existsSync(tsPartPath(vid)), false, 'foreign prefix deleted');
  assert.equal(await loadSourceFrontier(vid), null, 'foreign manifest deleted');
});

test('reconcile: oversize file truncated to the source size', async () => {
  const vid = 71107;
  fs.writeFileSync(tsPartPath(vid), Buffer.alloc(5000, 7));
  const out = await reconcileSourcePrefix(vid, 'node-a', 4096);
  assert.equal(out.frontier, 4096);
  assert.equal(fs.statSync(tsPartPath(vid)).size, 4096);
});

test('backoff/attempts: bounded, env-overridable with sane clamps', async () => {
  assert.equal(resumeBackoffMs(1), 5, 'test env pins backoff');
  delete process.env.MEDIA_RESUME_BACKOFF_MS;
  try {
    assert.equal(resumeBackoffMs(1), 800);
    assert.equal(resumeBackoffMs(2), 2000);
    assert.ok(resumeBackoffMs(99) <= 15_000, 'capped, never infinite growth');
  } finally {
    process.env.MEDIA_RESUME_BACKOFF_MS = '5';
  }
  delete process.env.MEDIA_SOURCE_MAX_ATTEMPTS;
  assert.equal(maxSourceFetchAttempts(), MAX_SOURCE_FETCH_ATTEMPTS);
  process.env.MEDIA_SOURCE_MAX_ATTEMPTS = '2';
  assert.equal(maxSourceFetchAttempts(), 2);
  process.env.MEDIA_SOURCE_MAX_ATTEMPTS = '9999';
  assert.equal(maxSourceFetchAttempts(), MAX_SOURCE_FETCH_ATTEMPTS, 'absurd values clamped');
  delete process.env.MEDIA_SOURCE_MAX_ATTEMPTS;
});

test('isResumeableUpstreamStatus: stale/transient yes, client/auth no', () => {
  for (const st of [403, 404, 408, 425, 429, 500, 502, 503, 509]) {
    assert.equal(isResumeableUpstreamStatus(st), true, `${st} resumeable`);
  }
  for (const st of [200, 206, 400, 401, 410, 416]) {
    assert.equal(isResumeableUpstreamStatus(st), false, `${st} not resumeable`);
  }
});

// ---------------------------------------------------------------------------
// Part B: job-level resume with genuine megajs ciphertext
// ---------------------------------------------------------------------------

const PLAIN = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 31 + 7) & 0xff));
const EXPECTED = Buffer.from(PLAIN);
const encStream = encrypt(Buffer.concat([Buffer.alloc(16, 0x21), Buffer.alloc(8, 0x22)]));
const ctChunks: Buffer[] = [];
let CT = Buffer.alloc(0);
let FILE_KEY = Buffer.alloc(32);
encStream.on('data', (c: Buffer) => ctChunks.push(Buffer.from(c)));
encStream.on('end', () => {
  CT = Buffer.concat(ctChunks);
  FILE_KEY = Buffer.from(encStream.key);
});
encStream.end(PLAIN);

before(async () => {
  while (CT.length === 0) await new Promise((r) => setTimeout(r, 10));
  assert.equal(CT.length, PLAIN.length, 'megajs CTR preserves length (test premise)');
});

const UPSTREAM = 'https://gfs.test/acq';

function rangeSlice(url: string): { from: number; to: number } {
  const m = url.match(/\/(\d+)-(\d+)$/);
  assert.ok(m, `range URL shape, got ${url}`);
  return { from: Number(m![1]), to: Number(m![2]) };
}

function sliceResponse(url: string): Response {
  const { from, to } = rangeSlice(url);
  return new Response(Buffer.from(CT.subarray(from, to + 1)), { status: 200 });
}

function srcFor(
  videoId: number,
  fetchImpl: (url: string, signal?: AbortSignal) => Promise<Response>,
  opts: { refresh?: () => Promise<string>; refreshCalls?: { n: number } } = {},
) {
  return {
    videoId,
    megaNodeId: `node-acq-${videoId}`,
    size: PLAIN.length,
    fileKey: FILE_KEY,
    upstreamUrl: UPSTREAM,
    fetchCiphertext: fetchImpl,
    // Skip the PCR duration probe (2 extra head/tail fetches): these tests
    // assert exact acquisition fetch sequences, so probe traffic would
    // pollute the counts. Production still probes; probe behavior is covered
    // by the media-route cold-pipeline tests.
    durationSeconds: 60,
    refreshUpstreamUrl: opts.refresh
      ? async () => {
          if (opts.refreshCalls) opts.refreshCalls.n++;
          return opts.refresh!();
        }
      : undefined,
  };
}

async function settleJob(videoId: number, timeoutMs = 30_000): Promise<void> {
  const t0 = Date.now();
  while (hasLiveRemuxJob(videoId) && Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(hasLiveRemuxJob(videoId), false, 'job settled (registry clean)');
}

/**
 * Launch an acquisition job, silencing its terminal cache rejection. The
 * route always observes job.cache; these tests only poll the registry, so
 * without this every expected failure (truncated source, garbage bytes)
 * would surface as an unhandled rejection.
 */
function startJob(src: Parameters<typeof getOrCreateLiveRemuxJob>[0]) {
  const job = getOrCreateLiveRemuxJob(src);
  job.cache.catch(() => {});
  return job;
}

test('fresh job: single 0- request, no refresh, no manifest (normal path unchanged)', async () => {
  const vid = 71201;
  const requested: string[] = [];
  const refreshCalls = { n: 0 };
  const baseline = getRemuxSlotStats().active;
  startJob(
    srcFor(
      vid,
      async (url) => {
        requested.push(url);
        return sliceResponse(url);
      },
      { refresh: async () => `${UPSTREAM}-fresh`, refreshCalls },
    ),
  );
  await settleJob(vid);
  assert.deepEqual(requested.filter((u) => u.startsWith(UPSTREAM)), [`${UPSTREAM}/0-${PLAIN.length - 1}`]);
  assert.equal(refreshCalls.n, 0, 'no fresh-URL fetch on the normal path');
  assert.equal(await loadSourceFrontier(vid), null, 'complete source leaves no frontier claim');
  assert.equal(getRemuxSlotStats().active, baseline, 'slot released exactly once');
  // Poison valve: random bytes download completely but can never transmux, so
  // the complete-but-unpublishable prefix is discarded (exactly today's
  // failure outcome) instead of poisoning the locally-complete shortcut.
  assert.equal(fs.existsSync(tsPartPath(vid)), false, 'unpublishable source leaves no residue');
});

test('failure after N bytes: N preserved, resume starts at N (never 0)', async () => {
  const vid = 71202;
  process.env.MEDIA_SOURCE_MAX_ATTEMPTS = '2'; // Phase A + exactly one resume
  const requested: string[] = [];
  try {
    startJob(
      srcFor(vid, async (url) => {
        requested.push(url);
        if (requested.length === 1) {
          // Stall shape: clean EOF after 1000 of 4096 bytes.
          const { from } = rangeSlice(url);
          assert.equal(from, 0);
          return new Response(Buffer.from(CT.subarray(0, 1000)), { status: 200 });
        }
        return new Response(null, { status: 500 });
      }),
    );
    await settleJob(vid);
  } finally {
    delete process.env.MEDIA_SOURCE_MAX_ATTEMPTS;
  }
  assert.equal(requested.length, 2, 'initial + one bounded resume');
  assert.ok(requested[0]!.endsWith(`/0-${PLAIN.length - 1}`), `first starts at 0, got ${requested[0]}`);
  // 1000 -> 16-aligned 992: the resume must continue, never restart.
  assert.ok(requested[1]!.endsWith(`/992-${PLAIN.length - 1}`), `resume starts at 992, got ${requested[1]}`);
  assert.equal(fs.statSync(tsPartPath(vid)).size, 1000, 'N bytes remain on disk');
  assert.equal((await loadSourceFrontier(vid))?.frontier, 1000, 'manifest claims exactly N');
});

test('resume completes byte-exactly and rejoins the publish path', async () => {
  // Random plaintext can never transmux, so a COMPLETED resume rejoins the
  // normal publish path and is then honestly rejected by it (poison valve:
  // no residue, no manifest — exactly today's failure outcome for garbage).
  // Completion itself is proven by the fetch sequence: the second fetch
  // served the FULL tail and no third fetch was needed (the loop exited via
  // frontier == size, not via budget exhaustion). Byte-exact reconstruction
  // of the plaintext is proven by the appendCipherRangeBody unit test below
  // (no ffmpeg involved); end-to-end publish of VALID sources is covered by
  // the media-route cold-pipeline tests.
  const vid = 71203;
  const requested: string[] = [];
  const refreshCalls = { n: 0 };
  const baseline = getRemuxSlotStats().active;
  startJob(
    srcFor(
      vid,
      async (url) => {
        requested.push(url);
        if (requested.length === 1) {
          return new Response(Buffer.from(CT.subarray(0, 1000)), { status: 200 });
        }
        return sliceResponse(url);
      },
      { refresh: async () => `${UPSTREAM}-fresh`, refreshCalls },
    ),
  );
  await settleJob(vid);
  assert.deepEqual(
    requested.map((u) => u.replace(UPSTREAM, 'U')),
    [`U/0-${PLAIN.length - 1}`, `U/992-${PLAIN.length - 1}`],
  );
  assert.equal(refreshCalls.n, 0, 'clean completion needs no fresh URL');
  assert.equal(getRemuxSlotStats().active, baseline, 'slot released exactly once');
  assert.equal(fs.existsSync(tsPartPath(vid)), false, 'garbage completion leaves no residue (poison valve)');
  assert.equal(await loadSourceFrontier(vid), null, 'no frontier claim after terminal publish failure');
});

test('appendCipherRangeBody: aligned resume reconstructs the byte-exact source', async () => {
  // Pure acquisition math without ffmpeg: a truncated first segment plus a
  // 16-aligned resume (decrypt at the floor, skip the overlap AFTER
  // decryption) must rebuild the exact plaintext. This is the core invariant
  // the job-level resume relies on.
  const vid = 71301;
  const part = tsPartPath(vid);
  fs.rmSync(part, { force: true });
  try {
    const body1 = new Response(Buffer.from(CT.subarray(0, 1000))).body as unknown as ReadableStream<Uint8Array>;
    const n1 = await appendCipherRangeBody(body1, FILE_KEY, 0, 0, part, PLAIN.length);
    assert.equal(n1, 1000, 'first segment appends exactly what arrived');
    assert.equal(fs.statSync(part).size, 1000);
    const p = resumeRequestParams(1000, PLAIN.length);
    assert.deepEqual(p, { rangeStart: 992, decryptStart: 992, skipBytes: 8 });
    const { from, to } = rangeSlice(`${UPSTREAM}/${p.rangeStart}-${PLAIN.length - 1}`);
    const body2 = new Response(Buffer.from(CT.subarray(from, to + 1))).body as unknown as ReadableStream<Uint8Array>;
    const n2 = await appendCipherRangeBody(body2, FILE_KEY, p.decryptStart, p.skipBytes, part, PLAIN.length - 1000);
    assert.equal(n2, PLAIN.length - 1000, 'resume appends exactly the missing tail');
    assert.ok(fs.readFileSync(part).equals(EXPECTED), 'reconstructed source is byte-exact');
  } finally {
    fs.rmSync(part, { force: true });
  }
});

test('appendCipherRangeBody: mid-body reset preserves what arrived (flush, then error)', async () => {
  // A connection reset mid-segment must not vaporize the bytes that already
  // arrived: the file keeps them (caller re-stats and resumes from there).
  // NOTE: the error fires ASYNCHRONOUSLY (setTimeout) to model a real RST:
  // a synchronous enqueue+error in start() discards the queue per the
  // WHATWG stream spec, so nothing would ever reach the pipe.
  const vid = 71302;
  const part = tsPartPath(vid);
  fs.rmSync(part, { force: true });
  try {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(CT.subarray(0, 500)));
        setTimeout(() => {
          try {
            controller.error(new Error('connection reset'));
          } catch {
            // already closed — pipe consumed and finished first
          }
        }, 10);
      },
    });
    await assert.rejects(
      appendCipherRangeBody(stream, FILE_KEY, 0, 0, part, PLAIN.length),
      /connection reset/,
    );
    assert.equal(fs.statSync(part).size, 500, 'arrived bytes flushed before the error surfaced');
    assert.ok(fs.readFileSync(part).equals(Buffer.from(EXPECTED.subarray(0, 500))), 'flushed prefix is exact');
  } finally {
    fs.rmSync(part, { force: true });
  }
});

test('second failure preserves the NEWEST frontier; next resume starts there', async () => {
  const vid = 71204;
  process.env.MEDIA_SOURCE_MAX_ATTEMPTS = '3'; // Phase A + two resumes
  const requested: string[] = [];
  try {
    startJob(
      srcFor(vid, async (url) => {
        requested.push(url);
        if (requested.length === 1) {
          return new Response(Buffer.from(CT.subarray(0, 1000)), { status: 200 });
        }
        if (requested.length === 2) {
          // 500 more bytes arrive, then the connection dies mid-body (async
          // RST: chunk delivered first, error after — see the test above).
          const { from } = rangeSlice(url);
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(CT.subarray(from, from + 500)));
              setTimeout(() => {
                try {
                  controller.error(new Error('connection reset'));
                } catch {
                  // already closed
                }
              }, 10);
            },
          });
          return new Response(stream, { status: 200 });
        }
        return new Response(null, { status: 500 });
      }),
    );
    await settleJob(vid);
  } finally {
    delete process.env.MEDIA_SOURCE_MAX_ATTEMPTS;
  }
  assert.ok(requested[0]!.endsWith(`/0-${PLAIN.length - 1}`));
  assert.ok(requested[1]!.endsWith(`/992-${PLAIN.length - 1}`), `first resume at 992, got ${requested[1]}`);
  // 1000 + (500 served − 8 CTR overlap skipped) = 1492 -> aligned 1488.
  assert.ok(requested[2]!.endsWith(`/1488-${PLAIN.length - 1}`), `second resume at 1488, got ${requested[2]}`);
  assert.ok(!requested.slice(1).some((u) => /\/0-/.test(u)), 'no resume ever restarts at 0');
  assert.equal(fs.statSync(tsPartPath(vid)).size, 1492, 'newest frontier preserved');
  assert.equal((await loadSourceFrontier(vid))?.frontier, 1492);
  fs.rmSync(tsPartPath(vid), { force: true });
  const { removeSourceFrontier } = await import('@/lib/media/source-acquisition');
  await removeSourceFrontier(vid);
});

test('stale URL (403) triggers exactly one refresh; resume uses the fresh base', async () => {
  // As in the completion test above, random bytes cannot transmux, so the
  // resumed-then-completed source is rejected by the publish path (no
  // residue). Completion is proven by the fetch sequence: after the fresh
  // base served the full tail, no further fetch was needed.
  const vid = 71205;
  const requested: string[] = [];
  const refreshCalls = { n: 0 };
  const FRESH = `${UPSTREAM}-fresh`;
  startJob(
    srcFor(
      vid,
      async (url) => {
        requested.push(url);
        if (requested.length === 1) {
          return new Response(Buffer.from(CT.subarray(0, 1000)), { status: 200 });
        }
        if (url.startsWith(FRESH)) return sliceResponse(url.replace(FRESH, UPSTREAM));
        return new Response(null, { status: 403 });
      },
      { refresh: async () => FRESH, refreshCalls },
    ),
  );
  await settleJob(vid);
  assert.equal(refreshCalls.n, 1, 'exactly one fresh-URL resolution');
  assert.equal(requested.length, 3, 'initial + stale-URL retry + fresh completion');
  assert.ok(requested[1]!.startsWith(UPSTREAM) && !requested[1]!.startsWith(FRESH), 'first resume reuses the URL');
  assert.ok(requested[2]!.startsWith(`${FRESH}/992-`), `retry uses fresh base at frontier, got ${requested[2]}`);
  assert.equal(fs.existsSync(tsPartPath(vid)), false, 'garbage completion leaves no residue (poison valve)');
  assert.equal(await loadSourceFrontier(vid), null, 'no frontier claim after terminal publish failure');
});

test('permanent failure keeps the partial prefix (never deletes progress)', async () => {
  const vid = 71206;
  process.env.MEDIA_SOURCE_MAX_ATTEMPTS = '3';
  let calls = 0;
  const refreshCalls = { n: 0 };
  try {
    startJob(
      srcFor(
        vid,
        async () => {
          calls++;
          if (calls === 1) return new Response(Buffer.from(CT.subarray(0, 1000)), { status: 200 });
          return new Response(null, { status: 404 });
        },
        { refresh: async () => `${UPSTREAM}-fresh2`, refreshCalls },
      ),
    );
    await settleJob(vid);
  } finally {
    delete process.env.MEDIA_SOURCE_MAX_ATTEMPTS;
  }
  assert.ok(calls >= 3, `bounded retries ran, got ${calls} fetches`);
  assert.ok(refreshCalls.n >= 1, 'stale 404 triggered a fresh-URL attempt');
  assert.equal(fs.statSync(tsPartPath(vid)).size, 1000, 'partial prefix intact after exhaustion');
  assert.equal((await loadSourceFrontier(vid))?.frontier, 1000);
  fs.rmSync(tsPartPath(vid), { force: true });
  const { removeSourceFrontier } = await import('@/lib/media/source-acquisition');
  await removeSourceFrontier(vid);
});

test('restart recovery: a new job resumes the preserved frontier (never 0)', async () => {
  const vid = 71207;
  process.env.MEDIA_SOURCE_MAX_ATTEMPTS = '2';
  // Seed a crash-interrupted prefix: bytes + manifest, no live job.
  fs.writeFileSync(tsPartPath(vid), Buffer.from(EXPECTED.subarray(0, 1000)));
  await storeSourceFrontierAtomic({ videoId: vid, megaNodeId: `node-acq-${vid}`, sourceSize: PLAIN.length, frontier: 1000, updatedAt: '' });
  const requested: string[] = [];
  try {
    startJob(
      srcFor(vid, async (url) => {
        requested.push(url);
        if (requested.length === 1) {
          // Serve 500 more ciphertext bytes, then exhaust the budget: the
          // restarted job extends the prefix (1492) before preserving it.
          const { from } = rangeSlice(url);
          return new Response(Buffer.from(CT.subarray(from, from + 500)), { status: 200 });
        }
        return new Response(null, { status: 500 });
      }),
    );
    await settleJob(vid);
  } finally {
    delete process.env.MEDIA_SOURCE_MAX_ATTEMPTS;
  }
  assert.ok(requested.length >= 1);
  assert.ok(requested[0]!.endsWith(`/992-${PLAIN.length - 1}`), `restart resumes at 992, got ${requested[0]}`);
  // The restarted job adopts the preserved prefix AND extends it: its first
  // fetch serves 500 more bytes (16-aligned resume skips 8 of overlap), so
  // the newest frontier is 1492 — progress, never a restart, never a loss.
  assert.ok(requested[1]!.endsWith(`/1488-${PLAIN.length - 1}`), `bounded retry continues at 1488, got ${requested[1]}`);
  assert.equal(fs.statSync(tsPartPath(vid)).size, 1492, 'prefix extended, then preserved on exhaustion');
  assert.equal((await loadSourceFrontier(vid))?.frontier, 1492);
  fs.rmSync(tsPartPath(vid), { force: true });
  const { removeSourceFrontier } = await import('@/lib/media/source-acquisition');
  await removeSourceFrontier(vid);
});

test('corrupt manifest + short file: frontier repaired from the file, resume continues', async () => {
  const vid = 71208;
  process.env.MEDIA_SOURCE_MAX_ATTEMPTS = '2';
  fs.writeFileSync(tsPartPath(vid), Buffer.from(EXPECTED.subarray(0, 1000)));
  fs.writeFileSync(frontierManifestPath(vid), '{"megaNodeId":');
  const requested: string[] = [];
  try {
    startJob(
      srcFor(vid, async (url) => {
        requested.push(url);
        if (requested.length === 1) {
          const { from } = rangeSlice(url);
          return new Response(Buffer.from(CT.subarray(from, from + 500)), { status: 200 });
        }
        return new Response(null, { status: 500 });
      }),
    );
    await settleJob(vid);
  } finally {
    delete process.env.MEDIA_SOURCE_MAX_ATTEMPTS;
  }
  assert.ok(requested[0]!.endsWith(`/992-${PLAIN.length - 1}`), `repaired frontier resumes at 992, got ${requested[0]}`);
  // Reconcile healed the manifest to the file (1000) before the first fetch;
  // the job then extended the prefix by 492 (500 served minus 8 overlap
  // skipped), so the newest frontier is 1492.
  assert.equal(fs.statSync(tsPartPath(vid)).size, 1492);
  assert.equal((await loadSourceFrontier(vid))?.frontier, 1492, 'manifest tracks the newest frontier');
  fs.rmSync(tsPartPath(vid), { force: true });
  const { removeSourceFrontier } = await import('@/lib/media/source-acquisition');
  await removeSourceFrontier(vid);
});

test('orphan sweep: resumable prefix kept, dangling manifest + plain temps removed', async () => {
  const keepVid = 71209;
  const plainVid = 71210;
  fs.writeFileSync(tsPartPath(keepVid), Buffer.alloc(500, 9));
  await storeSourceFrontierAtomic({ videoId: keepVid, megaNodeId: 'n', sourceSize: 4096, frontier: 500, updatedAt: '' });
  fs.writeFileSync(tsPartPath(plainVid), Buffer.from('junk'));
  fs.writeFileSync(path.join(tmpRoot, 'cache', `${plainVid}.part.mp4`), Buffer.from('junk'));
  fs.writeFileSync(path.join(tmpRoot, 'cache', '4244.live.spool'), Buffer.from('junk'));
  fs.writeFileSync(frontierManifestPath(99991), JSON.stringify({ videoId: 99991, megaNodeId: 'n', sourceSize: 10, frontier: 5, updatedAt: '' }));
  await cleanupOrphanedTempFiles();
  assert.equal(fs.existsSync(tsPartPath(keepVid)), true, 'resumable prefix survives restart sweep');
  assert.equal(fs.existsSync(frontierManifestPath(keepVid)), true, 'its manifest survives too');
  assert.equal(fs.existsSync(tsPartPath(plainVid)), false, 'manifest-less partial still swept');
  assert.equal(fs.existsSync(frontierManifestPath(99991)), false, 'dangling manifest swept');
  fs.rmSync(tsPartPath(keepVid), { force: true });
  const { removeSourceFrontier } = await import('@/lib/media/source-acquisition');
  await removeSourceFrontier(keepVid);
});
