/**
 * P2.0 product foundation: user-scoped creator grouping + safe reconciliation.
 *
 * Rules (from the P2 product requirements):
 *   - Creator and title come ONLY from the MEGA filename via
 *     parseVideoMetadata(). Folder names, parentNodeId, MEGA account names
 *     and node IDs NEVER determine the creator.
 *   - When no creator can be determined, the video belongs to the
 *     user-scoped "Unknown Creator" grouping - exactly ONE such creator per
 *     user (resolved by the existing (userId, slug) unique index, so
 *     concurrent calls cannot duplicate it).
 *   - Manual creator assignments (creatorAssignment === 'manual', set through
 *     the creator PATCH endpoint) are NEVER overwritten automatically - not
 *     by sync, not by reconciliation.
 */

import { prisma } from './db';
import { ensureCreatorForUser, normalizeCreatorName, parseVideoMetadata } from './titles';
import { MEGA_ACCOUNT_STATUSES } from './megaAccounts';

/** Display name of the fallback grouping for videos without a creator. */
export const UNKNOWN_CREATOR_NAME = 'Unknown Creator';

/**
 * Resolve (creating if needed) the single user-scoped "Unknown Creator"
 * grouping. Deduplicated by the (userId, slug) unique index + the same
 * per-job cache pattern as ensureCreatorForUser.
 */
export async function ensureUnknownCreatorForUser(
  userId: string,
  cache?: Map<string, number>,
): Promise<number> {
  return ensureCreatorForUser(userId, UNKNOWN_CREATOR_NAME, cache);
}

/**
 * Resolve the creator id for a parsed filename result: the normalized
 * creator name when present, otherwise the "Unknown Creator" grouping.
 */
export async function resolveCreatorIdForParsed(
  userId: string,
  parsedCreator: string | null,
  cache?: Map<string, number>,
): Promise<{ creatorId: number; assignment: 'auto' }> {
  if (parsedCreator) {
    const normalized = normalizeCreatorName(parsedCreator);
    return { creatorId: await ensureCreatorForUser(userId, normalized, cache), assignment: 'auto' };
  }
  return { creatorId: await ensureUnknownCreatorForUser(userId, cache), assignment: 'auto' };
}

export interface ReconcileCreatorsResult {
  scanned: number;
  updated: number;
  assignedUnknown: number;
  manualSkipped: number;
  dryRun: boolean;
}

/**
 * Safely reconcile EXISTING videos of one user against the improved filename
 * parser.
 *
 * Only videos with creatorAssignment !== 'manual' are considered; manual
 * assignments are counted in manualSkipped and never touched. For each
 * eligible video the MEGA filename is re-parsed (first exact " - "
 * separator, "Watch " prefix stripped from the creator candidate, folders
 * ignored) and the video is pointed at the matching user-scoped creator -
 * or at the "Unknown Creator" grouping when no creator can be determined.
 * A row is only rewritten when its creatorId or assignment would change.
 *
 * With { dryRun: true } nothing is written; the returned counts describe
 * what WOULD change.
 *
 * "Existing-data" safety: no column is added, no NOT NULL constraint is
 * introduced, and orphaned creators are never deleted - videos are only
 * re-pointed between creators owned by the same user.
 */
export async function reconcileCreatorsForUser(
  userId: string,
  opts?: { dryRun?: boolean },
): Promise<ReconcileCreatorsResult> {
  const dryRun = opts?.dryRun ?? false;

  const videos = await prisma.video.findMany({
    where: {
      megaAccount: {
        userId,
        status: { not: MEGA_ACCOUNT_STATUSES.DISCONNECTED },
      },
    },
    select: { id: true, megaFilename: true, creatorId: true, creatorAssignment: true },
    orderBy: { id: 'asc' },
  });

  const cache = new Map<string, number>();
  const result: ReconcileCreatorsResult = {
    scanned: videos.length,
    updated: 0,
    assignedUnknown: 0,
    manualSkipped: 0,
    dryRun,
  };

  for (const v of videos) {
    if (v.creatorAssignment === 'manual') {
      result.manualSkipped++;
      continue;
    }
    const parsed = parseVideoMetadata(v.megaFilename);
    const { creatorId, assignment } = await resolveCreatorIdForParsed(userId, parsed.creator, cache);
    if (creatorId !== v.creatorId || v.creatorAssignment !== assignment) {
      if (!dryRun) {
        await prisma.video.update({
          where: { id: v.id },
          data: { creatorId, creatorAssignment: assignment },
        });
      }
      result.updated++;
      if (!parsed.creator) result.assignedUnknown++;
    }
  }

  return result;
}
