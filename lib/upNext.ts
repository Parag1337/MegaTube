/**
 * Video-page "Up next" selection (max 4): 2 same-creator + 2 title-match.
 *
 * Pure selector over the existing recommendation pools (see
 * lib/recommendations.ts getVideoPools): same-creator candidates come from
 * the creator pool (newest first), title candidates from the title pool
 * (ranked by the existing PostgreSQL FTS + trigram relevance in
 * searchVideosLiteral - weighted ts_rank with title at 2.5x plus trigram
 * SIMILARITY - NOT naive substring matching). Pool order is preserved, so
 * the title picks are the closest title matches.
 *
 * Quotas: prefer exactly 2 creator + 2 title when candidates exist. A
 * same-creator shortfall is filled with extra title matches; a title
 * shortfall is filled with extra same-creator candidates, then the existing
 * random/discovery fallback pool. The current video is never included and
 * no video appears twice. No queries here - callers pass already-fetched
 * pools (fetched in parallel by getVideoPools), so this adds zero DB load.
 */

export interface UpNextPools<T> {
  creator: T[];
  title: T[];
  random: T[];
}

export const UP_NEXT_MAX = 4;
export const UP_NEXT_CREATOR_QUOTA = 2;
export const UP_NEXT_TITLE_QUOTA = 2;

export function selectUpNext<T extends { id: number }>(
  currentId: number,
  pools: UpNextPools<T>,
  max: number = UP_NEXT_MAX,
): T[] {
  const seen = new Set<number>([currentId]);
  const take = (items: readonly T[], n: number): T[] => {
    const out: T[] = [];
    if (n <= 0) return out;
    for (const v of items) {
      if (out.length >= n) break;
      if (seen.has(v.id)) continue;
      seen.add(v.id);
      out.push(v);
    }
    return out;
  };

  // 2 same-creator first, then title matches fill their quota PLUS any
  // creator shortfall (up to the max).
  const creatorPicks = take(pools.creator, UP_NEXT_CREATOR_QUOTA);
  const titlePicks = take(pools.title, max - creatorPicks.length);

  const out = [...creatorPicks, ...titlePicks];
  // Title shortfall: extra same-creator candidates, then discovery fallback.
  if (out.length < max) out.push(...take(pools.creator, max - out.length));
  if (out.length < max) out.push(...take(pools.random, max - out.length));
  return out.slice(0, max);
}
