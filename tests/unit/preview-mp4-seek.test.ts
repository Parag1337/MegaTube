/**
 * Regression tests for the exact MP4 sample-table acquisition (P1 fix for
 * the "exit 69: Error submitting packet to decoder" failures).
 *
 * Root cause under test: sparse-MP4 acquisition placed byte windows by a
 * linear time→byte guess; for variable-bitrate sources the keyframes ffmpeg
 * seeks to lie outside the acquired ranges, the holes decode as zeros, and
 * libopenh264 aborts. These tests pin the parser and the exact-window math
 * against synthetic-but-structurally-valid sample tables.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMp4VideoTrack,
  keyframeAtOrBefore,
  sampleAtOrAfter,
  exactWindowForScene,
} from '@/lib/preview/mp4-seek';
import { findMoovInChunk } from '@/lib/preview/mp4-index';

/** Build a box: size(4) + type(4) + payload. */
function box(type: string, payload: Buffer): Buffer {
  const size = 8 + payload.length;
  const out = Buffer.alloc(size);
  out.writeUInt32BE(size, 0);
  out.write(type, 4, 'latin1');
  payload.copy(out, 8);
  return out;
}

function fullBox(type: string, version: number, flags: number, payload: Buffer): Buffer {
  const vf = Buffer.alloc(4);
  vf.writeUInt32BE(((version & 0xff) << 24) | (flags & 0xffffff), 0);
  return box(type, Buffer.concat([vf, payload]));
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}
function u64(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(n, 0);
  return b;
}

interface TableOptions {
  /** mdhd timescale of the video track. */
  timescale: number;
  /** Per-sample durations in ticks (constant deltas for stts; must be uniform count). */
  delta: number;
  sampleCount: number;
  /** 1-based keyframe sample numbers. */
  keyframes: number[];
  /** Constant sample size (stsz constant mode). When set, sampleSizes is ignored. */
  constantSize?: number;
  sampleSizes?: number[];
  /** Chunk offset table: array of absolute chunk offsets; samples are packed sequentially. */
  chunkOffsets: number[];
  /** samples_per_chunk per chunk (stsc run-length entries must expand to exactly chunkOffsets.length chunks). */
  samplesPerChunk: number[];
  codec?: string;
  co64?: boolean;
}

/**
 * Assemble a minimal but structurally valid MP4 buffer:
 *   ftyp + moov(mvhd, trak(mdia(mdhd, hdlr vide, minf(stbl(stsd, stts, stss, stsc, stsz, stco|co64)))))
 */
function buildMp4(opts: TableOptions): Buffer {
  const codec = opts.codec ?? 'avc1';
  const { timescale, delta, sampleCount, chunkOffsets, samplesPerChunk } = opts;

  const mdhdPayload = Buffer.concat([
    u32(0), // creation
    u32(0), // modification
    u32(timescale),
    u32(sampleCount * delta),
  ]);
  const mdhd = fullBox('mdhd', 0, 0, mdhdPayload);

  const hdlrPayload = Buffer.concat([
    Buffer.alloc(4), // pre_defined
    Buffer.from('vide', 'latin1'),
  ]);
  const hdlr = fullBox('hdlr', 0, 0, hdlrPayload);

  // stsd: one avc1 entry with 60 bytes of codec config
  const entryPayload = Buffer.concat([
    Buffer.alloc(8), // reserved + data reference index
    Buffer.from(codec, 'latin1'),
    Buffer.alloc(60, 0),
  ]);
  const entrySize = 8 + entryPayload.length;
  const entryBuf = Buffer.alloc(entrySize);
  entryBuf.writeUInt32BE(entrySize, 0);
  entryBuf.write(codec, 4, 'latin1');
  entryPayload.copy(entryBuf, 8);
  const stsd = fullBox('stsd', 0, 0, Buffer.concat([u32(1), entryBuf]));

  // stts: one entry (sampleCount × delta)
  const stts = fullBox('stts', 0, 0, Buffer.concat([u32(1), u32(sampleCount), u32(delta)]));

  // stss: 1-based keyframes (omitted when empty → all samples sync)
  const stss = opts.keyframes.length
    ? fullBox('stss', 0, 0, Buffer.concat([u32(opts.keyframes.length), ...opts.keyframes.map(u32)]))
    : undefined;

  // stsz: constant or per-sample
  const sizes = opts.constantSize !== undefined
    ? null
    : (opts.sampleSizes ?? new Array(sampleCount).fill(500));
  const stsz = opts.constantSize !== undefined
    ? fullBox('stsz', 0, 0, Buffer.concat([u32(opts.constantSize), u32(sampleCount)]))
    : fullBox('stsz', 0, 0, Buffer.concat([u32(0), u32(sampleCount), ...(sizes as number[]).map(u32)]));

  // stsc: run-length of samples_per_chunk across chunk ranges
  const stscEntries: Array<[number, number]> = [];
  {
    let idx = 0;
    for (let e = 0; e < samplesPerChunk.length; e++) {
      const spc = samplesPerChunk[e];
      stscEntries.push([idx + 1, spc]);
      idx += 1;
    }
  }
  const stsc = fullBox(
    'stsc',
    0,
    0,
    Buffer.concat([u32(stscEntries.length), ...stscEntries.flatMap(([firstChunk, spc]) => [u32(firstChunk), u32(spc), u32(1)])]),
  );

  // stco / co64
  const stco = opts.co64
    ? fullBox('co64', 0, 0, Buffer.concat([u32(chunkOffsets.length), ...chunkOffsets.map((o) => u64(BigInt(o)))]))
    : fullBox('stco', 0, 0, Buffer.concat([u32(chunkOffsets.length), ...chunkOffsets.map(u32)]));

  const stblChildren = [stsd, stts, ...(stss ? [stss] : []), stsc, stsz, stco];
  const stbl = box('stbl', Buffer.concat(stblChildren));
  const minf = box('minf', stbl);
  const mdia = box('mdia', Buffer.concat([mdhd, hdlr, minf]));
  const trak = box('trak', mdia);
  const mvhd = fullBox('mvhd', 0, 0, Buffer.concat([u32(0), u32(0), u32(timescale), u32(sampleCount * delta)]));
  const moov = box('moov', Buffer.concat([mvhd, trak]));

  const ftyp = box('ftyp', Buffer.concat([Buffer.from('isom', 'latin1'), u32(0), Buffer.from('isomiso2avc1mp41', 'latin1')]));
  return Buffer.concat([ftyp, moov]);
}

function trakIndexOf(buf: Buffer) {
  const moov = findMoovInChunk(buf, 0, buf.length);
  assert.ok(moov, 'moov locatable in synthetic file');
  const idx = parseMp4VideoTrack(buf, moov, 0);
  assert.ok(idx, 'video track parses');
  return idx;
}

const baseOpts: TableOptions = {
  timescale: 1000,
  delta: 40, // 25 fps
  sampleCount: 30,
  keyframes: [1, 11, 21], // 1-based → 0-based 0, 10, 20
  chunkOffsets: [0x1000],
  samplesPerChunk: [30],
  sampleSizes: new Array(30).fill(500),
};

test('parseMp4VideoTrack: timescale, sizes, offsets, keyframes, codec', () => {
  const idx = trakIndexOf(buildMp4(baseOpts));
  assert.equal(idx.timescale, 1000);
  assert.equal(idx.sampleCount, 30);
  assert.equal(idx.codec, 'avc1');
  assert.deepEqual(idx.keyframes, [0, 10, 20]);
  assert.deepEqual(idx.sampleOffsets.slice(0, 3), [0x1000, 0x1000 + 500, 0x1000 + 1000]);
  assert.equal(idx.sampleOffsets[29], 0x1000 + 29 * 500);
  assert.deepEqual(idx.sampleTimes.slice(0, 4), [0, 40, 80, 120]);
  assert.equal(idx.durationTicks, 1200);
});

test('parseMp4VideoTrack: constant stsz sample_size and co64 offsets', () => {
  const idx = trakIndexOf(buildMp4({ ...baseOpts, constantSize: 500, chunkOffsets: [0x40000000 + 0x100], co64: true }));
  // co64 value exceeds 2^31; u32 would have wrapped, so this proves the 64-bit path ran.
  assert.equal(idx.sampleOffsets[0], 0x40000000 + 0x100);
  assert.equal(idx.sampleOffsets[29], 0x40000000 + 0x100 + 29 * 500);
});

test('parseMp4VideoTrack: no stss ⇒ every sample is a seek point', () => {
  const idx = trakIndexOf(buildMp4({ ...baseOpts, keyframes: [] }));
  assert.equal(idx.keyframes.length, 0);
  assert.equal(keyframeAtOrBefore(idx, 0.5), 12); // 500 ticks / 40 = sample 12, itself usable
});

test('keyframeAtOrBefore: picks the keyframe at/before the target, never a later one', () => {
  const idx = trakIndexOf(buildMp4(baseOpts));
  // Target 0.5s (500 ticks): samples ≤ 500 ticks end at sample 12; nearest keyframe ≤ 12 is sample 10 (400 ticks).
  assert.equal(keyframeAtOrBefore(idx, 0.5), 10);
  assert.equal(keyframeAtOrBefore(idx, 0), 0);
  assert.equal(keyframeAtOrBefore(idx, 0.4), 10); // exactly at keyframe sample 10's DTS
  assert.equal(keyframeAtOrBefore(idx, 10), 20); // every target maps to the last decodable group
  assert.equal(keyframeAtOrBefore(idx, -1), null);
});

test('sampleAtOrAfter: first sample at/after the target', () => {
  const idx = trakIndexOf(buildMp4(baseOpts));
  assert.equal(sampleAtOrAfter(idx, 0), 0);
  assert.equal(sampleAtOrAfter(idx, 0.04), 1);
  assert.equal(sampleAtOrAfter(idx, 0.041), 2);
  assert.equal(sampleAtOrAfter(idx, 99), null);
});

test('exactWindowForScene: window starts at the keyframe ffmpeg will seek to', () => {
  const idx = trakIndexOf(buildMp4(baseOpts));
  const w = exactWindowForScene(idx, { startSec: 0.5, durationSec: 0.8 }, 0x20000, 10 * 1024 * 1024);
  assert.ok(w);
  assert.equal(w.byteStart, (0x1000 + 10 * 500) & ~0xf);
  // End covers at least the scene: endTime = 0.5 + 0.8 + 2 = 3.3s ⇒ past the last sample ⇒ clamped to EOF.
  assert.equal(w.byteStart + w.byteLen, 0x20000);
});

test('exactWindowForScene: window is capped to perWindowMax', () => {
  const idx = trakIndexOf(buildMp4(baseOpts));
  const cap = 2048;
  const w = exactWindowForScene(idx, { startSec: 0, durationSec: 1.0 }, 0x20000, cap);
  assert.ok(w);
  assert.ok(w.byteLen <= cap);
});

test('exactWindowForScene: never returns a micro-window', () => {
  const idx = trakIndexOf(buildMp4(baseOpts));
  // End is clamped to EOF, so the floor can only stretch to the file size.
  const w = exactWindowForScene(idx, { startSec: 0, durationSec: 0.04 }, 0x20000, 10 * 1024 * 1024);
  assert.ok(w);
  assert.equal(w.byteStart, 0x1000);
  assert.ok(w.byteLen >= Math.min(256 * 1024, 0x20000 - w.byteStart));
});

test('parseMp4VideoTrack: rejects malformed input instead of mis-seeding windows', () => {
  const good = buildMp4(baseOpts);
  // Truncated moov is reported incomplete, never silently "complete garbage"
  const truncated = good.subarray(0, good.length - 200);
  const moovT = findMoovInChunk(truncated, 0, truncated.length);
  assert.ok(moovT === null || moovT.complete === false);
  // stsz sample-count mismatch with stts total
  const badSizes = buildMp4({ ...baseOpts, sampleSizes: new Array(29).fill(500) }); // 29 ≠ 30 times
  const moovB = findMoovInChunk(badSizes, 0, badSizes.length);
  // stts produces 30 times but stsz says 29 samples → parse must refuse
  assert.equal(parseMp4VideoTrack(badSizes, moovB!, 0), null);
  // Garbage buffer
  assert.equal(findMoovInChunk(Buffer.from('not an mp4 at all........'), 0), null);
});
