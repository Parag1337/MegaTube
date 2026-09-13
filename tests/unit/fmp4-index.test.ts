/**
 * Phase 2 unit tests: fMP4 fragment index (lib/media/fmp4-index.ts).
 *
 * Covers the parser/index/resolution/safety contract with synthetic boxes
 * (no MEGA, no ffmpeg): timescale discovery, completion gating (never index
 * a partial moof/mdat), time/byte resolution policy, gap/overlap handling,
 * truncation invalidation, and malformed-box resync.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendSpoolBytes,
  createFmp4Indexer,
  invalidateFromOffset,
  parseTrackTimescales,
  resolveByteToFragment,
  resolveTimeToFragment,
  setIndexerInit,
  type Fmp4Fragment,
} from '@/lib/media/fmp4-index';

// ---------------------------------------------------------------------------
// Synthetic box builders (ISO-BMFF layout mirrors real ffmpeg fMP4 output)
// ---------------------------------------------------------------------------

function box(type: string, payload: Buffer): Buffer {
  const out = Buffer.alloc(8 + payload.length);
  out.writeUInt32BE(8 + payload.length, 0);
  out.write(type, 4, 4, 'latin1');
  payload.copy(out, 8);
  return out;
}

function mdhdBox(timescale: number): Buffer {
  const p = Buffer.alloc(24);
  p[0] = 0; // version 0
  p.writeUInt32BE(0, 4); // creation
  p.writeUInt32BE(0, 8); // modification
  p.writeUInt32BE(timescale, 12);
  return box('mdhd', p);
}

function tkhdBox(trackId: number): Buffer {
  const p = Buffer.alloc(24);
  p[0] = 0; // version 0
  p.writeUInt32BE(0, 4);
  p.writeUInt32BE(0, 8);
  p.writeUInt32BE(trackId, 12);
  return box('tkhd', p);
}

function trakBox(trackId: number, timescale: number): Buffer {
  const mdia = box('mdia', Buffer.concat([mdhdBox(timescale)]));
  return box('trak', Buffer.concat([tkhdBox(trackId), mdia]));
}

function initSegment(tracks: Array<{ id: number; timescale: number }>): Buffer {
  const ftyp = box('ftyp', Buffer.from('isom0000isomiso2', 'latin1'));
  const moov = box('moov', Buffer.concat(tracks.map((t) => trakBox(t.id, t.timescale))));
  return Buffer.concat([ftyp, moov]);
}

function tfhdBox(trackId: number): Buffer {
  const p = Buffer.alloc(12);
  p.writeUInt32BE(0x020038, 0); // version 0 + flags (mirrors ffmpeg)
  p.writeUInt32BE(trackId, 4);
  p.writeUInt32BE(0, 8); // base-data-offset placeholder
  return box('tfhd', p);
}

function tfdtBoxV1(base: number): Buffer {
  const p = Buffer.alloc(12);
  p[0] = 1; // version 1
  const hi = Math.floor(base / 2 ** 32);
  const lo = base % 2 ** 32;
  p.writeUInt32BE(hi, 4);
  p.writeUInt32BE(lo, 8);
  return box('tfdt', p);
}

function mfhdBox(sequence: number): Buffer {
  const p = Buffer.alloc(8);
  p.writeUInt32BE(sequence, 4);
  return box('mfhd', p);
}

function moofBox(sequence: number, trafs: Array<{ trackId: number; base: number }>): Buffer {
  const parts = [mfhdBox(sequence)];
  for (const t of trafs) {
    parts.push(box('traf', Buffer.concat([tfhdBox(t.trackId), tfdtBoxV1(t.base)])));
  }
  return box('moof', Buffer.concat(parts));
}

function mdatBox(size: number): Buffer {
  return box('mdat', Buffer.alloc(Math.max(0, size - 8), 0xab));
}

function indexed(spool: Buffer): ReturnType<typeof appendSpoolBytes> {
  const idx = createFmp4Indexer();
  setIndexerInit(idx, spool.subarray(0, initLen), initLen);
  return appendSpoolBytes(idx, spool.subarray(initLen), initLen);
}

const V_TS = 15360;
const A_TS = 44100;
let initLen = 0;

function twoTrackSpool(): { init: Buffer; spool: Buffer; fragSizes: number[] } {
  const init = initSegment([
    { id: 1, timescale: V_TS },
    { id: 2, timescale: A_TS },
  ]);
  initLen = init.length;
  const moof1 = moofBox(1, [
    { trackId: 1, base: 0 },
    { trackId: 2, base: 0 },
  ]);
  const mdat1 = mdatBox(100);
  const moof2 = moofBox(2, [
    { trackId: 1, base: V_TS }, // 1.0 s video
    { trackId: 2, base: A_TS }, // 1.0 s audio
  ]);
  const mdat2 = mdatBox(120);
  const spool = Buffer.concat([init, moof1, mdat1, moof2, mdat2]);
  return { init, spool, fragSizes: [moof1.length + mdat1.length, moof2.length + mdat2.length] };
}

// ---------------------------------------------------------------------------
// Timescale discovery
// ---------------------------------------------------------------------------

test('parseTrackTimescales: discovers per-track timescales, first trak is video', () => {
  const init = initSegment([
    { id: 1, timescale: V_TS },
    { id: 2, timescale: A_TS },
  ]);
  const { byTrack, videoTrackId } = parseTrackTimescales(init);
  assert.equal(byTrack.get(1), V_TS);
  assert.equal(byTrack.get(2), A_TS);
  assert.equal(videoTrackId, 1);
});

test('parseTrackTimescales: empty map on garbage (fail-closed)', () => {
  const { byTrack, videoTrackId } = parseTrackTimescales(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
  assert.equal(byTrack.size, 0);
  assert.equal(videoTrackId, null);
});

// ---------------------------------------------------------------------------
// Completion gating
// ---------------------------------------------------------------------------

test('index: emits one fragment per complete moof+mdat with video-track time', () => {
  const { init, spool, fragSizes } = twoTrackSpool();
  const idx = createFmp4Indexer();
  setIndexerInit(idx, init, init.length);
  const emitted = appendSpoolBytes(idx, spool.subarray(init.length), init.length);
  assert.equal(emitted.length, 2);
  assert.equal(emitted[0].startTime, 0);
  assert.equal(emitted[0].spoolOffset, init.length);
  assert.equal(emitted[0].size, fragSizes[0]);
  assert.equal(emitted[0].endOffset, init.length + fragSizes[0]);
  assert.equal(emitted[0].sequence, 1);
  assert.equal(emitted[1].startTime, 1);
  assert.equal(emitted[1].spoolOffset, init.length + fragSizes[0]);
  assert.equal(emitted[1].sequence, 2);
});

test('index: partial moof is never emitted', () => {
  const { init, spool } = twoTrackSpool();
  const idx = createFmp4Indexer();
  setIndexerInit(idx, init, init.length);
  const media = spool.subarray(init.length);
  const emitted = appendSpoolBytes(idx, media.subarray(0, 10), init.length);
  assert.equal(emitted.length, 0);
  assert.equal(idx.fragments.length, 0);
});

test('index: complete moof without complete mdat is never emitted', () => {
  const { init, spool } = twoTrackSpool();
  const idx = createFmp4Indexer();
  setIndexerInit(idx, init, init.length);
  const media = spool.subarray(init.length);
  // Feed moof #1 fully + first 9 bytes of its mdat (header + 1 payload byte).
  const moof1End = media.indexOf('mdat') + 4; // end of moof == start of mdat box
  void moof1End;
  const firstMoofLen = (() => {
    const h = media.readUInt32BE(0);
    return h;
  })();
  const emitted = appendSpoolBytes(idx, media.subarray(0, firstMoofLen + 9), init.length);
  assert.equal(emitted.length, 0);
  assert.equal(idx.fragments.length, 0);
  // Completing the mdat emits exactly one fragment.
  const mdatLen = media.readUInt32BE(firstMoofLen);
  const emitted2 = appendSpoolBytes(
    idx,
    media.subarray(firstMoofLen + 9, firstMoofLen + mdatLen),
    init.length + firstMoofLen + 9,
  );
  assert.equal(emitted2.length, 1);
  assert.equal(emitted2[0].spoolOffset, init.length);
});

test('index: split delivery across many small chunks still emits exactly once', () => {
  const { init, spool } = twoTrackSpool();
  const idx = createFmp4Indexer();
  setIndexerInit(idx, init, init.length);
  const media = spool.subarray(init.length);
  let off = 0;
  let total = 0;
  for (let i = 0; i < media.length; i += 7) {
    const piece = media.subarray(i, Math.min(media.length, i + 7));
    total += appendSpoolBytes(idx, piece, init.length + off).length;
    off += piece.length;
  }
  assert.equal(total, 2);
  assert.equal(idx.fragments.length, 2);
});

test('index: duplicate (overlapping) delivery is not double-counted', () => {
  const { init, spool } = twoTrackSpool();
  const idx = createFmp4Indexer();
  setIndexerInit(idx, init, init.length);
  const media = spool.subarray(init.length);
  const first = appendSpoolBytes(idx, media, init.length);
  assert.equal(first.length, 2);
  const dup = appendSpoolBytes(idx, media, init.length);
  assert.equal(dup.length, 0);
  assert.equal(idx.fragments.length, 2);
});

test('index: gap resets the tail parser (never emits across missing bytes)', () => {
  const { init, spool } = twoTrackSpool();
  const idx = createFmp4Indexer();
  setIndexerInit(idx, init, init.length);
  const media = spool.subarray(init.length);
  // Skip 100 bytes in the middle: the parser must not emit a false boundary.
  const head = media.subarray(0, 20);
  assert.deepEqual(appendSpoolBytes(idx, head, init.length), []);
  const afterGap = media.subarray(120);
  const emitted = appendSpoolBytes(idx, afterGap, init.length + 120);
  // Bytes after a gap are unaligned garbage to the parser: no crash, and any
  // emission must still be a real moof+mdat pair at the claimed offsets.
  for (const f of emitted) {
    assert.ok(f.spoolOffset >= init.length + 120);
    assert.ok(f.endOffset > f.spoolOffset);
  }
  void indexed;
});

test('index: corrupt box size (<8) resyncs without throwing or emitting', () => {
  const idx = createFmp4Indexer();
  setIndexerInit(idx, initSegment([{ id: 1, timescale: V_TS }]), 64);
  const garbage = Buffer.from([0, 0, 0, 7, 109, 111, 111, 102, 1, 2, 3, 4]);
  const emitted = appendSpoolBytes(idx, garbage, 64);
  assert.equal(emitted.length, 0);
});

test('index: non-moof boxes (mfra/sidx) are consumed, never emitted', () => {
  const init = initSegment([{ id: 1, timescale: V_TS }]);
  const idx = createFmp4Indexer();
  setIndexerInit(idx, init, init.length);
  const junk = Buffer.concat([box('sidx', Buffer.alloc(20)), box('mfra', Buffer.alloc(16))]);
  assert.deepEqual(appendSpoolBytes(idx, junk, init.length), []);
  assert.equal(idx.fragments.length, 0);
});

// ---------------------------------------------------------------------------
// Resolution policy
// ---------------------------------------------------------------------------

function sampleFragments(): Fmp4Fragment[] {
  const { init, spool } = twoTrackSpool();
  const idx = createFmp4Indexer();
  setIndexerInit(idx, init, init.length);
  appendSpoolBytes(idx, spool.subarray(init.length), init.length);
  return idx.fragments;
}

test('resolveTime: exact hit, between (snaps back), before-first (null), after-frontier (last)', () => {
  const frags = sampleFragments();
  assert.equal(resolveTimeToFragment(frags, 0)?.index, 0);
  assert.equal(resolveTimeToFragment(frags, 1)?.index, 1);
  assert.equal(resolveTimeToFragment(frags, 0.5)?.index, 0);
  assert.equal(resolveTimeToFragment(frags, 1.999)?.index, 1);
  assert.equal(resolveTimeToFragment(frags, -1), null);
  assert.equal(resolveTimeToFragment(frags, 999)?.index, 1);
  assert.equal(resolveTimeToFragment([], 5), null);
  assert.equal(resolveTimeToFragment(frags, NaN), null);
});

test('resolveByte: inside, exact start, gap snap-back, before-first null', () => {
  const frags = sampleFragments();
  const [f0, f1] = frags;
  assert.equal(resolveByteToFragment(frags, f0.spoolOffset)?.index, 0);
  assert.equal(resolveByteToFragment(frags, f0.spoolOffset + 5)?.index, 0);
  assert.equal(resolveByteToFragment(frags, f1.spoolOffset)?.index, 1);
  assert.equal(resolveByteToFragment(frags, f1.endOffset + 500)?.index, 1);
  assert.equal(resolveByteToFragment(frags, f0.spoolOffset - 1), null);
});

test('invalidateFromOffset: drops fragments past a truncation point', () => {
  const { init, spool } = twoTrackSpool();
  const idx = createFmp4Indexer();
  setIndexerInit(idx, init, init.length);
  appendSpoolBytes(idx, spool.subarray(init.length), init.length);
  assert.equal(idx.fragments.length, 2);
  const removed = invalidateFromOffset(idx, idx.fragments[0].endOffset);
  assert.equal(removed, 1);
  assert.equal(idx.fragments.length, 1);
  assert.equal(invalidateFromOffset(idx, 0), 1);
  assert.equal(idx.fragments.length, 0);
});

test('index: video-track tfdt preferred over audio when they disagree', () => {
  const init = initSegment([
    { id: 1, timescale: 1000 },
    { id: 2, timescale: 1000 },
  ]);
  const idx = createFmp4Indexer();
  setIndexerInit(idx, init, init.length);
  const moof = moofBox(1, [
    { trackId: 1, base: 5000 }, // 5 s video
    { trackId: 2, base: 9000 }, // 9 s audio
  ]);
  const mdat = mdatBox(32);
  const emitted = appendSpoolBytes(idx, Buffer.concat([moof, mdat]), init.length);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].startTime, 5);
});
