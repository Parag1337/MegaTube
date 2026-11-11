/**
 * PERF seed: synthetic but realistic data for the localhost performance
 * investigation (docs/LOCALHOST-PERFORMANCE-INVESTIGATION.md).
 *
 * Creates:
 *   - one legacy-session user (cookie auth for curl measurements)
 *   - one linked MegaAccount (fake encrypted session; never used for real
 *     MEGA calls in the measured flows)
 *   - N videos with realistic titles/slugs/durations/sizes
 *   - watch history for a subset (exercises the history/recommended pools)
 *   - watchlist + saved rows
 *   - local thumbnail files copied from data/thumbs for a subset
 *
 * Run: DATABASE_URL=... npx tsx scripts/seed-perf.mts [--videos 240]
 * Idempotent: wipes and recreates rows for the seed user only.
 */

import { PrismaClient } from '../generated/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../lib/auth';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const nVideos = Number(args[args.indexOf('--videos') + 1]) || 240;
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    'postgresql://megatube:megatube-dev-only@localhost:5433/megatube?schema=public',
  max: 5,
});
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const EMAIL = 'perf-investigation@example.com';
const PASSWORD = 'perf-investigation-password';

const ADJ = ['golden', 'silent', 'electric', 'midnight', 'quiet', 'storm', 'autumn', 'crystal', 'hidden', 'final', 'first', 'lost', 'bright', 'deep', 'wild'];
const NOUN = ['harbor', 'signal', 'garden', 'circuit', 'voyage', 'echo', 'summit', 'meadow', 'archive', 'parade', 'letter', 'window', 'river', 'engine', 'lantern'];

function pick<T>(arr: T[], i: number): T {
  return arr[i % arr.length];
}

async function main() {
  // Fresh state for the seed user only.
  const existing = await prisma.user.findUnique({ where: { email: EMAIL } });
  if (existing) {
    await prisma.user.delete({ where: { id: existing.id } });
  }

  const passwordHash = await hashPassword(PASSWORD);
  const user = await prisma.user.create({
    data: { email: EMAIL, passwordHash },
    select: { id: true },
  });

  // Fake linked MEGA account. encryptedSession is envelope-encrypted by the
  // same format the app uses, but the material is synthetic garbage that
  // would fail session validation if ever used - so measured flows that do
  // NOT need MEGA stay realistic, and flows that DO (heal) fail fast.
  const fakeSession = `v1.${randomBytes(64).toString('base64url')}`;
  const account = await prisma.megaAccount.create({
    data: {
      userId: user.id,
      label: 'perf-fake-mega',
      megaEmail: 'perf-fake@mega.example',
      megaUserId: 'UperfFake00000',
      status: 'SYNCED',
      encryptedSession: fakeSession,
      lastAuthenticatedAt: new Date(),
      lastSyncStartedAt: new Date(),
      lastSyncCompletedAt: new Date(),
    },
    select: { id: true },
  });

  // Thumbnails available on disk for the first 24 (one eager homepage grid).
  const thumbsSource = path.resolve(process.cwd(), 'data/thumbs');
  const sourceThumbs = fs.existsSync(thumbsSource)
    ? fs.readdirSync(thumbsSource).filter((f) => f.endsWith('.png')).slice(0, 24)
    : [];
  const thumbsDir = thumbsSource; // same directory the thumbs route serves

  const creators = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      prisma.creator.create({
        data: {
          userId: user.id,
          name: `${pick(ADJ, i)} Studios`,
          slug: `${pick(ADJ, i)}-studios`,
        },
      }),
    ),
  );

  const now = Date.now();
  const videos: Array<{ id: number }> = [];
  for (let i = 0; i < nVideos; i++) {
    const title = `${pick(ADJ, i)} ${pick(NOUN, i)} ${i + 1}`;
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const hasThumb = i < 24 && sourceThumbs.length > 0;
    const created = await prisma.video.create({
      data: {
        megaUrl: null,
        megaFileId: `perfnode${i}`,
        megaFileKey: randomBytes(32).toString('hex'),
        megaFilename: `${slug}.ts`,
        title,
        slug,
        thumbnail: hasThumb ? `/api/media/thumbs/PLACEHOLDER` : null,
        thumbnailAvailable: hasThumb,
        mimeType: 'video/mp2t',
        fileSize: BigInt(Math.round(8_000_000 + (i % 17) * 1_400_000)),
        duration: 60 + (i % 25) * 12,
        createdAt: new Date(now - i * 3_600_000),
        megaAccountId: account.id,
        megaFa: null,
        // Cyclic assignment: every video belongs to one of the 6 creators,
        // so creator- and title-related pools have real work to do (the old
        // sparse i%3 assignment left most videos unassigned, which made the
        // home feed's history/related pools cheaper than any real library).
        creatorId: creators[i % creators.length].id,
      },
      select: { id: true },
    });
    videos.push(created);
    if (hasThumb && sourceThumbs.length > 0) {
      // Copy an existing PNG to this synthetic id so the thumbs route takes
      // its cached-file path (the hot path on a loaded homepage).
      const src = path.join(thumbsSource, sourceThumbs[i % sourceThumbs.length]);
      try {
        fs.copyFileSync(src, path.join(thumbsDir, `${created.id}.png`));
      } catch {
        // missing source - leave thumbnailAvailable anyway, 404 is fine
      }
      await prisma.video.update({
        where: { id: created.id },
        data: { thumbnail: `/api/media/thumbs/${created.id}` },
      });
    }
  }

  // History for the recommended pool + watchlist + saved rows.
  const watched = videos.slice(0, 40);
  await prisma.watchHistory.createMany({
    data: watched.map((v, i) => ({
      userId: user.id,
      videoId: v.id,
      lastWatchedAt: new Date(now - i * 7_200_000),
    })),
  });
  await prisma.watchlistItem.createMany({
    data: videos.slice(60, 80).map((v, i) => ({
      userId: user.id,
      videoId: v.id,
      createdAt: new Date(now - i * 1_800_000),
    })),
  });
  const folder = await prisma.savedFolder.create({
    data: { userId: user.id, name: 'perf folder' },
  });
  await prisma.savedVideo.createMany({
    data: videos.slice(100, 110).map((v, i) => ({
      userId: user.id,
      videoId: v.id,
      folderId: folder.id,
      createdAt: new Date(now - i * 900_000),
    })),
  });

  console.log(
    JSON.stringify({
      seeded: true,
      userId: user.id,
      accountId: account.id,
      videos: videos.length,
      thumbs: Math.min(24, sourceThumbs.length),
    }),
  );
}

main()
  .catch((err) => {
    console.error('seed failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
