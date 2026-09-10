/**
 * Server-side data access for videos and creators.
 * (Prisma client is Node-only; these functions are used in Server
 * Components / route handlers, never in client components.)
 *
 * VISIBILITY MODEL
 *   - Private videos (megaAccountId != null) belong to a MegaAccount and are
 *     ONLY visible to the website user who owns that account. Every public
 *     query below is therefore explicitly scoped to `megaAccountId: null`.
 */

import { prisma } from './db';
import { videosPerPage } from './config';
import { MEGA_ACCOUNT_STATUSES } from './megaAccounts';

export type VideoWithCreator = {
  id: number;
  slug: string;
  title: string;
  megaUrl: string | null;
  megaFilename: string;
  thumbnail: string | null;
  thumbnailAvailable: boolean;
  fileSize: bigint | null;
  mimeType: string | null;
  duration: number | null;
  embedUrl: string | null;
  isPrivate: boolean;
  account: { id: number; label: string; status: string; userId: string } | null;
  creator: { slug: string; name: string } | null;
};

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

/** Public-scope predicate: only the shared catalog, never private videos. */
const PUBLIC_SCOPE = { megaAccountId: null } as const;

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
}

export type CreatorRef = { id: number; slug: string; name: string };

export function serializeVideo(v: {
  id: number;
  slug: string;
  title: string;
  megaUrl: string | null;
  megaFilename: string;
  thumbnail: string | null;
  thumbnailAvailable: boolean;
  fileSize: bigint | null;
  mimeType: string | null;
  duration: number | null;
  embedUrl: string | null;
  creator: CreatorRef | null;
  megaAccount: { id: number; userId: string; label: string; status: string } | null;
}) {
  return {
    ...v,
    fileSize: v.fileSize === null ? null : Number(v.fileSize),
    isPrivate: v.megaAccount !== null,
    account: v.megaAccount
      ? {
          id: v.megaAccount.id,
          label: v.megaAccount.label,
          status: v.megaAccount.status,
          userId: v.megaAccount.userId,
        }
      : null,
  };
}

/** Homepage: deterministic random ordering (sortOrder set at import). */
export async function listVideos(
  page = 1,
): Promise<PageResult<ReturnType<typeof serializeVideo>>> {
  const perPage = videosPerPage();
  const safePage = Math.max(1, page);

  const [items, total] = await Promise.all([
    prisma.video.findMany({
      where: PUBLIC_SCOPE,
      select: videoSelect,
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      skip: (safePage - 1) * perPage,
      take: perPage,
    }),
    prisma.video.count({ where: PUBLIC_SCOPE }),
  ]);

  return {
    items: items.map(serializeVideo),
    total,
    page: safePage,
    perPage,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
  };
}

/**
 * Fetch any video by slug (public or private) for the video page, which then
 * enforces ownership for private ones. Includes the owning account so the
 * player can be selected and access checked.
 */
export async function getVideoBySlug(slug: string) {
  const video = await prisma.video.findUnique({
    where: { slug },
    select: {
      ...videoSelect,
      createdAt: true,
    },
  });
  return video ? { ...serializeVideo(video), createdAt: video.createdAt } : null;
}

/**
 * Search the catalog visible to ONE website user.
 *
 * Scope: every video linked through the user's own MEGA accounts (all linked
 * accounts, not disconnected ones - same rule as the library) plus the
 * public catalog. Never another user's videos, and never filtered by MEGA
 * folders, paths, node ids or account labels.
 *
 * Matches against: video title, creator name, and the real MEGA filename
 * (which is the "Creator - Title" source of truth from Phase 4).
 *
 * Case-insensitivity: SQLite's LIKE-based `contains` is case-insensitive
 * for ASCII, which covers the catalog.
 */
export async function searchVideos(
  query: string,
  page = 1,
  userId?: string,
): Promise<PageResult<ReturnType<typeof serializeVideo>>> {
  const perPage = videosPerPage();
  const safePage = Math.max(1, page);
  const q = query.trim();

  if (!q) {
    return { items: [], total: 0, page: 1, perPage, totalPages: 1 };
  }

  const scope = userId
    ? {
        OR: [
          { megaAccount: { userId, status: { not: MEGA_ACCOUNT_STATUSES.DISCONNECTED } } },
          PUBLIC_SCOPE,
        ],
      }
    : PUBLIC_SCOPE;

  // AND of [visibility scope, text match]. Deliberately composed via AND so
  // the scope's own OR cannot be clobbered by the match OR (a flat spread
  // would silently drop user isolation!).
  const where = {
    AND: [
      scope,
      {
        OR: [
          { title: { contains: q } },
          { megaFilename: { contains: q } },
          { creator: { is: { name: { contains: q } } } },
        ],
      },
    ],
  };

  const [items, total] = await Promise.all([
    prisma.video.findMany({
      where,
      select: videoSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (safePage - 1) * perPage,
      take: perPage,
    }),
    prisma.video.count({ where }),
  ]);

  return {
    items: items.map(serializeVideo),
    total,
    page: safePage,
    perPage,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
  };
}

/** Videos by a creator, ordered deterministically (public catalog only). */
export async function listVideosByCreator(
  creatorSlug: string,
  page = 1,
): Promise<{ creator: { slug: string; name: string } | null; result: PageResult<ReturnType<typeof serializeVideo>> }> {
  const perPage = videosPerPage();
  const safePage = Math.max(1, page);

  const creator = await prisma.creator.findUnique({
    where: { slug: creatorSlug },
    select: { slug: true, name: true, id: true },
  });

  if (!creator) {
    return {
      creator: null,
      result: { items: [], total: 0, page: 1, perPage, totalPages: 1 },
    };
  }

  const where = { ...PUBLIC_SCOPE, creatorId: creator.id };
  const [items, total] = await Promise.all([
    prisma.video.findMany({
      where,
      select: videoSelect,
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      skip: (safePage - 1) * perPage,
      take: perPage,
    }),
    prisma.video.count({ where }),
  ]);

  return {
    creator: { slug: creator.slug, name: creator.name },
    result: {
      items: items.map(serializeVideo),
      total,
      page: safePage,
      perPage,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
    },
  };
}

/** All creators with video counts (public catalog only). */
export async function listCreators() {
  const creators = await prisma.creator.findMany({
    select: {
      slug: true,
      name: true,
      avatar: true,
      _count: { select: { videos: true } },
    },
    orderBy: { name: 'asc' },
  });
  return creators;
}

/** Basic recommendations: same creator first, then random others (public only). */
export async function getRecommendations(
  currentVideoId: number,
  creatorId: number | null,
  limit = 12,
): Promise<ReturnType<typeof serializeVideo>[]> {
  const exclude = { id: { not: currentVideoId } };

  const sameCreator = creatorId
    ? await prisma.video.findMany({
        where: { ...PUBLIC_SCOPE, ...exclude, creatorId },
        select: videoSelect,
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        take: limit,
      })
    : [];

  const usedIds = [currentVideoId, ...sameCreator.map((v) => v.id)];
  const remaining = limit - sameCreator.length;
  const others = remaining > 0
    ? await prisma.video.findMany({
        where: { ...PUBLIC_SCOPE, id: { notIn: usedIds } },
        select: videoSelect,
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        take: remaining,
      })
    : [];

  return [...sameCreator, ...others].map(serializeVideo);
}

// ---------------------------------------------------------------------------
// Private library (per website user, across all their MEGA accounts)
// ---------------------------------------------------------------------------

/**
 * A user's combined private library: videos from every linked MEGA account
 * that is not disconnected. Optionally filtered to one account.
 */
export async function listLibraryVideosForUser(
  userId: string,
  page = 1,
  accountId?: number,
): Promise<PageResult<ReturnType<typeof serializeVideo>>> {
  const perPage = videosPerPage();
  const safePage = Math.max(1, page);

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
      skip: (safePage - 1) * perPage,
      take: perPage,
    }),
    prisma.video.count({ where }),
  ]);

  return {
    items: items.map(serializeVideo),
    total,
    page: safePage,
    perPage,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
  };
}

/** Total visible private video count for a user (header / summary). */
export async function countLibraryVideosForUser(userId: string): Promise<number> {
  return prisma.video.count({
    where: {
      megaAccount: {
        userId,
        status: { not: MEGA_ACCOUNT_STATUSES.DISCONNECTED },
      },
    },
  });
}
