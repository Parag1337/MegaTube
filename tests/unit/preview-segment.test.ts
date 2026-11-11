/**
 * Phase 5 tests: pure segment/window math (lib/preview/segment.ts).
 * No I/O, no ffmpeg — pins the candidate ladder, the 752-byte TS alignment,
 * the sprite geometry and the WebVTT document format.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

let seg: typeof import('@/lib/preview/segment');
before(async () => {
  seg = await import('@/lib/preview/segment');
});

test('candidatePositions: 25/50/75% of known duration, clamped before the end', () => {
  const c = seg.candidatePositions(100, 8);
  assert.deepEqual(c.map((x) => x.t), [25, 50, 75]);
  assert.ok(c.every((x) => !x.estimated));
  // 4 s video with 8 s clip: lastStart = 0 → all candidates clamp to 0 and dedupe.
  const short = seg.candidatePositions(4, 8);
  assert.equal(short.length, 1);
  assert.equal(short[0].t, 0);
});

test('candidatePositions: never inside the first 10% intro zone', () => {
  for (const c of seg.candidatePositions(1000, 8)) {
    assert.ok(c.t >= 0.1 * 1000 * 0.9, `candidate ${c.t} too early`);
  }
});

test('candidatePositions: unknown duration falls back to the fixed ladder, estimated', () => {
  const c = seg.candidatePositions(null, 8);
  assert.deepEqual(c.map((x) => x.t), [10, 30, 60]);
  assert.ok(c.every((x) => x.estimated));
});

test('byteWindowFor: TS windows are 752-byte aligned (188*4 = TS + CTR)', () => {
  const size = 100 * 1024 * 1024;
  for (const t of [10, 100, 250, 500, 900]) {
    const w = seg.byteWindowFor(t, 1000, size, 24 * 1024 * 1024, seg.TS_WINDOW_ALIGN);
    assert.equal(w.byteStart % seg.TS_WINDOW_ALIGN, 0, `start ${w.byteStart} misaligned for t=${t}`);
    assert.ok(w.byteLen > 0);
    assert.ok(w.byteStart + w.byteLen <= size);
  }
});

test('byteWindowFor: MP4 windows are 16-byte aligned', () => {
  const w = seg.byteWindowFor(50, 100, 1024 * 1024, 24 * 1024 * 1024, 16);
  assert.equal(w.byteStart % 16, 0);
});

test('byteWindowFor: clamped to the byte cap and the file size', () => {
  const big = seg.byteWindowFor(5, 3600, 500 * 1024 * 1024, 24 * 1024 * 1024, 752);
  assert.ok(big.byteLen <= 24 * 1024 * 1024);
  const tiny = seg.byteWindowFor(0, 10, 4096, 24 * 1024 * 1024, 752);
  assert.ok(tiny.byteLen <= 4096);
  const empty = seg.byteWindowFor(0, null, 0, 24 * 1024 * 1024, 752);
  assert.deepEqual(empty, { byteStart: 0, byteLen: 0 });
});

test('spritePlan: interval never below the floor, count never beyond duration', () => {
  // 10-min video: interval = max(4, 600/100=6) = 6, count = 100
  const long = seg.spritePlan(600, 160, 10, 100, 4);
  assert.equal(long.intervalSec, 6);
  assert.equal(long.count, 100);
  assert.equal(long.rows, 10);
  // 30-s video: interval = 4 (floor), count = 7, rows = 1
  const short = seg.spritePlan(30, 160, 10, 100, 4);
  assert.equal(short.intervalSec, 4);
  assert.equal(short.count, 7);
  assert.equal(short.rows, 1);
  // Degenerate: near-zero duration still yields one usable cell.
  const micro = seg.spritePlan(0.5, 160, 10, 100, 4);
  assert.equal(micro.count, 1);
});

test('buildSpriteVtt: cue grid math + xywh fragments', () => {
  const vtt = seg.buildSpriteVtt({
    spriteUrl: '/api/preview/7/timeline',
    durationSec: 48,
    intervalSec: 4,
    count: 12,
    cols: 10,
    tileW: 160,
    tileH: 90,
  });
  assert.match(vtt, /^WEBVTT\n/);
  assert.match(vtt, /00:00:00\.000 --> 00:00:04\.000\n\/api\/preview\/7\/timeline#xywh=0,0,160,90/);
  assert.match(vtt, /#xywh=160,0,160,90/); // cell 1 → col 1
  assert.match(vtt, /#xywh=0,90,160,90/); // cell 10 → row 1, col 0
  // Cells 0..11 cover 0-4 ... 44-48 (never beyond the 48 s duration).
  assert.match(vtt, /00:00:44\.000 --> 00:00:48\.000/);
  const cues = vtt.split('\n\n').length - 1; // minus the WEBVTT header
  assert.equal(cues, 12);
});

test('vttTimestamp: pads hours/ms correctly', () => {
  assert.equal(seg.vttTimestamp(0), '00:00:00.000');
  assert.equal(seg.vttTimestamp(3661.5), '01:01:01.500');
  assert.equal(seg.vttTimestamp(-1), '00:00:00.000');
});
