/**
 * ONE-OFF backfill: Video.duration from MEGA fa:8 media properties.
 *
 * Read-only on MEGA (a=ufa metadata fetch, no media download). Updates ONLY
 * rows with duration NULL that carry a type-8 attribute. Polite delay
 * between accounts' attribute endpoints; per-video failures are logged and
 * skipped (request-time fetch covers them later).
 */
import 'dotenv/config';

const BATCH = Number(process.argv[2] ?? 200);

async function main() {
  const { prisma } = await import('./lib/db');
  const { decryptSecret } = await import('./lib/mega/envelope');
  const { withMegaSession } = await import('./lib/sync/session-cache');
  const { getPrivateNodeMediaProperties } = await import('./lib/mega/attributes');
  const { parseFa } = await import('./lib/mega/nodes');

  const rows = await prisma.video.findMany({
    where: { duration: null, megaAccountId: { not: null } },
    select: {
      id: true, megaFa: true, fileKeyEncrypted: true,
      megaAccount: { select: { id: true, encryptedSession: true } },
    },
    orderBy: { id: 'asc' },
    take: BATCH,
  });
  console.log(`videos with null duration: at least ${rows.length} (batch ${BATCH})`);
  let updated = 0;
  let skippedNoFa8 = 0;
  let failed = 0;
  for (const row of rows) {
    if (!row.megaAccount || !row.fileKeyEncrypted || !parseFa(row.megaFa)[8]) {
      skippedNoFa8++;
      continue;
    }
    try {
      const fileKey = decryptSecret(row.fileKeyEncrypted);
      const seconds = await withMegaSession(
        row.megaAccount.id,
        row.megaAccount.encryptedSession,
        async (storage: unknown) => {
          const s = storage as { api: { request: (cmd: Record<string, unknown>) => Promise<unknown> } };
          const api = { request: (cmd: Record<string, unknown>) => s.api.request.call(s.api, cmd) };
          const media = await getPrivateNodeMediaProperties(api, row.megaFa, fileKey);
          return media?.durationSeconds ?? null;
        },
      );
      if (seconds !== null) {
        await prisma.video.update({ where: { id: row.id }, data: { duration: seconds } });
        updated++;
        if (updated % 25 === 0) console.log(`  ...${updated} updated`);
      } else {
        failed++;
      }
    } catch (err) {
      failed++;
      console.log(`  id=${row.id} failed: ${err instanceof Error ? err.message.slice(0, 100) : typeof err}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`done: updated=${updated} noFa8=${skippedNoFa8} failed=${failed}`);
  await prisma.$disconnect();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('backfill failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
