/**
 * Unit tests for the download system:
 *   - lib/download.ts: filename sanitization, MIME mapping,
 *     Content-Disposition, bounded-concurrency pool;
 *   - app/api/download/[videoId]/route.ts: auth, ownership, headers and a
 *     byte-exact full-file decrypt stream using a real temp SQLite DB and
 *     GENUINELY megajs-encrypted ciphertext (mirrors media-route.test.ts).
 *     No real MEGA credentials, no network.
 *
 * Spec items:
 *   - authenticated owner downloads original file / unauthenticated 401 /
 *     other user 404 (no leak) / invalid id 400 / missing video 404
 *   - Content-Disposition attachment with the ORIGINAL filename (+ ext)
 *   - correct Content-Type, Content-Length, no Accept-Ranges claim
 *   - disconnected account 410 / reauth 409 / missing node 409
 *   - HEAD answers metadata without touching MEGA
 *   - upstream 404 -> 410, 509 -> 503, session-expired -> 409
 *   - client abort cleans up (499, no hang)
 *   - two concurrent downloads both succeed (no global lock)
 *   - pool: bounded concurrency, failure isolation, order, empty input
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from './helpers/test-db';

const db = createTestDatabase('download-unit');
process.env.DATABASE_URL = db.url;
process.env.MEGA_SESSION_ENCRYPTION_KEY = 'ab'.repeat(32);

import { encrypt } from 'megajs';
import { encryptSecret } from '@/lib/mega/envelope';
import { MegaError } from '@/lib/mega/account';
import type { TemporaryDownloadUrl } from '@/lib/mega/account';
import {
  buildContentDisposition,
  extensionForMimeType,
  mimeTypeForDownload,
  runBounded,
  sanitizeDownloadFilename,
} from '@/lib/download';
import type {
  handleDownloadRequest as HandleDownloadRequestFn,
  DownloadDeps,
} from '@/app/api/download/[videoId]/route';

let handleDownloadRequest: typeof HandleDownloadRequestFn;
let prisma: typeof import('@/lib/db')['prisma'];
let createMegaAccount: typeof import('@/lib/megaAccounts')['createMegaAccount'];
let MEGA_ACCOUNT_STATUSES: typeof import('@/lib/megaAccounts')['MEGA_ACCOUNT_STATUSES'];

after(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('sanitizeDownloadFilename keeps a normal original name', () => {
  assert.equal(sanitizeDownloadFilename('Creator - My Video [2024].mp4'), 'Creator - My Video [2024].mp4');
});

test('sanitizeDownloadFilename strips path traversal', () => {
  assert.equal(sanitizeDownloadFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeDownloadFilename('C:\\Users\\x\\video.mp4'), 'video.mp4');
  assert.equal(sanitizeDownloadFilename('a/b/c.mkv'), 'c.mkv');
});

test('sanitizeDownloadFilename removes illegal chars + header injection', () => {
  // '/' and '\' split path segments first, then illegal chars are removed.
  assert.equal(sanitizeDownloadFilename('a<b>c:"d"/e\\f|g?h*i.mp4'), 'fghi.mp4');
  const crlf = sanitizeDownloadFilename('evil.mp4\r\nX-Injected: 1');
  assert.ok(!/[\r\n]/.test(crlf), 'no CR/LF may survive');
  assert.equal(sanitizeDownloadFilename('  spaced .ts  '), 'spaced .ts'.trim());
});

test('sanitizeDownloadFilename preserves the original extension', () => {
  assert.ok(sanitizeDownloadFilename('movie.ts').endsWith('.ts'));
  assert.ok(sanitizeDownloadFilename('movie.MKV').endsWith('.MKV'));
});

test('sanitizeDownloadFilename truncates long names but keeps extension', () => {
  const long = `${'a'.repeat(300)}.mp4`;
  const out = sanitizeDownloadFilename(long);
  assert.ok(out.length <= 180, `length ${out.length}`);
  assert.ok(out.endsWith('.mp4'));
});

test('sanitizeDownloadFilename falls back to title, then video.bin', () => {
  assert.equal(sanitizeDownloadFilename(null, 'My Title', '.mp4'), 'My Title.mp4');
  assert.equal(sanitizeDownloadFilename('', null), 'video.bin');
  assert.equal(sanitizeDownloadFilename('...', null), 'video.bin');
  assert.equal(sanitizeDownloadFilename(null, null), 'video.bin');
});

test('mimeTypeForDownload prefers stored MIME, then extension, then octet-stream', () => {
  assert.equal(mimeTypeForDownload('video/mp4', 'x.ts'), 'video/mp4');
  assert.equal(mimeTypeForDownload(null, 'movie.mkv'), 'video/x-matroska');
  assert.equal(mimeTypeForDownload(null, 'clip.TS'), 'video/mp2t');
  assert.equal(mimeTypeForDownload(null, 'weird.xyz'), 'application/octet-stream');
  assert.equal(mimeTypeForDownload('text/html', 'movie.mp4'), 'video/mp4');
});

test('extensionForMimeType maps known types', () => {
  assert.equal(extensionForMimeType('video/mp4'), 'mp4');
  assert.equal(extensionForMimeType('video/mp2t'), 'ts');
  assert.equal(extensionForMimeType('application/octet-stream'), '');
  assert.equal(extensionForMimeType(null), '');
});

test('buildContentDisposition uses plain form for ASCII', () => {
  assert.equal(buildContentDisposition('video.mp4'), 'attachment; filename="video.mp4"');
});

test('buildContentDisposition uses filename* for non-ASCII', () => {
  const d = buildContentDisposition('vidéo finale.ts');
  assert.equal(d, `attachment; filename="vid_o finale.ts"; filename*=UTF-8''${encodeURIComponent('vidéo finale.ts')}`);
  assert.ok(!/[\r\n\\]/.test(d), 'no injection chars');
});

test('runBounded respects the concurrency limit', async () => {
  let active = 0;
  let maxActive = 0;
  const result = await runBounded([1, 2, 3, 4, 5, 6], 3, async () => {
    active++;
    if (active > maxActive) maxActive = active;
    await new Promise((r) => setTimeout(r, 10));
    active--;
  });
  assert.equal(result.completed.length, 6);
  assert.equal(result.failed.length, 0);
  assert.ok(maxActive <= 3, `maxActive=${maxActive}`);
  assert.equal(result.maxActive, maxActive);
});

test('runBounded isolates failures and keeps going', async () => {
  const seen: number[] = [];
  const result = await runBounded([1, 2, 3, 4], 2, async (n) => {
    seen.push(n);
    if (n === 2 || n === 4) throw new Error(`boom-${n}`);
  });
  assert.deepEqual(result.completed, [1, 3]);
  assert.equal(result.failed.length, 2);
  assert.deepEqual(
    result.failed.map((f) => f.item),
    [2, 4],
  );
  assert.ok(result.failed[0].error.includes('boom-2'));
  assert.deepEqual(seen.sort(), [1, 2, 3, 4]);
});

test('runBounded handles empty input and serial limit', async () => {
  const empty = await runBounded([], 3, async () => {});
  assert.deepEqual(empty.completed, []);
  assert.deepEqual(empty.failed, []);
  let maxActive = 0;
  let active = 0;
  await runBounded([1, 2], 1, async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
  });
  assert.equal(maxActive, 1);
});

// ---------------------------------------------------------------------------
// Route handler: real DB + real megajs ciphertext, fake MEGA boundary
// ---------------------------------------------------------------------------

const PLAIN = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7) & 0xff));
const EXPECTED = Buffer.from(PLAIN);
const encKey = Buffer.concat([Buffer.alloc(16, 0x33), Buffer.alloc(8, 0x44)]);
const encStream = encrypt(encKey);
const ctChunks: Buffer[] = [];
let CT = Buffer.alloc(0);
let FILE_KEY = Buffer.alloc(32);
encStream.on('data', (c: Buffer) => ctChunks.push(Buffer.from(c)));
encStream.on('end', () => {
  CT = Buffer.concat(ctChunks);
  FILE_KEY = Buffer.from(encStream.key);
});
encStream.end(PLAIN);

const UPSTREAM = 'https://gfs.test/fakedl';

function ciphertextResponse(url: string, status = 200): Response {
  if (status !== 200) return new Response(null, { status });
  const m = url.match(/\/(\d+)-(\d+)$/);
  const from = m ? Number(m[1]) : 0;
  const to = m ? Number(m[2]) : CT.length - 1;
  return new Response(Buffer.from(CT.subarray(from, to + 1)), { status: 200 });
}

function fakeDeps(overrides: Partial<DownloadDeps> = {}): DownloadDeps {
  return {
    withMegaSession: async (_acc, _enc, fn) => fn({ fake: 'storage' } as never),
    getDownloadUrl: async (): Promise<TemporaryDownloadUrl> => ({ url: UPSTREAM, size: PLAIN.length }),
    fetchCiphertext: async (url, signal) => {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return ciphertextResponse(url);
    },
    ...overrides,
  };
}

async function readBody(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer());
}

async function makeUser(suffix: string) {
  return prisma.user.create({
    data: {
      email: `dl-${suffix}@example.com`,
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

async function makeVideo(accountId: number, slug: string, overrides: Record<string, unknown> = {}) {
  return prisma.video.create({
    data: {
      megaAccountId: accountId,
      megaNodeId: `node-${slug}`,
      megaFilename: 'Creator - Original Clip.ts',
      title: 'Original Clip',
      slug,
      creatorAssignment: 'none',
      fileSize: BigInt(PLAIN.length),
      mimeType: 'video/mp2t',
      fileKeyEncrypted: encryptSecret(FILE_KEY),
      ...overrides,
    },
  });
}

before(async () => {
  ({ prisma } = await import('@/lib/db'));
  ({ createMegaAccount, MEGA_ACCOUNT_STATUSES } = await import('@/lib/megaAccounts'));
  ({ handleDownloadRequest } = await import('@/app/api/download/[videoId]/route'));
});

test('unauthenticated request is rejected (401)', async () => {
  const res = await handleDownloadRequest(null, '1', new AbortController().signal);
  assert.equal(res.status, 401);
});

test('invalid video id is rejected (400)', async () => {
  const u = await makeUser('badid');
  for (const bad of ['0', '-3', 'abc', '1.5']) {
    const res = await handleDownloadRequest(u.id, bad, new AbortController().signal, fakeDeps());
    assert.equal(res.status, 400, bad);
  }
});

test('owner downloads the ORIGINAL file byte-exact with correct headers', async () => {
  const u = await makeUser('owner');
  const acc = await makeAccount(u.id, 'owner@example.com');
  const v = await makeVideo(acc.id, 'owner-video');

  const res = await handleDownloadRequest(u.id, String(v.id), new AbortController().signal, fakeDeps());
  assert.equal(res.status, 200);
  // Original container MIME (.ts), NOT the playback remux (video/mp4).
  assert.equal(res.headers.get('content-type'), 'video/mp2t');
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="Creator - Original Clip.ts"');
  assert.equal(res.headers.get('content-length'), String(PLAIN.length));
  assert.equal(res.headers.get('accept-ranges'), null);
  assert.ok((await readBody(res)).equals(EXPECTED), 'GET must return exact decrypted original bytes');
});

test('another website user is rejected (404, no leak)', async () => {
  const owner = await makeUser('iso-owner');
  const acc = await makeAccount(owner.id, 'iso-owner@example.com');
  const v = await makeVideo(acc.id, 'iso-video');

  const other = await makeUser('iso-other');
  const res = await handleDownloadRequest(other.id, String(v.id), new AbortController().signal, fakeDeps());
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error?: string };
  assert.ok(!JSON.stringify(body).includes('iso-owner'), 'response must not leak owner info');
});

test('missing video answers 404', async () => {
  const u = await makeUser('missing');
  const res = await handleDownloadRequest(u.id, '999999', new AbortController().signal, fakeDeps());
  assert.equal(res.status, 404);
});

test('video without node/key answers 409', async () => {
  const u = await makeUser('nokey');
  const acc = await makeAccount(u.id, 'nokey@example.com');
  const v = await makeVideo(acc.id, 'nokey-video', { megaNodeId: null, fileKeyEncrypted: null });
  const res = await handleDownloadRequest(u.id, String(v.id), new AbortController().signal, fakeDeps());
  assert.equal(res.status, 409);
});

test('DISCONNECTED account answers 410 without touching MEGA', async () => {
  const u = await makeUser('disc');
  const acc = await makeAccount(u.id, 'disc@example.com');
  const v = await makeVideo(acc.id, 'disc-video');
  await prisma.megaAccount.update({
    where: { id: acc.id },
    data: { status: MEGA_ACCOUNT_STATUSES.DISCONNECTED },
  });
  let megaTouched = false;
  const res = await handleDownloadRequest(
    u.id,
    String(v.id),
    new AbortController().signal,
    fakeDeps({
      withMegaSession: async () => {
        megaTouched = true;
        throw new Error('must not be reached');
      },
    }),
  );
  assert.equal(res.status, 410);
  assert.equal(megaTouched, false);
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
  const res = await handleDownloadRequest(
    u.id,
    String(v.id),
    new AbortController().signal,
    fakeDeps({
      withMegaSession: async () => {
        megaTouched = true;
        throw new Error('must not be reached');
      },
    }),
  );
  assert.equal(res.status, 409);
  assert.equal(megaTouched, false);
});

test('HEAD answers metadata without touching MEGA', async () => {
  const u = await makeUser('head');
  const acc = await makeAccount(u.id, 'head@example.com');
  const v = await makeVideo(acc.id, 'head-video');
  let megaTouched = false;
  const res = await handleDownloadRequest(
    u.id,
    String(v.id),
    new AbortController().signal,
    fakeDeps({
      withMegaSession: async () => {
        megaTouched = true;
        throw new Error('must not be reached');
      },
      getDownloadUrl: async () => {
        megaTouched = true;
        throw new Error('must not be reached');
      },
    }),
    'HEAD',
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="Creator - Original Clip.ts"');
  assert.equal(res.headers.get('content-type'), 'video/mp2t');
  assert.equal(res.headers.get('content-length'), String(PLAIN.length));
  assert.equal(megaTouched, false);
});

test('HEAD enforces ownership too', async () => {
  const owner = await makeUser('head-iso-owner');
  const acc = await makeAccount(owner.id, 'head-iso-owner@example.com');
  const v = await makeVideo(acc.id, 'head-iso-video');
  const other = await makeUser('head-iso-other');
  const res = await handleDownloadRequest(other.id, String(v.id), new AbortController().signal, fakeDeps(), 'HEAD');
  assert.equal(res.status, 404);
});

test('persistent upstream 404 answers 410', async () => {
  const u = await makeUser('gone');
  const acc = await makeAccount(u.id, 'gone@example.com');
  const v = await makeVideo(acc.id, 'gone-video');
  const res = await handleDownloadRequest(
    u.id,
    String(v.id),
    new AbortController().signal,
    fakeDeps({ fetchCiphertext: async (url) => ciphertextResponse(url, 404) }),
  );
  assert.equal(res.status, 410);
});

test('upstream 509 answers retryable 503', async () => {
  const u = await makeUser('quota');
  const acc = await makeAccount(u.id, 'quota@example.com');
  const v = await makeVideo(acc.id, 'quota-video');
  const res = await handleDownloadRequest(
    u.id,
    String(v.id),
    new AbortController().signal,
    fakeDeps({ fetchCiphertext: async (url) => ciphertextResponse(url, 509) }),
  );
  assert.equal(res.status, 503);
});

test('expired MEGA session answers 409', async () => {
  const u = await makeUser('expired');
  const acc = await makeAccount(u.id, 'expired@example.com');
  const v = await makeVideo(acc.id, 'expired-video');
  const res = await handleDownloadRequest(
    u.id,
    String(v.id),
    new AbortController().signal,
    fakeDeps({
      withMegaSession: async () => {
        throw new MegaError('session-expired', 'sid rejected');
      },
    }),
  );
  assert.equal(res.status, 409);
});

test('aborted client cleans up instead of hanging (499)', async () => {
  const u = await makeUser('abort');
  const acc = await makeAccount(u.id, 'abort@example.com');
  const v = await makeVideo(acc.id, 'abort-video');
  const ctrl = new AbortController();
  ctrl.abort();
  const res = await handleDownloadRequest(u.id, String(v.id), ctrl.signal, fakeDeps());
  // Either the preflight fetch throws AbortError (499) or the route fails
  // safe; it must never hang and never return a 200 with a dead stream.
  assert.ok(res.status === 499 || res.status === 502, `status=${res.status}`);
});

test('two concurrent downloads both succeed independently', async () => {
  const u = await makeUser('concurrent');
  const acc = await makeAccount(u.id, 'concurrent@example.com');
  const v = await makeVideo(acc.id, 'concurrent-video');
  const deps = fakeDeps();
  const [a, b] = await Promise.all([
    handleDownloadRequest(u.id, String(v.id), new AbortController().signal, deps),
    handleDownloadRequest(u.id, String(v.id), new AbortController().signal, deps),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.ok((await readBody(a)).equals(EXPECTED));
  assert.ok((await readBody(b)).equals(EXPECTED));
});

test('unsafe stored filename is sanitized in the header', async () => {
  const u = await makeUser('sanitize');
  const acc = await makeAccount(u.id, 'sanitize@example.com');
  const v = await makeVideo(acc.id, 'sanitize-video', {
    megaFilename: '../../evil\r\nX: 1.mp4',
  });
  const res = await handleDownloadRequest(u.id, String(v.id), new AbortController().signal, fakeDeps());
  assert.equal(res.status, 200);
  const disp = res.headers.get('content-disposition') ?? '';
  assert.ok(!/[\r\n]/.test(disp), 'header must be injection-free');
  assert.ok(disp.startsWith('attachment; filename="'), disp);
});
