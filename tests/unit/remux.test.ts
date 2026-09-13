/**
 * Unit tests for lib/media/remux.ts (MPEG-TS -> MP4 remux path).
 *
 * Covers the pure/decided parts without MEGA or ffmpeg: container decision,
 * decrypt-prefix round-trip with genuine megajs CTR ciphertext, fMP4 init
 * boundary detection, live-response byte collection, cached-file Range
 * responses, and sidecar cache-hit validation.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remux-unit-'));
process.env.MEDIA_CACHE_DIR = path.join(tmpRoot, 'cache');

import { encrypt } from 'megajs';
import {
  PCR_ALIGN,
  REMUXED_MIME_TYPE,
  SPOOL_WAIT_TIMEOUT_MS,
  canServeSeekFromSpool,
  cancelLiveRemuxJob,
  checkMediaTempBudget,
  cleanupOrphanedTempFiles,
  createCachedFileResponse,
  createLiveResponse,
  decryptPrefixToBuffer,
  findFragmentedMp4InitEnd,
  getOrCreateLiveRemuxJob,
  getRemuxSlotStats,
  hasLiveRemuxJob,
  joinLiveRemuxJob,
  mediaCacheDir,
  MediaTempBudgetError,
  mediaTempUsage,
  needsRemuxPlayback,
  noteSubscriberAttached,
  noteSubscriberDetached,
  patchFragmentedMp4Duration,
  pcrTailStart,
  readRemuxCache,
  remuxCachePaths,
  retainLiveRemuxJob,
  scanTsPcrDuration,
  waitForSpoolOffset,
  wakeSpoolWaiters,
  writeSidecarAtomic,
} from '@/lib/media/remux';
import type { LiveRemuxJob } from '@/lib/media/remux';

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Container decision
// ---------------------------------------------------------------------------
test('needsRemuxPlayback: only MPEG-TS needs conversion', () => {
  assert.equal(needsRemuxPlayback('video/mp2t'), true);
  assert.equal(needsRemuxPlayback('video/mp4'), false);
  assert.equal(needsRemuxPlayback('video/webm'), false);
  assert.equal(needsRemuxPlayback('video/quicktime'), false);
  assert.equal(needsRemuxPlayback(null), false);
  assert.equal(needsRemuxPlayback(undefined), false);
});

test('mediaCacheDir honors MEDIA_CACHE_DIR override', () => {
  assert.equal(mediaCacheDir(), path.join(tmpRoot, 'cache'));
});

// ---------------------------------------------------------------------------
// decryptPrefixToBuffer: genuine megajs CTR round-trip
// ---------------------------------------------------------------------------
const PLAIN = Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 7) & 0xff));
const EXPECTED = Buffer.from(PLAIN);
const encKey = Buffer.concat([Buffer.alloc(16, 0x33), Buffer.alloc(8, 0x44)]);
const encStream = encrypt(encKey);
const ctChunks: Buffer[] = [];
let CT = Buffer.alloc(0);
let FILE_KEY = Buffer.alloc(32);
encStream.on('data', (c: Buffer) => ctChunks.push(c));
encStream.on('end', () => {
  CT = Buffer.concat(ctChunks);
  FILE_KEY = Buffer.from(encStream.key);
});
encStream.end(PLAIN);

before(async () => {
  while (CT.length === 0) await new Promise((r) => setTimeout(r, 10));
});

test('decryptPrefixToBuffer returns exact plaintext for a ciphertext prefix', async () => {
  const out = await decryptPrefixToBuffer(FILE_KEY, Buffer.from(CT.subarray(0, 188)));
  assert.ok(out.equals(EXPECTED.subarray(0, 188)), 'decrypted prefix must match plaintext');
});

// ---------------------------------------------------------------------------
// createCachedFileResponse: Range semantics over a cached MP4
// ---------------------------------------------------------------------------
test('cached file: full GET -> 200 video/mp4 with exact bytes', async () => {
  const f = path.join(tmpRoot, 'full.mp4');
  fs.writeFileSync(f, EXPECTED);
  const res = createCachedFileResponse(f, 0, EXPECTED.length - 1, EXPECTED.length);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), REMUXED_MIME_TYPE);
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal(res.headers.get('content-length'), String(EXPECTED.length));
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(EXPECTED));
});

test('cached file: Range -> 206 with Content-Range and exact slice', async () => {
  const f = path.join(tmpRoot, 'part.mp4');
  fs.writeFileSync(f, EXPECTED);
  const res = createCachedFileResponse(f, 100, 199, EXPECTED.length);
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 100-199/${EXPECTED.length}`);
  assert.equal(res.headers.get('content-length'), '100');
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(EXPECTED.subarray(100, 200)));
});

// ---------------------------------------------------------------------------
// ensureRemuxedMp4: cache hit + graceful failure (no ffmpeg needed)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// readRemuxCache: hit / stale / absent (never starts work, no network)
// ---------------------------------------------------------------------------
test('readRemuxCache: valid sidecar returns cached file', async () => {
  const dir = mediaCacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const payload = Buffer.from('fake-mp4-bytes');
  fs.writeFileSync(path.join(dir, '777.mp4'), payload);
  fs.writeFileSync(
    path.join(dir, '777.json'),
    JSON.stringify({ megaNodeId: 'nodeX', sourceSize: 1234, outputSize: payload.length }),
  );
  const out = await readRemuxCache(777, 'nodeX', 1234);
  assert.ok(out && out.path.endsWith('777.mp4') && out.size === payload.length);
});

test('readRemuxCache: stale sidecar (size changed) or missing file -> null', async () => {
  const dir = mediaCacheDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '778.mp4'), Buffer.from('stale'));
  fs.writeFileSync(
    path.join(dir, '778.json'),
    JSON.stringify({ megaNodeId: 'nodeX', sourceSize: 999, outputSize: 5 }),
  );
  assert.equal(await readRemuxCache(778, 'nodeX', 1234), null, 'changed source must miss');
  assert.equal(await readRemuxCache(779, 'nodeX', 1234), null, 'absent cache must miss');
});

// ---------------------------------------------------------------------------
// findFragmentedMp4InitEnd: ftyp+moov boundary from synthetic boxes
// ---------------------------------------------------------------------------
function box(type: string, payloadLen: number): Buffer {
  const b = Buffer.alloc(8 + payloadLen);
  b.writeUInt32BE(8 + payloadLen, 0);
  b.write(type, 4, 4, 'latin1');
  return b;
}

test('findFragmentedMp4InitEnd: init ends where the first moof starts', () => {
  const init = Buffer.concat([box('ftyp', 16), box('moov', 100)]);
  const stream = Buffer.concat([init, box('moof', 50), box('mdat', 200)]);
  assert.equal(findFragmentedMp4InitEnd(stream), init.length);
  // Partial moov: need more data.
  assert.equal(findFragmentedMp4InitEnd(stream.subarray(0, init.length - 10)), -1);
  // Garbage first box: not an init segment.
  assert.equal(findFragmentedMp4InitEnd(box('moof', 50)), -1);
});

// ---------------------------------------------------------------------------
// createLiveResponse: bounded start-0 range satisfied from live bytes
// ---------------------------------------------------------------------------
function fakeLiveJob(init: Buffer): LiveRemuxJob {
  return {
    videoId: 1,
    xBroadcastBytes: 0,
    xStartedAt: Date.now(),
    spoolPath: '',
    spoolSynced: Promise.resolve(),
    spoolBytes: 0,
    spoolInitWritten: Promise.resolve(),
    initSpoolOffset: init.length,
    cache: Promise.resolve(null),
    ready: Promise.resolve(),
    liveEnded: false,
    liveError: null,
    initSegment: init,
    subscribers: new Set(),
    waiters: [],
    spoolWaiters: [],
    dying: false,
    cancelling: false,
    settled: false,
    graceTimer: null,
    abortController: new AbortController(),
    xReadyReject: null,
    xJoinedCount: 0,
  };
}

test('createLiveResponse: bytes=0-N replays the spool and ends 206', async () => {
  const spoolPath = path.join(tmpRoot, 'live-spool.bin');
  await fs.promises.writeFile(spoolPath, Buffer.from('INIT0123456789EXTRA'));
  const job = fakeLiveJob(Buffer.from('INIT'));
  job.spoolPath = spoolPath;
  job.spoolBytes = Buffer.from('INIT0123456789EXTRA').length;
  const res = createLiveResponse(job, 9, new AbortController().signal);
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-type'), REMUXED_MIME_TYPE);
  assert.equal(res.headers.get('content-range'), 'bytes 0-9/*');
  // Live ended: the reader emits the bytes and terminates cleanly.
  job.liveEnded = true;
  for (const sub of job.subscribers) sub.notify();
  const body = Buffer.from(await res.arrayBuffer());
  assert.ok(body.equals(Buffer.from('INIT012345')), `live bytes exact, got ${body.toString()}`);
});

test('createLiveResponse: live failure before init ends the body silently (no throw, no crash)', async () => {
  const job = fakeLiveJob(Buffer.from('INIT'));
  job.initSegment = null;
  const res = createLiveResponse(job, null, new AbortController().signal);
  job.liveEnded = true;
  job.liveError = new Error('boom');
  for (const sub of job.subscribers) sub.notify();
  for (const w of job.waiters.splice(0)) w();
  // Must resolve (possibly empty), never reject: a generator throw becomes
  // a Next "failed to pipe response" 500 + risks "Controller is already
  // closed". The browser sees a truncated stream and errors honestly.
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(body.length, 0);
});

// ---------------------------------------------------------------------------
// patchFragmentedMp4Duration: exact mvhd rewrite, v0 + v1
// ---------------------------------------------------------------------------
function mvhdBox(version: 0 | 1, timescale: number): Buffer {
  const len = version === 0 ? 108 : 120;
  const b = Buffer.alloc(len);
  b.writeUInt32BE(len, 0);
  b.write('mvhd', 4, 4, 'latin1');
  b[8] = version;
  if (version === 0) {
    b.writeUInt32BE(timescale, 20);
    b.writeUInt32BE(0, 24); // live/unknown duration
  } else {
    b.writeUInt32BE(timescale, 28);
    b.writeBigUInt64BE(BigInt(0), 32);
  }
  return b;
}

function initWithMvhd(version: 0 | 1, timescale: number): Buffer {
  const mvhd = mvhdBox(version, timescale);
  const moovLen = 8 + mvhd.length;
  const moov = Buffer.alloc(moovLen);
  moov.writeUInt32BE(moovLen, 0);
  moov.write('moov', 4, 4, 'latin1');
  mvhd.copy(moov, 8);
  return Buffer.concat([box('ftyp', 16), moov, box('moof', 50)]);
}

test('patchFragmentedMp4Duration: v0 mvhd gets exact ticks, rest untouched', () => {
  const init = initWithMvhd(0, 1000);
  const out = patchFragmentedMp4Duration(init, 1099);
  assert.ok(out, 'must patch');
  // mvhd duration field: moov(8+16 ftyp... compute: ftyp=24, moov at 24, mvhd at 32, duration at 32+24=56
  assert.equal(out!.readUInt32BE(56), 1099000);
  assert.equal(out!.readUInt32BE(52), 1000, 'timescale preserved');
  // Everything except the 4 duration bytes is identical.
  for (let i = 0; i < out!.length; i++) {
    if (i >= 56 && i < 60) continue;
    assert.equal(out![i], init[i], `byte ${i} untouched`);
  }
});

test('patchFragmentedMp4Duration: v1 mvhd gets exact 64-bit ticks', () => {
  const init = initWithMvhd(1, 90000);
  const out = patchFragmentedMp4Duration(init, 61);
  assert.ok(out, 'must patch');
  // ftyp=24, moov at 24, mvhd at 32, v1 duration at 32+32=64
  assert.equal(out!.readBigUInt64BE(64), BigInt(61 * 90000));
});

test('patchFragmentedMp4Duration: null when unusable (no fake duration)', () => {
  const init = initWithMvhd(0, 1000);
  assert.equal(patchFragmentedMp4Duration(init, null), null);
  assert.equal(patchFragmentedMp4Duration(init, 0), null);
  assert.equal(patchFragmentedMp4Duration(init, Number.NaN), null);
  assert.equal(patchFragmentedMp4Duration(box('moof', 50), 100), null, 'no moov');
});

// ---------------------------------------------------------------------------
// scanTsPcrDuration: exact duration from synthetic PCR packets
// ---------------------------------------------------------------------------
function tsPacket(pid: number, pcrSeconds: number | null): Buffer {
  const b = Buffer.alloc(188, 0xff);
  b[0] = 0x47;
  b[1] = (pid >> 8) & 0x1f;
  b[2] = pid & 0xff;
  if (pcrSeconds === null) {
    b[3] = 0x10;
    return b;
  }
  b[3] = 0x30;
  b[4] = 7;
  b[5] = 0x10;
  const field = Math.round(pcrSeconds * 90000) * 32768;
  b.writeUIntBE(field, 6, 6);
  return b;
}

test('scanTsPcrDuration: last-minus-first PCR of dominant PID, gated by size', () => {
  const headPkts: Buffer[] = [];
  for (let i = 0; i < 20; i++) headPkts.push(tsPacket(256, i * 0.1));
  for (let i = 0; i < 5; i++) headPkts.push(tsPacket(257, i * 0.1)); // minority PID ignored
  const head = Buffer.concat(headPkts);
  const tailPkts: Buffer[] = [];
  for (let i = 0; i < 20; i++) tailPkts.push(tsPacket(256, 100 + i * 0.1));
  const tail = Buffer.concat(tailPkts);
  const tailOffset = 12_500_000 - (12_500_000 % 188);
  // ~1 Mbps implied: 12.5 MB over ~102 s.
  const out = scanTsPcrDuration(head, 0, tail, tailOffset, 12_800_000);
  assert.ok(out, 'must find duration');
  assert.equal(out!.pid, 256);
  assert.ok(Math.abs(out!.seconds - 101.9) < 0.5, `exact-ish, got ${out!.seconds}`);
});

test('scanTsPcrDuration: null on garbage or implausible input', () => {
  const garbage = Buffer.alloc(188 * 10, 0x47);
  assert.equal(scanTsPcrDuration(garbage, 0, garbage, 1880, 1000), null, 'no PCRs');
  const head = Buffer.concat([tsPacket(256, 0), tsPacket(256, 1)]);
  const tail = Buffer.concat([tsPacket(256, 2), tsPacket(256, 3)]);
  // 1 GB claimed for a 3 s clip -> 2.6 Gbps implied -> gate rejects.
  assert.equal(scanTsPcrDuration(head, 0, tail, 188, 1_000_000_000), null, 'gate rejects');
});

// ---------------------------------------------------------------------------
// Bug 1: PCR probe tail offset must satisfy BOTH 188 (TS packet) and 16
// (MEGA CTR start) alignment - 752 = 188 × 4 is the combined alignment.
// ---------------------------------------------------------------------------
test('pcrTailStart: 752-aligned for every size (Bug 1 regression)', () => {
  // The audit's exact failure shape: naive %188 rounding produced offsets
  // ≡ 8 (mod 16) and megaDecrypt threw. Every size must give %16 == %188 == 0.
  for (const size of [197_030_392, 164_283_424, 159_545_072, 10_606_208, 188 * 1000 + 7, 1_000_000, 752, 100]) {
    const at = pcrTailStart(size);
    assert.equal(at % 188, 0, `size ${size}: %188`);
    assert.equal(at % 16, 0, `size ${size}: %16`);
    assert.equal(at % PCR_ALIGN, 0, `size ${size}: %752`);
    assert.ok(at <= Math.max(0, size - 1), `size ${size}: within file`);
  }
  // Small files clamp to 0 (whole file is the sample).
  assert.equal(pcrTailStart(100), 0);
  assert.equal(pcrTailStart(752 * 3), 0);
});

// ---------------------------------------------------------------------------
// P0-C: seek decisions use fMP4 (spool) coordinates, never source-TS size.
// The spool holds the init segment at [0..initSpoolOffset), so init-region
// offsets are serveable bytes like any other buffered prefix.
// ---------------------------------------------------------------------------
test('canServeSeekFromSpool: spool-space decisions (source size is irrelevant)', () => {
  const job = fakeLiveJob(Buffer.alloc(1200));
  job.initSpoolOffset = 1200;
  job.spoolBytes = 5_000_000;
  assert.equal(canServeSeekFromSpool(job, 0), false, 'start 0 is the normal live path');
  assert.equal(canServeSeekFromSpool(job, 600), true, 'init-region bytes are in the spool and serveable');
  assert.equal(canServeSeekFromSpool(job, 1200), true, 'at init end, buffered');
  assert.equal(canServeSeekFromSpool(job, 4_999_999), true, 'inside buffered window');
  job.liveEnded = true;
  assert.equal(canServeSeekFromSpool(job, 5_000_000), false, 'beyond buffered, live ended');
  assert.equal(canServeSeekFromSpool(job, 4_000_000_000), false, 'way beyond, live ended');
  job.liveEnded = false;
  assert.equal(canServeSeekFromSpool(job, 9_000_000), true, 'beyond buffered but live running: bytes will arrive');
});

test('P0-C: a source-valid offset beyond an ENDED spool is not serveable (no fake ranges)', async () => {
  // Source TS size 8 000 000, but the finished fMP4 spool holds only 5 000
  // bytes and the live has ended: offset 6 000 000 is "valid" against the
  // source size yet names no fMP4 byte. It must not produce a live-spool
  // 206 (the route falls through to the finished cache / honest 503).
  const job = fakeLiveJob(Buffer.alloc(8));
  job.spoolBytes = 5_000;
  job.liveEnded = true;
  assert.equal(canServeSeekFromSpool(job, 6_000_000), false);
  assert.equal(await waitForSpoolOffset(job, 6_000_000), 5_000, 'settles with the real frontier');
});

test('waitForSpoolOffset: resolves immediately when buffered, on end, and on abort', async () => {
  const job = fakeLiveJob(Buffer.alloc(8));
  job.spoolBytes = 1_000;
  assert.equal(await waitForSpoolOffset(job, 500), 1_000, 'already buffered -> immediate');
  job.liveEnded = true;
  assert.equal(await waitForSpoolOffset(job, 5_000), 1_000, 'ended short -> immediate short frontier');
  // Abort while waiting for growth.
  const job2 = fakeLiveJob(Buffer.alloc(8));
  job2.spoolBytes = 100;
  const ac = new AbortController();
  const p = waitForSpoolOffset(job2, 5_000, ac.signal);
  setTimeout(() => ac.abort(), 20);
  assert.equal(await p, 100, 'abort resolves with the current frontier');
  assert.equal(job2.spoolWaiters.length, 0, 'aborted waiter unregistered (no leak)');
  // Growth while waiting (frontier must be re-checked on notify).
  const job3 = fakeLiveJob(Buffer.alloc(8));
  job3.spoolBytes = 100;
  const p3 = waitForSpoolOffset(job3, 5_000);
  setTimeout(() => {
    job3.spoolBytes = 6_000;
    wakeSpoolWaiters(job3);
  }, 20);
  assert.equal(await p3, 6_000, 'growth wake re-checks the frontier (no stale waiter)');
});

test('P0-B: growth wakes a waiter promptly while the live is still running', async () => {
  const job = fakeLiveJob(Buffer.alloc(8));
  job.spoolBytes = 100;
  job.liveEnded = false;
  const t0 = Date.now();
  const p = waitForSpoolOffset(job, 5_000, undefined, 10_000);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(job.spoolWaiters.length, 1, 'registered while pending');
  // Spool grows (broadcast path) while the live keeps running.
  job.spoolBytes = 6_000;
  wakeSpoolWaiters(job);
  assert.equal(await p, 6_000, 'resolves with the grown frontier');
  assert.ok(Date.now() - t0 < 5_000, 'wakes promptly, long before any end/timeout');
  assert.equal(job.liveEnded, false, 'live still running: resolution came from growth, not end');
  assert.equal(job.spoolWaiters.length, 0, 'settled waiter unregistered');
});

test('P0-B: a stalled frontier settles via timeout instead of hanging forever', async () => {
  assert.ok(SPOOL_WAIT_TIMEOUT_MS >= 1_000, 'production bound is sane');
  const job = fakeLiveJob(Buffer.alloc(8));
  job.spoolBytes = 100;
  const t0 = Date.now();
  // Broken frontier: nothing grows, live never ends, no abort.
  assert.equal(await waitForSpoolOffset(job, 5_000, undefined, 40), 100, 'timeout settles with the current frontier');
  assert.ok(Date.now() - t0 < 5_000, 'bounded, never hangs');
  assert.equal(job.spoolWaiters.length, 0, 'timed-out waiter unregistered (no leak)');
});

test('waitForSpoolOffset: removed from job.spoolWaiters after settle (no leak)', async () => {
  const job = fakeLiveJob(Buffer.alloc(8));
  job.spoolBytes = 100;
  const ac = new AbortController();
  const p = waitForSpoolOffset(job, 5_000, ac.signal);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(job.spoolWaiters.length, 1, 'registered while pending');
  ac.abort();
  await p;
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(job.spoolWaiters.length, 0, 'unregistered after settle');
});

test('createLiveResponse: start-offset viewer receives the exact spool slice (cold seek)', async () => {
  const spoolPath = path.join(tmpRoot, 'seek-spool.bin');
  const payload = Buffer.concat([Buffer.from('INIT'), Buffer.alloc(996, 0x61), Buffer.alloc(4000, 0x62)]);
  await fs.promises.writeFile(spoolPath, payload);
  const job = fakeLiveJob(payload.subarray(0, 4));
  job.spoolPath = spoolPath;
  job.initSpoolOffset = 4;
  job.spoolBytes = payload.length;
  job.liveEnded = true;
  const res = createLiveResponse(job, 4999, new AbortController().signal, 1000);
  assert.equal(res.status, 206);
  assert.match(res.headers.get('content-range') ?? '', /bytes 1000-4999\//);
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(body.length, 4000);
  assert.ok(body.equals(payload.subarray(1000, 5000)), 'exact spool slice from the seek offset');
});

test('createLiveResponse: resolved Content-Range uses the real total once the live has ended', async () => {
  const spoolPath = path.join(tmpRoot, 'ended-spool.bin');
  await fs.promises.writeFile(spoolPath, Buffer.alloc(5000, 7));
  const job = fakeLiveJob(Buffer.alloc(8));
  job.spoolPath = spoolPath;
  job.spoolBytes = 5000;
  job.liveEnded = true;
  const res = createLiveResponse(job, 5099, new AbortController().signal, 1000);
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 1000-4999/5000', 'total clamped to the actual spool length');
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(body.length, 4000);
});

// ---------------------------------------------------------------------------
// P0-A/C: live HTTP contract matrix — every status/header/body triple must
// describe the fMP4 representation actually served, never the source.
// ---------------------------------------------------------------------------
test('live contract: 200 open live is non-seekable; 206 spool slices echo fMP4 offsets', async () => {
  const spoolPath = path.join(tmpRoot, 'contract-spool.bin');
  const payload = Buffer.concat([Buffer.from('INIT'), Buffer.alloc(9996, 0x61)]);
  await fs.promises.writeFile(spoolPath, payload);
  // Open-ended live stream: 200, explicitly non-seekable.
  {
    const job = fakeLiveJob(payload.subarray(0, 4));
    job.spoolPath = spoolPath;
    job.spoolBytes = payload.length;
    const res = createLiveResponse(job, null, new AbortController().signal);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('accept-ranges'), 'none', 'open live must not invite Range seeks');
    assert.equal(res.headers.get('content-range'), null, 'no range on a 200');
    job.liveEnded = true;
    for (const sub of job.subscribers) sub.notify();
    await res.body!.cancel().catch(() => {});
  }
  // Bounded start-0 (probe): 206 with unknown total.
  {
    const job = fakeLiveJob(payload.subarray(0, 4));
    job.spoolPath = spoolPath;
    job.spoolBytes = payload.length;
    const res = createLiveResponse(job, 1, new AbortController().signal);
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), 'bytes 0-1/*', 'unknown total while warming');
    assert.equal(res.headers.get('accept-ranges'), 'bytes', 'spool slices are satisfiable ranges');
    job.liveEnded = true;
    for (const sub of job.subscribers) sub.notify();
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(body.equals(payload.subarray(0, 2)), 'exact first bytes (init first)');
  }
  // Seek slice while running: same-offset fMP4 window, unknown total.
  {
    const job = fakeLiveJob(payload.subarray(0, 4));
    job.spoolPath = spoolPath;
    job.spoolBytes = payload.length;
    const res = createLiveResponse(job, 1099, new AbortController().signal, 1000);
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), 'bytes 1000-1099/*');
    assert.equal(res.headers.get('accept-ranges'), 'bytes');
    job.liveEnded = true;
    for (const sub of job.subscribers) sub.notify();
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(body.equals(payload.subarray(1000, 1100)), 'same-offset slice, no init prepended (client holds it)');
  }
});

test('P0-A/C1: cold-live start-0 body begins with the fMP4 init segment', async () => {
  // A viewer that never received init cannot decode fragments: the first
  // bytes of any start-0 live response must be ftyp+moov, never a mid-
  // stream moof. (Regression: the spool misordering served init + raw mdat
  // payload with moof #1 displaced to EOF.)
  const ftyp = Buffer.alloc(28);
  ftyp.writeUInt32BE(28, 0);
  ftyp.write('ftyp', 4, 4, 'latin1');
  const moov = Buffer.alloc(1208);
  moov.writeUInt32BE(1208, 0);
  moov.write('moov', 4, 4, 'latin1');
  const init = Buffer.concat([ftyp, moov]);
  const moof = Buffer.alloc(7196);
  moof.writeUInt32BE(7196, 0);
  moof.write('moof', 4, 4, 'latin1');
  const spoolPath = path.join(tmpRoot, 'init-first-spool.bin');
  await fs.promises.writeFile(spoolPath, Buffer.concat([init, moof]));
  const job = fakeLiveJob(init);
  job.spoolPath = spoolPath;
  job.spoolBytes = init.length + moof.length;
  const res = createLiveResponse(job, null, new AbortController().signal);
  const reader = res.body!.getReader();
  const head = await reader.read();
  await reader.cancel().catch(() => {});
  job.liveEnded = true;
  for (const sub of job.subscribers) sub.notify();
  assert.ok(head.value && head.value.length > 0, 'first bytes flow');
  const headBuf = Buffer.from(head.value);
  assert.equal(headBuf.subarray(4, 8).toString('latin1'), 'ftyp', 'stream opens with the init segment');
  assert.ok(headBuf.length >= 8, 'box header complete');
});

test('lifecycle: pre-aborted viewer registers no phantom subscriber', async () => {
  // A request that died in preflight must never pin the viewer count: the
  // abort listener below would never fire for an already-aborted signal,
  // leaving a subscriber that could never detach (grace shutdown would
  // never arm). Serve nothing instead — nobody is listening.
  const spoolPath = path.join(tmpRoot, 'phantom-spool.bin');
  const payload = Buffer.concat([Buffer.from('INIT'), Buffer.alloc(100, 0x61)]);
  await fs.promises.writeFile(spoolPath, payload);
  const job = fakeLiveJob(payload.subarray(0, 4));
  job.spoolPath = spoolPath;
  job.spoolBytes = payload.length;
  const res = createLiveResponse(job, null, AbortSignal.abort());
  assert.equal(res.status, 204, 'dead viewer gets an empty response, not a stream');
  assert.equal(job.subscribers.size, 0, 'no phantom subscriber registered');
  assert.equal(Buffer.from(await res.arrayBuffer()).length, 0);
});

test('Bug 4 regression: aborted live viewer never rejects unhandled (clean detach)', async () => {
  const spoolPath = path.join(tmpRoot, 'abort-spool.bin');
  await fs.promises.writeFile(spoolPath, Buffer.alloc(1_000_000, 9));
  const job = fakeLiveJob(Buffer.alloc(8));
  job.spoolPath = spoolPath;
  job.spoolBytes = 1_000_000;
  const ac = new AbortController();
  const res = createLiveResponse(job, null, ac.signal);
  const reader = res.body!.getReader();
  const first = await reader.read(); // some bytes flowed
  assert.ok(first.value && first.value.length > 0);
  // Browser aborts: cancel + controller error at once (the crash shape).
  const cancelPromise = reader.cancel().catch(() => 'cancelled');
  ac.abort();
  await cancelPromise;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(job.subscribers.size, 0, 'viewer detached from the job');
});

test('Bug 4 regression: cancel AFTER stream end does not reject or crash', async () => {
  const spoolPath = path.join(tmpRoot, 'late-cancel-spool.bin');
  await fs.promises.writeFile(spoolPath, Buffer.from('short'));
  const job = fakeLiveJob(Buffer.alloc(8));
  job.spoolPath = spoolPath;
  job.spoolBytes = 5;
  job.liveEnded = true;
  const res = createLiveResponse(job, null, new AbortController().signal);
  const body = Buffer.from(await res.arrayBuffer());
  assert.ok(body.equals(Buffer.from('short')));
  // Response fully consumed; a late reader.cancel() must be harmless.
  await res.body!.cancel().catch(() => 'already closed');
  await new Promise((r) => setTimeout(r, 20));
});

// ---------------------------------------------------------------------------
// Subscriber-aware lifecycle: counting, grace, cancellation (fake jobs).
// Grace uses a short env override + real timers (deterministic margins).
// ---------------------------------------------------------------------------
function withShortGrace<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.MEDIA_ZERO_SUBSCRIBER_GRACE_MS;
  process.env.MEDIA_ZERO_SUBSCRIBER_GRACE_MS = '80';
  return fn().finally(() => {
    if (prev === undefined) delete process.env.MEDIA_ZERO_SUBSCRIBER_GRACE_MS;
    else process.env.MEDIA_ZERO_SUBSCRIBER_GRACE_MS = prev;
  });
}

test('lifecycle 1-4: retain/release counts viewers; detach-to-zero arms grace', async () => {
  await withShortGrace(async () => {
    const job = fakeLiveJob(Buffer.alloc(8));
    assert.equal(job.subscribers.size, 0);
    const r1 = retainLiveRemuxJob(job);
    assert.equal(job.subscribers.size, 1, 'first subscriber attaches');
    const r2 = retainLiveRemuxJob(job);
    assert.equal(job.subscribers.size, 2, 'second subscriber attaches');
    r1();
    assert.equal(job.subscribers.size, 1, 'first detach leaves the other');
    assert.equal(job.graceTimer, null, 'no timer while watched');
    r2();
    assert.equal(job.subscribers.size, 0, 'second detach empties');
    assert.notEqual(job.graceTimer, null, 'zero-subscriber grace timer starts');
  });
});

test('lifecycle: duplicate release is harmless (idempotent detach)', async () => {
  await withShortGrace(async () => {
    const job = fakeLiveJob(Buffer.alloc(8));
    const release = retainLiveRemuxJob(job);
    release();
    assert.equal(job.subscribers.size, 0);
    release();
    release();
    assert.equal(job.subscribers.size, 0, 'no negative count, no throw');
  });
});

test('lifecycle 6-7: attach during grace cancels shutdown; watched job never aborts', async () => {
  await withShortGrace(async () => {
    const job = fakeLiveJob(Buffer.alloc(8));
    const r1 = retainLiveRemuxJob(job);
    r1(); // -> zero, timer armed
    assert.notEqual(job.graceTimer, null);
    const r2 = retainLiveRemuxJob(job); // new interest during grace
    assert.equal(job.graceTimer, null, 'attach cancels the pending shutdown');
    assert.equal(job.dying, false);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(job.dying, false, 'watched job survives past the grace window');
    assert.equal(job.liveEnded, false);
    r2();
  });
});

test('lifecycle 8: grace expiry aborts an unwatched job (dying, ended, quiet)', async () => {
  await withShortGrace(async () => {
    const job = fakeLiveJob(Buffer.alloc(8));
    const release = retainLiveRemuxJob(job);
    release(); // -> zero, timer armed
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(job.dying, true, 'shutdown decided');
    assert.equal(job.cancelling, true);
    assert.equal(job.liveEnded, true, 'broadcast ended so waiters settle');
    assert.ok(job.liveError instanceof Error, 'waiters observe a terminal error');
    assert.equal((job.liveError as Error).name, 'LiveJobCancelledError');
  });
});

test('lifecycle 10 (part): cancellation itself never touches the slot counter', async () => {
  await withShortGrace(async () => {
    const before = getRemuxSlotStats().active;
    const job = fakeLiveJob(Buffer.alloc(8));
    cancelLiveRemuxJob(job, 'test');
    cancelLiveRemuxJob(job, 'test'); // idempotent: second call is a no-op
    assert.equal(job.dying, true);
    assert.equal(getRemuxSlotStats().active, before, 'no direct release; the job finally owns it');
  });
});

test('lifecycle 14: detach after completion is harmless (no timer, no throw)', async () => {
  await withShortGrace(async () => {
    const job = fakeLiveJob(Buffer.alloc(8));
    job.liveEnded = true;
    const release = retainLiveRemuxJob(job);
    release();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(job.graceTimer, null, 'finished jobs never arm');
    assert.equal(job.dying, false);
  });
});

test('lifecycle: new job does NOT arm grace timer at creation (preflight-safe)', { timeout: 30000 }, async () => {
  // Regression: arming the grace timer at creation self-cancels healthy new
  // jobs when the route preflight (session + a=g + sniff + ffmpeg init)
  // exceeds the grace window on slow MEGA. The route then sees a rejected
  // ready promise and answers 503, causing the player retry spiral.
  await withShortGrace(async () => {
    const vid = 99005;
    const job = getOrCreateLiveRemuxJob(abandonSrc(vid, hangingFetch));
    assert.equal(hasLiveRemuxJob(vid), true, 'job registered');
    assert.equal(job.graceTimer, null, 'no grace timer at creation');
    assert.equal(job.dying, false, 'job is alive');
    // A preflight longer than the grace window must NOT kill the job.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(hasLiveRemuxJob(vid), true, 'job survived past grace window');
    assert.equal(job.graceTimer, null, 'still no grace timer (no subscriber ever attached)');
    assert.equal(job.dying, false, 'still alive after waiting');
    // Cleanup.
    cancelLiveRemuxJob(job, 'test-cleanup');
    const t0 = Date.now();
    while (!job.settled && Date.now() - t0 < 5000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(job.settled, true, 'teardown ran to completion');
    assert.equal(hasLiveRemuxJob(vid), false, 'registry clean');
  });
});

test('lifecycle: join cancels a running grace timer (interest signal)', { timeout: 30000 }, async () => {
  // joinLiveRemuxJob works off the module registry: a real (hanging) job
  // exercises the true route hook — a join means a request is heading for
  // preflight, so a running countdown must stand down.
  await withShortGrace(async () => {
    const vid = 99004;
    const job = getOrCreateLiveRemuxJob(abandonSrc(vid, hangingFetch));
    const viewer = { notify: () => {}, detached: false };
    job.subscribers.add(viewer);
    noteSubscriberAttached(job);
    viewer.detached = true;
    job.subscribers.delete(viewer);
    noteSubscriberDetached(job);
    assert.notEqual(job.graceTimer, null, 'armed on last leave');
    joinLiveRemuxJob(vid);
    assert.equal(job.graceTimer, null, 'join disarms (interest arrived)');
    assert.equal(job.dying, false);
    // Cleanup: cancel explicitly and let the abort settle the teardown.
    // NOTE: registry removal is synchronous in cancel(); slot release and
    // temp cleanup happen in the job finally, so wait for `settled`.
    const slotBaseline = getRemuxSlotStats().active;
    cancelLiveRemuxJob(job, 'test-cleanup');
    const t0 = Date.now();
    while (!job.settled && Date.now() - t0 < 5000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(job.settled, true, 'teardown ran to completion');
    assert.equal(hasLiveRemuxJob(vid), false, 'registry clean');
    assert.equal(getRemuxSlotStats().active, slotBaseline - 1, 'cancelled job released its slot once');
  });
});

// ---------------------------------------------------------------------------
// Subscriber-aware lifecycle against REAL jobs (fast-failing fetch: no
// ffmpeg, no network). Video ids are unique per test (module registry).
// ---------------------------------------------------------------------------
function hangingFetch(_url: string, signal?: AbortSignal): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    void resolve; // hangs by design: settles only via abort below
    if (signal?.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      return;
    }
    signal?.addEventListener('abort', () => {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
  });
}

function failingFetch(): Promise<Response> {
  return Promise.resolve(new Response(null, { status: 500 }));
}

function abandonSrc(videoId: number, fetchImpl: (url: string, signal?: AbortSignal) => Promise<Response>) {
  return {
    videoId,
    megaNodeId: `node-${videoId}`,
    size: 1000,
    fileKey: Buffer.alloc(32, 7),
    upstreamUrl: 'https://gfs.test/fake',
    fetchCiphertext: fetchImpl,
  };
}

test('lifecycle 8-11: abandoned job cancelled after grace; slot + registry + temps cleaned once', { timeout: 30000 }, async () => {
  await withShortGrace(async () => {
    const vid = 99001;
    const baseline = getRemuxSlotStats().active;
    const job = getOrCreateLiveRemuxJob(abandonSrc(vid, hangingFetch));
    assert.equal(hasLiveRemuxJob(vid), true, 'job registered');
    assert.equal(getRemuxSlotStats().active, baseline + 1, 'slot held');
    // A viewer attaches (response created) and leaves: the only transition.
    const viewer = { notify: () => {}, detached: false };
    job.subscribers.add(viewer);
    noteSubscriberAttached(job);
    viewer.detached = true;
    job.subscribers.delete(viewer);
    noteSubscriberDetached(job);
    assert.notEqual(job.graceTimer, null, 'grace armed on last leave');
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(job.dying, true, 'cancelled after grace');
    // Settle: the abort rejects the hanging fetch -> fail -> finally. The
    // registry is removed synchronously by cancel(), so wait for `settled`
    // (slot release + temp cleanup happen in the finally).
    const t0 = Date.now();
    while (!job.settled && Date.now() - t0 < 5000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(job.settled, true, 'teardown ran to completion');
    assert.equal(hasLiveRemuxJob(vid), false, 'registry cleaned');
    assert.equal(getRemuxSlotStats().active, baseline, 'slot released exactly once');
    const dir = mediaCacheDir();
    for (const suffix of ['ts.part', 'live.spool', 'part.mp4']) {
      assert.equal(fs.existsSync(path.join(dir, `${vid}.${suffix}`)), false, `no ${suffix} residue`);
    }
  });
});

test('lifecycle 16-17: concurrent creators share one job; dying jobs are never handed out', { timeout: 30000 }, async () => {
  const vid = 99002;
  let fetchCalls = 0;
  const countingFail: (url: string, _signal?: AbortSignal) => Promise<Response> = () => {
    fetchCalls++;
    return failingFetch();
  };
  const a = getOrCreateLiveRemuxJob(abandonSrc(vid, countingFail));
  const b = getOrCreateLiveRemuxJob(abandonSrc(vid, countingFail));
  assert.equal(a, b, 'second creator joins the same job (no duplicate upstream work)');
  // Let it fail fast on the 500 (no viewers ever attach).
  const t0 = Date.now();
  while (hasLiveRemuxJob(vid) && Date.now() - t0 < 5000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(fetchCalls, 1, 'exactly one upstream fetch for two creators');
  // Dying-job race: cancel, then create during teardown -> fresh object.
  const c = getOrCreateLiveRemuxJob(abandonSrc(vid, countingFail));
  cancelLiveRemuxJob(c, 'test-race');
  assert.equal(c.dying, true);
  const d = getOrCreateLiveRemuxJob(abandonSrc(vid, countingFail));
  assert.notEqual(d, c, 'a dying job is never handed out; a fresh job is created');
  assert.equal(d.dying, false);
  const t1 = Date.now();
  while (hasLiveRemuxJob(vid) && Date.now() - t1 < 5000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(hasLiveRemuxJob(vid), false, 'teardown complete, registry clean');
  assert.ok(getRemuxSlotStats().active >= 0, 'slot counter never negative');
});

test('lifecycle 12-13: error path releases the slot exactly once (pool stays healthy)', { timeout: 30000 }, async () => {
  const vid = 99003;
  const baseline = getRemuxSlotStats().active;
  getOrCreateLiveRemuxJob(abandonSrc(vid, failingFetch));
  const t0 = Date.now();
  while (hasLiveRemuxJob(vid) && Date.now() - t0 < 5000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(getRemuxSlotStats().active, baseline, 'failed job released its slot exactly once');
});

// ---------------------------------------------------------------------------
// Bug 6: orphaned temp cleanup
// ---------------------------------------------------------------------------
test('cleanupOrphanedTempFiles: removes only temp files, keeps caches', async () => {
  const dir = mediaCacheDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '4242.ts.part'), 'junk');
  fs.writeFileSync(path.join(dir, '4243.part.mp4'), 'junk');
  fs.writeFileSync(path.join(dir, '4244.live.spool'), 'junk');
  fs.writeFileSync(path.join(dir, '4242.mp4'), 'real-cache');
  fs.writeFileSync(path.join(dir, '4242.json'), '{}');
  await cleanupOrphanedTempFiles();
  assert.equal(fs.existsSync(path.join(dir, '4242.ts.part')), false, '.ts.part removed');
  assert.equal(fs.existsSync(path.join(dir, '4243.part.mp4')), false, '.part.mp4 removed');
  assert.equal(fs.existsSync(path.join(dir, '4244.live.spool')), false, '.live.spool removed');
  assert.equal(fs.existsSync(path.join(dir, '4242.mp4')), true, 'cache untouched');
  assert.equal(fs.existsSync(path.join(dir, '4242.json')), true, 'sidecar untouched');
});

// ---------------------------------------------------------------------------
// P1-A: spool reader model — one read stream per frontier advance, shared
// nothing between viewers, every viewer sees identical bytes, streams close.
// (Measured: 15 MB live output serves 2 viewers with ~16 streams total —
// one per fragment advance each. No reader rewrite justified.)
// ---------------------------------------------------------------------------
test('P1-A: concurrent viewers receive byte-identical spool content', async () => {
  const spoolPath = path.join(tmpRoot, 'p1a-spool.bin');
  const payload = Buffer.concat([Buffer.from('INIT'), Buffer.alloc(9996, 0x61)]);
  await fs.promises.writeFile(spoolPath, payload);
  const drain = async () => {
    const job = fakeLiveJob(payload.subarray(0, 4));
    job.spoolPath = spoolPath;
    job.spoolBytes = payload.length;
    job.liveEnded = true;
    const res = createLiveResponse(job, null, new AbortController().signal);
    return Buffer.from(await res.arrayBuffer());
  };
  const [a, b] = await Promise.all([drain(), drain()]);
  assert.ok(a.equals(payload), 'viewer 1 exact');
  assert.ok(b.equals(payload), 'viewer 2 exact, independent reader');
});

test('P1-A: one read stream per frontier advance (bounded, no duplicates)', async () => {
  const spoolPath = path.join(tmpRoot, 'p1a-growth-spool.bin');
  const init = Buffer.from('INIT');
  await fs.promises.writeFile(spoolPath, init);
  const job = fakeLiveJob(init);
  job.spoolPath = spoolPath;
  job.spoolBytes = init.length;

  // Count spool read streams; restore afterwards (file runs sequentially).
  const fsMod = fs as unknown as { createReadStream: typeof fs.createReadStream };
  const orig = fsMod.createReadStream;
  let streams = 0;
  fsMod.createReadStream = ((p: unknown, o: unknown) => {
    if (String(p) === spoolPath) streams++;
    return (orig as (...a: never[]) => fs.ReadStream)(p as never, o as never);
  }) as typeof fs.createReadStream;
  try {
    const received: Buffer[] = [];
    const res = createLiveResponse(job, null, new AbortController().signal);
    const reader = res.body!.getReader();
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received.push(Buffer.from(value));
      }
    })();
    const receivedBytes = () => received.reduce((n, c) => n + c.length, 0);
    // Three sequential growth spurts; each is consumed before the next, so
    // the viewer opens exactly one stream per spurt (+1 for the initial).
    let expected = init.length;
    for (let i = 0; i < 3; i++) {
      const chunk = Buffer.alloc(50, 0x61 + i);
      await fs.promises.appendFile(spoolPath, chunk);
      job.spoolBytes += chunk.length;
      expected += chunk.length;
      // Notify until consumed (a notify that lands before parking is lost
      // by design; the waiter re-arms, so retrying is the correct driver).
      const deadline = Date.now() + 2000;
      wakeSpoolWaiters(job);
      for (const sub of job.subscribers) sub.notify();
      while (receivedBytes() < expected && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
        wakeSpoolWaiters(job);
        for (const sub of job.subscribers) sub.notify();
      }
      assert.equal(receivedBytes(), expected, `spurt ${i} fully consumed`);
    }
    job.liveEnded = true;
    wakeSpoolWaiters(job);
    for (const sub of job.subscribers) sub.notify();
    await pump;
    const full = Buffer.concat(received);
    assert.equal(full.length, expected);
    assert.ok(full.subarray(0, 4).equals(init), 'init first');
    assert.equal(streams, 4, `exactly one stream per advance (1 initial + 3 spurts), got ${streams}`);
    assert.equal(job.subscribers.size, 0, 'viewer detached at end');
  } finally {
    fsMod.createReadStream = orig;
  }
});

// ---------------------------------------------------------------------------
// P1-B: sidecar atomicity — readers never observe a partial document.
// ---------------------------------------------------------------------------
test('P1-B: writeSidecarAtomic round-trips exact JSON with no residue', async () => {
  const dir = mediaCacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const { sidecarPath } = remuxCachePaths(9001);
  const value = { megaNodeId: 'n', sourceSize: 10, outputSize: 20, lastAccessedAt: new Date().toISOString() };
  await writeSidecarAtomic(sidecarPath, value);
  assert.deepEqual(JSON.parse(fs.readFileSync(sidecarPath, 'utf8')), value);
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')).length, 0, 'no temp residue');
  fs.rmSync(sidecarPath, { force: true });
});

test('P1-B: truncated sidecar / missing sidecar -> cache miss (never corrupt serve)', async () => {
  const dir = mediaCacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const { mp4Path, sidecarPath } = remuxCachePaths(9002);
  const bytes = Buffer.from('fake-mp4');
  fs.writeFileSync(mp4Path, bytes);
  fs.writeFileSync(sidecarPath, '{"megaNodeId": "n", "sourceSize":'); // crash mid-write shape
  assert.equal(await readRemuxCache(9002, 'n', bytes.length), null, 'partial sidecar is a miss, not a serve');
  fs.rmSync(sidecarPath, { force: true });
  assert.equal(await readRemuxCache(9002, 'n', bytes.length), null, 'missing sidecar is a miss');
  fs.rmSync(mp4Path, { force: true });
});

// ---------------------------------------------------------------------------
// P1-C: temp budget admission + usage accounting.
// ---------------------------------------------------------------------------
test('P1-C: checkMediaTempBudget fails fast only under real pressure', async () => {
  const prev = process.env.MEDIA_TEMP_MAX_BYTES;
  try {
    delete process.env.MEDIA_TEMP_MAX_BYTES;
    assert.doesNotThrow(() => checkMediaTempBudget(100 * 1024 * 1024), 'default budget admits normal jobs');
    process.env.MEDIA_TEMP_MAX_BYTES = '1';
    assert.throws(() => checkMediaTempBudget(100 * 1024 * 1024), MediaTempBudgetError, 'tiny budget refuses a 100MB job');
    assert.throws(() => checkMediaTempBudget(100 * 1024 * 1024), /temporary media budget exhausted/);
    assert.equal(new MediaTempBudgetError().name, 'MediaTempBudgetError');
  } finally {
    if (prev === undefined) delete process.env.MEDIA_TEMP_MAX_BYTES;
    else process.env.MEDIA_TEMP_MAX_BYTES = prev;
  }
});

test('P1-C: mediaTempUsage counts only temp files', async () => {
  const dir = mediaCacheDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '9101.ts.part'), Buffer.alloc(100));
  fs.writeFileSync(path.join(dir, '9101.live.spool'), Buffer.alloc(50));
  fs.writeFileSync(path.join(dir, '9101.mp4'), Buffer.alloc(1000));
  fs.writeFileSync(path.join(dir, '9101.json'), '{}');
  const usage = mediaTempUsage();
  assert.equal(usage.bytes, 150, 'only temps counted');
  assert.equal(usage.files, 2);
  fs.rmSync(path.join(dir, '9101.ts.part'), { force: true });
  fs.rmSync(path.join(dir, '9101.live.spool'), { force: true });
  fs.rmSync(path.join(dir, '9101.mp4'), { force: true });
  fs.rmSync(path.join(dir, '9101.json'), { force: true });
});
