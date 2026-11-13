/**
 * Regression tests for the MPEG-TS random-access trim (P1 fix for the
 * "exit 69: Error submitting packet to decoder" failures on VOE-CDN files
 * whose bytes are MPEG-TS, labelled video/mp4).
 *
 * Windows of such streams almost always begin mid-GOP; libopenh264 errors on
 * every non-keyframe packet and the decoder aborts. The trim keeps bytes
 * from the packet carrying the first self-contained random-access group.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findTsRandomAccessOffset,
  findTsPushStartPackets,
  TS_PACKET_SIZE,
} from '@/lib/preview/ts-window';

const PID_VIDEO = 0x100;

function tsPacket(pid: number, pusi: boolean, payload: Buffer): Buffer {
  const pkt = Buffer.alloc(TS_PACKET_SIZE, 0xff);
  pkt[0] = 0x47;
  pkt[1] = ((pusi ? 0x40 : 0x00) | ((pid >> 8) & 0x1f)) & 0xff;
  pkt[2] = pid & 0xff;
  pkt[3] = 0x10; // payload only, no adaptation field
  payload.copy(pkt, 4, 0, Math.min(payload.length, TS_PACKET_SIZE - 4));
  return pkt;
}

function pes(streamId: number): Buffer {
  return Buffer.from([0x00, 0x00, 0x01, streamId, 0x00, 0x05, 0x80, 0x80, 0x05, 0x21, 0x00, 0x00]);
}
const sps = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0x67]), Buffer.alloc(16, 0x42)]);
const pps = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0x68]), Buffer.alloc(6, 0x01)]);
const idr = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0x65]), Buffer.alloc(40, 0xa1)]);
const pFrame = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0x41]), Buffer.alloc(40, 0xb1)]);
const sei = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0x06]), Buffer.alloc(8, 0x00)]);

/** A video PES packet with the given payload NALs. */
const videoPes = (payload: Buffer, pusi = true): Buffer =>
  tsPacket(PID_VIDEO, pusi, Buffer.concat([pes(0xe0), payload]));

test('findTsPushStartPackets: collects PUSI offsets and PIDs', () => {
  const buf = Buffer.concat([
    videoPes(sps),
    tsPacket(PID_VIDEO, false, pps),
    videoPes(pFrame),
  ]);
  const starts = findTsPushStartPackets(buf);
  assert.ok(starts);
  assert.deepEqual(starts.map((s) => s.offset), [0, 376]);
  assert.deepEqual(starts.map((s) => s.pid), [PID_VIDEO, PID_VIDEO]);
});

test('findTsPushStartPackets: rejects buffers that are not 188-aligned TS', () => {
  assert.equal(findTsPushStartPackets(Buffer.from('definitely not a ts stream...............')), null);
  const buf = Buffer.concat([videoPes(sps), Buffer.alloc(TS_PACKET_SIZE, 0)]); // desynced packet
  assert.equal(findTsPushStartPackets(buf), null);
});

test('findTsRandomAccessOffset: keeps the packet carrying the SPS/PPS/IDR group', () => {
  // Packet 0: mid-GOP junk (no random access). Packet 1: SPS. Packet 2: PPS+IDR group.
  const buf = Buffer.concat([
    videoPes(pFrame), // junk: no SPS/PPS/IDR
    videoPes(sps), // SPS in a PUSI packet
    videoPes(Buffer.concat([pps, idr])), // PPS + IDR — decodable
  ]);
  // Trim must keep from the PUSI packet that opens the SPS (188), not the PPS packet.
  const offset = findTsRandomAccessOffset(buf);
  assert.equal(offset, 188);
});

test('findTsRandomAccessOffset: skips an IDR missing its PPS and picks the next decodable one', () => {
  const buf = Buffer.concat([
    videoPes(sps), // SPS, but the following IDR has no PPS
    videoPes(idr), // IDR with sps but NO pps → not decodable…
    videoPes(Buffer.concat([sps, pps, idr])), // proper self-contained group
  ]);
  const offset = findTsRandomAccessOffset(buf);
  assert.equal(offset, 376); // the second PES packet (decodable)
});

test('findTsRandomAccessOffset: a non-IDR VCL before the IDR disqualifies the group', () => {
  const buf = Buffer.concat([
    videoPes(sps), // SPS
    videoPes(Buffer.concat([pps, pFrame, idr])), // PPS + P-frame before IDR → undecodable
    videoPes(Buffer.concat([sps, pps, idr])), // clean self-contained group
  ]);
  const offset = findTsRandomAccessOffset(buf);
  assert.equal(offset, 376);
});

test('findTsRandomAccessOffset: returns null when no decodable group exists', () => {
  // IDR present but no SPS/PPS anywhere
  assert.equal(findTsRandomAccessOffset(Buffer.concat([videoPes(idr), videoPes(idr)])), null);
  // SPS+PPS but no IDR
  assert.equal(findTsRandomAccessOffset(Buffer.concat([videoPes(sps), videoPes(pps)])), null);
  // Bytes with no TS structure at all
  assert.equal(findTsRandomAccessOffset(Buffer.alloc(TS_PACKET_SIZE * 3, 0)), null);
});

test('findTsRandomAccessOffset: SEI between PPS and IDR is harmless', () => {
  const buf = Buffer.concat([videoPes(sps), videoPes(Buffer.concat([pps, sei, idr]))]);
  assert.equal(findTsRandomAccessOffset(buf), 0);
});

test('findTsRandomAccessOffset: returns 0 when the window already starts at a group', () => {
  const buf = Buffer.concat([
    videoPes(Buffer.concat([sps, pps, idr])),
    videoPes(pFrame),
  ]);
  assert.equal(findTsRandomAccessOffset(buf), 0);
});
