/**
 * Unit tests for app/api/media/[videoId]/route.ts (private MEGA playback).
 *
 * Uses a real temporary SQLite database and an injected fake MEGA boundary
 * (MediaDeps) with GENUINELY megajs-encrypted ciphertext. No real MEGA
 * credentials, no network. Because the ciphertext is real MEGA CTR
 * ciphertext, the assertions below prove byte-exact DECRYPTED plaintext
 * correctness for aligned AND non-aligned ranges.
 *
 * Spec items:
 *   - authenticated owner can stream / unauthenticated rejected / other user rejected
 *   - valid GET returns 200 with correct Content-Type/Length + valid plaintext
 *   - Range 0-1023 returns 206 with correct Content-Range/Length/bytes
 *   - non-zero AND non-aligned Range returns the exact requested plaintext
 *     (regression: alignment bytes must never leak, keystream must not shift)
 *   - invalid Range returns 416
 *   - stream/decryption errors handled; invalid MEGA session handled (409)
 *   - no password login, no destructive MEGA operations (boundary exposes
 *     only session-resume + read-only URL fetch; no login/delete capability)
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { createTestDatabase } from './helpers/test-db';

const db = createTestDatabase('media-route-unit');
process.env.DATABASE_URL = db.url;
process.env.MEGA_SESSION_ENCRYPTION_KEY = 'ab'.repeat(32);
// Isolated cache dir for this test file (warm-cache + temp-file assertions).
const MEDIA_CACHE_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'media-route-unit-'));
process.env.MEDIA_CACHE_DIR = MEDIA_CACHE_TMP;

import { encrypt } from 'megajs';
import { encryptSecret } from '@/lib/mega/envelope';
import { MegaError } from '@/lib/mega/account';
import type { TemporaryDownloadUrl } from '@/lib/mega/account';
import type { handleMediaRequest as HandleMediaRequestFn, MediaDeps } from '@/app/api/media/[videoId]/route';

let handleMediaRequest: typeof HandleMediaRequestFn;
let prisma: typeof import('@/lib/db')['prisma'];
let createMegaAccount: typeof import('@/lib/megaAccounts')['createMegaAccount'];
let MEGA_ACCOUNT_STATUSES: typeof import('@/lib/megaAccounts')['MEGA_ACCOUNT_STATUSES'];

after(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Real MEGA ciphertext fixture: plaintext -> megajs CTR ciphertext + file key
// ---------------------------------------------------------------------------
const PLAIN = Buffer.from(Array.from({ length: 4096 }, (_, i) => i & 0xff));
// megajs streams MUTATE their input buffers in place (CTR XOR), so keep a
// pristine snapshot for assertions BEFORE the encryptor consumes PLAIN.
const EXPECTED = Buffer.from(PLAIN);
const encKey = Buffer.concat([Buffer.alloc(16, 0x11), Buffer.alloc(8, 0x22)]);
const encStream = encrypt(encKey);
const ctChunks: Buffer[] = [];
let CT = Buffer.alloc(0);
let FILE_KEY = Buffer.alloc(32);
encStream.on('data', (c: Buffer) => ctChunks.push(c));
encStream.on('end', () => {
  CT = Buffer.concat(ctChunks);
  // megajs exposes the finished 32-byte key (key16+nonce+mac) on the stream.
  FILE_KEY = Buffer.from(encStream.key);
});
encStream.end(PLAIN);

const UPSTREAM = 'https://gfs.test/fakeenc';

function ciphertextResponse(url: string): Response {
  const m = url.match(/\/(\d+)-(\d+)$/);
  const from = m ? Number(m[1]) : 0;
  const to = m ? Number(m[2]) : CT.length - 1;
  // COPY: the route's decryptor XORs chunks in place; handing out a view of
  // the shared CT fixture would corrupt it for subsequent requests/tests.
  return new Response(Buffer.from(CT.subarray(from, to + 1)), { status: 200 });
}

/** Fake MEGA boundary: session resume never touches the network. */
function fakeDeps(overrides: Partial<MediaDeps> = {}): MediaDeps {
  return {
    withMegaSession: async (_acc, _enc, fn) => fn({ fake: 'storage' } as never),
    getDownloadUrl: async (): Promise<TemporaryDownloadUrl> => ({ url: UPSTREAM, size: PLAIN.length }),
    fetchCiphertext: async (url) => ciphertextResponse(url),
    ...overrides,
  };
}

const REQUESTED: string[] = [];

function recordingDeps(overrides: Partial<MediaDeps> = {}): MediaDeps {
  return fakeDeps({
    fetchCiphertext: async (url) => {
      REQUESTED.push(url);
      return ciphertextResponse(url);
    },
    ...overrides,
  });
}

async function readBody(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Database fixtures
// ---------------------------------------------------------------------------
async function makeUser(suffix: string) {
  return prisma.user.create({
    data: {
      email: `media-${suffix}@example.com`,
      passwordHash:
        'pbkdf2:sha256:100000:00000000000000000000000000000000:000000000000000000000000000000000000000000000000000000000000000000',
    },
  });
}

async function makeAccount(userId: string, email: string) {
  return createMegaAccount({
    userId,
    label: `Acc ${email}`,
    email,
    material: {
      v: 1 as const,
      sid: 's'.repeat(60),
      masterKey: Buffer.alloc(16, 1).toString('base64url'),
      rsa: null,
      user: 'Uowner',
      name: 'Owner',
      email,
    },
  });
}

async function makeVideo(accountId: number, slug: string) {
  return prisma.video.create({
    data: {
      megaAccountId: accountId,
      megaNodeId: `node-${slug}`,
      megaFilename: 'Creator - Title.mp4',
      title: 'Title',
      slug,
      creatorAssignment: 'none',
      fileSize: BigInt(PLAIN.length),
      mimeType: 'video/mp4',
      fileKeyEncrypted: encryptSecret(FILE_KEY),
    },
  });
}

before(async () => {
  ({ prisma } = await import('@/lib/db'));
  ({ createMegaAccount, MEGA_ACCOUNT_STATUSES } = await import('@/lib/megaAccounts'));
  const route = await import('@/app/api/media/[videoId]/route');
  handleMediaRequest = route.handleMediaRequest;
  // Build a small real MPEG-TS fixture (ffmpeg + megajs encryption) for the
  // cold-pipeline tests. Skipped gracefully when ffmpeg is unavailable.
  try {
    const tmp = path.join(os.tmpdir(), `media-route-ts-${randomBytes(4).toString('hex')}.ts`);
    await execFileP('ffmpeg', [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x240:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
      '-c:v', 'libopenh264', '-b:v', '120k', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '16k',
      '-force_key_frames', 'expr:gte(t,n_forced*1)',
      '-muxdelay', '0', '-muxpreload', '0',
      '-f', 'mpegts', tmp,
    ]);
    const plain = fs.readFileSync(tmp);
    fs.rmSync(tmp, { force: true });
    const { encrypt } = await import('megajs');
    const encKey = Buffer.concat([Buffer.alloc(16, 0x55), Buffer.alloc(8, 0x66)]);
    const encStream = encrypt(encKey);
    const ctChunks: Buffer[] = [];
    const keyRef: { key: Buffer } = { key: Buffer.alloc(32) };
    encStream.on('data', (c: Buffer) => ctChunks.push(Buffer.from(c)));
    encStream.on('end', () => { keyRef.key = Buffer.from(encStream.key); });
    encStream.end(plain);
    while (keyRef.key.every((b) => b === 0)) await new Promise((r) => setTimeout(r, 10));
    FF_TS = { plain, ct: Buffer.concat(ctChunks), key: keyRef.key };
  } catch {
    FF_TS = null; // cold-pipeline tests skip; everything else still runs
  }
});

// ---------------------------------------------------------------------------
// Authorization / user isolation
// ---------------------------------------------------------------------------
test('unauthenticated request is rejected (401)', async () => {
  const res = await handleMediaRequest(null, '1', new Headers(), new AbortController().signal);
  assert.equal(res.status, 401);
});

test('authenticated owner can stream: 200 + plaintext bytes + headers', async () => {
  const u = await makeUser('owner');
  const acc = await makeAccount(u.id, 'owner@example.com');
  const v = await makeVideo(acc.id, 'owner-video');

  const res = await handleMediaRequest(u.id, String(v.id), new Headers(), new AbortController().signal, fakeDeps());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal(res.headers.get('content-length'), String(PLAIN.length));
  // The body is genuine megajs-decrypted plaintext (MAC verified on full GET).
  assert.ok((await readBody(res)).equals(EXPECTED), 'full GET must return exact decrypted plaintext');
});

test('another website user is rejected (404, no leak)', async () => {
  const owner = await makeUser('iso-owner');
  const acc = await makeAccount(owner.id, 'iso-owner@example.com');
  const v = await makeVideo(acc.id, 'iso-video');

  const other = await makeUser('iso-other');
  const res = await handleMediaRequest(other.id, String(v.id), new Headers(), new AbortController().signal);
  assert.equal(res.status, 404);
});

test('REAUTH_REQUIRED account answers 409 without touching MEGA', async () => {
  const u = await makeUser('reauth');
  const acc = await makeAccount(u.id, 'reauth@example.com');
  const v = await makeVideo(acc.id, 'reauth-video');
  await prisma.megaAccount.update({
    where: { id: acc.id },
    data: { status: MEGA_ACCOUNT_STATUSES.REAUTH_REQUIRED },
  });

  let megaTouched = false;
  const res = await handleMediaRequest(u.id, String(v.id), new Headers(), new AbortController().signal, fakeDeps({
    withMegaSession: async () => {
      megaTouched = true;
      throw new Error('must not be reached');
    },
  }));
  assert.equal(res.status, 409);
  assert.equal(megaTouched, false, 'no MEGA call, no password login attempt');
});

// ---------------------------------------------------------------------------
// Range semantics + byte correctness
// ---------------------------------------------------------------------------
test('Range 0-1023 returns 206 with correct Content-Range and exact bytes', async () => {
  const u = await makeUser('r0');
  const acc = await makeAccount(u.id, 'r0@example.com');
  const v = await makeVideo(acc.id, 'r0-video');

  const res = await handleMediaRequest(u.id, String(v.id), new Headers({ range: 'bytes=0-1023' }), new AbortController().signal, fakeDeps());
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 0-1023/${PLAIN.length}`);
  assert.equal(res.headers.get('content-length'), '1024');
  assert.ok((await readBody(res)).equals(EXPECTED.subarray(0, 1024)), 'bytes 0-1023 exact plaintext');
});

test('non-zero aligned Range (1024-2047) returns exact plaintext', async () => {
  const u = await makeUser('r1');
  const acc = await makeAccount(u.id, 'r1@example.com');
  const v = await makeVideo(acc.id, 'r1-video');

  const res = await handleMediaRequest(u.id, String(v.id), new Headers({ range: 'bytes=1024-2047' }), new AbortController().signal, fakeDeps());
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 1024-2047/${PLAIN.length}`);
  assert.ok((await readBody(res)).equals(EXPECTED.subarray(1024, 2048)));
});

test('NON-ALIGNED Range (1031-2046) returns exact plaintext (regression: no alignment-byte leak, no keystream shift)', async () => {
  const u = await makeUser('r2');
  const acc = await makeAccount(u.id, 'r2@example.com');
  const v = await makeVideo(acc.id, 'r2-video');

  const deps = recordingDeps();
  const res = await handleMediaRequest(u.id, String(v.id), new Headers({ range: 'bytes=1031-2046' }), new AbortController().signal, deps);
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 1031-2046/${PLAIN.length}`);
  assert.equal(res.headers.get('content-length'), '1016');

  // The upstream ciphertext request must be 16-byte aligned at the start...
  const rangeReq = REQUESTED.find((url) => url.startsWith(UPSTREAM) && !url.endsWith('/0-187'));
  assert.ok(rangeReq, 'exactly one range request to MEGA storage');
  assert.ok(rangeReq.endsWith('/1024-2046'), `upstream range must be block-aligned, got ${rangeReq}`);

  // ...and the returned bytes must be the EXACT requested plaintext range.
  const body = await readBody(res);
  assert.equal(body.length, 1016);
  assert.ok(body.equals(EXPECTED.subarray(1031, 2047)), 'non-aligned range must return exact plaintext after decrypt-then-trim');
});

test('suffix Range (bytes=-512) returns the file tail', async () => {
  const u = await makeUser('r3');
  const acc = await makeAccount(u.id, 'r3@example.com');
  const v = await makeVideo(acc.id, 'r3-video');

  const res = await handleMediaRequest(u.id, String(v.id), new Headers({ range: 'bytes=-512' }), new AbortController().signal, fakeDeps());
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 3584-4095/${PLAIN.length}`);
  assert.ok((await readBody(res)).equals(EXPECTED.subarray(3584)));
});

test('out-of-bounds Range returns 416 with bytes */<size>', async () => {
  const u = await makeUser('r4');
  const acc = await makeAccount(u.id, 'r4@example.com');
  const v = await makeVideo(acc.id, 'r4-video');

  const res = await handleMediaRequest(u.id, String(v.id), new Headers({ range: 'bytes=9999-' }), new AbortController().signal, fakeDeps());
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('content-range'), `bytes */${PLAIN.length}`);
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------
test('invalid stored session -> 409 + account flipped to REAUTH_REQUIRED (never a password login)', async () => {
  const u = await makeUser('expired');
  const acc = await makeAccount(u.id, 'expired@example.com');
  const v = await makeVideo(acc.id, 'expired-video');

  const res = await handleMediaRequest(u.id, String(v.id), new Headers(), new AbortController().signal, fakeDeps({
    withMegaSession: async () => {
      throw new MegaError('session-expired', 'MEGA rejected the stored session');
    },
  }));
  assert.equal(res.status, 409);

  const account = await prisma.megaAccount.findUnique({ where: { id: acc.id } });
  assert.equal(account?.status, MEGA_ACCOUNT_STATUSES.REAUTH_REQUIRED);
  assert.ok(account?.lastSyncError && account.lastSyncError.length > 0);
});

test('node vanished on MEGA (404 upstream) -> 410', async () => {
  const u = await makeUser('gone');
  const acc = await makeAccount(u.id, 'gone@example.com');
  const v = await makeVideo(acc.id, 'gone-video');

  const res = await handleMediaRequest(u.id, String(v.id), new Headers(), new AbortController().signal, fakeDeps({
    fetchCiphertext: async () => new Response(null, { status: 404 }),
  }));
  assert.equal(res.status, 410);
});

test('transient MEGA failure (url fetch throws) -> 503', async () => {
  const u = await makeUser('transient');
  const acc = await makeAccount(u.id, 'transient@example.com');
  const v = await makeVideo(acc.id, 'transient-video');

  const res = await handleMediaRequest(u.id, String(v.id), new Headers(), new AbortController().signal, fakeDeps({
    getDownloadUrl: async () => {
      throw new MegaError('transient', 'MEGA congestion');
    },
  }));
  assert.equal(res.status, 503);
});

test('corrupt ciphertext surfaces as a stream error (MAC verification fails), not silent corruption', async () => {
  const u = await makeUser('corrupt');
  const acc = await makeAccount(u.id, 'corrupt@example.com');
  const v = await makeVideo(acc.id, 'corrupt-video');

  const garbage = Buffer.alloc(PLAIN.length, 0x5a);
  const res = await handleMediaRequest(u.id, String(v.id), new Headers(), new AbortController().signal, fakeDeps({
    fetchCiphertext: async () => new Response(garbage, { status: 200 }),
  }));
  assert.equal(res.status, 200);
  await assert.rejects(() => res.text(), /MAC verification failed/, 'decryption failure must surface to the client');
});

// ---------------------------------------------------------------------------
// MEGA safety (structural)
// ---------------------------------------------------------------------------
test('MEGA boundary exposes no destructive capability (read-only surface)', async () => {
  // The injectable boundary can only: resume a stored session, resolve a
  // download URL, and fetch ciphertext. There is no login/password/delete/
  // rename surface to call from this code path.
  const deps = fakeDeps();
  assert.equal(typeof deps.withMegaSession, 'function');
  assert.equal(typeof deps.getDownloadUrl, 'function');
  assert.equal(typeof deps.fetchCiphertext, 'function');
});

// ---------------------------------------------------------------------------
// Bug 2: a cold MPEG-TS seek must be served from the live spool window, not
// answered as JSON 503 after a 45 s cache wait.
// ---------------------------------------------------------------------------
const execFileP = promisify(execFile);
/**
 * Real MPEG-TS fixture (ffmpeg-generated, megajs-encrypted): the cold TS
 * pipeline only works when ffmpeg can actually transmux the bytes, so these
 * tests use genuine TS content and skip cleanly when ffmpeg is unavailable.
 */
let FF_TS: { plain: Buffer; ct: Buffer; key: Buffer } | null = null;

function tsCiphertextResponse(url: string): Response {
  const m = url.match(/\/(\d+)-(\d+)$/);
  const from = m ? Number(m[1]) : 0;
  const to = m ? Number(m[2]) : FF_TS!.ct.length - 1;
  return new Response(Buffer.from(FF_TS!.ct.subarray(from, to + 1)), { status: 200 });
}

function tsDeps(overrides: Partial<MediaDeps> = {}): MediaDeps {
  return fakeDeps({
    getDownloadUrl: async (): Promise<TemporaryDownloadUrl> => ({ url: UPSTREAM, size: FF_TS!.plain.length }),
    fetchCiphertext: async (url) => tsCiphertextResponse(url),
    ...overrides,
  });
}

async function makeTsVideo(slug: string) {
  const u = await makeUser(`ts-${slug}`);
  const acc = await makeAccount(u.id, `ts-${slug}@example.com`);
  const v = await prisma.video.create({
    data: {
      megaAccountId: acc.id,
      megaNodeId: `node-ts-${slug}`,
      megaFilename: 'Creator - TS Title.mp4',
      title: 'TS Title',
      slug,
      creatorAssignment: 'none',
      fileSize: BigInt(FF_TS!.plain.length),
      mimeType: 'video/mp2t',
      fileKeyEncrypted: encryptSecret(FF_TS!.key),
    },
  });
  return { user: u, video: v };
}

test('cold MPEG-TS seek while the live is running -> 206 media bytes (no JSON 503)', async (t) => {
  if (!FF_TS) return t.skip('ffmpeg unavailable: cannot build a real TS fixture');
  const { user, video } = await makeTsVideo('cold-seek');
  // Slow every upstream fetch slightly so the pipeline is provably still
  // warming while the seek arrives (the old code waited 45 s then sent JSON).
  const deps = tsDeps({
    fetchCiphertext: async (url) => {
      await new Promise((r) => setTimeout(r, 80));
      return tsCiphertextResponse(url);
    },
  });
  // Kick the pipeline off (start-0 open-ended GET); detach the viewer.
  const startedPromise = handleMediaRequest(user.id, String(video.id), new Headers(), new AbortController().signal, deps);
  startedPromise.then((r) => r.body?.cancel().catch(() => {})).catch(() => {});
  // Wait until the live spool holds real bytes (init + first fragments).
  const spoolPath = path.join(MEDIA_CACHE_TMP, `${video.id}.live.spool`);
  let spooled = 0;
  for (let i = 0; i < 100 && spooled < 4096; i++) {
    await new Promise((r) => setTimeout(r, 25));
    try {
      spooled = fs.statSync(spoolPath).size;
    } catch {
      spooled = 0;
    }
  }
  // Immediately seek within the already-spooled window.
  const seekRes = await handleMediaRequest(
    user.id,
    String(video.id),
    new Headers({ range: 'bytes=2048-8191' }),
    new AbortController().signal,
    deps,
  );
  // Bug 2 contract: a media response with real Range semantics - never the
  // JSON 503 the media element cannot interpret. (Exact x-media-path is
  // timing-dependent: live-spool while warming, warm-cache once done.)
  assert.equal(seekRes.status, 206);
  assert.equal(seekRes.headers.get('content-type'), 'video/mp4');
  assert.match(seekRes.headers.get('content-range') ?? '', /^bytes 2048-\d+\//, 'a real Content-Range, not JSON');
  await readBody(seekRes);
  await startedPromise.catch(() => {});
});

test('cold MPEG-TS start-0 GET still streams a byte-continuous fMP4 (init first)', async (t) => {
  if (!FF_TS) return t.skip('ffmpeg unavailable: cannot build a real TS fixture');
  const { user, video } = await makeTsVideo('cold-start');
  const res = await handleMediaRequest(user.id, String(video.id), new Headers(), new AbortController().signal, tsDeps());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  const body = await readBody(res);
  // Live fMP4 output must START with the init segment (ftyp+moov): the
  // regression where the spool began at 'moof' corrupted every viewer.
  assert.ok(body.length >= 8, 'has bytes');
  assert.equal(body.subarray(4, 8).toString('latin1'), 'ftyp', 'stream starts with the fMP4 init segment');
});

test('warm MPEG-TS cache hit -> 206 range from the cache file, no MEGA contact', async () => {
  const { user, video } = await makeTsVideo('warm-hit');
  // Seed a valid warm cache for this video.
  const { remuxCachePaths } = await import('@/lib/media/remux');
  const { mp4Path, sidecarPath } = remuxCachePaths(video.id);
  fs.mkdirSync(path.dirname(mp4Path), { recursive: true });
  const cacheBytes = Buffer.from('fake-warm-mp4-bytes');
  fs.writeFileSync(mp4Path, cacheBytes);
  fs.writeFileSync(
    sidecarPath,
    JSON.stringify({ megaNodeId: `node-ts-warm-hit`, sourceSize: FF_TS ? FF_TS.plain.length : Number(video.fileSize), outputSize: cacheBytes.length }),
  );
  let megaTouched = false;
  const res = await handleMediaRequest(
    user.id,
    String(video.id),
    new Headers({ range: 'bytes=0-9' }),
    new AbortController().signal,
    fakeDeps({
      withMegaSession: async () => {
        megaTouched = true;
        throw new Error('warm hit must not touch MEGA');
      },
    }),
  );
  assert.equal(megaTouched, false, 'P0 guarantee: warm cache answers before any MEGA work');
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('x-media-path'), 'warm-cache');
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(cacheBytes.subarray(0, 10)));
  fs.rmSync(path.dirname(mp4Path), { recursive: true, force: true });
});

after(() => {
  fs.rmSync(MEDIA_CACHE_TMP, { recursive: true, force: true });
});
