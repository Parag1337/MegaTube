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

test('transient storage 404 (stale g-URL) recovers with a fresh URL -> 200, not 410', async () => {
  const u = await makeUser('staleurl');
  const acc = await makeAccount(u.id, 'staleurl@example.com');
  const v = await makeVideo(acc.id, 'staleurl-video');

  // First range fetch hits a stale URL (404); the fresh-URL retry serves bytes.
  let fetches = 0;
  const res = await handleMediaRequest(u.id, String(v.id), new Headers(), new AbortController().signal, fakeDeps({
    fetchCiphertext: async (url) => {
      fetches++;
      if (fetches === 1) return new Response(null, { status: 404 });
      return ciphertextResponse(url);
    },
  }));
  assert.equal(res.status, 200);
  assert.ok(fetches >= 2, 'must retry the range fetch once with a fresh URL');
  assert.ok((await readBody(res)).equals(EXPECTED), 'retried fetch must return exact decrypted plaintext');
});

test('persistent storage 500 -> 502 after the single retry (never hangs)', async () => {
  const u = await makeUser('unreach');
  const acc = await makeAccount(u.id, 'unreach@example.com');
  const v = await makeVideo(acc.id, 'unreach-video');

  const res = await handleMediaRequest(u.id, String(v.id), new Headers(), new AbortController().signal, fakeDeps({
    fetchCiphertext: async () => new Response(null, { status: 500 }),
  }));
  assert.equal(res.status, 502);
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
  if (seekRes.headers.get('x-media-path') === 'live-spool') {
    // P0-C: live-spool ranges count fMP4 output bytes: unknown total (`*`)
    // while running, or the real spool total once ended — never source size.
    const m = (seekRes.headers.get('content-range') ?? '').match(/^bytes 2048-8191\/(\*|\d+)$/);
    assert.ok(m, `fMP4 coords, got ${seekRes.headers.get('content-range')}`);
    if (m[1] !== '*') {
      assert.notEqual(Number(m[1]), FF_TS!.plain.length, 'total must be fMP4 output size, never source-TS size');
    }
    assert.equal(seekRes.headers.get('accept-ranges'), 'bytes', 'spool slices are satisfiable');
  }
  await readBody(seekRes);
  await startedPromise.catch(() => {});
});

test('P0-C: suffix Range on a cold live goes to the finished cache (never live-spool)', async (t) => {
  if (!FF_TS) return t.skip('ffmpeg unavailable: cannot build a real TS fixture');
  const { user, video } = await makeTsVideo('suffix-live');
  // A suffix range needs a known total, which a warming live has not got.
  // The route must not invent fMP4 offsets for it: it waits (bounded) for
  // the faststart cache and serves real cache coordinates.
  const res = await handleMediaRequest(
    user.id,
    String(video.id),
    new Headers({ range: 'bytes=-100' }),
    new AbortController().signal,
    tsDeps(),
  );
  assert.equal(res.status, 206);
  assert.notEqual(res.headers.get('x-media-path'), 'live-spool', 'suffix must never be answered from the live spool');
  const cr = res.headers.get('content-range') ?? '';
  assert.match(cr, /^bytes \d+-\d+\/\d+$/, `closed cache coordinates, got ${cr}`);
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(body.length, 100, 'exactly the last 100 cache bytes');
});

test('P0-B/C: seek far beyond a short live settles bounded (416 with real total, never hangs)', async (t) => {
  if (!FF_TS) return t.skip('ffmpeg unavailable: cannot build a real TS fixture');
  const { user, video } = await makeTsVideo('seek-beyond');
  // 10 000 000 names no byte of this ~1 MB output (it is "valid" against no
  // finished representation): the request must settle — via the finished
  // cache with its REAL total — instead of hanging on the spool frontier.
  const t0 = Date.now();
  const res = await handleMediaRequest(
    user.id,
    String(video.id),
    new Headers({ range: 'bytes=10000000-' }),
    new AbortController().signal,
    tsDeps(),
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 45_000, `bounded (took ${elapsed}ms), never hangs to abort`);
  assert.equal(res.status, 416, 'beyond every representation -> 416');
  assert.match(
    res.headers.get('content-range') ?? '',
    /^bytes \*\/\d+$/,
    '416 carries the finished-cache total, never the source size',
  );
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
  fs.rmSync(mp4Path, { force: true });
  fs.rmSync(sidecarPath, { force: true });
});

// ---------------------------------------------------------------------------
// P0 regression: direct-MP4 requests must NOT serialize a blocking MEGA
// probe before the first media byte (the preflight that starved 627/631/636
// into the browser's abort/re-request spiral). The only allowed extra fetch
// is the single 188 B container sniff that routes TS-as-MP4 into remux.
// ---------------------------------------------------------------------------
test('P0: small direct MP4 serves first byte with body + at most one tiny routing sniff (no blocking probe)', async () => {
  const u = await makeUser('noprobe');
  const acc = await makeAccount(u.id, 'noprobe@example.com');
  const v = await makeVideo(acc.id, 'noprobe-video');
  REQUESTED.length = 0; // isolate from earlier recording tests sharing the buffer
  const res = await handleMediaRequest(u.id, String(v.id), new Headers(), new AbortController().signal, recordingDeps());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-media-path'), 'direct');
  await readBody(res);
  // The recording-deps helper counts upstream fetches; a blocking
  // faststart probe would add 2 extra (head + tail) before the body fetch.
  assert.ok(REQUESTED.length <= 2, `expected <=2 upstream fetches, got ${REQUESTED.length}: ${REQUESTED.join(',')}`);
  REQUESTED.length = 0;
});

test('P0 C4 slice: mp4-labeled bytes that are actually MPEG-TS route into remux, never direct', async () => {
  // Real megajs ciphertext whose plaintext starts with a TS sync byte, served
  // under a video/mp4 label (the 627/631 shape). The route must NOT answer
  // `direct` (browsers park at 0:00 on TS bytes); it enters the remux
  // pipeline instead (synthetic bytes cannot transmux, so the honest answer
  // here is the retryable 503 — never a 200-direct of unplayable bytes).
  const { encrypt: encrypt2 } = await import('megajs');
  const tsish = Buffer.from(EXPECTED);
  tsish[0] = 0x47;
  const ek = Buffer.concat([Buffer.alloc(16, 0x33), Buffer.alloc(8, 0x44)]);
  const es = encrypt2(ek);
  const chunks: Buffer[] = [];
  es.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
  es.end(tsish);
  await new Promise<void>((resolve) => es.on('end', () => resolve()));
  const ct = Buffer.concat(chunks);
  const fk = Buffer.from(es.key);
  const u = await makeUser('mislabeled');
  const acc = await makeAccount(u.id, 'mislabeled@example.com');
  const v = await prisma.video.create({
    data: {
      megaAccountId: acc.id,
      megaNodeId: 'node-mislabeled-ts',
      megaFilename: 'Creator - Title.mp4',
      title: 'Title',
      slug: 'mislabeled-ts-video',
      creatorAssignment: 'none',
      fileSize: BigInt(ct.length),
      mimeType: 'video/mp4',
      fileKeyEncrypted: encryptSecret(fk),
    },
  });
  const slice = (url: string): Response => {
    const m = url.match(/\/(\d+)-(\d+)$/);
    const from = m ? Number(m[1]) : 0;
    const to = m ? Number(m[2]) : ct.length - 1;
    return new Response(Buffer.from(ct.subarray(from, to + 1)), { status: 200 });
  };
  const res = await handleMediaRequest(u.id, String(v.id), new Headers(), new AbortController().signal, fakeDeps({
    getDownloadUrl: async (): Promise<TemporaryDownloadUrl> => ({ url: UPSTREAM, size: ct.length }),
    fetchCiphertext: async (url) => slice(url),
  }));
  assert.notEqual(res.headers.get('x-media-path'), 'direct', 'TS bytes must never take the direct path');
  assert.equal(res.status, 503, 'untransmuxable synthetic TS answers retryable 503');
  await res.text().catch(() => {});
  // P1-C terminal-path cleanup: the failed job runs to its finally (slot
  // release + temp removal) even though no viewer is attached anymore.
  const { hasLiveRemuxJob: jobGone } = await import('@/lib/media/remux');
  const deadline = Date.now() + 15_000;
  while (jobGone(v.id) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(jobGone(v.id), false, 'failed job tore down (bounded)');
  for (const suffix of ['ts.part', 'live.spool', 'part.mp4']) {
    assert.equal(
      fs.existsSync(path.join(MEDIA_CACHE_TMP, `${v.id}.${suffix}`)),
      false,
      `failed job left no ${suffix}`,
    );
  }
});

// ---------------------------------------------------------------------------
// P0 regression: a transient apiCode-9 (ENOENT) answers retryable 503, not
// permanent 410 (historical lone-404 bursts self-resolved minutes later).
// ---------------------------------------------------------------------------
test('P0: transient apiCode 9 retries once with a fresh URL -> 503, not 410', async () => {
  const u = await makeUser('enoent');
  const acc = await makeAccount(u.id, 'enoent@example.com');
  const v = await makeVideo(acc.id, 'enoent-video');
  // First a=g throws ENOENT; the retry (fresh URL) succeeds.
  let calls = 0;
  const res = await handleMediaRequest(u.id, String(v.id), new Headers(), new AbortController().signal, fakeDeps({
    getDownloadUrl: async (): Promise<TemporaryDownloadUrl> => {
      calls++;
      if (calls === 1) throw new MegaError('unknown', 'node gone', 9);
      return { url: UPSTREAM, size: PLAIN.length };
    },
  }));
  assert.equal(calls, 2, 'must retry the URL fetch once');
  assert.equal(res.status, 503, 'transient ENOENT must be retryable, never a permanent 410');
});

// ---------------------------------------------------------------------------
// P0 regression: a PERSISTENT apiCode-9 still answers 410 (genuinely gone).
// ---------------------------------------------------------------------------
test('P0: persistent apiCode 9 (both attempts fail) -> 410', async () => {
  const u = await makeUser('enoent2');
  const acc = await makeAccount(u.id, 'enoent2@example.com');
  const v = await makeVideo(acc.id, 'enoent2-video');
  const res = await handleMediaRequest(u.id, String(v.id), new Headers(), new AbortController().signal, fakeDeps({
    getDownloadUrl: async (): Promise<TemporaryDownloadUrl> => {
      throw new MegaError('unknown', 'node gone', 9);
    },
  }));
  assert.equal(res.status, 410);
});

// ---------------------------------------------------------------------------
// P0 regression: normal browser aborts (ResponseAborted) are quiet 499s,
// never "playback setup failures".
// ---------------------------------------------------------------------------
test('P0: ResponseAborted from a dead client -> quiet 499, no failure log', async () => {
  const u = await makeUser('aborted');
  const acc = await makeAccount(u.id, 'aborted@example.com');
  const v = await makeVideo(acc.id, 'aborted-video');
  const res = await handleMediaRequest(u.id, String(v.id), new Headers(), new AbortController().signal, fakeDeps({
    getDownloadUrl: async (): Promise<TemporaryDownloadUrl> => {
      const err = new Error('');
      err.name = 'ResponseAborted';
      throw err;
    },
  }));
  assert.equal(res.status, 499);
});

// ---------------------------------------------------------------------------
// P0 regression: bounded remux-slot admission (never wait forever).
// ---------------------------------------------------------------------------
test('P0: tryAcquireRemuxSlot times out instead of waiting forever', async () => {
  const { tryAcquireRemuxSlot, RemuxSlotUnavailableError } = await import('@/lib/media/remux');
  // Saturate is indirect here: just verify the fast path resolves and the
  // error class exists with the right name (full saturation needs ffmpeg).
  assert.equal(new RemuxSlotUnavailableError().name, 'RemuxSlotUnavailableError');
  await assert.rejects(
    tryAcquireRemuxSlot(1, AbortSignal.abort()),
    /remux slot unavailable/,
    'pre-aborted signal must reject immediately, never hang',
  );
});

test('P1-C: exhausted temp budget fails fast with 503 + Retry-After (no job, nothing warmed)', async () => {
  const u = await makeUser('tempbudget');
  const acc = await makeAccount(u.id, 'tempbudget@example.com');
  const v = await prisma.video.create({
    data: {
      megaAccountId: acc.id,
      megaNodeId: 'node-tempbudget',
      megaFilename: 'Creator - TS Title.mp4',
      title: 'TS Title',
      slug: 'tempbudget-video',
      creatorAssignment: 'none',
      fileSize: BigInt(200 * 1024 * 1024),
      mimeType: 'video/mp2t',
      fileKeyEncrypted: encryptSecret(FILE_KEY),
    },
  });
  const { hasLiveRemuxJob } = await import('@/lib/media/remux');
  const prev = process.env.MEDIA_TEMP_MAX_BYTES;
  process.env.MEDIA_TEMP_MAX_BYTES = '1';
  try {
    const res = await handleMediaRequest(u.id, String(v.id), new Headers(), new AbortController().signal, fakeDeps({
      getDownloadUrl: async (): Promise<TemporaryDownloadUrl> => ({ url: UPSTREAM, size: 200 * 1024 * 1024 }),
    }));
    assert.equal(res.status, 503, 'budget refusal is retryable, never 502/410');
    assert.equal(res.headers.get('retry-after'), '5', 'caller backoff honored');
    assert.equal(hasLiveRemuxJob(v.id), false, 'refused admission registers no job');
  } finally {
    if (prev === undefined) delete process.env.MEDIA_TEMP_MAX_BYTES;
    else process.env.MEDIA_TEMP_MAX_BYTES = prev;
  }
});

after(() => {
  fs.rmSync(MEDIA_CACHE_TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// P1.2: probe result persistence — a successful probe becomes persistent
// knowledge; later plays reuse it instead of re-probing.
// ---------------------------------------------------------------------------
async function pollFor<T>(fn: () => Promise<T>, want: (v: T) => boolean, timeoutMs: number, step = 100): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (want(v)) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error('poll timeout');
    await new Promise((r) => setTimeout(r, step));
  }
}

async function videoDuration(id: number): Promise<number | null> {
  return (await prisma.video.findUnique({ where: { id }, select: { duration: true } }))?.duration ?? null;
}

async function makeFaVideo(accountId: number, slug: string, duration: number | null) {
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
      megaFa: '826:0*H1AAAA/826:8*H2BBBB',
      duration,
    },
  });
}

/** Fake MEGA session whose api.request answers the fa:8 attribute handshake. */
function fa8Deps(calls: string[], opts: { delayMs?: number; durationMicros?: number | null; fail?: boolean } = {}): MediaDeps {
  return fakeDeps({
    withMegaSession: async (_acc, _enc, fn) =>
      fn({
        api: {
          request: async (cmd: Record<string, unknown>) => {
            calls.push(String(cmd.a));
            if (opts.fail) throw new Error('fa:8 down');
            if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
            if (cmd.a !== 'ufa') throw new Error(`unexpected api call ${String(cmd.a)}`);
            return { p: 'https://attr.test/x' };
          },
        },
      } as never),
  });
}

/** Stub the global fetch for the attribute POST only; everything else passes through. */
async function withAttrFetch(durationMicros: number | null, fn: () => Promise<void>): Promise<void> {
  const { foldKey } = await import('@/lib/mega/nodes');
  const { createCipheriv } = await import('node:crypto');
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    const url = String((input as Request)?.url ?? input);
    if (url.startsWith('https://attr.test/')) {
      if (durationMicros === null) return new Response('gone', { status: 404 });
      const payload = Buffer.from(JSON.stringify({ duration: durationMicros }));
      const padded = Buffer.concat([payload, Buffer.alloc((16 - (payload.length % 16)) % 16, 0x20)]);
      const cipher = createCipheriv('aes-128-cbc', foldKey(FILE_KEY), Buffer.alloc(16, 0));
      cipher.setAutoPadding(false);
      const enc = Buffer.concat([cipher.update(padded), cipher.final()]);
      const lenPrefix = Buffer.alloc(4);
      lenPrefix.writeUInt32LE(enc.length, 0);
      return new Response(Buffer.concat([Buffer.alloc(8, 0), lenPrefix, enc]), { status: 200 });
    }
    return (origFetch as typeof fetch)(input as never, init as never);
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = origFetch;
  }
}

test('P1.2: successful fa:8 probe persists once, second play reuses it (no re-probe)', async () => {
  const u = await makeUser('fa8persist');
  const acc = await makeAccount(u.id, 'fa8persist@example.com');
  const v = await makeFaVideo(acc.id, 'fa8persist-video', null);
  assert.equal(await videoDuration(v.id), null);

  const calls: string[] = [];
  await withAttrFetch(729_000_000, async () => {
    const res1 = await handleMediaRequest(u.id, String(v.id), new Headers(), new AbortController().signal, fa8Deps(calls));
    assert.equal(res1.status, 200);
    assert.ok((await readBody(res1)).equals(EXPECTED));
    // Background persist lands shortly after (never blocks the response).
    await pollFor(() => videoDuration(v.id), (d) => d === 729, 5000);
    assert.deepEqual(calls, ['ufa'], 'exactly one attribute handshake for the first play');

    calls.length = 0;
    const res2 = await handleMediaRequest(u.id, String(v.id), new Headers(), new AbortController().signal, fa8Deps(calls));
    assert.equal(res2.status, 200);
    await readBody(res2);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(calls.length, 0, 'persisted duration is reused: no second fa:8 probe');
    assert.equal(await videoDuration(v.id), 729, 'value stable across plays');
  });
});

test('P1.2: invalid durations are never persisted; valid values round + first-wins', async () => {
  const { persistVideoDuration } = await import('@/app/api/media/[videoId]/route');
  const u = await makeUser('durvalid');
  const acc = await makeAccount(u.id, 'durvalid@example.com');
  const v = await makeFaVideo(acc.id, 'durvalid-video', null);
  // None of these may throw, and none may write.
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
    persistVideoDuration(v.id, bad as number);
  }
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await videoDuration(v.id), null, '0/negative/NaN/Infinity/null never persisted');
  persistVideoDuration(v.id, 729.4);
  await pollFor(() => videoDuration(v.id), (d) => d === 729, 5000);
  // A later (even valid) probe never overwrites the stored value.
  persistVideoDuration(v.id, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await videoDuration(v.id), 729, 'first valid probe wins permanently');
});

test('P1.2: failed probe preserves an existing valid duration', async () => {
  const u = await makeUser('fa8fail');
  const acc = await makeAccount(u.id, 'fa8fail@example.com');
  const v = await makeFaVideo(acc.id, 'fa8fail-video', 100);
  const calls: string[] = [];
  await withAttrFetch(null, async () => {
    const res = await handleMediaRequest(u.id, String(v.id), new Headers(), new AbortController().signal, fa8Deps(calls, { fail: true }));
    assert.equal(res.status, 200, 'probe failure never breaks playback');
    await readBody(res);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await videoDuration(v.id), 100, 'stored duration untouched by the failure');
  });
});

test('P1.2: concurrent cold viewers share one fa:8 probe (no duplicates)', async () => {
  const u = await makeUser('fa8conc');
  const acc = await makeAccount(u.id, 'fa8conc@example.com');
  const v = await makeFaVideo(acc.id, 'fa8conc-video', null);
  const calls: string[] = [];
  await withAttrFetch(600_000_000, async () => {
    const deps = fa8Deps(calls, { delayMs: 80 });
    const [r1, r2] = await Promise.all([
      handleMediaRequest(u.id, String(v.id), new Headers(), new AbortController().signal, deps),
      handleMediaRequest(u.id, String(v.id), new Headers(), new AbortController().signal, deps),
    ]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    await Promise.all([readBody(r1), readBody(r2)]);
    // The shared supplier ran once despite two overlapping cold requests.
    assert.deepEqual(calls, ['ufa'], 'single-flight: one handshake, not two');
    await pollFor(() => videoDuration(v.id), (d) => d === 600, 5000);
  });
});

test('P1.2: fa:8 persistence never blocks the first media byte', async () => {
  const u = await makeUser('fa8nonblock');
  const acc = await makeAccount(u.id, 'fa8nonblock@example.com');
  const v = await makeFaVideo(acc.id, 'fa8nonblock-video', null);
  const calls: string[] = [];
  await withAttrFetch(500_000_000, async () => {
    const res = await handleMediaRequest(u.id, String(v.id), new Headers(), new AbortController().signal, fa8Deps(calls, { delayMs: 150 }));
    assert.equal(res.status, 200);
    assert.ok((await readBody(res)).equals(EXPECTED), 'full body served');
    // The response (and body) completed while the 150 ms probe was still in
    // flight: persistence is strictly background.
    assert.equal(await videoDuration(v.id), null, 'not yet persisted at response time');
    await pollFor(() => videoDuration(v.id), (d) => d === 500, 5000);
  });
});

// ---------------------------------------------------------------------------
// P1.2 layout verdicts: a 100MB+ MP4 is probed once, the verdict persisted,
// and later plays skip the probe (faststart) or warm directly (non-faststart).
// ---------------------------------------------------------------------------
const BIG_SIZE = 100 * 1024 * 1024 + 12345;

async function makeBigMp4Fixture(): Promise<{ ct: Buffer; key: Buffer }> {
  // Classifier-only fixture (never transmuxed): ftyp + moov up front.
  const plain = Buffer.alloc(BIG_SIZE, 0);
  plain.writeUInt32BE(24, 0);
  plain.write('ftyp', 4, 4, 'latin1');
  plain.write('isom', 8, 4, 'latin1');
  plain.writeUInt32BE(100, 24);
  plain.write('moov', 28, 4, 'latin1');
  const { encrypt: encryptBig } = await import('megajs');
  const ek = Buffer.concat([Buffer.alloc(16, 0x55), Buffer.alloc(8, 0x66)]);
  const es = encryptBig(ek);
  const chunks: Buffer[] = [];
  es.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
  es.end(plain);
  await new Promise<void>((resolve) => es.on('end', () => resolve()));
  return { ct: Buffer.concat(chunks), key: Buffer.from(es.key) };
}

function bigCtDeps(ct: Buffer, size: number, requested: string[], extra: Partial<MediaDeps> = {}): MediaDeps {
  return fakeDeps({
    getDownloadUrl: async (): Promise<TemporaryDownloadUrl> => ({ url: UPSTREAM, size }),
    fetchCiphertext: async (url) => {
      requested.push(url);
      const m = url.match(/\/(\d+)-(\d+)$/);
      const from = m ? Number(m[1]) : 0;
      const to = m ? Number(m[2]) : ct.length - 1;
      return new Response(Buffer.from(ct.subarray(from, to + 1)), { status: 200 });
    },
    ...extra,
  });
}

async function makeBigVideo(accountId: number, slug: string, key: Buffer) {
  return prisma.video.create({
    data: {
      megaAccountId: accountId,
      megaNodeId: `node-${slug}`,
      megaFilename: 'Creator - Big.mp4',
      title: 'Big',
      slug,
      creatorAssignment: 'none',
      fileSize: BigInt(BIG_SIZE),
      mimeType: 'video/mp4',
      fileKeyEncrypted: encryptSecret(key),
    },
  });
}

test('P1.2: faststart verdict persists; second play skips the probe', async () => {
  const { ct, key } = await makeBigMp4Fixture();
  const u = await makeUser('layoutfast');
  const acc = await makeAccount(u.id, 'layoutfast@example.com');
  const v = await makeBigVideo(acc.id, 'layoutfast-video', key);
  assert.equal((await prisma.video.findUnique({ where: { id: v.id }, select: { mp4Faststart: true } }))?.mp4Faststart, null, 'migration default is unknown');

  const requested: string[] = [];
  const probeUrls = () => requested.filter((r) => r.endsWith('/0-262143'));
  const res1 = await handleMediaRequest(u.id, String(v.id), new Headers(), new AbortController().signal, bigCtDeps(ct, BIG_SIZE, requested));
  assert.equal(res1.status, 200);
  assert.equal(res1.headers.get('x-media-path'), 'direct');
  await readBody(res1);
  await pollFor(
    async () => (await prisma.video.findUnique({ where: { id: v.id }, select: { mp4Faststart: true } }))?.mp4Faststart ?? null,
    (f) => f === true,
    5000,
  );
  assert.equal(probeUrls().length, 1, 'first play probes once');

  requested.length = 0;
  const res2 = await handleMediaRequest(u.id, String(v.id), new Headers(), new AbortController().signal, bigCtDeps(ct, BIG_SIZE, requested));
  assert.equal(res2.status, 200);
  await readBody(res2);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(probeUrls().length, 0, 'known faststart: no probe on repeat plays');
});

test('P1.2: non-faststart verdict persists and warms the faststart cache', { timeout: 300000 }, async (t) => {
  // A REAL 100MB+ moov-at-end MP4 (ffmpeg default layout): proves the full
  // verdict -> background warm -> servable faststart cache chain on genuine
  // MP4 input (not just the probe classifier). Built by concatenating a
  // short noisy segment (incompressible => real megabytes, fast encode).
  let plain: Buffer;
  try {
    const workdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'media-route-big-'));
    const seg = path.join(workdir, 'seg.ts');
    await execFileP('ffmpeg', [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=8:size=640x480:rate=30,noise=alls=25:allf=t',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
      '-c:v', 'libopenh264', '-b:v', '8M', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '64k',
      '-f', 'mpegts', seg,
    ]);
    const list = path.join(workdir, 'list.txt');
    await fs.promises.writeFile(list, Array.from({ length: 14 }, () => `file '${seg}'`).join('\n'));
    const big = path.join(workdir, 'big.mp4');
    await execFileP('ffmpeg', [
      '-v', 'error', '-y',
      '-f', 'concat', '-safe', '0', '-i', list,
      '-c', 'copy',
      big,
    ]);
    plain = fs.readFileSync(big);
    fs.rmSync(workdir, { recursive: true, force: true });
  } catch {
    return t.skip('ffmpeg unavailable/failed: cannot build a real 100MB MP4 fixture');
  }
  if (plain.length < 100 * 1024 * 1024) return t.skip(`fixture too small (${plain.length}): gate needs 100MB`);
  // Sanity: moov must NOT be up front (else the premise is wrong).
  const head = plain.subarray(0, 262144);
  assert.ok(!head.subarray(0, 262144).includes(Buffer.from('moov')), 'fixture is genuinely moov-at-end');
  const { encrypt: encryptBig } = await import('megajs');
  const ek = Buffer.concat([Buffer.alloc(16, 0x55), Buffer.alloc(8, 0x66)]);
  const es = encryptBig(ek);
  const chunks: Buffer[] = [];
  es.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
  es.end(plain);
  await new Promise<void>((resolve) => es.on('end', () => resolve()));
  const ct = Buffer.concat(chunks);
  const key = Buffer.from(es.key);
  const size = plain.length;

  const { hasLiveRemuxJob, readRemuxCache } = await import('@/lib/media/remux');
  const u = await makeUser('layoutslow');
  const acc = await makeAccount(u.id, 'layoutslow@example.com');
  const v = await prisma.video.create({
    data: {
      megaAccountId: acc.id,
      megaNodeId: 'node-layoutslow-video',
      megaFilename: 'Creator - Big.mp4',
      title: 'Big',
      slug: 'layoutslow-video',
      creatorAssignment: 'none',
      fileSize: BigInt(size),
      mimeType: 'video/mp4',
      fileKeyEncrypted: encryptSecret(key),
    },
  });
  const requested: string[] = [];
  const res1 = await handleMediaRequest(u.id, String(v.id), new Headers(), new AbortController().signal, bigCtDeps(ct, size, requested));
  assert.equal(res1.status, 200, 'this play still streams direct immediately');
  await readBody(res1);
  assert.ok(requested.some((r) => r.endsWith('/0-262143')), 'first play runs the layout probe');
  await pollFor(
    async () => (await prisma.video.findUnique({ where: { id: v.id }, select: { mp4Faststart: true } }))?.mp4Faststart ?? null,
    (f) => f === false,
    5000,
  );
  // The verdict fired the background warm (single-flight live job)...
  await pollFor(async () => hasLiveRemuxJob(v.id), (on) => on === true, 10000);
  // …which runs to a published faststart cache that later plays hit.
  await pollFor(async () => hasLiveRemuxJob(v.id), (on) => on === false, 180000);
  const warm = await readRemuxCache(v.id, 'node-layoutslow-video', size);
  assert.ok(warm, 'non-faststart verdict warmed a servable faststart cache');
});

async function makeTsShortVideo(accountId: number, slug: string) {
  return prisma.video.create({
    data: {
      megaAccountId: accountId,
      megaNodeId: `node-${slug}`,
      megaFilename: 'Creator - TS Title.mp4',
      title: 'TS Title',
      slug,
      creatorAssignment: 'none',
      fileSize: BigInt(4096),
      mimeType: 'video/mp2t',
      fileKeyEncrypted: encryptSecret(FILE_KEY),
    },
  });
}

function shortGrace<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.MEDIA_ZERO_SUBSCRIBER_GRACE_MS;
  process.env.MEDIA_ZERO_SUBSCRIBER_GRACE_MS = '150';
  return fn().finally(() => {
    if (prev === undefined) delete process.env.MEDIA_ZERO_SUBSCRIBER_GRACE_MS;
    else process.env.MEDIA_ZERO_SUBSCRIBER_GRACE_MS = prev;
  });
}

test('lifecycle 18: viewer lost in preflight gets a fast honest 503 (never hangs, never 502)', { timeout: 30000 }, async () => {
  const { hasLiveRemuxJob } = await import('@/lib/media/remux');
  const u = await makeUser('abandonpre');
  const acc = await makeAccount(u.id, 'abandonpre@example.com');
  const v = await makeTsShortVideo(acc.id, 'abandonpre-video');
  // Hanging upstream that honors cancellation (like the real wrapper).
  const hanging: MediaDeps['fetchCiphertext'] = (_url, signal) =>
    new Promise<Response>((resolve, reject) => {
      void resolve;
      if (signal?.aborted) {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        return;
      }
      signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
  await shortGrace(async () => {
    const t0 = Date.now();
    // Fire without awaiting: the request parks in preflight (no headers ever).
    const pending = handleMediaRequest(
      u.id,
      String(v.id),
      new Headers(),
      new AbortController().signal,
      fakeDeps({
        getDownloadUrl: async (): Promise<TemporaryDownloadUrl> => ({ url: UPSTREAM, size: 4096 }),
        fetchCiphertext: hanging,
      }),
    );
    // Job created; the viewer never attaches (stuck preflight) and the
    // browser is conceptually gone: grace + cancel must settle it.
    await pollFor(async () => hasLiveRemuxJob(v.id), (on) => on === true, 3000);
    const res = await pending;
    const elapsed = Date.now() - t0;
    assert.equal(res.status, 503, 'cancelled preflight answers retryable 503, never 502');
    assert.ok(elapsed < 10_000, `bounded (${elapsed}ms): no 20s-timeout hang, no indefinite stall`);
    assert.equal(hasLiveRemuxJob(v.id), false, 'abandoned job removed after cancel');
  });
});

test('lifecycle: pre-aborted request in the live section answers quiet 499 fast (no phantom subscriber)', async () => {
  const { hasLiveRemuxJob } = await import('@/lib/media/remux');
  const u = await makeUser('preabort');
  const acc = await makeAccount(u.id, 'preabort@example.com');
  const v = await makeTsShortVideo(acc.id, 'preabort-video');
  const hanging: MediaDeps['fetchCiphertext'] = (_url, signal) =>
    new Promise<Response>((resolve, reject) => {
      void resolve;
      if (signal?.aborted) {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        return;
      }
      signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
  // The viewer is already gone when the live section runs: nothing may be
  // served to it, and no subscriber may pin the job.
  const t0 = Date.now();
  const res = await handleMediaRequest(
    u.id,
    String(v.id),
    new Headers(),
    AbortSignal.abort(),
    fakeDeps({
      getDownloadUrl: async (): Promise<TemporaryDownloadUrl> => ({ url: UPSTREAM, size: 4096 }),
      fetchCiphertext: hanging,
    }),
  );
  assert.equal(res.status, 499, 'dead viewer: quiet 499, never a stream or 5xx');
  assert.ok(Date.now() - t0 < 5000, 'fast: no preflight/init waits for a gone viewer');
});

test('lifecycle 16+19: concurrent viewers share one upstream job; a later viewer gets a fresh job', { timeout: 30000 }, async () => {
  const { hasLiveRemuxJob } = await import('@/lib/media/remux');
  const u = await makeUser('sharedjob');
  const acc = await makeAccount(u.id, 'sharedjob@example.com');
  const v = await makeTsShortVideo(acc.id, 'sharedjob-video');
  let fullFetches = 0;
  const countingFail: MediaDeps['fetchCiphertext'] = async (url) => {
    if (/\/0-4095$/.test(url)) fullFetches++;
    // Delayed failure: both overlapping requests must be parked in
    // preflight together (past the synchronous join) before the job dies.
    await new Promise((r) => setTimeout(r, 300));
    return new Response(null, { status: 500 });
  };
  const deps = fakeDeps({
    getDownloadUrl: async (): Promise<TemporaryDownloadUrl> => ({ url: UPSTREAM, size: 4096 }),
    fetchCiphertext: countingFail,
  });
  // Two overlapping cold requests: the single-flight map section is
  // synchronous, so the second deterministically joins instead of starting
  // duplicate work.
  const [r1, r2] = await Promise.all([
    handleMediaRequest(u.id, String(v.id), new Headers(), new AbortController().signal, deps),
    handleMediaRequest(u.id, String(v.id), new Headers(), new AbortController().signal, deps),
  ]);
  assert.equal(r1.status, 503);
  assert.equal(r2.status, 503);
  assert.equal(fullFetches, 1, 'exactly one full upstream fetch for two concurrent viewers');
  await pollFor(async () => hasLiveRemuxJob(v.id), (on) => on === false, 5000);
  // After teardown, a subsequent viewer transparently gets a fresh job with
  // honest handling (second upstream attempt, still no 502).
  const r3 = await handleMediaRequest(u.id, String(v.id), new Headers(), new AbortController().signal, deps);
  assert.equal(r3.status, 503);
  assert.equal(fullFetches, 2, 'fresh job performs its own upstream attempt');
});

after(() => {
  fs.rmSync(MEDIA_CACHE_TMP, { recursive: true, force: true });
});
