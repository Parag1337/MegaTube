/**
 * Exact MP4 video-track sample table for bounded sparse acquisition.
 *
 * The sparse-MP4 source path fetches a head/tail chunk that is known to
 * contain the moov index, then fetches bounded media windows at ABSOLUTE
 * offsets. ffmpeg input-seeking uses the moov sample table (stts/stsc/stsz/
 * stco) to jump to the keyframe for a requested timestamp. If the acquired
 * windows are placed by a linear time→byte guess instead of that index, the
 * keyframe ffmpeg seeks to typically lies OUTSIDE the acquired ranges; the
 * holes between ranges read as zeros, and libopenh264 fails with
 * "Error submitting packet to decoder" (process exit 69). This module parses
 * the sample table so the acquisition can request exactly the bytes ffmpeg
 * will read: the keyframe at/before each scene target through the sample
 * covering the scene's end.
 *
 * The parser is deliberately conservative: any malformed or unexpected byte
 * layout returns `null`, and callers fall back to the previous linear-window
 * behaviour. Nothing here is trusted for anything except offset selection.
 *
 * Box layout knowledge is intentionally limited to what MP4/M4V/MOV demuxers
 * write in practice:
 *   - 32-bit box sizes, `largesize` (size == 1) 64-bit boxes, size == 0
 *     ("to end of file");
 *   - stts (sample_count, sample_delta), ctts is parsed only for shape
 *     validation and otherwise ignored;
 *   - stss (1-based keyframe sample numbers; absent ⇒ every sample sync);
 *   - stsz with either a constant sample_size or a per-sample table;
 *   - stsc (first_chunk, samples_per_chunk, sample_description_index);
 *   - stco (32-bit chunk offsets) and co64 (64-bit chunk offsets);
 *   - mdhd v0 (32-bit) and v1 (64-bit) timescale.
 */

import type { MoovLocation } from './mp4-index';

export interface VideoTrackIndex {
  /** mdhd timescale of the video track. */
  timescale: number;
  /** Codec fourcc from the video stsd entry (diagnostic only). */
  codec: string | null;
  /** Total video samples (== stsz entry count). */
  sampleCount: number;
  /** DTS of each sample in mdhd ticks (non-decreasing). */
  sampleTimes: number[];
  /** Byte size of each sample (from stsz). */
  sampleSizes: number[];
  /** Absolute file offset of each sample (from stco/co64 + stsc + stsz). */
  sampleOffsets: number[];
  /** Zero-based indices of sync (keyframe) samples. Empty ⇒ all sync. */
  keyframes: number[];
  /** Track duration in mdhd ticks (cumulative stts). */
  durationTicks: number;
}

interface Box {
  start: number;
  size: number;
  type: string;
  /** Offset of this box's payload (after size+type[+largesize]). */
  payload: number;
}

/**
 * Sequential box walk over [start, end). Returns the boxes in order; stops at
 * the first malformed/truncated box. Offsets are buffer-relative.
 */
function walkBoxes(buf: Buffer, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let off = start;
  while (off + 8 <= end) {
    const size32 = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (size32 === 1) {
      if (off + 16 > end) break;
      const big = Number(buf.readBigUInt64BE(off + 8));
      if (!Number.isSafeInteger(big) || big < 16) break;
      boxes.push({ start: off, size: big, type, payload: off + 16 });
      off += big;
      continue;
    }
    if (size32 === 0) {
      // "to end of file" — legal only as the last box; stop after recording.
      boxes.push({ start: off, size: end - off, type, payload: off + 8 });
      break;
    }
    if (size32 < 8 || off + size32 > end) break;
    boxes.push({ start: off, size: size32, type, payload: off + 8 });
    off += size32;
  }
  return boxes;
}

/** First direct child box of `type` inside [start, end), or null. */
function child(buf: Buffer, start: number, end: number, type: string): Box | null {
  for (const box of walkBoxes(buf, start, end)) {
    if (box.type === type) return box;
  }
  return null;
}

function findBox(buf: Buffer, start: number, end: number, type: string, depth = 0): Box | null {
  for (const box of walkBoxes(buf, start, end)) {
    if (box.type === type) return box;
    // Container boxes we descend into; anything else is opaque.
    if (
      depth < 4 &&
      (box.type === 'moov' || box.type === 'trak' || box.type === 'mdia' || box.type === 'minf' || box.type === 'stbl' || box.type === 'edts' || box.type === 'udta')
    ) {
      const found = findBox(buf, box.payload, box.start + box.size, type, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function readBoxChildren(buf: Buffer, box: Box): Box[] {
  return walkBoxes(buf, box.payload, box.start + box.size);
}

function readFullBoxU32(buf: Buffer, box: Box, offsetFromPayload: number): number | null {
  const at = box.payload + offsetFromPayload;
  if (at + 4 > box.start + box.size) return null;
  return buf.readUInt32BE(at);
}

/** Parse mdhd (v0/v1) → { timescale }. Returns null on truncation. */
function parseMdhd(buf: Buffer, mdhd: Box): { timescale: number } | null {
  const base = mdhd.start;
  const end = mdhd.start + mdhd.size;
  if (base + 12 > end) return null;
  const version = buf.readUInt8(base + 8);
  if (version === 1) {
    if (base + 36 > end) return null;
    const timescale = buf.readUInt32BE(base + 28);
    return timescale > 0 ? { timescale } : null;
  }
  if (version === 0) {
    if (base + 28 > end) return null;
    const timescale = buf.readUInt32BE(base + 20);
    return timescale > 0 ? { timescale } : null;
  }
  return null;
}

/** Parse stsd → first entry's fourcc (diagnostic only). */
function parseStsdCodec(buf: Buffer, stsd: Box): string | null {
  const at = stsd.payload + 8; // skip version/flags + entry_count
  if (at + 8 > stsd.start + stsd.size) return null;
  const entrySize = buf.readUInt32BE(at);
  if (entrySize < 8 || at + entrySize > stsd.start + stsd.size) return null;
  const fourcc = buf.toString('latin1', at + 4, at + 8);
  return /^[ -~]{4}$/.test(fourcc) ? fourcc : null;
}

/** Parse stts → { times, durationTicks }. Expansion is O(samples). */
function parseStts(buf: Buffer, stts: Box): { times: number[]; durationTicks: number } | null {
  const countPos = stts.payload + 4; // version/flags, then entry_count
  if (countPos + 4 > stts.start + stts.size) return null;
  const entryCount = buf.readUInt32BE(countPos);
  let off = countPos + 4;
  const times: number[] = [];
  let t = 0;
  for (let i = 0; i < entryCount; i++) {
    if (off + 8 > stts.start + stts.size) return null;
    const sampleCount = buf.readUInt32BE(off);
    const sampleDelta = buf.readUInt32BE(off + 4);
    off += 8;
    if (sampleDelta === 0 && sampleCount > 0) return null;
    if (times.length + sampleCount > 10_000_000) return null; // sanity bound
    for (let s = 0; s < sampleCount; s++) {
      times.push(t);
      t += sampleDelta;
    }
  }
  return { times, durationTicks: t };
}

/** Parse ctts for shape validation only (values carry B-frame reorder). */
function parseCtts(buf: Buffer, ctts: Box): boolean {
  const countPos = ctts.payload + 4;
  if (countPos + 4 > ctts.start + ctts.size) return false;
  const entryCount = buf.readUInt32BE(countPos);
  if ((entryCount * 8) + 8 > ctts.size) return false;
  return true;
}

/** Parse stss → zero-based keyframe sample indices (ascending). */
function parseStss(buf: Buffer, stss: Box): number[] | null {
  const countPos = stss.payload + 4;
  if (countPos + 4 > stss.start + stss.size) return null;
  const count = buf.readUInt32BE(countPos);
  if (count > 10_000_000) return null;
  let off = countPos + 4;
  if (off + count * 4 > stss.start + stss.size) return null;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const sampleNumber = buf.readUInt32BE(off);
    off += 4;
    if (sampleNumber === 0) return null;
    out.push(sampleNumber - 1);
  }
  return out;
}

/** Parse stsz → { sizes } (per-sample or constant sample_size). */
function parseStsz(buf: Buffer, stsz: Box): number[] | null {
  const sampleSize = readFullBoxU32(buf, stsz, 4);
  const entryCount = readFullBoxU32(buf, stsz, 8);
  if (sampleSize === null || entryCount === null) return null;
  if (entryCount > 10_000_000) return null;
  if (sampleSize !== 0) {
    return new Array(entryCount).fill(sampleSize);
  }
  let off = stsz.payload + 12;
  if (off + entryCount * 4 > stsz.start + stsz.size) return null;
  const sizes: number[] = new Array(entryCount);
  for (let i = 0; i < entryCount; i++) {
    sizes[i] = buf.readUInt32BE(off);
    off += 4;
  }
  return sizes;
}

/** Parse stsc → entries [firstChunk, samplesPerChunk, sampleDescriptionIndex]. */
function parseStsc(buf: Buffer, stsc: Box): Array<[number, number, number]> | null {
  const countPos = stsc.payload + 4;
  if (countPos + 4 > stsc.start + stsc.size) return null;
  const count = buf.readUInt32BE(countPos);
  if (count > 10_000_000) return null;
  let off = countPos + 4;
  if (off + count * 12 > stsc.start + stsc.size) return null;
  const entries: Array<[number, number, number]> = [];
  for (let i = 0; i < count; i++) {
    const firstChunk = buf.readUInt32BE(off);
    const samplesPerChunk = buf.readUInt32BE(off + 4);
    const sdi = buf.readUInt32BE(off + 8);
    off += 12;
    if (firstChunk === 0 || samplesPerChunk === 0) return null;
    entries.push([firstChunk, samplesPerChunk, sdi]);
  }
  return entries;
}

/** Parse stco (32-bit) or co64 (64-bit) chunk offsets. */
function parseChunkOffsets(buf: Buffer, stco: Box | null, co64: Box | null): number[] | null {
  if (stco) {
    const countPos = stco.payload + 4;
    if (countPos + 4 > stco.start + stco.size) return null;
    const count = buf.readUInt32BE(countPos);
    if (count > 10_000_000) return null;
    let off = countPos + 4;
    if (off + count * 4 > stco.start + stco.size) return null;
    const out: number[] = new Array(count);
    for (let i = 0; i < count; i++) {
      out[i] = buf.readUInt32BE(off);
      off += 4;
    }
    return out;
  }
  if (co64) {
    const countPos = co64.payload + 4;
    if (countPos + 4 > co64.start + co64.size) return null;
    const count = buf.readUInt32BE(countPos);
    if (count > 10_000_000) return null;
    let off = countPos + 4;
    if (off + count * 8 > co64.start + co64.size) return null;
    const out: number[] = new Array(count);
    for (let i = 0; i < count; i++) {
      const big = buf.readBigUInt64BE(off);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      out[i] = Number(big);
      off += 8;
    }
    return out;
  }
  return null;
}

/**
 * Expand the chunk table: absolute offset per sample, in sample index order.
 * Expansion follows stsc's run-length encoding of samples-per-chunk.
 */
function expandSampleOffsets(
  sizes: number[],
  chunkOffsets: number[],
  stsc: Array<[number, number, number]>,
): number[] | null {
  const offsets: number[] = new Array(sizes.length);
  let sample = 0;
  for (let e = 0; e < stsc.length; e++) {
    const [firstChunk, samplesPerChunk] = stsc[e];
    const nextFirst = e + 1 < stsc.length ? stsc[e + 1][0] : chunkOffsets.length + 1;
    for (let chunk = firstChunk - 1; chunk < nextFirst - 1; chunk++) {
      if (chunk < 0 || chunk >= chunkOffsets.length) return null;
      let off = chunkOffsets[chunk];
      for (let s = 0; s < samplesPerChunk; s++) {
        if (sample >= sizes.length) return null;
        offsets[sample] = off;
        off += sizes[sample];
        sample += 1;
      }
    }
  }
  if (sample !== sizes.length) return null;
  return offsets;
}

/**
 * Parse the first video track's sample table from a complete moov chunk.
 * `buf`/`baseOffset` follow the findMoovInChunk convention: `moov.start` is an
 * absolute offset and `baseOffset` maps buffer index 0 to it.
 */
export function parseMp4VideoTrack(
  buf: Buffer,
  moov: MoovLocation,
  baseOffset = 0,
): VideoTrackIndex | null {
  if (!moov.complete) return null;
  const moovStart = moov.start - baseOffset;
  const moovEnd = moov.end - baseOffset;
  if (moovStart < 0 || moovEnd > buf.length || moovEnd - moovStart < 16) return null;

  for (const trak of walkBoxes(buf, moovStart + 8, moovEnd)) {
    if (trak.type !== 'trak') continue;
    const trakEnd = trak.start + trak.size;
    const hdlr = findBox(buf, trak.payload, trakEnd, 'hdlr', 1);
    if (!hdlr) continue;
    // handler_type sits after version/flags + pre_defined.
    const handlerAt = hdlr.payload + 8;
    if (handlerAt + 4 > buf.length) continue;
    const handler = buf.toString('latin1', handlerAt, handlerAt + 4);
    if (handler !== 'vide') continue;

    const mdia = child(buf, trak.payload, trakEnd, 'mdia');
    if (!mdia) return null;
    const mdiaEnd = mdia.start + mdia.size;
    const mdhd = child(buf, mdia.payload, mdiaEnd, 'mdhd');
    if (!mdhd) return null;
    const mdhdInfo = parseMdhd(buf, mdhd);
    if (!mdhdInfo) return null;

    const minf = child(buf, mdia.payload, mdiaEnd, 'minf');
    if (!minf) return null;
    const minfEnd = minf.start + minf.size;
    const stbl = child(buf, minf.payload, minfEnd, 'stbl');
    if (!stbl) return null;
    const stblEnd = stbl.start + stbl.size;

    const sttsBox = child(buf, stbl.payload, stblEnd, 'stts');
    const stszBox = child(buf, stbl.payload, stblEnd, 'stsz');
    const stscBox = child(buf, stbl.payload, stblEnd, 'stsc');
    const stcoBox = child(buf, stbl.payload, stblEnd, 'stco');
    const co64Box = child(buf, stbl.payload, stblEnd, 'co64');
    const stssBox = child(buf, stbl.payload, stblEnd, 'stss');
    const stsdBox = child(buf, stbl.payload, stblEnd, 'stsd');
    const cttsBox = child(buf, stbl.payload, stblEnd, 'ctts');
    if (!sttsBox || !stszBox || !stscBox) return null;
    if (cttsBox && !parseCtts(buf, cttsBox)) return null;

    const stts = parseStts(buf, sttsBox);
    if (!stts) return null;
    const sizes = parseStsz(buf, stszBox);
    if (!sizes) return null;
    if (stts.times.length !== sizes.length) return null;
    const stsc = parseStsc(buf, stscBox);
    if (!stsc) return null;
    const chunkOffsets = parseChunkOffsets(buf, stcoBox, co64Box);
    if (!chunkOffsets) return null;
    const offsets = expandSampleOffsets(sizes, chunkOffsets, stsc);
    if (!offsets) return null;
    const keyframes = stssBox ? parseStss(buf, stssBox) : [];
    if (!keyframes) return null;
    const badKeyframe = keyframes.find((i) => i < 0 || i >= sizes.length);
    if (badKeyframe !== undefined) return null;

    return {
      timescale: mdhdInfo.timescale,
      codec: stsdBox ? parseStsdCodec(buf, stsdBox) : null,
      sampleCount: sizes.length,
      sampleTimes: stts.times,
      sampleSizes: sizes,
      sampleOffsets: offsets,
      keyframes,
      durationTicks: stts.durationTicks,
    };
  }
  return null;
}

/**
 * Binary search: greatest sample index whose DTS ≤ `timeSec`, or null when
 * the time is before the first sample.
 */
export function keyframeAtOrBefore(index: VideoTrackIndex, timeSec: number): number | null {
  if (!(timeSec >= 0) || index.sampleCount === 0) return null;
  const targetTicks = timeSec * index.timescale;
  let lo = 0;
  let hi = index.sampleCount - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (index.sampleTimes[mid] <= targetTicks) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (ans < 0) return null;
  if (index.keyframes.length === 0) return ans; // every sample is sync
  // Greatest keyframe ≤ ans (keyframes are ascending).
  let kLo = 0;
  let kHi = index.keyframes.length - 1;
  let kAns = -1;
  while (kLo <= kHi) {
    const mid = (kLo + kHi) >> 1;
    if (index.keyframes[mid] <= ans) {
      kAns = index.keyframes[mid];
      kLo = mid + 1;
    } else {
      kHi = mid - 1;
    }
  }
  return kAns >= 0 ? kAns : null;
}

/** Smallest sample index whose DTS ≥ `timeSec`, or null when out of range. */
export function sampleAtOrAfter(index: VideoTrackIndex, timeSec: number): number | null {
  if (index.sampleCount === 0) return null;
  const targetTicks = timeSec * index.timescale;
  let lo = 0;
  let hi = index.sampleCount - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (index.sampleTimes[mid] >= targetTicks) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans >= 0 ? ans : null;
}

export interface ExactWindow {
  byteStart: number;
  byteLen: number;
}

/** Align n down to `align` (align must be a power of two or 16). */
function alignDown16(n: number): number {
  return Math.floor(n / 16) * 16;
}

/**
 * Build the absolute byte window ffmpeg will actually read for one scene:
 * from the keyframe at/before the scene target through the sample covering
 * the scene's end (+B-frame slack). Returns null when the index cannot cover
 * the scene (caller falls back to the linear window for that scene).
 *
 * `padSec` covers decode-tail overshoot and B-frame CTS reordering; the
 * result is clamped to [0, totalSize) and to `perWindowMax` bytes.
 */
export function exactWindowForScene(
  index: VideoTrackIndex,
  scene: { startSec: number; durationSec: number },
  totalSize: number,
  perWindowMax: number,
  padSec = 2,
): ExactWindow | null {
  const kf = keyframeAtOrBefore(index, scene.startSec);
  if (kf === null) return null;
  const endTime = scene.startSec + Math.max(0.2, scene.durationSec) + Math.max(0, padSec);
  const endIdx = sampleAtOrAfter(index, endTime);
  const startAbs = alignDown16(index.sampleOffsets[kf]);
  let endAbs: number;
  if (endIdx !== null) {
    endAbs = index.sampleOffsets[endIdx] + index.sampleSizes[endIdx];
  } else {
    endAbs = totalSize; // through end of file
  }
  // Small trailing slack so odd edit lists / CTS reorder cannot clip the last frame.
  endAbs = Math.min(totalSize, endAbs + 64 * 1024);
  if (endAbs <= startAbs) return null;
  let len = Math.min(endAbs - startAbs, perWindowMax);
  if (len <= 0) return null;
  // Floor: never return a micro-window; a scene needs at least this much.
  // The cap always wins — a window must never exceed its byte budget.
  const minLen = Math.min(256 * 1024, totalSize);
  if (len < minLen && minLen <= perWindowMax) len = Math.min(minLen, totalSize - startAbs);
  return { byteStart: startAbs, byteLen: len };
}
