import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  extensionOf,
  isVideoNode,
  parseFa,
  foldKey,
  decodeFileKey,
  decodeShareKeys,
  decodeFileNodes,
  mimeFromVideoExtension,
  sniffMimeType,
} from '@/lib/mega/nodes';
import { normalizeDurationToSeconds } from '@/lib/mega/attributes';

function ecbEncrypt(key: Buffer, data: Buffer): Buffer {
  const c = crypto.createCipheriv('aes-128-ecb', key, Buffer.alloc(0));
  c.setAutoPadding(false);
  return Buffer.concat([c.update(data), c.final()]);
}

/** Share auth tag: ECB(masterKey, (h+h)[0:16]) - mirrors the official clients. */
function handleAuth(masterKey: Buffer, handle: string): Buffer {
  const doubled = Buffer.from(handle + handle, 'utf8');
  return ecbEncrypt(masterKey, doubled.subarray(0, 16));
}

/** Pack attributes the same way MEGA/megajs does: "MEGA{json}" padded to 16 bytes. */
function packAttributes(attrs: Record<string, unknown>): Buffer {
  const raw = Buffer.from('MEGA' + JSON.stringify(attrs));
  const out = Buffer.alloc(Math.ceil(raw.length / 16) * 16);
  raw.copy(out);
  return out;
}

const MASTER_KEY = crypto.randomBytes(16);
const FILE_KEY_A = crypto.randomBytes(32);
const SHARE_KEY = crypto.randomBytes(16);
const ME = 'Uowner123';
const SHARE_H = 'Ushared456x1'; // 12-char handle, like real MEGA handles

test('extensionOf basic behavior', () => {
  assert.equal(extensionOf('My Movie.MP4'), 'mp4');
  assert.equal(extensionOf('clip.mkv'), 'mkv');
  assert.equal(extensionOf('a.b.c'), 'c');
  assert.equal(extensionOf('archive'), null);
  assert.equal(extensionOf('.hidden'), null);
  assert.equal(extensionOf('x.'), null);
  assert.equal(extensionOf(null), null);
});

test('isVideoNode: video extensions detected', () => {
  assert.equal(isVideoNode('clip.mp4', null), true);
  assert.equal(isVideoNode('clip.MOV', null), true);
  assert.equal(isVideoNode('episode.mkv', null), true);
  assert.equal(isVideoNode('track.3gp', null), true);
  assert.equal(isVideoNode('movie.webm', null), true);
});

test('isVideoNode: non-video files rejected', () => {
  assert.equal(isVideoNode('readme.txt', null), false);
  assert.equal(isVideoNode('photo.jpg', null), false);
  assert.equal(isVideoNode('archive.zip', null), false);
  assert.equal(isVideoNode('notes', null), false);
  assert.equal(isVideoNode(null, null), false);
});

test('isVideoNode: media-properties attribute (type 8) marks a video', () => {
  assert.equal(isVideoNode('clip', '1:0*thumb1/1:1*prev1/1:8*media1'), true);
  assert.equal(isVideoNode('clip', '1:0*thumb1/1:1*prev1'), false);
  assert.equal(isVideoNode('clip', null), false);
});

test('parseFa parses the versioned attribute list', () => {
  const parsed = parseFa('1:0*abcdef/1:1*abcdef/1:8*abcdef');
  assert.equal(parsed[0], 'abcdef');
  assert.equal(parsed[1], 'abcdef');
  assert.equal(parsed[8], 'abcdef');
  assert.deepEqual(parseFa(null), {});
  assert.deepEqual(parseFa(undefined), {});
  assert.deepEqual(parseFa('garbage/no-match'), {});
});

test('foldKey XORs the two halves of a 32-byte file key', () => {
  const fileKey = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  const folded = foldKey(fileKey);
  assert.equal(folded.length, 16);
  for (let i = 0; i < 16; i++) {
    assert.equal(folded[i], i ^ (i + 16));
  }
});

test('decodeShareKeys verifies the ha auth field', () => {
  const ok = [{ h: SHARE_H, ha: handleAuth(MASTER_KEY, SHARE_H).toString('base64url'), k: ecbEncrypt(MASTER_KEY, SHARE_KEY).toString('base64url') }];
  const map = decodeShareKeys(ok, MASTER_KEY);
  assert.ok(map.has(SHARE_H));
  assert.ok(map.get(SHARE_H)!.equals(SHARE_KEY));

  // tampered ha -> share key must NOT be trusted
  const badHa = handleAuth(MASTER_KEY, SHARE_H);
  badHa[0] ^= 0xff;
  const badOk = [{ h: SHARE_H, ha: badHa.toString('base64url'), k: ecbEncrypt(MASTER_KEY, SHARE_KEY).toString('base64url') }];
  assert.equal(decodeShareKeys(badOk, MASTER_KEY).size, 0);

  assert.equal(decodeShareKeys(undefined, MASTER_KEY).size, 0);
});

test('decodeFileKey: own file (master key path)', () => {
  const kEnc = ecbEncrypt(MASTER_KEY, FILE_KEY_A);
  const f = { h: 'n1', t: 0, k: `${ME}:${kEnc.toString('base64url')}` };
  const key = decodeFileKey(f, ME, MASTER_KEY, new Map(), null);
  assert.ok(key!.equals(FILE_KEY_A));
});

test('decodeFileKey: received share (share key path)', () => {
  const shareMap = decodeShareKeys(
    [{
      h: SHARE_H,
      ha: handleAuth(MASTER_KEY, SHARE_H).toString('base64url'),
      k: ecbEncrypt(MASTER_KEY, SHARE_KEY).toString('base64url'),
    }],
    MASTER_KEY,
  );
  const kEnc = ecbEncrypt(SHARE_KEY, FILE_KEY_A);
  const f = { h: 'n2', t: 0, k: `${SHARE_H}:${kEnc.toString('base64url')}` };
  const key = decodeFileKey(f, ME, MASTER_KEY, shareMap, null);
  assert.ok(key!.equals(FILE_KEY_A));
});

test('decodeFileKey: unknown owner only -> null', () => {
  const kEnc = ecbEncrypt(SHARE_KEY, FILE_KEY_A);
  const f = { h: 'n3', t: 0, k: `Ustranger999:${kEnc.toString('base64url')}` };
  assert.equal(decodeFileKey(f, ME, MASTER_KEY, new Map(), null), null);
});

test('decodeFileKey: RSA-encrypted key uses the storage decryptor', () => {
  const keyMaterial = Buffer.concat([FILE_KEY_A, crypto.randomBytes(8)]);
  const f = { h: 'n4', t: 0, k: `${ME}:${keyMaterial.toString('base64url')}` };
  let calledWith: Buffer | null = null;
  const storageLike = {
    decryptRsaKey: (c: Buffer) => {
      calledWith = c;
      return keyMaterial;
    },
  };
  const key = decodeFileKey(f, ME, MASTER_KEY, new Map(), storageLike);
  assert.ok(key!.equals(FILE_KEY_A));
  assert.ok(calledWith!.equals(keyMaterial));
});

test('decodeFileKey: RSA key without a storage decryptor -> null', () => {
  const keyMaterial = crypto.randomBytes(256);
  const f = { h: 'n5', t: 0, k: `${ME}:${keyMaterial.toString('base64url')}` };
  assert.equal(decodeFileKey(f, ME, MASTER_KEY, new Map(), null), null);
});

test('decodeFileNodes: full tree with name decryption, folder filter, keyless node', () => {
  const name = 'my secret video.mp4';
  const atPlain = packAttributes({ n: name });
  const c = crypto.createCipheriv('aes-128-cbc', foldKey(FILE_KEY_A), Buffer.alloc(16, 0));
  c.setAutoPadding(false);
  const at = Buffer.concat([c.update(atPlain), c.final()]).toString('base64url');
  const kEnc = ecbEncrypt(MASTER_KEY, FILE_KEY_A);

  const raw = {
    f: [
      { h: 'nodeA', p: 'parentA', t: 0, ts: 1_700_000_000, s: 1234, u: ME, at, fa: '1:0*thumb1', k: `${ME}:${kEnc.toString('base64url')}` },
      { h: 'folderZ', p: null, t: 1, s: 0 },
      { h: 'nodeB', p: null, t: 0, ts: null, s: 0, u: ME, fa: null },
    ],
  };

  const nodes = decodeFileNodes(raw, ME, MASTER_KEY, null);
  assert.equal(nodes.length, 2);

  const a = nodes.find((n) => n.h === 'nodeA')!;
  assert.equal(a.name, name);
  assert.ok(a.fileKey!.equals(FILE_KEY_A));
  assert.equal(a.p, 'parentA');
  assert.equal(a.ts, 1_700_000_000);
  assert.equal(a.s, 1234);
  assert.equal(a.u, ME);
  assert.equal(a.fa, '1:0*thumb1');

  const b = nodes.find((n) => n.h === 'nodeB')!;
  assert.equal(b.fileKey, null);
  assert.equal(b.name, null);
  assert.equal(b.p, null);
  assert.equal(b.ts, null);
});

test('mimeFromVideoExtension maps known video containers', () => {
  assert.equal(mimeFromVideoExtension('a.mp4'), 'video/mp4');
  assert.equal(mimeFromVideoExtension('a.MOV'), 'video/quicktime');
  assert.equal(mimeFromVideoExtension('a.mkv'), 'video/x-matroska');
  assert.equal(mimeFromVideoExtension('a.webm'), 'video/webm');
  assert.equal(mimeFromVideoExtension('a.txt'), null);
  assert.equal(mimeFromVideoExtension(null), null);
});

test('normalizeDurationToSeconds handles micro/milli/second units', () => {
  assert.equal(normalizeDurationToSeconds(90_000_000), 90); // microseconds
  assert.equal(normalizeDurationToSeconds(90_200), 90); // milliseconds
  assert.equal(normalizeDurationToSeconds(90.4), 90); // seconds
  assert.equal(normalizeDurationToSeconds(1_000_000), 1); // boundary: micro -> 1s
  assert.equal(normalizeDurationToSeconds(0), null);
  assert.equal(normalizeDurationToSeconds(-5), null);
  assert.equal(normalizeDurationToSeconds('nope'), null);
  assert.equal(normalizeDurationToSeconds(NaN), null);
  assert.equal(normalizeDurationToSeconds(Infinity), null);
});

test('sniffMimeType: MPEG-TS stream detected from sync bytes', () => {
  const tsPacket = Buffer.alloc(188, 0x47);
  tsPacket[1] = 0x40;
  assert.equal(sniffMimeType(tsPacket), 'video/mp2t');
  const longTs = Buffer.concat([Buffer.alloc(188, 0x47), Buffer.alloc(188, 0x47)]);
  assert.equal(sniffMimeType(longTs), 'video/mp2t');
});

test('sniffMimeType: MP4 ftyp box detected', () => {
  const ftyp = Buffer.alloc(28, 0);
  ftyp.writeUInt32BE(28, 0);
  ftyp.write('ftyp', 4, 'latin1');
  assert.equal(sniffMimeType(ftyp), 'video/mp4');
});

test('sniffMimeType: WebM EBML header detected', () => {
  const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00]);
  assert.equal(sniffMimeType(webm), 'video/webm');
});

test('sniffMimeType: AVI RIFF header detected', () => {
  const avi = Buffer.alloc(12, 0);
  avi.write('RIFF', 0, 'latin1');
  avi.writeUInt32LE(100, 4);
  avi.write('AVI ', 8, 'latin1');
  assert.equal(sniffMimeType(avi), 'video/x-msvideo');
});

test('sniffMimeType: returns null for unknown data', () => {
  assert.equal(sniffMimeType(Buffer.from('hello world')), null);
  assert.equal(sniffMimeType(Buffer.alloc(0)), null);
  assert.equal(sniffMimeType(Buffer.alloc(4)), null);
});
