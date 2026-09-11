/**
 * Backfill: Video.duration via MPEG-TS PCR differencing (no full download).
 *
 * MEGA fa:8 media attributes are unretrievable for this library (ETEMPUNAVAIL
 * on every video tried), so exact durations come from Program Clock
 * References: decrypt a 1 MB head sample + 188-aligned 2 MB tail sample and
 * difference last-minus-first PCR (same PID), gated by plausibility against
 * the known file size. ~3 MB per video. Updates ONLY rows with NULL
 * duration. Request-time probing (live pipeline) covers the rest over time.
 *
 * Usage: npx tsx scripts/backfill-durations.mts [batchSize]
 */
import 'dotenv/config';

const BATCH = Number(process.argv[2] ?? 100);
const HEAD_BYTES = 1024 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;

async function main() {
  const { prisma } = await import('../lib/db');
  const { decryptSecret } = await import('../lib/mega/envelope');
  const { withMegaSession } = await import('../lib/sync/session-cache');
  const { getTemporaryDownloadUrl } = await import('../lib/mega/account');
  const { scanTsPcrDuration, pcrTailStart } = await import('../lib/media/remux');
  const { keepAliveFetch } = await import('../lib/net-resilience');
  const { decrypt: megaDecrypt } = await import('megajs');

  const rows = await prisma.video.findMany({
    where: { duration: null, megaAccountId: { not: null } },
    select: {
      id: true, fileSize: true, mimeType: true,
      megaNodeId: true, fileKeyEncrypted: true,
      megaAccount: { select: { id: true, encryptedSession: true } },
    },
    orderBy: { id: 'asc' },
    take: BATCH,
  });
  console.log(`null-duration rows in batch: ${rows.length}`);
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  async function decryptAt(fileKey: Buffer, cipher: Buffer, start: number): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const d = megaDecrypt(fileKey, { start, disableVerification: true });
      const chunks: Buffer[] = [];
      d.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
      d.on('end', () => resolve(Buffer.concat(chunks)));
      d.on('error', reject);
      d.end(Buffer.from(cipher));
    });
  }

  for (const row of rows) {
    if (!row.megaAccount || !row.fileKeyEncrypted || !row.megaNodeId || row.fileSize === null) {
      skipped++;
      continue;
    }
    // PCR probing only applies to MPEG-TS sources.
    if (row.mimeType !== null && row.mimeType !== 'video/mp2t' && row.mimeType !== 'video/mpeg') {
      skipped++;
      continue;
    }
    try {
      const size = Number(row.fileSize);
      const fileKey = decryptSecret(row.fileKeyEncrypted);
      const seconds = await withMegaSession(
        row.megaAccount.id,
        row.megaAccount.encryptedSession,
        async (storage: unknown) => {
          const dl = await getTemporaryDownloadUrl(storage as never, row.megaNodeId as string);
          // 752 = lcm(188, 16): aligns to both 188-byte TS packets and 16-byte AES-CTR blocks
          const tailStart = pcrTailStart(size);
          const [headRes, tailRes] = await Promise.all([
            keepAliveFetch(`${dl.url}/0-${Math.min(size - 1, HEAD_BYTES - 1)}`),
            keepAliveFetch(`${dl.url}/${tailStart}-${size - 1}`),
          ]);
          if (!headRes.ok || !headRes.body || !tailRes.ok || !tailRes.body) return null;
          const [headCipher, tailCipher] = await Promise.all([
            headRes.arrayBuffer().then((b) => Buffer.from(b)),
            tailRes.arrayBuffer().then((b) => Buffer.from(b)),
          ]);
          const [headPlain, tailPlain] = await Promise.all([
            decryptAt(fileKey, headCipher, 0),
            decryptAt(fileKey, tailCipher, Math.max(0, tailStart)),
          ]);
          return scanTsPcrDuration(headPlain, 0, tailPlain, Math.max(0, tailStart), size)?.seconds ?? null;
        },
      );
      if (seconds !== null) {
        await prisma.video.update({ where: { id: row.id }, data: { duration: Math.round(seconds) } });
        updated++;
        if (updated % 10 === 0) console.log(`  ...${updated} updated`);
      } else {
        failed++;
      }
    } catch (err) {
      failed++;
      console.log(`  id=${row.id} failed: ${err instanceof Error ? err.message.slice(0, 100) : typeof err}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`done: updated=${updated} skipped=${skipped} failed=${failed}`);
  await prisma.$disconnect();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('backfill failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
