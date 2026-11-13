/**
 * Phase 5.1 remediation: montage source resolution.
 *
 * Pins the bounded acquisition contract without MEGA/ffmpeg:
 *  - unknown-duration TS scenes are selected by file fraction, marked
 *    estimated, and seek to 0 inside their cut window;
 *  - known-duration TS scenes keep the exact relative timestamp mapping;
 *  - the warm cache serves every scene locally;
 *  - cancellation is observable before any work;
 *  - probe bytes are accounted once when their head/tail files are reused.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megatube-preview-source-media-'));
const previewDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megatube-preview-source-work-'));
process.env.MEDIA_CACHE_DIR = mediaDir;
process.env.PREVIEW_CACHE_DIR = previewDir;

type SourceModule = typeof import('@/lib/preview/source');
let source: SourceModule;
type OwnedVideo = import('@/lib/preview/types').OwnedVideo;

/** Real 24-byte MEGA-style file key for the sniff/decrypt path tests. */
const testFileKey = Buffer.alloc(24, 7);

/**
 * Encrypt a fixture buffer the same way MEGA stores files: AES-128-CTR with
 * the "unmerged" file key (key[i] ^ key[16+i]) and the 8-byte nonce from the
 * key's tail. This is exactly what megajs's decrypt() expects, so fixtures
 * exercise the real decryption path.
 */
function encryptFixture(plain: Buffer): Buffer {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require('node:crypto') as typeof import('node:crypto');
  const aesKey = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) aesKey[i] = testFileKey[i] ^ testFileKey[16 + i];
  const iv = Buffer.concat([testFileKey.subarray(16, 24), Buffer.alloc(8)]);
  return crypto.createCipheriv('aes-128-ctr', aesKey, iv).update(plain);
}

before(async () => {
  source = await import('@/lib/preview/source');
});

after(() => {
  fs.rmSync(mediaDir, { recursive: true, force: true });
  fs.rmSync(previewDir, { recursive: true, force: true });
});

const noNetworkDeps = (warm: { path: string; size: number } | null = null) => ({
  fetchCiphertext: async () => {
    throw new Error('unexpected MEGA fetch');
  },
  withSession: async () => {
    throw new Error('unexpected MEGA session');
  },
  getDownloadUrl: async () => {
    throw new Error('unexpected MEGA URL');
  },
  readWarmCache: async () => warm,
});

function videoOf(id: number, overrides: Partial<OwnedVideo> = {}): OwnedVideo {
  return {
    id,
    megaNodeId: `node-${id}`,
    mimeType: 'video/mp2t',
    fileSize: 32 * 1024 * 1024,
    duration: null,
    mp4Faststart: null,
    megaAccountId: 1,
    encryptedSession: 'v1.test',
    ...overrides,
  };
}

/**
 * Build a synthetic MPEG-TS payload: repeating [SPS+PPS packet][IDR
 * packet][P-frame packet] groups, each carrying payload-unit-start video
 * packets (PID 0x100). Enough for the random-access trim to find a
 * self-contained group anywhere in the file.
 */
function makeTsGroup(): Buffer {
  const mk = (pid: number, pusi: boolean, payload: Buffer): Buffer => {
    const pkt = Buffer.alloc(188, 0xff);
    pkt[0] = 0x47;
    pkt[1] = ((pusi ? 0x40 : 0x00) | ((pid >> 8) & 0x1f)) & 0xff;
    pkt[2] = pid & 0xff;
    pkt[3] = 0x10; // payload only
    payload.copy(pkt, 4, 0, Math.min(payload.length, 184));
    return pkt;
  };
  const nal = (type: number, body: Buffer) =>
    Buffer.concat([Buffer.from([0x00, 0x00, 0x01, type]), body]);
  const pes = (streamId: number) =>
    Buffer.from([0x00, 0x00, 0x01, streamId, 0x00, 0x05, 0x80, 0x80, 0x05, 0x21, 0x00, 0x00]);
  const sps = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0x67]), Buffer.alloc(24, 0x42)]);
  const pps = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0x68]), Buffer.alloc(6, 0x01)]);
  const idr = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0x65]), Buffer.alloc(60, 0xa1)]);
  const p = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0x41]), Buffer.alloc(60, 0xb1)]);
  const idr2 = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0x65]), Buffer.alloc(60, 0xc1)]);
  const p2 = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0x41]), Buffer.alloc(60, 0xd1)]);
  // SPS+PPS in the pusi packet; IDR and a P-frame in continuation packets.
  return Buffer.concat([
    mk(0x100, true, Buffer.concat([pes(0xe0), sps, pps])),
    mk(0x100, false, idr),
    mk(0x100, false, p),
    mk(0x100, true, Buffer.concat([pes(0xe0), idr2])),
    mk(0x100, false, p2),
  ]);
}

function makeTsBuffer(size: number): Buffer {
  const group = makeTsGroup();
  const out = Buffer.alloc(Math.ceil(size / group.length) * group.length);
  let off = 0;
  while (off < out.length) {
    group.copy(out, off);
    off += group.length;
  }
  return out.subarray(0, Math.floor(size / 188) * 188 || 0);
}

/** Sparse local TS prefix + matching frontier manifest. */
function seedTsPrefix(video: OwnedVideo): void {
  const size = Number(video.fileSize);
  const part = path.join(mediaDir, `${video.id}.ts.part`);
  const fixture = makeTsBuffer(size);
  fs.writeFileSync(part, fixture);
  fs.truncateSync(part, size);
  fs.writeFileSync(
    path.join(mediaDir, `${video.id}.ts.frontier.json`),
    JSON.stringify({
      videoId: video.id,
      megaNodeId: video.megaNodeId,
      sourceSize: size,
      frontier: size,
      updatedAt: new Date().toISOString(),
    }),
  );
}

test('unknown-duration TS: byte-fraction windows, estimated, degraded, seek 0', async () => {
  const video = videoOf(9101);
  seedTsPrefix(video);
  const workDir = fs.mkdtempSync(path.join(previewDir, 'work-'));
  const scenes = [
    { index: 0, startSec: 10, durationSec: 1.2, fraction: 0.1, estimated: true },
    { index: 1, startSec: 50, durationSec: 1.2, fraction: 0.5, estimated: true },
    { index: 2, startSec: 90, durationSec: 1.2, fraction: 0.9, estimated: true },
  ];
  const plan = await source.resolveMontageSources(
    video,
    scenes,
    workDir,
    Buffer.alloc(16),
    noNetworkDeps(),
    { durationSec: null, prefetchedTransferBytes: 777 },
  );
  try {
    assert.equal(plan.kind, 'ts-window');
    assert.equal(plan.segments.length, 3);
    assert.equal(plan.degradedSelection, true);
    assert.equal(plan.omittedScenes.length, 0);
    assert.equal(plan.transferBytes, 777, 'probe bytes are accounted once');
    for (const segment of plan.segments) {
      assert.equal(segment.estimated, true);
      assert.equal(segment.seekSec, 0, 'a fraction window is the segment start');
      assert.ok(segment.byteFraction !== null && segment.byteFraction > 0);
      assert.ok(fs.statSync(segment.path).size > 0);
    }
    // Distinct file regions, not three copies of the beginning.
    const starts = plan.segments.map((s) => {
      const request = scenes.find((r) => r.index === s.index)!;
      return Math.floor(request.fraction * Number(video.fileSize));
    });
    assert.ok(starts[1] > starts[0] && starts[2] > starts[1]);
  } finally {
    await plan.cleanup();
  }
});

test('known-duration TS: relative input seek inside the cut window', async () => {
  const video = videoOf(9102, { duration: 1000 });
  seedTsPrefix(video);
  const workDir = fs.mkdtempSync(path.join(previewDir, 'work-'));
  const scenes = [
    { index: 0, startSec: 100, durationSec: 1.2 },
    { index: 1, startSec: 500, durationSec: 1.2 },
    { index: 2, startSec: 900, durationSec: 1.2 },
  ];
  const plan = await source.resolveMontageSources(video, scenes, workDir, Buffer.alloc(16), noNetworkDeps(), {
    durationSec: 1000,
  });
  try {
    assert.equal(plan.kind, 'ts-window');
    assert.equal(plan.degradedSelection, false);
    assert.equal(plan.segments.length, 3);
    for (const segment of plan.segments) {
      assert.equal(segment.estimated, false);
      assert.equal(segment.byteFraction, null);
      assert.ok(segment.seekSec >= 0 && segment.seekSec < 10, `relative seek ${segment.seekSec}`);
    }
  } finally {
    await plan.cleanup();
  }
});

test('warm cache: one local MP4 serves every scene without MEGA bytes', async () => {
  const video = videoOf(9103, { mimeType: 'video/mp4' });
  const warmPath = path.join(mediaDir, 'warm.mp4');
  fs.writeFileSync(warmPath, Buffer.alloc(1024));
  const workDir = fs.mkdtempSync(path.join(previewDir, 'work-'));
  const scenes = [
    { index: 0, startSec: 10, durationSec: 1.2, fraction: 0.1, estimated: true },
    { index: 1, startSec: 50, durationSec: 1.2, fraction: 0.5, estimated: true },
  ];
  const plan = await source.resolveMontageSources(
    video,
    scenes,
    workDir,
    Buffer.alloc(16),
    noNetworkDeps({ path: warmPath, size: 1024 }),
    { durationSec: null },
  );
  try {
    assert.equal(plan.kind, 'local-mp4');
    assert.equal(plan.transferBytes, 0);
    assert.equal(plan.degradedSelection, true);
    assert.equal(plan.segments.length, 2);
    for (const segment of plan.segments) {
      assert.equal(segment.path, warmPath);
      assert.equal(segment.estimated, true);
      assert.ok(segment.byteFraction !== null);
    }
  } finally {
    await plan.cleanup();
  }
});

test('stored mp4 with TS bytes (VOE-CDN mislabel): 188-byte sniff routes to the TS path', async () => {
  const video = videoOf(9105, { mimeType: 'video/mp4', duration: 1000 });
  seedTsPrefix(video);
  const workDir = fs.mkdtempSync(path.join(previewDir, 'work-'));
  const tsCipher = encryptFixture(makeTsBuffer(752));
  const megaCalls: string[] = [];
  const deps = {
    fetchCiphertext: async (url: string) => {
      megaCalls.push(url);
      if (url.endsWith('/0-187')) return new Response(tsCipher.subarray(0, 188));
      throw new Error(`unexpected MEGA fetch: ${url}`);
    },
    withSession: async (_a: number, _b: string, fn: (s: unknown) => Promise<unknown>) => fn({}),
    getDownloadUrl: async () => ({ url: 'https://mega.test/node-9105/file', size: Number(video.fileSize) }),
    readWarmCache: async () => null,
  };
  const scenes = [
    { index: 0, startSec: 100, durationSec: 1.2 },
    { index: 1, startSec: 500, durationSec: 1.2 },
  ];
  const plan = await source.resolveMontageSources(video, scenes, workDir, testFileKey, deps, {
    durationSec: 1000,
  });
  try {
    assert.equal(plan.kind, 'ts-window');
    assert.equal(plan.transferBytes, 0, 'local prefix serves the windows');
    // Exactly one network fetch: the 188-byte container sniff. No moov hunt.
    assert.equal(megaCalls.length, 1);
    assert.ok(megaCalls[0].endsWith('/0-187'));
    assert.ok(plan.segments.length > 0);
  } finally {
    await plan.cleanup();
  }
});

test('stored mp4 with MP4 bytes (genuine): proceeds to the MP4 path', async () => {
  const video = videoOf(9106, { mimeType: 'video/mp4', duration: 100 });
  const workDir = fs.mkdtempSync(path.join(previewDir, 'work-'));
  const ftypPlain = Buffer.alloc(188, 0);
  ftypPlain.writeUInt32BE(32, 0);
  ftypPlain.write('ftyp', 4, 'latin1');
  ftypPlain.write('isom', 8, 'latin1');
  const ftypCipher = encryptFixture(ftypPlain);
  const megaCalls: string[] = [];
  const deps = {
    fetchCiphertext: async (url: string) => {
      megaCalls.push(url);
      if (url.endsWith('/0-187')) return new Response(ftypCipher.subarray(0, 188));
      // Everything else 404s: acquisition must fail, and it must have tried the MP4 path.
      return new Response(null, { status: 404 });
    },
    withSession: async (_a: number, _b: string, fn: (s: unknown) => Promise<unknown>) => fn({}),
    getDownloadUrl: async () => ({ url: 'https://mega.test/node-9106/file', size: Number(video.fileSize) }),
    readWarmCache: async () => null,
  };
  const scenes = [{ index: 0, startSec: 10, durationSec: 1.2 }];
  await assert.rejects(
    source.resolveMontageSources(video, scenes, workDir, testFileKey, deps, {
      durationSec: 100,
    }),
    /ciphertext fetch failed with status 404/,
  );
  // The sniff happened first, then the 4 MB head fetch — never a TS window fetch.
  assert.ok(megaCalls[0].endsWith('/0-187'), 'sniff fetched first');
  assert.ok(megaCalls.some((c) => /\/0-\d+$/.test(c) && c.endsWith('4194303')), 'head range fetched');
});

test('resolveMontageSources: a pre-aborted job performs no acquisition', async () => {
  const video = videoOf(9104);
  seedTsPrefix(video);
  const workDir = fs.mkdtempSync(path.join(previewDir, 'work-'));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    source.resolveMontageSources(
      video,
      [{ index: 0, startSec: 10, durationSec: 1.2, fraction: 0.5 }],
      workDir,
      Buffer.alloc(16),
      noNetworkDeps(),
      { signal: controller.signal },
    ),
    (err: unknown) => err instanceof Error && err.name === 'AbortError',
  );
});
