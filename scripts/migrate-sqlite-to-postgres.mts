/**
 * One-shot data migration: SQLite -> PostgreSQL.
 *
 * SAFETY:
 *   - SQLite is opened READ-ONLY (`readonly: true` + `fileMustExist`) and
 *     never written. The -wal/-shm sidecar files are NOT touched: the main
 *     database file is only opened in readonly mode and no checkpoint is
 *     ever requested.
 *   - Writes go ONLY to the local PostgreSQL database given via
 *     TARGET_DATABASE_URL (defaults to the local dev database below).
 *   - IDs, timestamps, BigInt values and encrypted payloads are copied
 *     byte-for-byte; nothing is regenerated or transformed.
 *   - VideoSearch (the old SQLite FTS index) is NOT copied: PostgreSQL has
 *     its own trigger-maintained search structures (see
 *     prisma/migrations/20260914150000_postgres_search) that populate and
 *     stay current automatically.
 *   - Sequences are reset afterwards so future inserts continue after the
 *     imported max IDs.
 *
 * Usage:
 *   npx tsx scripts/migrate-sqlite-to-postgres.mts [--sqlite path/to/app.db] [--dry-run]
 */

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { PrismaPg } from '@prisma/adapter-pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
function argValue(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
const SQLITE_PATH = path.resolve(
  PROJECT_ROOT,
  argValue('--sqlite') ?? 'data/database/app.db',
);
const TARGET_URL =
  argValue('--target') ??
  process.env.TARGET_DATABASE_URL ??
  'postgresql://megatube:megatube-dev-only@localhost:5433/megatube?schema=public';
const DRY_RUN = args.includes('--dry-run');

type Row = Record<string, unknown>;

async function main(): Promise<void> {
  // --- SQLite (READ-ONLY) ---------------------------------------------------
  const sqlite = new Database(SQLITE_PATH, { readonly: true, fileMustExist: true });
  const rows = {
    user: sqlite.prepare('SELECT * FROM "User" ORDER BY "id"').all() as Row[],
    creator: sqlite.prepare('SELECT * FROM "Creator" ORDER BY "id"').all() as Row[],
    megaAccount: sqlite.prepare('SELECT * FROM "MegaAccount" ORDER BY "id"').all() as Row[],
    session: sqlite.prepare('SELECT * FROM "Session" ORDER BY "id"').all() as Row[],
    video: sqlite.prepare('SELECT * FROM "Video" ORDER BY "id"').all() as Row[],
    watchlistItem: sqlite.prepare('SELECT * FROM "WatchlistItem" ORDER BY "id"').all() as Row[],
    savedFolder: sqlite.prepare('SELECT * FROM "SavedFolder" ORDER BY "id"').all() as Row[],
    savedVideo: sqlite.prepare('SELECT * FROM "SavedVideo" ORDER BY "id"').all() as Row[],
    watchHistory: sqlite.prepare('SELECT * FROM "WatchHistory" ORDER BY "id"').all() as Row[],
  };
  console.log(
    `[sqlite] counts: ` +
      Object.entries(rows)
        .map(([k, v]) => `${k}=${v.length}`)
        .join(', '),
  );

  // --- PostgreSQL target ----------------------------------------------------
  const { PrismaClient } = await import(
    path.resolve(PROJECT_ROOT, 'generated/client') /* relative import survives .mts transpile */
  );

  const adapter = new PrismaPg({ connectionString: TARGET_URL });
  const prisma = new PrismaClient({ adapter });

  // BigInt rendering for logs only.
  BigInt.prototype.toJSON = function (this: bigint) {
    return this.toString();
  };

  // Import in dependency order. Chunked so a 1000-row table stays well
  // under parameter limits.
  async function insertChunked(
    table: 'user' | 'creator' | 'megaAccount' | 'session' | 'video' | 'watchlistItem' | 'savedFolder' | 'savedVideo' | 'watchHistory',
    list: Row[],
    batchSize = 200,
  ): Promise<number> {
    let done = 0;
    for (let i = 0; i < list.length; i += batchSize) {
      const chunk = list.slice(i, i + batchSize);
      // createMany with skipDuplicates would silently skip; individual
      // creates in one transaction instead surface ANY conflict loudly.
      await prisma.$transaction(
        chunk.map((row) => (prisma[table] as never as { create: (a: unknown) => unknown }).create({ data: row })),
      );
      done += chunk.length;
      process.stdout.write(`\r[${table}] ${done}/${list.length}`);
    }
    if (list.length > 0) process.stdout.write('\n');
    return done;
  }

  // SQLite stores booleans as 0/1 and DATETIME as UTC "YYYY-MM-DD
  // HH:MM:SS" strings; PostgreSQL needs real booleans and timestamps. The
  // string MUST be normalized to an explicit UTC ISO form before parsing:
  // `new Date("2026-01-01 10:00:00")` (space-separated) parses as LOCAL
  // time, which would silently shift every timestamp by the host's UTC
  // offset. Passing the ISO string itself keeps the value byte-exact.
  function toDate(v: unknown): string | null {
    if (v == null) return null;
    if (typeof v === 'number') return new Date(v).toISOString();
    const s = String(v);
    // "YYYY-MM-DD HH:MM:SS[.SSS]" -> "YYYY-MM-DDTHH:MM:SS[.SSS]Z"
    const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(?:Z)?$/.exec(s);
    if (!m) return new Date(s).toISOString(); // ISO already, or fallback
    return `${m[1]}T${m[2]}Z`;
  }
  const toBool = (v: unknown): boolean | null => (v == null ? null : v === 1);

  const users = rows.user.map((r) => ({
    id: r.id as string,
    email: r.email as string,
    passwordHash: r.passwordHash as string,
    clerkUserId: (r.clerkUserId as string | null) ?? null,
    createdAt: toDate(r.createdAt)!,
    updatedAt: toDate(r.updatedAt)!,
  }));

  const creators = rows.creator.map((r) => ({
    id: r.id as number,
    userId: r.userId as string,
    name: r.name as string,
    slug: r.slug as string,
    avatar: r.avatar as string | null,
    description: r.description as string | null,
    createdAt: toDate(r.createdAt)!,
    updatedAt: toDate(r.updatedAt)!,
  }));

  const megaAccounts = rows.megaAccount.map((r) => ({
    id: r.id as number,
    userId: r.userId as string,
    label: r.label as string,
    megaEmail: r.megaEmail as string,
    megaUserId: r.megaUserId as string | null,
    encryptedSession: r.encryptedSession as string,
    status: r.status as string,
    lastAuthenticatedAt: toDate(r.lastAuthenticatedAt),
    lastSyncStartedAt: toDate(r.lastSyncStartedAt),
    lastSyncCompletedAt: toDate(r.lastSyncCompletedAt),
    lastSyncErrorAt: toDate(r.lastSyncErrorAt),
    lastSyncError: r.lastSyncError as string | null,
    consecutiveSyncFailures: r.consecutiveSyncFailures as number,
    videoCount: r.videoCount as number,
    createdAt: toDate(r.createdAt)!,
    updatedAt: toDate(r.updatedAt)!,
    lastSyncMeta: r.lastSyncMeta as string | null,
  }));

  const sessions = rows.session.map((r) => ({
    id: r.id as string,
    userId: r.userId as string,
    token: r.token as string,
    expiresAt: toDate(r.expiresAt)!,
    createdAt: toDate(r.createdAt)!,
  }));

  const videos = rows.video.map((r) => ({
    id: r.id as number,
    megaAccountId: r.megaAccountId as number | null,
    megaUrl: r.megaUrl as string | null,
    megaFileId: r.megaFileId as string | null,
    megaFileKey: r.megaFileKey as string | null,
    megaFilename: r.megaFilename as string,
    megaNodeId: r.megaNodeId as string | null,
    parentNodeId: r.parentNodeId as string | null,
    fileKeyEncrypted: r.fileKeyEncrypted as string | null,
    title: r.title as string,
    slug: r.slug as string,
    creatorId: r.creatorId as number | null,
    creatorAssignment: r.creatorAssignment as string | null,
    fileSize: r.fileSize == null ? null : BigInt(r.fileSize as string | number),
    mimeType: r.mimeType as string | null,
    duration: r.duration as number | null,
    mp4Faststart: toBool(r.mp4Faststart),
    thumbnail: r.thumbnail as string | null,
    thumbnailAvailable: r.thumbnailAvailable === 1,
    embedUrl: r.embedUrl as string | null,
    sortOrder: r.sortOrder as number,
    tags: r.tags as string | null,
    createdAt: toDate(r.createdAt)!,
    updatedAt: toDate(r.updatedAt)!,
    megaFa: r.megaFa as string | null,
    megaModifiedAt: toDate(r.megaModifiedAt),
  }));

  const watchlistItems = rows.watchlistItem.map((r) => ({
    id: r.id as number,
    userId: r.userId as string,
    videoId: r.videoId as number,
    createdAt: toDate(r.createdAt)!,
  }));

  const savedFolders = rows.savedFolder.map((r) => ({
    id: r.id as number,
    userId: r.userId as string,
    name: r.name as string,
    createdAt: toDate(r.createdAt)!,
  }));

  const savedVideos = rows.savedVideo.map((r) => ({
    id: r.id as number,
    userId: r.userId as string,
    videoId: r.videoId as number,
    folderId: r.folderId as number | null,
    createdAt: toDate(r.createdAt)!,
  }));

  const watchHistory = rows.watchHistory.map((r) => ({
    id: r.id as number,
    userId: r.userId as string,
    videoId: r.videoId as number,
    lastWatchedAt: toDate(r.lastWatchedAt)!,
    createdAt: toDate(r.createdAt)!,
  }));

  if (DRY_RUN) {
    console.log('[dry-run] no writes performed.');
    console.log(`  user=${users.length} creator=${creators.length} megaAccount=${megaAccounts.length}`);
    console.log(`  session=${sessions.length} video=${videos.length}`);
    console.log(
      `  watchlistItem=${watchlistItems.length} savedFolder=${savedFolders.length} savedVideo=${savedVideos.length} watchHistory=${watchHistory.length}`,
    );
    await prisma.$disconnect();
    sqlite.close();
    return;
  }

  console.log('[postgres] wiping target tables (dependency-safe order)...');
  // Dependency-safe truncate: children first. TRUNCATE ... CASCADE would
  // also clear unrelated tables; explicit deletes keep the blast radius
  // exactly these nine tables.
  await prisma.$transaction([
    prisma.watchHistory.deleteMany(),
    prisma.savedVideo.deleteMany(),
    prisma.savedFolder.deleteMany(),
    prisma.watchlistItem.deleteMany(),
    prisma.video.deleteMany(),
    prisma.session.deleteMany(),
    prisma.megaAccount.deleteMany(),
    prisma.creator.deleteMany(),
    prisma.user.deleteMany(),
  ]);

  console.log('[postgres] importing (dependency order)...');
  const counts = {
    user: await insertChunked('user', users),
    creator: await insertChunked('creator', creators),
    megaAccount: await insertChunked('megaAccount', megaAccounts),
    session: await insertChunked('session', sessions),
    video: await insertChunked('video', videos),
    watchlistItem: await insertChunked('watchlistItem', watchlistItems),
    savedFolder: await insertChunked('savedFolder', savedFolders),
    savedVideo: await insertChunked('savedVideo', savedVideos),
    watchHistory: await insertChunked('watchHistory', watchHistory),
  };

  console.log('[postgres] resetting sequences...');
  // SERIAL sequences must continue past the imported max IDs. Empty tables
  // get setval(seq, 1, false) so the next value is 1 (setval(x, 0, true)
  // would be out of range).
  for (const table of [
    'Creator',
    'Video',
    'MegaAccount',
    'WatchlistItem',
    'SavedFolder',
    'SavedVideo',
    'WatchHistory',
  ] as const) {
    await prisma.$executeRawUnsafe(
      `SELECT setval(
         pg_get_serial_sequence('"${table}"', 'id'),
         GREATEST((SELECT COALESCE(MAX("id"), 0) FROM "${table}"), 1),
         (SELECT MAX("id") IS NOT NULL FROM "${table}")
       )`,
    );
  }

  console.log('[postgres] verifying counts...');
  const pgCounts = {
    user: await prisma.user.count(),
    creator: await prisma.creator.count(),
    megaAccount: await prisma.megaAccount.count(),
    session: await prisma.session.count(),
    video: await prisma.video.count(),
    watchlistItem: await prisma.watchlistItem.count(),
    savedFolder: await prisma.savedFolder.count(),
    savedVideo: await prisma.savedVideo.count(),
    watchHistory: await prisma.watchHistory.count(),
  };
  let mismatch = false;
  for (const key of Object.keys(counts) as (keyof typeof counts)[]) {
    if (counts[key] !== pgCounts[key]) {
      mismatch = true;
      console.error(`  MISMATCH ${key}: sqlite=${counts[key]} postgres=${pgCounts[key]}`);
    }
  }
  if (mismatch) {
    throw new Error('PostgreSQL counts do not match the imported SQLite counts.');
  }
  console.log('  all counts match.');

  // Search index sanity: the triggers must have populated VideoSearch.
  const searchRows = (await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT COUNT(*) AS n FROM "VideoSearch"`,
  )) as Array<{ n: bigint }>;
  const indexed = Number(searchRows[0]?.n ?? 0);
  console.log(`[postgres] VideoSearch rows: ${indexed} (expected ${pgCounts.video})`);
  if (indexed !== pgCounts.video) {
    throw new Error('VideoSearch did not backfill to the Video count.');
  }

  console.log('[done] migration complete.');
  await prisma.$disconnect();
  sqlite.close();
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exitCode = 1;
});
