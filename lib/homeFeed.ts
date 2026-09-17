/**
 * P2.2.1 Home feed composer: ONE continuous interleaved feed from five
 * explicitly quota'd sources - no visible sections, no per-card labels.
 *
 * Sources and targets (of page size):
 *   recent   15% - newest synced videos, newest first
 *   history  10% - videos related to recent watches (0% without history;
 *                  redistributed to random + variety)
 *   related  15% - same-creator / title matches around the page's newest
 *                  picks (works with or without history)
 *   random   30% - deterministic daily-seeded shuffle, paged
 *   variety  30% - general library through the opposite window (oldest
 *                  pages first), so videos missed by every other pool
 *                  still surface. NOT a second random pool.
 *
 * Rules: quotas via largest-remainder (total always exactly page size);
 * first-claim de-duplication with per-source caps so no pool starves the
 * others; shortfalls redistributed in source order; deterministic
 * round-robin interleave; previous pages reconstructed for exclusion so
 * adjacent pages do not repeat. No AI, no scoring, no profiling, no
 * tracking infrastructure.
 */

import { videosPerPage } from './config';
import { listLibraryVideosForUser, listRandomVideos, serializeVideo } from './videos';
import { listNewVideosForUser } from './personal';
import {
  getHistoryRelatedVideos,
  getSameCreatorVideos,
  getTitleRelatedVideos,
} from './recommendations';
import { getCached, homeFeedCacheKey, homeTakenCacheKey, setCached } from './feedCache';

export type FeedSource = 'recent' | 'history' | 'related' | 'random' | 'variety';

export type FeedVideo = ReturnType<typeof serializeVideo>;

export interface FeedPick {
  video: FeedVideo;
  source: FeedSource;
}

/** Fixed source order: quota ties, assignment passes, interleave turns. */
const SOURCE_ORDER: FeedSource[] = ['recent', 'history', 'related', 'random', 'variety'];

const BASE_WEIGHTS: Record<FeedSource, number> = {
  recent: 0.15,
  history: 0.1,
  related: 0.15,
  random: 0.3,
  variety: 0.3,
};

/** Default seed: stable within a day (so pagination is stable), rotates daily. */
export function homeFeedSeed(date = new Date()): string {
  return `home-${date.toISOString().slice(0, 10)}`;
}

/**
 * Quotas per source for a page of `perPage` videos. Largest-remainder keeps
 * the total exactly equal to perPage; ties break in fixed source order, so
 * the result is fully deterministic. Without history its 10% is split
 * proportionally into random + variety (30:30 -> +5/+5).
 */
export function calculateQuotas(perPage: number, hasHistory: boolean): Record<FeedSource, number> {
  const weights: Record<FeedSource, number> = hasHistory
    ? BASE_WEIGHTS
    : { recent: 0.15, history: 0, related: 0.15, random: 0.35, variety: 0.35 };
  const floors = {} as Record<FeedSource, number>;
  const fracs: Array<{ source: FeedSource; frac: number }> = [];
  let assigned = 0;
  for (const s of SOURCE_ORDER) {
    const exact = weights[s] * perPage;
    const f = Math.floor(exact + 1e-9);
    floors[s] = f;
    assigned += f;
    fracs.push({ source: s, frac: exact - f });
  }
  let remainder = perPage - assigned;
  fracs.sort((a, b) => b.frac - a.frac || SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source));
  for (const { source } of fracs) {
    if (remainder <= 0) break;
    floors[source]++;
    remainder--;
  }
  return floors;
}

/**
 * Assign videos to sources honoring quotas with first-claim ownership:
 * pass 1 caps every source at its quota (no pool can starve the others);
 * pass 2 redistributes any shortfall in source order so the page stays as
 * full as the library allows. Already-taken ids (previous pages) are
 * skipped. Returns picks in source order (interleave separately).
 */
export function assignQuotas<T extends { id: number }>(
  pools: Array<{ source: FeedSource; videos: T[] }>,
  quotas: Record<FeedSource, number>,
  perPage: number,
  taken: Set<number> = new Set(),
): Array<{ video: T; source: FeedSource }> {
  const seen = new Set(taken);
  const picks: Array<{ video: T; source: FeedSource }> = [];
  const leftovers: Array<{ source: FeedSource; videos: T[] }> = [];
  for (const pool of pools) {
    const rest: T[] = [];
    let quota = quotas[pool.source] ?? 0;
    for (const v of pool.videos) {
      if (seen.has(v.id)) continue;
      if (quota > 0) {
        quota--;
        seen.add(v.id);
        picks.push({ video: v, source: pool.source });
      } else {
        rest.push(v);
      }
    }
    leftovers.push({ source: pool.source, videos: rest });
  }
  // Pass 2: fill shortfalls in fixed source order.
  for (const pool of leftovers) {
    if (picks.length >= perPage) break;
    for (const v of pool.videos) {
      if (picks.length >= perPage) break;
      if (seen.has(v.id)) continue;
      seen.add(v.id);
      picks.push({ video: v, source: pool.source });
    }
  }
  return picks;
}

/**
 * Deterministic round-robin interleave of per-source buckets into ONE
 * continuous feed (no sections, no labels). Buckets keep their internal
 * order; turns cycle recent -> history -> related -> random -> variety.
 */
export function interleaveBuckets<T>(buckets: T[][]): T[] {
  const out: T[] = [];
  const ptrs = buckets.map(() => 0);
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (let s = 0; s < buckets.length; s++) {
      if (ptrs[s] < buckets[s].length) {
        out.push(buckets[s][ptrs[s]++]);
        progressed = true;
      }
    }
  }
  return out;
}

/**
 * Related pool for one page: same-creator + title matches around the
 * page's newest picks (first two). Bounded: at most 4 small queries, cap
 * 24 videos. Takes are deliberately generous - quotas cap consumption, and
 * a deep pool survives overlap with earlier-claiming sources. Excludes the
 * seed videos themselves - they belong to Recent.
 */
async function fetchRelatedPool(userId: string, seeds: FeedVideo[], cap = 24): Promise<FeedVideo[]> {
  const seedList = seeds.slice(0, 2);
  // Phase 1 perf: the two seeds are independent - resolve their
  // same-creator/title pairs concurrently, then merge in seed order exactly
  // as the old sequential loop did (identical output, fewer round trips).
  const perSeed = await Promise.all(
    seedList.map((seed) =>
      Promise.all([
        getSameCreatorVideos(userId, seed.id, 12),
        getTitleRelatedVideos(userId, seed.title, { excludeVideoIds: [seed.id], limit: 12 }),
      ]),
    ),
  );
  const out: FeedVideo[] = [];
  const seen = new Set(seeds.map((s) => s.id));
  for (const [same, titled] of perSeed) {
    for (const v of [...same, ...titled]) {
      if (out.length >= cap) break;
      if (seen.has(v.id)) continue;
      seen.add(v.id);
      out.push(v);
    }
    if (out.length >= cap) break;
  }
  return out;
}

export interface HomeFeedPage {
  items: FeedPick[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

/**
 * Build one Home feed page. Deterministic for the same user, data, page
 * and seed. Previous pages are reconstructed (same deterministic inputs)
 * so their picks can be excluded - adjacent pages do not repeat.
 */
export async function buildHomeFeedPage(
  userId: string,
  page = 1,
  seed: string = homeFeedSeed(),
): Promise<HomeFeedPage> {
  const perPage = videosPerPage();
  const safePage = Math.max(1, Math.floor(page) || 1);

  // Phase 2 perf: repeat visits (back-navigation, tab switches, client
  // navs) reuse the fully-built page instead of recomputing ~19 queries.
  // User-scoped key + 30s TTL + precise invalidation on history/creator/
  // sync writes (see lib/feedCache.ts for the safety argument).
  const cacheKey = homeFeedCacheKey(userId, safePage, seed);
  const cached = getCached<HomeFeedPage>(cacheKey);
  if (cached) return cached;

  const probe = await listNewVideosForUser(userId, 1);
  const total = probe.total;
  // A user with no private videos gets an empty Home feed. Without this,
  // the random pool (which also sees the shared public catalog) would leak
  // catalog videos into the private Home view of a fresh user whose library
  // is empty - the page instead renders its connect-a-MEGA-account state.
  if (total === 0) {
    const empty: HomeFeedPage = { items: [], page: 1, perPage, total: 0, totalPages: 1 };
    setCached(cacheKey, empty);
    return empty;
  }
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  // Phase 1 perf: start the history query immediately so its Neon round
  // trips overlap the page batch fetches below instead of preceding them.
  // The promise is created once (single fetch, as before) and awaited where
  // its result is first needed. Empty libraries still return above, before
  // any history work starts.
  const historyPromise = getHistoryRelatedVideos(userId, perPage);
  let quotas: Record<FeedSource, number> | null = null;

  const taken = new Set<number>();
  let pagePicks: Array<{ video: FeedVideo; source: FeedSource }> = [];

  for (let p = 1; p <= safePage; p++) {
    // Phase 3A: page p only needs previous pages' TAKEN id sets, not their
    // pools. Reuse cached taken sets so a first visit to page N fetches
    // only page N's pools (~page-1 cost) instead of rebuilding pages
    // 1..N-1 (~N x page-1 cost). Output is identical: taken sets are exactly
    // what the skipped iterations would have contributed.
    if (p < safePage) {
      const cachedTaken = getCached<number[]>(homeTakenCacheKey(userId, p, seed));
      if (cachedTaken) {
        for (const id of cachedTaken) taken.add(id);
        continue;
      }
    }
    const [newP, randP, varP] = await Promise.all([
      p === 1 && probe.page === 1 ? probe : listNewVideosForUser(userId, p),
      listRandomVideos(userId, p, seed),
      listLibraryVideosForUser(userId, Math.max(1, totalPages - p + 1)),
    ]);
    const relatedP = await fetchRelatedPool(userId, newP.items.slice(0, 2));
    const historyAll = await historyPromise;
    quotas ??= calculateQuotas(perPage, historyAll.length > 0);
    const assigned = assignQuotas(
      [
        { source: 'recent', videos: newP.items },
        { source: 'history', videos: p === 1 ? historyAll : [] },
        { source: 'related', videos: relatedP },
        { source: 'random', videos: randP.items },
        { source: 'variety', videos: varP.items },
      ],
      quotas,
      perPage,
      taken,
    );
    for (const a of assigned) taken.add(a.video.id);
    setCached(
      homeTakenCacheKey(userId, p, seed),
      assigned.map((a) => a.video.id),
    );
    if (p === safePage) {
      const bySource = new Map<FeedSource, FeedPick[]>();
      for (const s of SOURCE_ORDER) bySource.set(s, []);
      for (const a of assigned) bySource.get(a.source)!.push(a);
      pagePicks = interleaveBuckets(SOURCE_ORDER.map((s) => bySource.get(s)!));
    }
  }

  const result = { items: pagePicks, page: safePage, perPage, total, totalPages };
  setCached(cacheKey, result);
  return result;
}
