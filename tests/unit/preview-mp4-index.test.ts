/**
 * Phase 5 tests: minimal MP4 top-level box walker (lib/preview/mp4-index.ts).
 * Fixtures are built in-memory as real ftyp/moov/mdat layouts.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

let idx: typeof import('@/lib/preview/mp4-index');
before(async () => {
  idx = await import('@/lib/preview/mp4-index');
});

function box(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload]);
}

test('faststart layout: moov found complete in the head, no mdat before it', () => {
  const ftyp = box('ftyp', Buffer.alloc(8));
  const moov = box('moov', Buffer.alloc(32));
  const mdat = box('mdat', Buffer.alloc(64));
  const buf = Buffer.concat([ftyp, moov, mdat]);
  const moovLoc = idx.findMoov(buf, 0);
  assert.ok(moovLoc);
  assert.equal(moovLoc.complete, true);
  assert.equal(moovLoc.mdatBeforeMoov, false);
  assert.equal(moovLoc.start, ftyp.length);
  assert.equal(moovLoc.end, ftyp.length + moov.length);
});

test('non-faststart layout: mdat precedes moov', () => {
  const ftyp = box('ftyp', Buffer.alloc(8));
  const mdat = box('mdat', Buffer.alloc(64));
  const moov = box('moov', Buffer.alloc(32));
  const buf = Buffer.concat([ftyp, mdat, moov]);
  const moovLoc = idx.findMoov(buf, 0);
  assert.ok(moovLoc);
  assert.equal(moovLoc.mdatBeforeMoov, true);
  assert.equal(moovLoc.start, ftyp.length + mdat.length);
});

test('moov at tail: baseOffset maps buffer offsets to absolute file offsets', () => {
  const ftyp = box('ftyp', Buffer.alloc(8));
  const mdat = box('mdat', Buffer.alloc(64));
  const tail = box('moov', Buffer.alloc(32));
  const whole = Buffer.concat([ftyp, mdat, tail]);
  const tailStart = ftyp.length + mdat.length;
  const tailBuf = whole.subarray(tailStart);
  const moovLoc = idx.findMoov(tailBuf, tailStart);
  assert.ok(moovLoc);
  assert.equal(moovLoc.start, tailStart);
  assert.equal(moovLoc.end, tailStart + tail.length);
  assert.equal(moovLoc.complete, true);
});

test('truncated moov: located but incomplete (caller fetches the tail)', () => {
  const ftyp = box('ftyp', Buffer.alloc(8));
  const moovFull = box('moov', Buffer.alloc(1000));
  const buf = Buffer.concat([ftyp, moovFull.subarray(0, 100)]); // head cut inside moov
  const moovLoc = idx.findMoov(buf, 0);
  assert.ok(moovLoc);
  assert.equal(moovLoc.complete, false);
});

test('64-bit largesize boxes are walked with their real extent', () => {
  const ftyp = box('ftyp', Buffer.alloc(8));
  const payload = Buffer.alloc(48);
  const head = Buffer.alloc(16);
  head.writeUInt32BE(1, 0); // size==1 → largesize follows
  head.write('moov', 4, 'latin1');
  head.writeUInt32BE(0, 8);
  head.writeUInt32BE(16 + payload.length, 12);
  const moov = Buffer.concat([head, payload]);
  const mdat = box('mdat', Buffer.alloc(16));
  const buf = Buffer.concat([ftyp, moov, mdat]);
  const moovLoc = idx.findMoov(buf, 0);
  assert.ok(moovLoc);
  assert.equal(moovLoc.complete, true);
  assert.equal(moovLoc.end, ftyp.length + 16 + payload.length);
});

test('size==0 (extends to EOF) terminates the walk', () => {
  const ftyp = box('ftyp', Buffer.alloc(8));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(0, 0);
  head.write('mdat', 4, 'latin1');
  const buf = Buffer.concat([ftyp, head, Buffer.alloc(40)]);
  const boxes = idx.walkTopLevelBoxes(buf, 0);
  const mdat = boxes.find((b) => b.type === 'mdat');
  assert.ok(mdat);
  // "Extends to EOF" includes the box's own 8-byte header: 8 + 40.
  assert.equal(mdat.size, 48);
});

test('malformed garbage: null (never throws)', () => {
  const garbage = Buffer.alloc(64, 0xff);
  assert.equal(idx.findMoov(garbage, 0), null);
  assert.equal(idx.findMoov(Buffer.alloc(0), 0), null);
  assert.deepEqual(idx.walkTopLevelBoxes(Buffer.alloc(4), 0), []);
});

// Real non-faststart layout: [ftyp][mdat payload...][moov]. A tail fetch
// starts INSIDE the mdat payload, so the box walker cannot see the moov —
// findMoovInChunk must signature-scan instead.
function mvhdMoov(mvhdPayload = Buffer.alloc(24)): Buffer {
  const mvhd = box('mvhd', mvhdPayload);
  return box('moov', mvhd);
}

test('tail chunk starting mid-mdat: moov found by validated signature scan', () => {
  const ftyp = box('ftyp', Buffer.alloc(8));
  const mdatPayload = Buffer.alloc(4096, 0xab); // arbitrary media bytes
  const mdat = box('mdat', mdatPayload);
  const moov = mvhdMoov();
  const whole = Buffer.concat([ftyp, mdat, moov]);
  // Tail window starts well inside mdat, exactly like the 4 MB fetches do.
  const tailStart = ftyp.length + 1000;
  const tailBuf = whole.subarray(tailStart);
  assert.equal(idx.findMoov(tailBuf, tailStart), null); // walker can't reach it
  const loc = idx.findMoovInChunk(tailBuf, tailStart, whole.length);
  assert.ok(loc);
  assert.equal(loc.start, ftyp.length + mdat.length);
  assert.equal(loc.end, whole.length);
  assert.equal(loc.complete, true);
});

test('signature scan rejects decoy "moov" bytes inside the mdat payload', () => {
  const ftyp = box('ftyp', Buffer.alloc(8));
  const payload = Buffer.alloc(4096, 0x11);
  // Craft bytes that look like a moov box but have no mvhd first child.
  const decoy = Buffer.alloc(64, 0x22);
  decoy.writeUInt32BE(64, 0);
  decoy.write('moov', 4, 'latin1');
  decoy.writeUInt32BE(64, 8);
  decoy.write('mdat', 12, 'latin1');
  decoy.copy(payload, 512);
  const mdat = box('mdat', payload);
  const moov = mvhdMoov();
  const whole = Buffer.concat([ftyp, mdat, moov]);
  const tailStart = ftyp.length + 100;
  const loc = idx.findMoovInChunk(whole.subarray(tailStart), tailStart, whole.length);
  assert.ok(loc);
  assert.equal(loc.start, ftyp.length + mdat.length);
});

test('signature scan ignores a moov whose declared size overruns the file', () => {
  const ftyp = box('ftyp', Buffer.alloc(8));
  const payload = Buffer.alloc(512, 0x33);
  // A "moov" with mvhd but a size field larger than the whole file.
  const fake = Buffer.alloc(64, 0x44);
  fake.writeUInt32BE(0xfffffff0, 0);
  fake.write('moov', 4, 'latin1');
  fake.writeUInt32BE(24, 8);
  fake.write('mvhd', 12, 'latin1');
  fake.copy(payload, 64);
  const mdat = box('mdat', payload);
  const whole = Buffer.concat([ftyp, mdat]);
  const loc = idx.findMoovInChunk(whole.subarray(ftyp.length + 16), ftyp.length + 16, whole.length);
  assert.equal(loc, null);
});

test('signature scan reports incomplete when the chunk ends inside moov', () => {
  const ftyp = box('ftyp', Buffer.alloc(8));
  const mdat = box('mdat', Buffer.alloc(2048, 0x55));
  const moov = mvhdMoov(Buffer.alloc(4096, 0x66));
  const whole = Buffer.concat([ftyp, mdat, moov]);
  const tailStart = ftyp.length + 100;
  // Chunk ends after the moov header + mvhd header, before the moov ends.
  const cut = ftyp.length + mdat.length + 64;
  const loc = idx.findMoovInChunk(whole.subarray(tailStart, cut), tailStart, whole.length);
  assert.ok(loc);
  assert.equal(loc.complete, false);
  assert.equal(loc.end, whole.length);
});
