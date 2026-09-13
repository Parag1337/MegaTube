/**
 * P2.0 product foundation: user-scoped Watchlist, Saved Videos and History.
 *
 * Every function is user-scoped by construction:
 *   - listing/lookup queries always filter on userId;
 *   - add/record/remove operations first verify the video is VISIBLE to the
 *     requesting user (their own non-disconnected MEGA accounts plus the
 *     public catalog) and answer null/false otherwise, so User A can never
 *     read or modify User B's data (IDOR-safe by default);
 *   - no video metadata is duplicated - rows only reference Video.
 *
 * All list operations are paginated; no function loads a whole library.
 */

import { prisma } from './db';
import { videosPerPage } from './config';
import { MEGA_ACCOUNT_STATUSES } from './megaAccounts';
import { serializeVideo, type PageResult } from './videos';

/** Columns needed by serializeVideo(), shared by every query below. */
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
 * Visibility rule for personal collections: a video may be added to a
 * user's watchlist/saved/history only when it is part of that user's own
 * library (any linked, non-disconnected MEGA account) or the shared public
 * catalog. Another user's private videos are never visible and behave
 * exactly like a missing video (null).
 */
async function findVisibleVideo(userId: string, videoId: number): Promise<{ id: number } | null> {
  return prisma.video.findFirst({
    where: {
      id: videoId,
      OR: [
        {
          megaAccount: {
            userId,
            status: { not: MEGA_ACCOUNT_STATUSES.DISCONNECTED },
          },
        },
        { megaAccountId: null },
      ],
    },
    select: { id: true },
  });
}

function pageWindow(page: number): { safePage: number; perPage: number; skip: number } {
  const perPage = videosPerPage();
  const safePage = Math.max(1, Math.floor(page) || 1);
  return { safePage, perPage, skip: (safePage - 1) * perPage };
}

function emptyPage<T>(perPage: number): PageResult<T> {
  return { items: [], total: 0, page: 1, perPage, totalPages: 1 };
}

type SerializedVideo = ReturnType<typeof serializeVideo>;

// ---------------------------------------------------------------------------
// Watchlist
// ---------------------------------------------------------------------------

/** All watchlist videos for a user, most recently added first. */
export async function listWatchlist(userId: string, page = 1): Promise<PageResult<SerializedVideo>> {
  const { safePage, perPage, skip } = pageWindow(page);
  const where = { userId };
  const [rows, total] = await Promise.all([
    prisma.watchlistItem.findMany({
      where,
      include: { video: { select: videoSelect } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip,
      take: perPage,
    }),
    prisma.watchlistItem.count({ where }),
  ]);
  return {
    items: rows.map((r) => serializeVideo(r.video)),
    total,
    page: safePage,
    perPage,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
  };
}

/**
 * Add a video to the user's watchlist. Idempotent: adding twice keeps a
 * single row. Returns null when the video is not visible to the user.
 */
export async function addToWatchlist(
  userId: string,
  videoId: number,
): Promise<{ videoId: number; created: boolean } | null> {
  const visible = await findVisibleVideo(userId, videoId);
  if (!visible) return null;
  try {
    await prisma.watchlistItem.create({ data: { userId, videoId } });
    return { videoId, created: true };
  } catch (err) {
    // P2002 = the (userId, videoId) row already exists: idempotent success.
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002') {
      return { videoId, created: false };
    }
    throw err;
  }
}

/** Remove a video from the user's watchlist. True when a row was removed. */
export async function removeFromWatchlist(userId: string, videoId: number): Promise<boolean> {
  const removed = await prisma.watchlistItem.deleteMany({ where: { userId, videoId } });
  return removed.count > 0;
}

/**
 * Clear the user's whole watchlist. Returns the number of removed rows.
 * Saved Videos and History are untouched.
 */
export async function clearWatchlist(userId: string): Promise<number> {
  const removed = await prisma.watchlistItem.deleteMany({ where: { userId } });
  return removed.count;
}

/** Whether a particular video is in the user's watchlist. */
export async function isOnWatchlist(userId: string, videoId: number): Promise<boolean> {
  const row = await prisma.watchlistItem.findUnique({
    where: { userId_videoId: { userId, videoId } },
    select: { id: true },
  });
  return row !== null;
}

// ---------------------------------------------------------------------------
// Saved Videos (bookmarks, optionally organized in user-created folders)
// ---------------------------------------------------------------------------

export type SavedVideoFolderFilter =
  | { kind: 'all' }
  | { kind: 'uncategorized' }
  | { kind: 'folder'; folderId: number };

export type SavedItem = SerializedVideo & { folderId: number | null };

/**
 * Saved videos for a user, most recently saved first.
 *
 * folderFilter narrows the listing (default: everything = "All Saved"):
 *   { kind: 'all' }            - every saved video;
 *   { kind: 'uncategorized' }  - saved videos in no folder;
 *   { kind: 'folder', folderId } - saved videos inside one folder.
 * A folderId belonging to another user matches nothing (never leaks).
 */
export async function listSavedVideos(
  userId: string,
  page = 1,
  folderFilter: SavedVideoFolderFilter = { kind: 'all' },
): Promise<PageResult<SavedItem>> {
  const { safePage, perPage, skip } = pageWindow(page);
  const where =
    folderFilter.kind === 'all'
      ? { userId }
      : folderFilter.kind === 'uncategorized'
        ? { userId, folderId: null }
        : { userId, folderId: folderFilter.folderId };
  const [rows, total] = await Promise.all([
    prisma.savedVideo.findMany({
      where,
      include: { video: { select: videoSelect } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip,
      take: perPage,
    }),
    prisma.savedVideo.count({ where }),
  ]);
  return {
    items: rows.map((r) => ({ ...serializeVideo(r.video), folderId: r.folderId })),
    total,
    page: safePage,
    perPage,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
  };
}

/**
 * Save (bookmark) a video. Idempotent: saving twice keeps a single row.
 * Returns null when the video is not visible to the user.
 */
export async function saveVideo(
  userId: string,
  videoId: number,
): Promise<{ videoId: number; created: boolean } | null> {
  const visible = await findVisibleVideo(userId, videoId);
  if (!visible) return null;
  try {
    await prisma.savedVideo.create({ data: { userId, videoId } });
    return { videoId, created: true };
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002') {
      return { videoId, created: false };
    }
    throw err;
  }
}

/** Remove a saved bookmark. True when a row was removed. */
export async function unsaveVideo(userId: string, videoId: number): Promise<boolean> {
  const removed = await prisma.savedVideo.deleteMany({ where: { userId, videoId } });
  return removed.count > 0;
}

/** Whether a particular video is saved by the user. */
export async function isVideoSaved(userId: string, videoId: number): Promise<boolean> {
  const row = await prisma.savedVideo.findUnique({
    where: { userId_videoId: { userId, videoId } },
    select: { id: true },
  });
  return row !== null;
}

// ---------------------------------------------------------------------------
// History ("videos I watched" - no analytics, no sessions)
// ---------------------------------------------------------------------------

export type HistoryItem = SerializedVideo & { lastWatchedAt: Date };

/**
 * Record a watch: creates the history row or bumps lastWatchedAt when the
 * video was watched before (never unlimited duplicates). Returns null when
 * the video is not visible to the user.
 */
export async function recordWatch(
  userId: string,
  videoId: number,
): Promise<{ videoId: number; lastWatchedAt: Date } | null> {
  const visible = await findVisibleVideo(userId, videoId);
  if (!visible) return null;
  const now = new Date();
  const row = await prisma.watchHistory.upsert({
    where: { userId_videoId: { userId, videoId } },
    update: { lastWatchedAt: now },
    create: { userId, videoId, lastWatchedAt: now },
    select: { videoId: true, lastWatchedAt: true },
  });
  return row;
}

/** History for a user, most recently watched first. */
export async function listHistory(userId: string, page = 1): Promise<PageResult<HistoryItem>> {
  const { safePage, perPage, skip } = pageWindow(page);
  const where = { userId };
  const [rows, total] = await Promise.all([
    prisma.watchHistory.findMany({
      where,
      include: { video: { select: videoSelect } },
      orderBy: [{ lastWatchedAt: 'desc' }, { id: 'desc' }],
      skip,
      take: perPage,
    }),
    prisma.watchHistory.count({ where }),
  ]);
  return {
    items: rows.map((r) => ({ ...serializeVideo(r.video), lastWatchedAt: r.lastWatchedAt })),
    total,
    page: safePage,
    perPage,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
  };
}

/**
 * Recent history entries with their creator ids - the input for
 * history-related recommendation primitives. Scoped to the user; newest
 * first, capped so callers cannot pull the whole table.
 */
export async function listRecentHistoryRefs(
  userId: string,
  limit = 5,
): Promise<Array<{ videoId: number; title: string; creatorId: number | null }>> {
  const rows = await prisma.watchHistory.findMany({
    where: { userId },
    include: { video: { select: { id: true, title: true, creatorId: true } } },
    orderBy: [{ lastWatchedAt: 'desc' }, { id: 'desc' }],
    take: Math.max(1, Math.min(limit, 20)),
  });
  return rows.map((r) => ({
    videoId: r.video.id,
    title: r.video.title,
    creatorId: r.video.creatorId,
  }));
}

/** Remove one history entry. True when a row was removed. */
export async function removeHistoryItem(userId: string, videoId: number): Promise<boolean> {
  const removed = await prisma.watchHistory.deleteMany({ where: { userId, videoId } });
  return removed.count > 0;
}

/** Clear the user's whole history. Returns the number of removed rows. */
export async function clearHistory(userId: string): Promise<number> {
  const removed = await prisma.watchHistory.deleteMany({ where: { userId } });
  return removed.count;
}

// ---------------------------------------------------------------------------
// New Videos (newest-added/synced first - no "newness" ranking)
// ---------------------------------------------------------------------------

/**
 * Newest videos in the user's library: Video.createdAt is the moment the
 * video entered MegaTube (set at sync), so ordering by it newest-first is
 * exactly "newest-added/synced". Paginated, user-scoped, backed by the
 * existing (megaAccountId, createdAt) compound index - no separate table,
 * no duplicate timestamp, never loads the whole library.
 */
export async function listNewVideosForUser(
  userId: string,
  page = 1,
  accountId?: number,
): Promise<PageResult<SerializedVideo>> {
  const { safePage, perPage, skip } = pageWindow(page);
  const where = {
    megaAccount: {
      userId,
      status: { not: MEGA_ACCOUNT_STATUSES.DISCONNECTED },
      ...(accountId ? { id: accountId } : {}),
    },
  };
  const [items, total] = await Promise.all([
    prisma.video.findMany({
      where,
      select: videoSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip,
      take: perPage,
    }),
    prisma.video.count({ where }),
  ]);
  if (items.length === 0 && total === 0 && safePage === 1) {
    return emptyPage<SerializedVideo>(perPage);
  }
  return {
    items: items.map(serializeVideo),
    total,
    page: safePage,
    perPage,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
  };
}
