/**
 * Single-video delete service: deletes the ACTUAL file node on the owner's
 * linked MEGA account plus the corresponding MegaTube record.
 *
 * This is NOT a second deletion system: the MEGA operation is the shared
 * `deleteMegaNode` helper (permanent `a=d`, see lib/mega/nodeOps) used by
 * the existing duplicate-deletion endpoints, with the same ownership
 * re-verification, already-gone (-9) handling, and session-expiry mapping.
 * The only difference from the bulk flow is bookkeeping: the bulk flow lets
 * the next sync reconcile the rows away, while a single-video delete
 * removes its row immediately so the UI can navigate away at once. The end
 * state is identical (MEGA file gone, record gone).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Storage } from 'megajs';
import { prisma } from './db';
import { classifyMegaError, MegaError, safeMegaErrorMessage } from './mega/account';
import { isNotFoundError } from './mega/nodeOps';

export interface DeleteDeps {
  withMegaSession: <T>(
    accountId: number,
    encryptedSession: string,
    fn: (storage: Storage) => Promise<T>,
  ) => Promise<T>;
  deleteMegaNode: (storage: Storage, nodeId: string) => Promise<void>;
  markAccountReauthRequired: (accountId: number, message: string) => Promise<void>;
  evictMegaSession: (accountId: number) => void;
  enqueueSync: (accountId: number, source: string) => Promise<unknown>;
}

export interface DeletedVideo {
  id: number;
  nodeId: string;
  /** True when MEGA reported the node was already gone (-9). */
  alreadyGone: boolean;
  syncQueued: boolean;
}

export class DeleteVideoError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'DeleteVideoError';
    this.status = status;
  }
}

function thumbsDir(): string {
  return process.env.THUMBS_DIR ?? path.join(process.cwd(), 'data', 'thumbs');
}

/** Best-effort local thumbnail cleanup (mirrors the sync removal path). */
function removeLocalThumbnails(videoId: number): void {
  for (const ext of ['png', 'jpg']) {
    try {
      fs.rmSync(path.join(thumbsDir(), `${videoId}.${ext}`), { force: true });
    } catch {
      // ignore - cosmetic cleanup only
    }
  }
}

/**
 * Delete one owned video (MEGA node + MegaTube record).
 *
 * @throws {DeleteVideoError} with an HTTP status for every expected failure.
 */
export async function deleteVideo(
  videoId: number,
  userId: string,
  deps: DeleteDeps,
): Promise<DeletedVideo> {
  if (!Number.isInteger(videoId) || videoId <= 0) {
    throw new DeleteVideoError(400, 'Invalid video ID.');
  }

  // Ownership-scoped lookup: missing, public, or another user's video all
  // resolve to null (callers answer 404 without leaking existence).
  const video = await prisma.video.findFirst({
    where: { id: videoId, megaAccount: { userId } },
    select: {
      id: true,
      megaNodeId: true,
      megaAccountId: true,
      megaAccount: {
        select: { id: true, userId: true, encryptedSession: true, status: true },
      },
    },
  });
  if (!video || !video.megaAccount) throw new DeleteVideoError(404, 'Video not found.');
  const account = video.megaAccount;

  const nodeId = video.megaNodeId;
  if (!video.megaAccountId || !nodeId) {
    throw new DeleteVideoError(409, 'This video is not linked to a MEGA file and cannot be deleted.');
  }

  // 1) Delete the EXACT node (stable MEGA handle) through the owner's session.
  let alreadyGone = false;
  try {
    await deps.withMegaSession(account.id, account.encryptedSession, async (storage) => {
      try {
        await deps.deleteMegaNode(storage, nodeId);
      } catch (err) {
        if (isNotFoundError(err)) {
          // Deleted externally (or twice from two tabs): the MEGA end state
          // is already what the user asked for - fall through to local
          // cleanup and report honestly.
          alreadyGone = true;
          return;
        }
        throw err;
      }
    });
  } catch (err) {
    if (err instanceof MegaError) {
      const msg = safeMegaErrorMessage(err.kind);
      if (err.kind === 'session-expired' || err.kind === 'auth' || err.kind === 'mfa') {
        deps.evictMegaSession(account.id);
        await deps.markAccountReauthRequired(account.id, msg);
        throw new DeleteVideoError(409, 'Your MEGA session needs to be reconnected.');
      }
      throw new DeleteVideoError(502, msg);
    }
    if (err instanceof DeleteVideoError) throw err;
    const kind = classifyMegaError(err, 'session');
    if (kind === 'session-expired' || kind === 'auth' || kind === 'mfa') {
      deps.evictMegaSession(account.id);
      await deps.markAccountReauthRequired(account.id, safeMegaErrorMessage(kind));
      throw new DeleteVideoError(409, 'Your MEGA session needs to be reconnected.');
    }
    throw new DeleteVideoError(
      502,
      kind === 'transient' ? 'MEGA is temporarily unavailable. Try again.' : 'Could not delete the file on MEGA.',
    );
  }

  // 2) MEGA delete confirmed (or already gone): remove the record + local
  //    thumbnails, then queue a sync so account state reconciles as usual.
  removeLocalThumbnails(video.id);
  await prisma.video.delete({ where: { id: video.id } });
  const { invalidateHomeFeed } = await import('./feedCache');
  invalidateHomeFeed(userId);
  let syncQueued = false;
  try {
    const outcome = await deps.enqueueSync(account.id, 'video-delete');
    syncQueued = outcome === 'queued' || outcome === 'already-pending';
  } catch {
    syncQueued = false;
  }
  return { id: video.id, nodeId, alreadyGone, syncQueued };
}
