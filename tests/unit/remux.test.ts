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
  REMUXED_MIME_TYPE,
  createCachedFileResponse,
  createLiveResponse,
  decryptPrefixToBuffer,
  findFragmentedMp4InitEnd,
  mediaCacheDir,
  needsRemuxPlayback,
  patchFragmentedMp4Duration,
  readRemuxCache,
  scanTsPcrDuration,
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
    cache: Promise.resolve(null),
    ready: Promise.resolve(),
    liveEnded: false,
    liveError: null,
    initSegment: init,
    subscribers: new Set(),
    waiters: [],
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
