/**
 * Database query-count + wall-time benchmark for the Phase 3 report.
 *
 * Runs each logical operation against the configured DATABASE_URL and counts
 * the SQL statements it issues. Counting happens at the pg pool
 * (lib/db.ts `withDbQueryCounter`) because Prisma's async 'query' log events
 * under-count concurrent waves. Wall time is also reported but is only
 * meaningful relative to the database's round-trip latency: on a local DB it
 * mostly reflects per-query overhead, on a latency-injected proxy
 * (scripts/latency-proxy.mjs) it scales with query count × RTT.
 *
 * Usage:
 *   npx tsx scripts/bench-db.mts [--runs 3] [--out file.json]
 *
 * Seeding: scripts/seed-perf.mts (240 videos + history/watchlist/saved rows).
 * Read-only: the script never writes (the counters below are page 1-2
 * reads that are already cached by lib/feedCache — the cache is per-process
 * and this process is fresh, so every run measures the cold build).
 */

import { prisma, withDbQueryCounter } from '../lib/db';
import { buildHomeFeedPage, homeFeedSeed } from '../lib/homeFeed';
import { searchVideosLiteral, listLibraryVideosForUser, listVideosByCreator, listRandomVideos } from '../lib/videos';
import { listWatchlist, listHistory, listSavedVideos, listNewVideosForUser } from '../lib/personal';
import { listSavedFolders } from '../lib/savedFolders';
import { getVideoPools, getHistoryRelatedVideos, getTitleRelatedVideos } from '../lib/recommendations';
import { invalidateUserFeedData as clearCachesForTests } from '../lib/feedCache';
import fs from 'node:fs';

function argVal(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const RUNS = Number(argVal('--runs', '3'));
const OUT = argVal('--out', '');

interface Sample {
  queries: number;
  ms: number;
}
type Stats = { name: string; queries: { min: number; max: number; p50: number }; ms: { min: number; max: number; p50: number } };

function summarize(name: string, samples: Sample[]): Stats {
  const qs = samples.map((s) => s.queries).sort((a, b) => a - b);
  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  const mid = (xs: number[]) => xs[Math.floor(xs.length / 2)];
  return {
    name,
    queries: { min: qs[0], p50: mid(qs), max: qs[qs.length - 1] },
    ms: { min: Math.round(ms[0]), p50: Math.round(mid(ms)), max: Math.round(ms[ms.length - 1]) },
  };
}

async function count(fn: () => Promise<unknown>): Promise<Sample> {
  let queries = 0;
  const t0 = performance.now();
  await withDbQueryCounter(
    () => {
      queries++;
    },
    fn,
  );
  return { queries, ms: performance.now() - t0 };
}

async function main(): Promise<void> {
  // Resolve the seeded perf user (never writes).
  const user = await prisma.user.findFirst({
    where: { email: 'perf-investigation@example.com' },
    select: { id: true },
  });
  if (!user) {
    console.error('Seed user not found — run scripts/seed-perf.mts first.');
    process.exit(1);
  }
  const userId = user.id;
  const video = await prisma.video.findFirst({
    where: { slug: 'golden-harbor-1' },
    select: { id: true, title: true, creatorId: true },
  });

  const results: Record<string, Stats> = {};
  const sample = async (name: string, fn: () => Promise<unknown>) => {
    if (!results[name]) results[name] = { name, samples: [] } as never;
    const samples = (results[name] as unknown as { samples: Sample[] }).samples;
    samples.push(await count(fn));
  };

  for (let i = 0; i < RUNS; i++) {
    // Fresh-process caches make the first iteration cold; clear between runs
    // so every run measures the cold build (the interesting case for RTT).
    clearCachesForTests();

    await sample('home page 1 (cold build)', () => buildHomeFeedPage(userId, 1, homeFeedSeed()));
    await sample('home page 2 (cold build, page-1 taken cached)', () => buildHomeFeedPage(userId, 2, homeFeedSeed()));
    await sample('search q=harbor page 1', () => searchVideosLiteral('harbor', 1, userId));
    await sample('library page 1', () => listLibraryVideosForUser(userId, 1));
    await sample('new videos page 1', () => listNewVideosForUser(userId, 1));
    await sample('watchlist page 1', () => listWatchlist(userId, 1));
    await sample('history page 1', () => listHistory(userId, 1));
    await sample('saved videos page 1', () => listSavedVideos(userId, 1));
    await sample('saved folders', () => listSavedFolders(userId));
    await sample('history-related pool', () => getHistoryRelatedVideos(userId, 24));
    if (video) {
      await sample('video page pools', () =>
        getVideoPools(userId, { id: video.id, title: video.title, creatorId: video.creatorId }),
      );
      await sample('video pools: title pool only', () =>
        getTitleRelatedVideos(userId, video.title, { excludeVideoIds: [video.id], limit: 24 }),
      );
      await sample('video pools: random pages only', async () => {
        await listRandomVideos(userId, 1, `related-${video.id}`);
        return listRandomVideos(userId, 2, `related-${video.id}`);
      });
      const creator = await prisma.video.findFirst({
        where: { id: video.id },
        select: { creator: { select: { slug: true } } },
      });
      if (creator?.creator) {
        await sample('creator listing page 1', () => listVideosByCreator(userId, creator.creator.slug, 1));
      }
    }
  }

  const out: Record<string, unknown> = { db: process.env.DATABASE_URL?.replace(/\/\/[^@]*@/, '//<redacted>@'), results: {} };
  for (const [name, acc] of Object.entries(results)) {
    out.results[name] = summarize(name, (acc as unknown as { samples: Sample[] }).samples);
  }
  const json = JSON.stringify(out, null, 2);
  if (OUT) fs.writeFileSync(OUT, json);
  console.log(json);
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
