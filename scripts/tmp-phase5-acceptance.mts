/**
 * Phase 5 real-data acceptance harness (MegaAccount #1, real synced videos).
 *
 * Reproduces the intermittent playback failure: repeated requests, multiple
 * videos, concurrent requests, browser-style range sequences. Verifies
 * status/headers and that the plaintext is valid MP4 (ftyp) — the exact
 * properties whose absence made Chrome show
 * "No video with supported format and MIME type found".
 */
import 'dotenv/config';
import crypto from 'node:crypto';

const BASE = 'http://localhost:3000';

interface VideoRef {
  id: number;
  slug: string;
  title: string;
  size: number;
}

async function main() {
  const { prisma } = await import('../lib/db');
  const account = await prisma.megaAccount.findUnique({ where: { id: 1 }, select: { userId: true } });
  if (!account) throw new Error('account #1 missing');

  const videos = await prisma.video.findMany({
    where: { megaAccountId: 1 },
    orderBy: { id: 'desc' },
    take: 4,
    select: { id: true, slug: true, title: true, fileSize: true },
  });
  if (videos.length < 2) throw new Error('need at least 2 videos');
  const refs: VideoRef[] = videos.map((v) => ({ id: v.id, slug: v.slug, title: v.title, size: Number(v.fileSize ?? 0) }));

  const token = crypto.randomBytes(32).toString('hex');
  await prisma.session.create({ data: { userId: account.userId, token, expiresAt: new Date(Date.now() + 10 * 60_000) } });

  const get = (videoId: number, range: string | null) =>
    fetch(`${BASE}/api/media/${videoId}`, {
      headers: { cookie: `session_token=${token}`, ...(range ? { range } : {}) },
      redirect: 'manual',
    });

  /**
   * Read AT MOST maxBytes from a response, then cancel. Prevents the harness
   * from pulling 100 MB open-ended bodies (client-side timeouts killed the
   * previous run mid-stream with "terminated").
   */
  async function readCapped(res: Response, maxBytes: number): Promise<{ buf: Buffer; truncated: boolean }> {
    if (!res.body) return { buf: Buffer.alloc(0), truncated: false };
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      total += value.length;
      if (total >= maxBytes) {
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
    }
    return { buf: Buffer.concat(chunks), truncated };
  }

  const failures: string[] = [];
  let checks = 0;

  function check(cond: boolean, label: string) {
    checks++;
    if (!cond) failures.push(label);
  }

  try {
    // ---- 1) Repeated requests to the SAME video (the intermittent bug) ----
    console.log(`--- repeated playback: video ${refs[0].id} "${refs[0].title}" x 8 ---`);
    for (let i = 1; i <= 8; i++) {
      const t0 = Date.now();
      const res = await get(refs[0].id, 'bytes=0-1023');
      const buf = Buffer.from(await res.arrayBuffer());
      const ftyp = buf.indexOf('ftyp', 0, 'latin1');
      check(res.status === 206, `repeat ${i}: status ${res.status}`);
      check(buf.length === 1024, `repeat ${i}: length ${buf.length}`);
      check(ftyp >= 0 && ftyp <= 8, `repeat ${i}: ftyp at ${ftyp} (invalid plaintext)`);
      check(res.headers.get('content-range') === `bytes 0-1023/${refs[0].size}`, `repeat ${i}: content-range`);
      check(res.headers.get('accept-ranges') === 'bytes', `repeat ${i}: accept-ranges`);
      console.log(`  attempt ${i}: ${res.status} ${Date.now() - t0}ms ftyp@${ftyp}`);
    }

    // ---- 2) Browser-style range sequence on one video ----
    console.log('--- browser-style range sequence (metadata/seek/tail) ---');
    const tailStart = Math.max(0, refs[0].size - 1289186);
    for (const r of ['bytes=0-', `bytes=${tailStart}-`, 'bytes=32768-', 'bytes=17924096-']) {
      const res = await get(refs[0].id, r);
      const { buf, truncated } = await readCapped(res, 2 * 1024 * 1024);
      check(res.status === 206, `seq ${r}: status ${res.status}`);
      check((res.headers.get('accept-ranges') ?? '') === 'bytes', `seq ${r}: accept-ranges`);
      check(buf.length > 0, `seq ${r}: body empty`);
      console.log(`  ${r} -> ${res.status} read=${buf.length}${truncated ? ' (capped)' : ''} len=${res.headers.get('content-length')}`);
    }

    // ---- 3) Different videos ----
    console.log('--- different videos ---');
    for (const v of refs.slice(1)) {
      const res = await get(v.id, 'bytes=0-1023');
      const buf = Buffer.from(await res.arrayBuffer());
      const ftyp = buf.indexOf('ftyp', 0, 'latin1');
      check(res.status === 206, `video ${v.id}: status ${res.status}`);
      check(ftyp >= 0 && ftyp <= 8, `video ${v.id}: ftyp at ${ftyp}`);
      console.log(`  video ${v.id} "${v.title}": ${res.status} ftyp@${ftyp}`);
    }

    // ---- 4) Concurrent requests (browser prefetch behavior) ----
    console.log('--- 6 concurrent range requests ---');
    const concurrent = await Promise.all(
      ['bytes=0-1023', 'bytes=1024-2047', 'bytes=10-1033', 'bytes=1024-2047', 'bytes=0-1023', 'bytes=-512'].map((r) => get(refs[0].id, r)),
    );
    for (const res of concurrent) {
      check(res.status === 206, `concurrent: status ${res.status}`);
      check((res.headers.get('accept-ranges') ?? '') === 'bytes', 'concurrent: accept-ranges');
    }
    console.log(`  statuses: ${concurrent.map((r) => r.status).join(', ')}`);

    // ---- 5) Non-aligned byte-exactness spot check (regression) ----
    const ref = (await readCapped(await get(refs[0].id, 'bytes=0-2047'), 4096)).buf;
    const na = (await readCapped(await get(refs[0].id, 'bytes=10-1033'), 4096)).buf;
    check(na.equals(ref.subarray(10, 1034)), 'non-aligned 10-1033 byte-exact');
    console.log('--- non-aligned 10-1033 byte-exact: OK ---');

    // ---- 6) Beyond EOF ----
    const eof = await get(refs[0].id, 'bytes=999999999-');
    check(eof.status === 416, `beyond EOF: ${eof.status}`);
    console.log(`--- beyond EOF: ${eof.status} ---`);

    console.log(`\nRESULT: ${checks - failures.length}/${checks} checks passed`);
    if (failures.length) {
      console.log('FAILURES:');
      for (const f of failures) console.log(' -', f);
      process.exitCode = 1;
    } else {
      console.log('ALL REAL-DATA CHECKS PASS');
    }
  } finally {
    await prisma.session.deleteMany({ where: { token } });
    await prisma.$disconnect();
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    console.error('harness failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
