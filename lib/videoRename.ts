/**
 * Rename-a-video service: renames the ACTUAL file node on the owner's linked
 * MEGA account, then updates MegaTube's PostgreSQL metadata from the new
 * filename.
 *
 * Ordering guarantee: the database is only written AFTER the MEGA rename
 * succeeds, so the DB can never claim a name MEGA does not have. When the
 * MEGA rename succeeds but the DB write fails, that partial state is
 * reported explicitly (megaRenamed: true) instead of as a generic failure.
 *
 * Filename -> metadata mapping reuses the existing sync/parser pipeline:
 *   - `parseVideoMetadata()` (lib/titles.ts) derives (creator, title) from
 *     the new filename with the exact same rules as library sync
 *     ("Creator - Title.ext" split on the FIRST " - ", extension excluded).
 *   - `resolveCreatorIdForParsed()` (lib/creators.ts) assigns the
 *     filename-derived creator. When the filename carries NO creator
 *     pattern, the existing creator association is preserved untouched.
 *
 * The Video row keeps its id/slug/MEGA node id: nothing is re-created.
 */

import type { Storage } from 'megajs';
import { prisma } from './db';
import { decryptSecret } from './mega/envelope';
import { classifyMegaError, MegaError, safeMegaErrorMessage } from './mega/account';
import { isNotFoundError } from './mega/nodeOps';
import { parseVideoMetadata } from './titles';
import { resolveCreatorIdForParsed } from './creators';
import { mimeFromVideoExtension } from './mega/nodes';

/** Maximum MEGA filename length accepted by this endpoint. */
export const MAX_RENAME_LENGTH = 255;

export interface RenameDeps {
  withMegaSession: <T>(
    accountId: number,
    encryptedSession: string,
    fn: (storage: Storage) => Promise<T>,
  ) => Promise<T>;
  renameMegaNode: (
    storage: Storage,
    nodeId: string,
    fileKey: Buffer,
    newName: string,
  ) => Promise<void>;
  markAccountReauthRequired: (accountId: number, message: string) => Promise<void>;
  evictMegaSession: (accountId: number) => void;
}

export interface RenamedVideo {
  id: number;
  title: string;
  megaFilename: string;
  slug: string;
  creator: { slug: string; name: string } | null;
  creatorAssignment: string | null;
}

export class RenameError extends Error {
  status: number;
  /**
   * True when the MEGA rename already succeeded and only the follow-up DB
   * write failed: the file on MEGA carries the new name while MegaTube's
   * metadata does not (a resync reconciles it).
   */
  megaRenamed: boolean;
  constructor(status: number, message: string, megaRenamed = false) {
    super(message);
    this.name = 'RenameError';
    this.status = status;
    this.megaRenamed = megaRenamed;
  }
}

/**
 * Validate a candidate MEGA filename. Returns the trimmed name or throws
 * RenameError(400). MEGA filenames cannot contain path separators.
 */
export function validateNewFilename(raw: unknown): string {
  if (typeof raw !== 'string') throw new RenameError(400, 'A new filename is required.');
  const name = raw.trim();
  if (!name) throw new RenameError(400, 'A new filename is required.');
  if (name.length > MAX_RENAME_LENGTH) {
    throw new RenameError(400, `The filename must be ${MAX_RENAME_LENGTH} characters or fewer.`);
  }
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new RenameError(400, 'The filename cannot contain path separators.');
  }
  if (/[\x00-\x1f\x7f]/.test(name)) {
    throw new RenameError(400, 'The filename contains invalid characters.');
  }
  return name;
}

/**
 * Rename one owned video.
 *
 * @throws {RenameError} with an HTTP status for every expected failure.
 */
export async function renameVideo(
  videoId: number,
  userId: string,
  rawName: unknown,
  deps: RenameDeps,
): Promise<RenamedVideo> {
  if (!Number.isInteger(videoId) || videoId <= 0) {
    throw new RenameError(400, 'Invalid video ID.');
  }
  const newName = validateNewFilename(rawName);

  // Ownership-scoped lookup: missing, public, or another user's video all
  // resolve to null (callers answer 404 without leaking existence).
  const video = await prisma.video.findFirst({
    where: { id: videoId, megaAccount: { userId } },
    select: {
      id: true,
      slug: true,
      title: true,
      megaFilename: true,
      megaNodeId: true,
      megaAccountId: true,
      creatorId: true,
      creatorAssignment: true,
      mimeType: true,
      fileKeyEncrypted: true,
      megaAccount: {
        select: { id: true, userId: true, encryptedSession: true, status: true },
      },
    },
  });
  if (!video || !video.megaAccount) throw new RenameError(404, 'Video not found.');
  const account = video.megaAccount;

  const nodeId = video.megaNodeId;
  if (!video.megaAccountId || !nodeId) {
    throw new RenameError(409, 'This video is not linked to a MEGA file and cannot be renamed.');
  }
  if (newName === video.megaFilename) {
    throw new RenameError(400, 'The new name is the same as the current name.');
  }
  if (!video.fileKeyEncrypted) {
    throw new RenameError(409, 'This video has no stored file key and cannot be renamed yet.');
  }
  let fileKey: Buffer;
  try {
    fileKey = decryptSecret(video.fileKeyEncrypted);
  } catch {
    throw new RenameError(500, 'The stored file key is unreadable.');
  }
  if (fileKey.length !== 32) {
    throw new RenameError(500, 'The stored file key is invalid.');
  }

  // 1) Rename the EXACT node (stable MEGA handle) on the owner's account.
  //    No DB write happens before this succeeds.
  try {
    await deps.withMegaSession(account.id, account.encryptedSession, async (storage) => {
      await deps.renameMegaNode(storage, nodeId, fileKey, newName);
    });
  } catch (err) {
    if (isNotFoundError(err)) {
      throw new RenameError(404, 'The file no longer exists on MEGA.');
    }
    if (err instanceof MegaError) {
      const msg = safeMegaErrorMessage(err.kind);
      if (err.kind === 'session-expired' || err.kind === 'auth' || err.kind === 'mfa') {
        deps.evictMegaSession(account.id);
        await deps.markAccountReauthRequired(account.id, msg);
        throw new RenameError(409, 'Your MEGA session needs to be reconnected.');
      }
      throw new RenameError(502, msg);
    }
    if (err instanceof RenameError) throw err;
    const kind = classifyMegaError(err, 'session');
    if (kind === 'session-expired' || kind === 'auth' || kind === 'mfa') {
      deps.evictMegaSession(account.id);
      await deps.markAccountReauthRequired(account.id, safeMegaErrorMessage(kind));
      throw new RenameError(409, 'Your MEGA session needs to be reconnected.');
    }
    throw new RenameError(
      502,
      kind === 'transient' ? 'MEGA is temporarily unavailable. Try again.' : 'Could not rename the file on MEGA.',
    );
  }

  // 2) MEGA rename succeeded: derive metadata with the SAME parser sync uses.
  const parsed = parseVideoMetadata(newName);
  let creatorId: number | null = video.creatorId;
  let creatorAssignment: string | null = video.creatorAssignment;
  if (parsed.creator) {
    const resolved = await resolveCreatorIdForParsed(userId, parsed.creator);
    creatorId = resolved.creatorId;
    creatorAssignment = resolved.assignment;
  }
  // No creator pattern -> preserve the existing creator association exactly.
  const data: Record<string, unknown> = {
    megaFilename: newName,
    title: parsed.title,
    creatorId,
    creatorAssignment,
  };
  const mimeType = mimeFromVideoExtension(newName);
  if (mimeType) data.mimeType = mimeType;

  // 3) Persist. On failure the MEGA file ALREADY carries the new name -
  //    report that explicitly (a later sync reconciles the row).
  try {
    const updated = await prisma.video.update({
      where: { id: video.id },
      data,
      select: {
        id: true,
        title: true,
        megaFilename: true,
        slug: true,
        creatorAssignment: true,
        creator: { select: { slug: true, name: true } },
      },
    });
    const { invalidateHomeFeed } = await import('./feedCache');
    invalidateHomeFeed(userId);
    return {
      id: updated.id,
      title: updated.title,
      megaFilename: updated.megaFilename,
      slug: updated.slug,
      creator: updated.creator,
      creatorAssignment: updated.creatorAssignment,
    };
  } catch {
    throw new RenameError(
      502,
      'The file was renamed on MEGA but MegaTube could not save the new name. It will reconcile on the next sync.',
      true,
    );
  }
}
