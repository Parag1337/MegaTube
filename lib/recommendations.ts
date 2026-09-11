/**
 * P2.0 product foundation: SIMPLE recommendation query primitives.
 *
 * This is deliberately NOT a recommendation engine: no AI, no embeddings,
 * no vector database, no ML ranking, no multi-factor scoring. Just reusable,
 * paginated, user-scoped database queries that the future Home feed and
 * Video page can call directly:
 *
 *   same creator  ->  title match (existing FTS infrastructure)  ->  random
 *
 * The ordering above is the whole "ranking": deterministic and
 * understandable. Every primitive excludes the current video, never leaks
 * another user's videos (all queries are scoped to the requesting user's
 * library + the public catalog), and reuses listRandomVideos instead of
 * duplicating randomization logic.
 */

import { prisma } from './db';
import { MEGA_ACCOUNT_STATUSES } from './megaAccounts';
import { listRandomVideos, searchVideos, serializeVideo } from './videos';
import { listRecentHistoryRefs } from './personal';

type SerializedVideo = ReturnType<typeof serializeVideo>;

/** Columns needed by serializeVideo(). */
const videoSelect = {
  id: true,
  slug: true,
  title: true,
  megaUrl: true,
  megaFilename: true,
  thumbnail: true,
  thumbnailAvailable: true,
  fileSize: true,
  mimeType: true,
  duration: true,
  embedUrl: true,
  creator: { select: { id: true, slug: true, name: true } },
  megaAccount: { select: { id: true, userId: true, label: true, status: true } },
} as const;

/**
 * Videos visible to ONE user: their own linked, non-disconnected MEGA
 * accounts plus the shared public catalog. Never another user's videos.
 */
function userLibraryScope(userId: string) {
  return {
    OR: [
      {
        megaAccount: {
          userId,
          status: { not: MEGA_ACCOUNT_STATUSES.DISCONNECTED },
        },
      },
      { megaAccountId: null },
    ],
  };
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 12;
  return Math.max(1, Math.min(Math.floor(limit), 24));
}

// ---------------------------------------------------------------------------
// A. Same creator (excluding the current video)
// ---------------------------------------------------------------------------

/**
 * Videos from the same creator as the given video, newest first, excluding
 * the video itself. Returns [] when the video is not visible to the user or
 * has no creator assigned.
 */
export async function getSameCreatorVideos(
  userId: string,
  videoId: number,
  limit = 12,
): Promise<SerializedVideo[]> {
  const take = clampLimit(limit);
  const current = await prisma.video.findFirst({
    where: { AND: [userLibraryScope(userId), { id: videoId }] },
    select: { id: true, creatorId: true },
  });
  if (!current || current.creatorId === null) return [];

  const rows = await prisma.video.findMany({
    where: {
      AND: [userLibraryScope(userId), { creatorId: current.creatorId }, { id: { not: videoId } }],
    },
    select: videoSelect,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take,
  });
  return rows.map(serializeVideo);
}

// ---------------------------------------------------------------------------
// B. Title-related (reuses the existing search/FTS infrastructure)
// ---------------------------------------------------------------------------

/**
 * Videos related to a supplied title, using the existing searchVideos()
 * path (FTS5 trigram fast path + LIKE fallback) - no second search engine.
 * Excludes the given video ids. Deterministic search ranking is preserved.
 */
export async function getTitleRelatedVideos(
  userId: string,
  title: string,
  opts?: { excludeVideoIds?: number[]; limit?: number },
): Promise<SerializedVideo[]> {
  const take = clampLimit(opts?.limit ?? 12);
  const q = title.trim();
  if (!q) return [];
  const excluded = new Set(opts?.excludeVideoIds ?? []);

  // searchVideos() pages by videosPerPage(); walk pages until the limit is
  // filled (bounded: at most 3 pages - this stays a cheap primitive).
  const found: SerializedVideo[] = [];
  const seen = new Set<number>(excluded);
  for (let page = 1; page <= 3 && found.length < take; page++) {
    const result = await searchVideos(q, page, userId);
    if (result.items.length === 0) break;
    for (const item of result.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      found.push(item);
      if (found.length >= take) break;
    }
    if (page >= result.totalPages) break;
  }
  return found;
}

// ---------------------------------------------------------------------------
// C. History-related (creator + title of recently watched videos)
// ---------------------------------------------------------------------------

/**
 * Given a user's recent history, find videos related to those watched
 * videos using only existing data (creator, title). Creator matches come
 * first (in watch-recency order), then title matches. Already-watched
 * videos and the optionally excluded ids are never returned.
 */
export async function getHistoryRelatedVideos(
  userId: string,
  limit = 12,
  opts?: { excludeVideoIds?: number[] },
): Promise<SerializedVideo[]> {
  const take = clampLimit(limit);
  const refs = await listRecentHistoryRefs(userId, 5);
  if (refs.length === 0) return [];

  const excluded = new Set([...refs.map((r) => r.videoId), ...(opts?.excludeVideoIds ?? [])]);
  const found: SerializedVideo[] = [];
  const seen = new Set<number>(excluded);
  const push = (v: SerializedVideo) => {
    if (seen.has(v.id)) return;
    seen.add(v.id);
    if (found.length < take) found.push(v);
  };

  // Creator matches first, most recently watched creator first.
  for (const ref of refs) {
    if (found.length >= take) break;
    if (ref.creatorId === null) continue;
    const rows = await prisma.video.findMany({
      where: {
        AND: [
          userLibraryScope(userId),
          { creatorId: ref.creatorId },
          { id: { notIn: [...seen] } },
        ],
      },
      select: videoSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take - found.length,
    });
    for (const row of rows) push(serializeVideo(row));
  }

  // Then title matches per watched video.
  for (const ref of refs) {
    if (found.length >= take) break;
    const related = await getTitleRelatedVideos(userId, ref.title, {
      excludeVideoIds: [...seen],
      limit: take - found.length,
    });
    for (const v of related) push(v);
  }

  return found;
}

// ---------------------------------------------------------------------------
// D. Random discovery (reuses the optimized random-video implementation)
// ---------------------------------------------------------------------------

/**
 * Random discovery slice. Thin wrapper over listRandomVideos() - the
 * existing ID-shuffle implementation - so randomization logic exists once.
 * The seed controls the ordering (same seed = same order, stable paging).
 */
export async function getRandomDiscovery(
  userId: string,
  limit = 12,
  seed = '',
): Promise<SerializedVideo[]> {
  const take = clampLimit(limit);
  const result = await listRandomVideos(userId, 1, seed);
  return result.items.slice(0, take);
}

// ---------------------------------------------------------------------------
// Combined: "give me related videos" for one video page
// ---------------------------------------------------------------------------

/**
 * The single call the future Video page needs: same-creator videos first,
 * then title matches, then random discovery to fill up to `limit`.
 * Deterministic, user-scoped, current video always excluded. Returns []
 * when the video itself is not visible to the user.
 */
export async function getRelatedVideos(
  userId: string,
  videoId: number,
  limit = 12,
): Promise<SerializedVideo[]> {
  const take = clampLimit(limit);
  const current = await prisma.video.findFirst({
    where: { AND: [userLibraryScope(userId), { id: videoId }] },
    select: { id: true, title: true, creatorId: true },
  });
  if (!current) return [];

  const found: SerializedVideo[] = [];
  const seen = new Set<number>([videoId]);
  const push = (v: SerializedVideo) => {
    if (seen.has(v.id)) return;
    seen.add(v.id);
    if (found.length < take) found.push(v);
  };

  for (const v of await getSameCreatorVideos(userId, videoId, take)) push(v);

  if (found.length < take) {
    for (const v of await getTitleRelatedVideos(userId, current.title, {
      excludeVideoIds: [...seen],
      limit: take - found.length,
    }))
      push(v);
  }

  if (found.length < take) {
    // Deterministic per-video seed so the "discover" tail is stable.
    for (const v of await getRandomDiscovery(userId, take, `related-${videoId}`)) push(v);
  }

  return found.slice(0, take);
}
