/**
 * The MEGA library synchronization job (server-side only).
 *
 * One job = one MEGA account = one full `a=f c=1` fetch + reconciliation
 * against the stored Video rows for that account. The job:
 *
 *   1. claims the account (atomic status gate - concurrent jobs skip)
 *   2. resumes the stored MEGA session (no password)
 *   3. fetches the node tree, keeps video files only
 *   4. reconciles: add / update / remove / leave-unchanged
 *      (identity = MEGA node handle; unchanged rows are never rewritten and
 *       their thumbnails are never refetched)
 *   5. fetches thumbnails + media duration for NEW videos only
 *   6. updates status/timestamps and logs a safe summary
 *
 * Error policy:
 *   - session expired / credentials rejected  -> REAUTH_REQUIRED (no retry)
 *   - transient (congestion/rate-limit/network) -> ERROR + backoff retry
 *   - unexpected                               -> ERROR + backoff retry
 *
 * NEVER logs secrets: only counts, ids and sanitized MEGA error labels.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Storage } from 'megajs';
import { prisma } from '../db';
import {
  MegaError,
  safeMegaErrorMessage,
} from '../mega/account';
import { isVideoNode, mimeFromVideoExtension, parseFa } from '../mega/nodes';
import {
  getPrivateNodeImage,
  getPrivateNodeMediaProperties,
} from '../mega/attributes';
import type { ApiLike } from '../mega/attributes';
import { encryptSecret } from '../mega/envelope';
import {
  claimSyncStart,
  markAccountError,
  markAccountReauthRequired,
  markSyncCompleted,
  MEGA_ACCOUNT_STATUSES,
} from '../megaAccounts';
import { planReconciliation } from './reconcile';
import type { RemoteVideoNode, ExistingVideoRow } from './reconcile';
import { withMegaSession as realWithMegaSession, evictMegaSession } from './session-cache';
import { fetchAccountFileNodes as realFetchAccountFileNodes } from '../mega/account';
import { setSyncProgress, bumpSyncProgress, clearSyncProgress, getSyncProgress } from './progress';

/**
 * Injectable MEGA boundary (tests substitute these; production uses the
 * real session-resume + node-fetch implementations). The worker NEVER gets
 * a password-login capability - there is nothing to inject for one.
 */
export interface SyncDeps {
  withMegaSession: typeof realWithMegaSession;
  fetchAccountFileNodes: typeof realFetchAccountFileNodes;
}

const defaultDeps: SyncDeps = {
  withMegaSession: realWithMegaSession,
  fetchAccountFileNodes: realFetchAccountFileNodes,
};
import { setLastSyncMeta } from '../megaAccounts';
import { parseVideoMetadata, uniqueSlug, ensureCreatorForUser, normalizeCreatorName } from '../titles';

const THUMBS_DIR = path.resolve(process.cwd(), 'data/thumbs');
const ATTRIBUTE_FETCH_DELAY_MS = 200; // be polite to MEGA's attribute endpoints

/** Wrap a live megajs Storage's API client into the minimal ApiLike surface. */
function toApiLike(storage: Storage): ApiLike {
  const request = storage.api.request as unknown as (
    cmd: Record<string, unknown>,
  ) => Promise<unknown>;
  return { request: (cmd) => request.call(storage.api, cmd) };
}

export interface SyncResult {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  total: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function thumbnailFileFor(videoId: number, ext: string): string {
  return path.join(THUMBS_DIR, `${videoId}.${ext}`);
}

export function thumbnailPathForVideo(videoId: number): string {
  return `/api/media/thumbs/${videoId}`;
}

async function existingRowsForAccount(accountId: number): Promise<ExistingVideoRow[]> {
  const rows = await prisma.video.findMany({
    where: { megaAccountId: accountId },
    select: {
      id: true,
      megaNodeId: true,
      megaFilename: true,
      fileSize: true,
      parentNodeId: true,
      megaModifiedAt: true,
      megaFa: true,
      thumbnail: true,
      thumbnailAvailable: true,
    },
  });
  return rows.filter((r) => r.megaNodeId !== null).map((r) => ({
    id: r.id,
    megaNodeId: r.megaNodeId as string,
    megaFilename: r.megaFilename,
    fileSize: r.fileSize,
    parentNodeId: r.parentNodeId,
    megaModifiedAt: r.megaModifiedAt,
    megaFa: r.megaFa,
    thumbnail: r.thumbnail,
    thumbnailAvailable: r.thumbnailAvailable,
  }));
}

/**
 * Fetch a thumbnail for a new video and store it under data/thumbs.
 * Returns the public URL to persist, or null when unavailable.
 */
async function fetchAndStoreThumbnail(
  api: ApiLike,
  videoId: number,
  fa: string | null,
  fileKey: Buffer,
): Promise<string | null> {
  try {
    const image = await getPrivateNodeImage(api, fa, 'thumbnail', fileKey);
    if (!image) return null;
    const ext = image.mimeType === 'image/png' ? 'png' : 'jpg';
    fs.mkdirSync(THUMBS_DIR, { recursive: true });
    fs.writeFileSync(thumbnailFileFor(videoId, ext), image.data);
    return thumbnailPathForVideo(videoId);
  } catch (err) {
    console.warn(
      `[sync] thumbnail fetch failed (videoId=${videoId}): ${err instanceof Error ? err.message : 'unknown'}`,
    );
    return null;
  }
}

/**
 * Run a full sync for one account.
 *
 * @returns the sync result, or null when the job was a no-op (already
 *   syncing) or the account needs re-authentication.
 */
export async function syncMegaAccount(
  accountId: number,
  deps: SyncDeps = defaultDeps,
): Promise<SyncResult | null> {
  const claimed = await claimSyncStart(accountId);
  if (!claimed) {
    console.log(`[sync] MegaAccount ${accountId} sync skipped: already syncing`);
    return null;
  }

  const account = await prisma.megaAccount.findUnique({
    where: { id: accountId },
    select: { id: true, encryptedSession: true, status: true, megaEmail: true },
  });
  if (!account) {
    return null;
  }
  if (!account.encryptedSession || account.status === MEGA_ACCOUNT_STATUSES.DISCONNECTED) {
    await markAccountReauthRequired(accountId, 'No MEGA session stored for this account.');
    return null;
  }

  console.log(`[sync] MegaAccount ${accountId} sync started`);

  let result: SyncResult | null = null;
  let sessionExpired = false;

  const progressStartedAt = Date.now();

  try {
    result = await deps.withMegaSession(accountId, account.encryptedSession, async (storage) => {
      const api = toApiLike(storage);
      // --- PHASE A: scanning (total unknown -> no percentage) ------------
      setSyncProgress(accountId, {
        startedAt: progressStartedAt,
        phase: 'scanning',
        nodesScanned: 0,
        totalVideos: null,
      });
      const nodes = await deps.fetchAccountFileNodes(storage, (nodesScanned) => {
        setSyncProgress(accountId, { phase: 'scanning', nodesScanned });
      });
      const remote: RemoteVideoNode[] = nodes
        .filter((n) => isVideoNode(n.name, n.fa))
        .map((n) => ({
          nodeId: n.h,
          parentNodeId: n.p,
          name: n.name,
          size: n.s,
          ts: n.ts,
          fa: n.fa,
          fileKey: n.fileKey,
        }));

      console.log(`[sync] MegaAccount ${accountId} scanned ${nodes.length} file nodes, ${remote.length} are videos`);

      const existing = await existingRowsForAccount(accountId);
      const plan = planReconciliation(remote, existing);
      // Every video in the plan gets processed exactly once (add/update/
      // remove/verify-unchanged) -> the denominator for real progress.
      const totalToProcess =
        plan.toAdd.length + plan.toUpdate.length + plan.toRemove.length + plan.unchanged.length;

      // --- PHASE B: reconciliation (total known -> real percentage) ------
      setSyncProgress(accountId, {
        phase: 'reconciling',
        nodesScanned: nodes.length,
        totalVideos: totalToProcess,
        processedVideos: 0,
        created: 0,
        updated: 0,
        removed: 0,
      });

      /** Push a Phase-B counter snapshot (monotonic within this job). */
      const reportProgress = (processed: number, created: number, updated: number, removed: number) =>
        bumpSyncProgress(accountId, { processedVideos: processed, created, updated, removed });

      let processed = 0;

      let added = 0;
      let updated = 0;
      let removed = 0;

      /** Count one processed video (whatever the outcome) and push progress. */
      const tick = () => {
        processed++;
        reportProgress(processed, added, updated, removed);
      };

      // --- additions -------------------------------------------------------
      for (const r of plan.toAdd) {
        try {
          // Real MEGA filename is the source of truth; node-id fallback only
          // when the attributes blob was undecryptable (never invent metadata).
          const name = r.name ?? `video-${r.nodeId}`;
          const parsed = parseVideoMetadata(name);
          const slug = await uniqueSlug(parsed.title);

          let creatorId: number | null = null;
          if (parsed.creator) {
            const normalized = normalizeCreatorName(parsed.creator);
            creatorId = await ensureCreatorForUser(account.userId, normalized);
          }

          const row = await prisma.video.create({
            data: {
              megaAccountId: accountId,
              megaUrl: `https://mega.nz/file/${r.nodeId}`,
              megaNodeId: r.nodeId,
              parentNodeId: r.parentNodeId,
              megaFilename: name,
              title: parsed.title,
              slug,
              creatorId,
              creatorAssignment: parsed.creator ? 'auto' : 'none',
              fileSize: BigInt(r.size),
              mimeType: mimeFromVideoExtension(name),
              megaModifiedAt: r.ts !== null ? new Date(r.ts * 1000) : null,
              megaFa: r.fa,
              fileKeyEncrypted: r.fileKey ? encryptSecret(r.fileKey) : null,
              thumbnailAvailable: Boolean(parseFa(r.fa)[0]),
              thumbnail: null,
              embedUrl: null,
              sortOrder: 0,
            },
          });
          added++;
          tick();

          if (r.fileKey && parseFa(r.fa)[0]) {
            const thumb = await fetchAndStoreThumbnail(api, row.id, r.fa, r.fileKey);
            if (thumb) {
              await prisma.video.update({ where: { id: row.id }, data: { thumbnail: thumb } });
            }
            await sleep(ATTRIBUTE_FETCH_DELAY_MS);
          }
          if (r.fileKey && parseFa(r.fa)[8]) {
            try {
              const media = await getPrivateNodeMediaProperties(api, r.fa, r.fileKey);
              if (media && media.durationSeconds !== null) {
                await prisma.video.update({
                  where: { id: row.id },
                  data: { duration: media.durationSeconds },
                });
              }
            } catch {
              // Thumbnail/media attribute fetches are best-effort; the video
              // row is already created and playable without them.
            }
            await sleep(ATTRIBUTE_FETCH_DELAY_MS);
          }
        } catch (err) {
          console.warn(
            `[sync] MegaAccount ${accountId} failed to fully process node ${r.nodeId}: ${err instanceof Error ? err.message : 'unknown'}`,
          );
          // Failures still count as processed: progress must always reach 100%.
          tick();
        }
      }

      // --- updates ---------------------------------------------------------
      for (const u of plan.toUpdate) {
        try {
          const name = u.remote.name ?? u.row.megaFilename;
          const parsed = parseVideoMetadata(name);
          const data: Record<string, unknown> = {
            megaFilename: name,
            title: parsed.title,
            fileSize: BigInt(u.remote.size),
            parentNodeId: u.remote.parentNodeId,
            megaModifiedAt: u.remote.ts !== null ? new Date(u.remote.ts * 1000) : null,
            megaFa: u.remote.fa,
          };
          // A rename can introduce/upgrade the creator from the filename, but only
          // when there is no manual override.
          if (parsed.creator && u.row.creatorAssignment !== 'manual') {
            const normalized = normalizeCreatorName(parsed.creator);
            data.creatorId = await ensureCreatorForUser(account.userId, normalized);
            data.creatorAssignment = 'auto';
          } else if (!parsed.creator && u.row.creatorAssignment === 'auto') {
            data.creatorId = null;
            data.creatorAssignment = 'none';
          }
          // A size/timestamp change implies the file content changed (re-upload
          // into the same node is not a MEGA concept) - refresh the key too.
          if (u.remote.fileKey && (u.changes.includes('size') || u.changes.includes('timestamp'))) {
            data.fileKeyEncrypted = encryptSecret(u.remote.fileKey);
          }
          const mimeType = mimeFromVideoExtension(name);
          if (mimeType) data.mimeType = mimeType;
          if (u.changes.includes('file-attributes')) {
            data.thumbnailAvailable = Boolean(parseFa(u.remote.fa)[0]);
          }
          await prisma.video.update({ where: { id: u.row.id }, data });
          updated++;
          tick();

          // New thumbnail became available? Fetch it once.
          if (u.changes.includes('file-attributes') && !u.row.thumbnail && u.remote.fileKey && parseFa(u.remote.fa)[0]) {
            const thumb = await fetchAndStoreThumbnail(api, u.row.id, u.remote.fa, u.remote.fileKey);
            if (thumb) {
              await prisma.video.update({ where: { id: u.row.id }, data: { thumbnail: thumb } });
            }
            await sleep(ATTRIBUTE_FETCH_DELAY_MS);
          }
        } catch (err) {
          console.warn(
            `[sync] MegaAccount ${accountId} failed to update node ${u.remote.nodeId}: ${err instanceof Error ? err.message : 'unknown'}`,
          );
          tick();
        }
      }

      // --- removals ----------------------------------------------------------
      for (const r of plan.toRemove) {
        try {
          // Best-effort thumbnail cleanup (filename may have a different ext).
          for (const ext of ['png', 'jpg']) {
            try {
              fs.rmSync(thumbnailFileFor(r.id, ext), { force: true });
            } catch {
              // ignore
            }
          }
          await prisma.video.delete({ where: { id: r.id } });
          removed++;
          tick();
        } catch (err) {
          console.warn(
            `[sync] MegaAccount ${accountId} failed to remove video ${r.id}: ${err instanceof Error ? err.message : 'unknown'}`,
          );
          tick();
        }
      }

      // Unchanged rows are processed instantly (no writes); count them now
      // so processedVideos reaches the total exactly at the end.
      processed += plan.unchanged.length;
      reportProgress(processed, added, updated, removed);

      const total = await prisma.video.count({ where: { megaAccountId: accountId } });        setSyncProgress(accountId, { phase: 'finalizing' });
      console.log(
        `[sync] MegaAccount ${accountId} sync completed: added=${added} updated=${updated} removed=${removed} videos=${total}`,
      );
      return { added, updated, removed, unchanged: plan.unchanged.length, total };
    });
  } catch (err) {
    if (err instanceof MegaError) {
      if (err.kind === 'session-expired' || err.kind === 'auth' || err.kind === 'mfa') {
        sessionExpired = true;
        evictMegaSession(accountId);
        const msg = safeMegaErrorMessage(err.kind);
        await markAccountReauthRequired(accountId, msg);
        await writeInterruptedMeta(accountId, progressStartedAt, 'failed');
        console.warn(`[sync] MegaAccount ${accountId} now REAUTH_REQUIRED: ${msg}`);
      } else {
        await markAccountError(accountId, safeMegaErrorMessage(err.kind));
        await writeInterruptedMeta(accountId, progressStartedAt, 'failed');
        console.warn(`[sync] MegaAccount ${accountId} sync failed (transient): ${safeMegaErrorMessage(err.kind)}`);
      }
    } else {
      await markAccountError(accountId, 'Unexpected error during sync.');
      await writeInterruptedMeta(accountId, progressStartedAt, 'failed');
      console.warn(`[sync] MegaAccount ${accountId} sync failed unexpectedly`);
    }
    clearSyncProgress(accountId);
    return null;
  }

  if (result) {
    await markSyncCompleted(accountId, result.total);
    // Durable final result for the UI (survives restarts).
    const p = getSyncProgress(accountId);
    await setLastSyncMeta(accountId, {
      startedAt: new Date(progressStartedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - progressStartedAt,
      discovered: p?.totalVideos ?? result.total,
      totalVideos: result.total,
      created: result.added,
      updated: result.updated,
      removed: result.removed,
      unchanged: result.unchanged,
      outcome: 'completed',
    });
  } else if (!sessionExpired) {
    // result null without reauth = unexpected path; make sure status is sane
    // (the error branches above already set ERROR/REAUTH_REQUIRED)
  }

  clearSyncProgress(accountId);
  return result;
}

/**
 * Persist an interrupted/failed sync record so the UI can show a durable
 * "the last sync did not finish" state after a crash or error. Best-effort:
 * meta failures never mask the actual error handling.
 */
async function writeInterruptedMeta(
  accountId: number,
  startedAt: number,
  outcome: 'failed' | 'interrupted',
): Promise<void> {
  try {
    const p = getSyncProgress(accountId);
    await setLastSyncMeta(accountId, {
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      discovered: p?.totalVideos ?? 0,
      totalVideos: 0,
      created: p?.created ?? 0,
      updated: p?.updated ?? 0,
      removed: p?.removed ?? 0,
      unchanged: 0,
      outcome,
    });
  } catch {
    // ignore - meta is advisory
  }
}
