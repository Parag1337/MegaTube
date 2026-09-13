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
import { Prisma } from '../generated/client';
import {
  SearchNode,
  SearchSyntaxError,
  buildSearchFilterSql,
  buildSearchPrismaWhere,
  buildSearchRankSql,
  literalSearchNode,
  parseSearchQuery,
} from './search';

export { SearchSyntaxError };

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

/**
 * Visibility scope shared by search and the #random command: every video
 * linked through the given user's own MEGA accounts (not disconnected
 * ones) plus the public catalog. Never another user's videos.
 */
function libraryScope(userId?: string) {
  return userId
    ? {
        OR: [
          { megaAccount: { userId, status: { not: MEGA_ACCOUNT_STATUSES.DISCONNECTED } } },
          PUBLIC_SCOPE,
        ],
      }
    : PUBLIC_SCOPE;
}

/** Exact secret command that switches the search page into random mode. */
export const RANDOM_SEARCH_COMMAND = '#random';

/** True only for the exact command (after trimming) - never substrings. */
export function isRandomSearchCommand(query: string): boolean {
  return query.trim() === RANDOM_SEARCH_COMMAND;
}

/** FNV-1a 32-bit hash for seeding the shuffle. */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic PRNG (mulberry32) so one seed always yields one ordering. */
function seededRandom(seed: string): () => number {
  let a = hashSeed(seed);
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic Fisher-Yates shuffle: the same seed always produces the
 * same permutation (stable pagination), a new seed a fresh ordering. The
 * database ordering is never touched.
 */
export function shuffleWithSeed<T>(items: readonly T[], seed: string): T[] {
  const arr = [...items];
  const rand = seededRandom(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * The #random command: all videos visible to the user, shuffled by `seed`.
 *
 * Pagination is applied AFTER shuffling, so page 1..N partition one stable
 * random ordering (no duplicates, no gaps) for a given seed.
 *
 * Scalability (P1.2): only the eligible video IDs (integers) are read and
 * shuffled - never the full rows. The page's rows are then fetched by
 * primary key and restored to shuffled order. Shuffling the complete ID set
 * with Fisher-Yates keeps the ordering uniform (unbiased) and stable per
 * seed, which a per-page `ORDER BY RANDOM()` could not provide (it would
 * reshuffle every page and return duplicates/gaps).
 */
export async function listRandomVideos(
  userId?: string,
  page = 1,
  seed = '',
): Promise<PageResult<ReturnType<typeof serializeVideo>>> {
  const perPage = videosPerPage();
  const safePage = Math.max(1, page);

  const idRows = await prisma.video.findMany({
    where: libraryScope(userId),
    select: { id: true },
    orderBy: { id: 'asc' },
  });

  const shuffledIds = shuffleWithSeed(
    idRows.map((r) => r.id),
    seed,
  );
  const total = shuffledIds.length;
  const pageIds = shuffledIds.slice((safePage - 1) * perPage, safePage * perPage);

  if (pageIds.length === 0) {
    return {
      items: [],
      total,
      page: safePage,
      perPage,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
    };
  }

  const rows = await prisma.video.findMany({
    where: { id: { in: pageIds } },
    select: videoSelect,
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const items: NonNullable<ReturnType<typeof serializeVideo>>[] = [];
  const missingIds: number[] = [];

  for (const id of pageIds) {
    const row = byId.get(id);
    if (row) {
      items.push(serializeVideo(row));
    } else {
      missingIds.push(id);
    }
  }

  if (missingIds.length > 0) {
    const used = new Set(pageIds);
    const refillIds: number[] = [];
    for (const id of shuffledIds) {
      if (refillIds.length >= missingIds.length) break;
      if (!used.has(id)) {
        used.add(id);
        refillIds.push(id);
      }
    }
    if (refillIds.length > 0) {
      const refillRows = await prisma.video.findMany({
        where: { id: { in: refillIds } },
        select: videoSelect,
      });
      const refillById = new Map(refillRows.map((r) => [r.id, r]));
      for (const id of refillIds) {
        const row = refillById.get(id);
        if (row) items.push(serializeVideo(row));
      }
    }
  }

  return {
    items,
    total,
    page: safePage,
    perPage,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
  };
}

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
 * Database-side boolean search over the VideoSearch trigram index.
 *
 * The AST filter decides WHICH videos are eligible (each TERM is one
 * index-backed EXISTS(MATCH) probe - or an inline LIKE for sub-3-character
 * terms the trigram index cannot serve - composed with SQL AND/OR/NOT).
 * BM25 over the positive terms decides the ORDER. Ownership uses the exact
 * same rule as the LIKE path (own non-disconnected accounts plus the public
 * catalog); the user id never enters the MATCH expression itself.
 *
 * Returns null when the FTS index is unavailable (pre-migration database),
 * so the caller can use the Prisma/LIKE fallback. SearchSyntaxError is
 * never swallowed here - malformed queries propagate to the caller.
 */
async function searchVideosFts(
  ast: SearchNode,
  page: number,
  userId?: string,
): Promise<PageResult<ReturnType<typeof serializeVideo>> | null> {
  const filter = buildSearchFilterSql(ast);
  const rank = buildSearchRankSql(ast);

  const perPage = videosPerPage();
  const safePage = Math.max(1, page);
  const take = perPage;
  const skip = (safePage - 1) * perPage;

  const scope =
    userId === undefined
      ? Prisma.sql`v."megaAccountId" IS NULL`
      : Prisma.sql`(v."megaAccountId" IS NULL OR v."megaAccountId" IN (SELECT "id" FROM "MegaAccount" WHERE "userId" = ${userId} AND "status" <> ${MEGA_ACCOUNT_STATUSES.DISCONNECTED}))`;

  // BM25 is more negative for better matches; rows with no positive-term
  // match (pure-NOT results) get NULL and sort after ranked rows. SQLite
  // sorts NULLs first on ASC, hence the explicit NULL guard.
  const orderBy =
    rank === null
      ? Prisma.sql`v."createdAt" DESC, v."id" DESC`
      : Prisma.sql`CASE WHEN "rank" IS NULL THEN 1 ELSE 0 END, "rank" ASC, v."createdAt" DESC, v."id" DESC`;
  const rankSelect = rank ?? Prisma.sql`NULL`;

  try {
    const [idRows, countRows] = await Promise.all([
      prisma.$queryRaw<Array<{ id: number; rank: number | null }>>`
        SELECT v."id" AS id, ${rankSelect} AS rank FROM "Video" AS v
        WHERE ${scope} AND ${filter}
        ORDER BY ${orderBy}
        LIMIT ${take} OFFSET ${skip}`,
      prisma.$queryRaw<Array<{ total: bigint }>>`
        SELECT COUNT(*) AS total FROM "Video" AS v
        WHERE ${scope} AND ${filter}`,
    ]);

    const total = Number(countRows[0]?.total ?? 0);
    if (idRows.length === 0) {
      return { items: [], total, page: safePage, perPage, totalPages: Math.max(1, Math.ceil(total / perPage)) };
    }

    const rows = await prisma.video.findMany({
      where: { id: { in: idRows.map((r) => r.id) } },
      select: videoSelect,
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const items = idRows
      .map((r) => byId.get(r.id))
      .filter((r): r is NonNullable<typeof r> => r !== undefined)
      .map(serializeVideo);

    return {
      items,
      total,
      page: safePage,
      perPage,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
    };
  } catch {
    // FTS table missing (pre-migration database) or malformed MATCH:
    // caller falls back to LIKE rather than failing the search.
    return null;
  }
}

/**
 * Execute an already-parsed search AST: FTS fast path first, Prisma/LIKE
 * fallback when the index is unavailable.
 */
async function executeSearchAst(
  ast: SearchNode,
  page: number,
  userId?: string,
): Promise<PageResult<ReturnType<typeof serializeVideo>>> {
  const perPage = videosPerPage();
  const safePage = Math.max(1, page);

  // Native-index fast path; LIKE fallback when unavailable.
  const fast = await searchVideosFts(ast, safePage, userId);
  if (fast) return fast;

  const scope = libraryScope(userId);

  // AND of [visibility scope, text match]. Deliberately composed via AND so
  // the scope's own OR cannot be clobbered by the match OR (a flat spread
  // would silently drop user isolation!).
  const where = {
    AND: [scope, buildSearchPrismaWhere(ast)],
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
 * Query language (lib/search.ts): whitespace is implicit OR, `||` explicit
 * OR, `&&` AND, `!` NOT, `(...)` grouping, `"..."` phrase terms. Results
 * are ranked by FTS5 BM25 over the positive terms (title weighted first);
 * NOT-only queries fall back to recency order. Throws SearchSyntaxError for
 * malformed boolean syntax.
 */
export async function searchVideos(
  query: string,
  page = 1,
  userId?: string,
): Promise<PageResult<ReturnType<typeof serializeVideo>>> {
  const perPage = videosPerPage();
  const q = query.trim();

  if (!q) {
    return { items: [], total: 0, page: 1, perPage, totalPages: 1 };
  }

  return executeSearchAst(parseSearchQuery(q), page, userId);
}

/**
 * Literal (non-boolean) search for internal callers that feed derived text
 * such as video titles into the engine. The whole query is ONE phrase term,
 * so titles containing `&&`, `||`, `!` or parentheses can never become
 * syntax errors or change meaning.
 */
export async function searchVideosLiteral(
  query: string,
  page = 1,
  userId?: string,
): Promise<PageResult<ReturnType<typeof serializeVideo>>> {
  const perPage = videosPerPage();
  const ast = literalSearchNode(query.trim());

  if (!ast) {
    return { items: [], total: 0, page: 1, perPage, totalPages: 1 };
  }

  return executeSearchAst(ast, page, userId);
}

/** Videos by a creator for a specific user (private videos only). */
export async function listVideosByCreator(
  userId: string,
  creatorSlug: string,
  page = 1,
): Promise<{ creator: { id: number; slug: string; name: string; avatar: string | null; description: string | null } | null; result: PageResult<ReturnType<typeof serializeVideo>> }> {
  const perPage = videosPerPage();
  const safePage = Math.max(1, page);

  // P1.6: seek the (userId, slug) composite unique index directly instead
  // of scanning by slug alone and checking ownership in application code.
  // Ownership is now enforced inside the query; the not-found shape is
  // unchanged (creator:null + empty page, never another user's creator).
  const creator = await prisma.creator.findUnique({
    where: { userId_slug: { userId, slug: creatorSlug } },
    select: { id: true, slug: true, name: true, avatar: true, description: true },
  });

  if (!creator) {
    return {
      creator: null,
      result: { items: [], total: 0, page: 1, perPage, totalPages: 1 },
    };
  }

  const where = {
    creatorId: creator.id,
    megaAccount: {
      userId,
      status: { not: MEGA_ACCOUNT_STATUSES.DISCONNECTED },
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
    creator: { id: creator.id, slug: creator.slug, name: creator.name, avatar: creator.avatar, description: creator.description },
    result: {
      items: items.map(serializeVideo),
      total,
      page: safePage,
      perPage,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
    },
  };
}

/** All creators with video counts for the authenticated user. */
export async function listCreators(userId: string) {
  const creators = await prisma.creator.findMany({
    where: { userId },
    select: {
      id: true,
      slug: true,
      name: true,
      avatar: true,
      description: true,
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
