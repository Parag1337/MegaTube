/**
 * ONE-OFF database metadata correction for Phase 4 (MegaAccount #1).
 *
 * Uses the EXISTING synced node identity: resumes the stored session
 * (no password), fetches the node tree read-only (a=f), decrypts the real
 * filenames with the FIXED decoder, and updates ONLY the wrong metadata
 * (megaFilename, title, slug, creator, mimeType).
 *
 * Never touched: megaNodeId, ownership, thumbnails, file keys, sync metadata.
 * No MEGA write operation of any kind.
 */
import 'dotenv/config';
import { applyNetworkResilience } from '../lib/net-resilience';

applyNetworkResilience();

interface CorrectionStats {
  scanned: number;
  corrected: number;
  skippedNoName: number;
  alreadyCorrect: number;
}

async function main() {
  const { prisma } = await import('../lib/db');
  const { decryptSecret } = await import('../lib/mega/envelope');
  const { openMegaSession, fetchAccountFileNodes } = await import('../lib/mega/account');
  const { isVideoNode, mimeFromVideoExtension } = await import('../lib/mega/nodes');
  const { parseVideoMetadata, uniqueSlug, ensureCreatorForUser, normalizeCreatorName } = await import('../lib/titles');

  const CDN_SUFFIX_RE = /_-_(?:VOE|CDN|Content_Delivery|Video_Cloud)[^.]*\.[^.]+$/i;

  function detectMimeType(filename: string): string {
    if (CDN_SUFFIX_RE.test(filename)) return 'video/mp2t';
    const ext = filename.split('.').pop()?.toLowerCase();
    if (ext === 'ts') return 'video/mp2t';
    return mimeFromVideoExtension(filename) ?? 'video/mp4';
  }

  const ACCOUNT_ID = 1;

  const accountRow = await prisma.megaAccount.findUnique({
    where: { id: ACCOUNT_ID },
    select: { encryptedSession: true },
  });
  if (!accountRow?.encryptedSession) throw new Error('no stored session');
  const storage = await openMegaSession(
    JSON.parse(decryptSecret(accountRow.encryptedSession).toString('utf8')) as Parameters<typeof openMegaSession>[0],
  );
  const nodes = await fetchAccountFileNodes(storage);
  const byNode = new Map(nodes.filter((n) => n.name && isVideoNode(n.name, n.fa)).map((n) => [n.h, n]));
  console.log(`remote video nodes with decrypted names: ${byNode.size}`);

  const rows = await prisma.video.findMany({
    where: { megaAccountId: ACCOUNT_ID },
    select: { id: true, megaNodeId: true, megaFilename: true, title: true, slug: true, mimeType: true, creatorId: true },
  });
  console.log(`existing Video rows: ${rows.length}`);

  const stats: CorrectionStats = { scanned: rows.length, corrected: 0, skippedNoName: 0, alreadyCorrect: 0 };

  for (const row of rows) {
    const node = row.megaNodeId ? byNode.get(row.megaNodeId) : undefined;
    if (!node?.name) {
      stats.skippedNoName++;
      continue;
    }
    const parsed = parseVideoMetadata(node.name);
    const mimeType = detectMimeType(node.name);
    const titleOk = row.title === parsed.title;
    const fileOk = row.megaFilename === node.name;
    const mimeOk = row.mimeType === mimeType;
    if (titleOk && fileOk && mimeOk && row.creatorId !== null === (parsed.creator !== null)) {
      stats.alreadyCorrect++;
      continue;
    }

    let creatorId: number | null | undefined = undefined;
    if (parsed.creator) {
      const creator = await ensureCreatorForUser(userId, normalizeCreatorName(parsed.creator));
      creatorId = creator.id;
    } else {
      creatorId = null;
    }

    // Keep the slug stable when the title is already the correct one;
    // otherwise derive a fresh unique slug from the corrected title.
    const slug = titleOk ? row.slug : await uniqueSlug(parsed.title);

    await prisma.video.update({
      where: { id: row.id },
      data: {
        megaFilename: node.name,
        title: parsed.title,
        slug,
        mimeType,
        creatorAssignment: parsed.creator ? 'auto' : 'none',
        creatorId,
      },
    });
    stats.corrected++;
  }

  console.log('correction stats:', JSON.stringify(stats));

  // Verification sample.
  const sample = await prisma.video.findMany({
    where: { megaAccountId: ACCOUNT_ID },
    select: { title: true, megaFilename: true, mimeType: true, creator: { select: { name: true } } },
    take: 5,
    orderBy: { id: 'asc' },
  });
  console.log('sample after correction:');
  for (const s of sample) {
    console.log(`  title=${JSON.stringify(s.title)} creator=${JSON.stringify(s.creator?.name ?? null)} mime=${s.mimeType}`);
  }

  await prisma.$disconnect();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('correction failed:', err instanceof Error ? err.stack : err);
    process.exit(1);
  },
);
