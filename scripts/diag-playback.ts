/**
 * ONE-OFF playback diagnostic for Phase 4 (real video, MegaAccount #1).
 *
 * - Mints a temporary website session row for the account OWNER (server-side
 *   only; deleted at the end). No MEGA password is involved anywhere.
 * - Exercises GET /api/media/<videoId> with: full GET, Range 0-1023,
 *   Range 1024-2047, and a bogus Range; records status/headers/sizes.
 * - Saves the first decrypted bytes and inspects the MP4 container signature.
 * - NEVER logs credentials, session tokens, or file keys.
 */
import 'dotenv/config';
import crypto from 'node:crypto';

const BASE = 'http://localhost:3000';

async function main() {
  const { prisma } = await import('../lib/db');

  // The owner of MegaAccount #1 (verified in the Phase 3 isolation check).
  const account = await prisma.megaAccount.findUnique({
    where: { id: 1 },
    select: { userId: true },
  });
  if (!account) throw new Error('account #1 missing');

  const video = await prisma.video.findFirst({
    where: { megaAccountId: 1, megaNodeId: 'zwxgTTzB' },
    select: { id: true, title: true, megaFilename: true, mimeType: true, fileSize: true },
  });
  if (!video) throw new Error('test video not found');
  console.log('video under test:', JSON.stringify({ id: video.id, title: video.title, mime: video.mimeType, size: Number(video.fileSize ?? 0) }));

  // Temporary website session for the owner.
  const token = crypto.randomBytes(32).toString('hex');
  await prisma.session.create({
    data: { userId: account.userId, token, expiresAt: new Date(Date.now() + 10 * 60_000) },
  });

  try {
    const get = (path: string, headers: Record<string, string> = {}) =>
      fetch(`${BASE}${path}`, { headers: { cookie: `session_token=${token}`, ...headers }, redirect: 'manual' });

    // 1) Authorization checks ------------------------------------------------
    const anon = await fetch(`${BASE}/api/media/${video.id}`, { redirect: 'manual' });
    console.log('anon GET status:', anon.status);

    // 2) Range 0-1023 (plaintext head) ---------------------------------------
    const fullRes = await get(`/api/media/${video.id}`, { range: 'bytes=0-1023' });
    const buf0 = Buffer.from(await fullRes.arrayBuffer());
    console.log('Range 0-1023:', fullRes.status, 'content-range:', fullRes.headers.get('content-range'), 'content-length:', fullRes.headers.get('content-length'), 'actual bytes:', buf0.length);
    console.log('first 16 bytes (hex):', buf0.subarray(0, 16).toString('hex'));
    console.log('first 12 bytes (ascii):', JSON.stringify(buf0.subarray(0, 12).toString('latin1')));

    // 3) Non-zero range ------------------------------------------------------
    const r2 = await get(`/api/media/${video.id}`, { range: 'bytes=1024-2047' });
    const buf2 = Buffer.from(await r2.arrayBuffer());
    console.log('Range 1024-2047:', r2.status, 'content-range:', r2.headers.get('content-range'), 'actual bytes:', buf2.length);

    // 4) Invalid range -------------------------------------------------------
    const r3 = await get(`/api/media/${video.id}`, { range: 'bytes=999999999-' });
    console.log('Range beyond EOF:', r3.status, r3.headers.get('content-range'));

    // 5) Signature checks ----------------------------------------------------
    // MEGA plaintext MP4 begins with "....ftyp" (box size + ftyp brand).
    const ftypOffset = buf0.indexOf('ftyp', 0, 'latin1');
    console.log('ftyp box found at offset:', ftypOffset, '(expected 4 for standard MP4)');
    const looksMp4 = ftypOffset >= 0 && ftypOffset <= 8;
    console.log('plaintext MP4 container signature:', looksMp4 ? 'VALID' : 'NOT FOUND - bytes may not be decrypted plaintext');

    // 6) NON-ALIGNED start (start % 16 !== 0): byte-correctness --------------
    // Chrome seeks with arbitrary offsets; the route must return the exact
    // plaintext slice regardless of 16-byte alignment.
    const refRes = await get(`/api/media/${video.id}`, { range: 'bytes=0-2047' });
    const ref = Buffer.from(await refRes.arrayBuffer());
    const na = await get(`/api/media/${video.id}`, { range: 'bytes=10-1033' });
    const naBuf = Buffer.from(await na.arrayBuffer());
    // bytes 10..1033 inclusive = 1024 bytes = ref[10..1034)
    const expected = ref.subarray(10, 1034);
    const naOk = naBuf.length === expected.length && naBuf.equals(expected);
    console.log('NON-ALIGNED Range 10-1033:', na.status, 'len:', naBuf.length, 'bytes correct:', naOk);

    // 7) Tail of the file (moov usually lives at the end) ---------------------
    const size = 509291490;
    const tailStart = size - 4096; // 509287394 -> %16 != 0 (non-aligned)
    const tail = await get(`/api/media/${video.id}`, { range: `bytes=${tailStart}-` });
    const tailBuf = Buffer.from(await tail.arrayBuffer());
    const refTailStart = tailStart - (tailStart % 16);
    const refTail = await get(`/api/media/${video.id}`, { range: `bytes=${refTailStart}-${size - 1}` });
    const refTailBuf = Buffer.from(await refTail.arrayBuffer());
    const tailExpected = refTailBuf.subarray(tailStart - refTailStart);
    const tailOk = tailBuf.length === tailExpected.length && tailBuf.equals(tailExpected);
    console.log('TAIL Range (non-aligned):', tail.status, 'len:', tailBuf.length, 'bytes correct:', tailOk);
    console.log('tail contains moov:', tailBuf.includes('moov', 0, 'latin1'), '| avc1:', tailBuf.includes('avc1', 0, 'latin1'), '| hvc1/hev1:', tailBuf.includes('hvc1', 0, 'latin1') || tailBuf.includes('hev1', 0, 'latin1'), '| av01:', tailBuf.includes('av01', 0, 'latin1'), '| mp4a:', tailBuf.includes('mp4a', 0, 'latin1'));

    // 8) Full GET: verify headers + that the stream delivers real plaintext
    // progressively. Do NOT buffer the whole 509MB (client body timeouts);
    // read the first 2 MiB, check them against the ranged reference, cancel.
    const noRange = await get(`/api/media/${video.id}`);
    console.log('full GET (no Range):', noRange.status, 'content-length:', noRange.headers.get('content-length'));
    if (noRange.body) {
      const reader = noRange.body.getReader();
      const headChunks: Buffer[] = [];
      let headLen = 0;
      while (headLen < 2 * 1024 * 1024) {
        const { done, value } = await reader.read();
        if (done) break;
        headChunks.push(Buffer.from(value));
        headLen += value.length;
      }
      await reader.cancel().catch(() => {});
      const nrHead = Buffer.concat(headChunks);
      console.log('full GET streamed bytes before cancel:', nrHead.length, '| head correct:', nrHead.subarray(0, 2048).equals(ref));
    }
  } finally {
    await prisma.session.deleteMany({ where: { token } });
    await prisma.$disconnect();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('diag failed:', err instanceof Error ? err.stack : err);
    process.exit(1);
  },
);
