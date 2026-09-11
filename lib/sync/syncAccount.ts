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
import { parseVideoMetadata, uniqueSlug, slugify } from '../titles';
import { resolveCreatorIdForParsed } from '../creators';

const THUMBS_DIR = path.resolve(process.cwd(), 'data/thumbs');
const ATTRIBUTE_FETCH_DELAY_MS = 200; // be polite to MEGA's attribute endpoints

/**
 * P1.4: bounded parallelism for MEGA attribute (thumbnail / media-props)
 * fetches. The delay above is a politeness rate, not a serial dependency:
 * with a shared pacer enforcing >=200ms between attribute-call STARTS,
 * up to ATTR_CONCURRENCY fetches may overlap their network latency while
 * the request rate MEGA observes never exceeds today's serial loop.
 * Database writes stay serial (SQLite); only network I/O overlaps.
 */
const ATTR_CONCURRENCY = 3;

/** Space out MEGA attribute calls: at most one start per delay window. */
function createAttributePacer(delayMs: number): () => Promise<void> {
  let lastStart = 0;
  let tail: Promise<void> = Promise.resolve();
  return async () => {
    const prev = tail;
    let release!: () => void;
    tail = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      const wait = lastStart + delayMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastStart = Date.now();
    } finally {
      release();
    }
  };
}

/** Run items with at most `limit` workers; per-item errors propagate. */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

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
      creatorId: true,
      creatorAssignment: true,
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
    creatorId: r.creatorId,
    creatorAssignment: r.creatorAssignment,
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
    select: { id: true, encryptedSession: true, status: true, megaEmail: true, userId: true },
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

      // P1.4: one creator lookup per distinct creator per job instead of
      // one per video (a 1000-video import from 5 creators did 1000
      // findFirst calls; now it does 5).
      const creatorCache = new Map<string, number>();
      const paceAttributeCall = createAttributePacer(ATTRIBUTE_FETCH_DELAY_MS);

      // P1.4: allocate slugs from one snapshot scoped to the current user's
      // videos. Video.slug is globally unique, so this still guarantees no
      // duplicates: cross-user collisions fall through to the P2002 handler
      // which falls back to uniqueSlug() and retries once.
      const slugSet = new Set(
        (await prisma.video.findMany({
          where: { megaAccount: { userId: account.userId } },
          select: { slug: true },
        })).map((r) => r.slug),
      );
      const allocSlug = (title: string): string => {
        const base = slugify(title);
        let slug = base;
        let n = 2;
        while (slugSet.has(slug)) slug = `${base}-${n++}`;
        slugSet.add(slug);
        return slug;
      };

      // --- additions, phase 1: create rows (serial DB writes) -------------
      // Attribute (thumbnail/media) fetches are collected and run in phase
      // 2 with bounded concurrency; the row is already created and playable
      // without them, exactly as before.
      const pendingAttrs: Array<{
        videoId: number;
        nodeId: string;
        fa: string | null;
        fileKey: Buffer | null;
        needThumb: boolean;
        needMedia: boolean;
      }> = [];
      for (const r of plan.toAdd) {
        try {
          // Real MEGA filename is the source of truth; node-id fallback only
          // when the attributes blob was undecryptable (never invent metadata).
          const name = r.name ?? `video-${r.nodeId}`;
          const parsed = parseVideoMetadata(name);
          const fa = parseFa(r.fa);

          // Filename-derived creator, or the user-scoped "Unknown Creator"
          // grouping when the filename carries no creator (P2.0: never null
          // for automatic assignments; manual overrides happen later via the
          // creator PATCH endpoint, which sets assignment 'manual').
          let creatorId: number | null = null;
          let creatorAssignment = 'none';
          if (account.userId) {
            ({ creatorId, assignment: creatorAssignment } = await resolveCreatorIdForParsed(
              account.userId,
              parsed.creator,
              creatorCache,
            ));
          }

          const data = {
            megaAccountId: accountId,
            megaUrl: `https://mega.nz/file/${r.nodeId}`,
            megaNodeId: r.nodeId,
            parentNodeId: r.parentNodeId,
            megaFilename: name,
            title: parsed.title,
            slug: allocSlug(parsed.title),
            creatorId,
            creatorAssignment,
            fileSize: BigInt(r.size),
            mimeType: mimeFromVideoExtension(name),
            megaModifiedAt: r.ts !== null ? new Date(r.ts * 1000) : null,
            megaFa: r.fa,
            fileKeyEncrypted: r.fileKey ? encryptSecret(r.fileKey) : null,
            thumbnailAvailable: Boolean(fa[0]),
            thumbnail: null,
            embedUrl: null,
            sortOrder: 0,
          };
          let row;
          try {
            row = await prisma.video.create({ data });
          } catch (err) {
            // Slug allocated from the snapshot lost a cross-job race: redo
            // this one row with a live uniqueness probe and retry once.
            if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002') {
              const slug = await uniqueSlug(parsed.title);
              slugSet.add(slug);
              row = await prisma.video.create({ data: { ...data, slug } });
            } else {
              throw err;
            }
          }
          added++;
          tick();

          if (r.fileKey && (fa[0] || fa[8])) {
            pendingAttrs.push({
              videoId: row.id,
              nodeId: r.nodeId,
              fa: r.fa,
              fileKey: r.fileKey,
              needThumb: Boolean(fa[0]),
              needMedia: Boolean(fa[8]),
            });
          }
        } catch (err) {
          console.warn(
            `[sync] MegaAccount ${accountId} failed to fully process node ${r.nodeId}: ${err instanceof Error ? err.message : 'unknown'}`,
          );
          // Failures still count as processed: progress must always reach 100%.
          tick();
        }
      }

      // --- additions, phase 2: thumbnails + durations (bounded overlap) ---
      // Same MEGA calls in the same per-video order (thumbnail first, then
      // media properties) and the same >=200ms start spacing as the old
      // serial loop; only the network latency overlaps. Follow-up DB
      // updates stay serial per worker and best-effort as before.
      await runWithConcurrency(pendingAttrs, ATTR_CONCURRENCY, async (p) => {
        try {
          if (p.needThumb && p.fileKey) {
            await paceAttributeCall();
            const thumb = await fetchAndStoreThumbnail(api, p.videoId, p.fa, p.fileKey);
            if (thumb) {
              await prisma.video.update({ where: { id: p.videoId }, data: { thumbnail: thumb } });
            }
          }
          if (p.needMedia && p.fileKey) {
            try {
              await paceAttributeCall();
              const media = await getPrivateNodeMediaProperties(api, p.fa, p.fileKey);
              if (media && media.durationSeconds !== null) {
                await prisma.video.update({
                  where: { id: p.videoId },
                  data: { duration: media.durationSeconds },
                });
              }
            } catch {
              // Thumbnail/media attribute fetches are best-effort; the video
              // row is already created and playable without them.
            }
          }
        } catch (err) {
          console.warn(
            `[sync] MegaAccount ${accountId} failed to fetch attributes for node ${p.nodeId}: ${err instanceof Error ? err.message : 'unknown'}`,
          );
        }
      });

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
          // A rename can introduce/change the filename-derived creator
          // (including falling back to the "Unknown Creator" grouping), but
          // only when there is no manual override. Writes are skipped when
          // the assignment would not change, so creator bookkeeping never
          // dirties reconciliation state.
          if (account.userId && u.row.creatorAssignment !== 'manual') {
            const resolved = await resolveCreatorIdForParsed(
              account.userId,
              parsed.creator,
              creatorCache,
            );
            if (u.row.creatorId !== resolved.creatorId || u.row.creatorAssignment !== resolved.assignment) {
              data.creatorId = resolved.creatorId;
              data.creatorAssignment = resolved.assignment;
            }
          }
          // A size/timestamp change implies the file content changed (re-upload
          // into the same node is not a MEGA concept) - refresh the key too.
          if (u.remote.fileKey && (u.changes.includes('size') || u.changes.includes('timestamp'))) {
            data.fileKeyEncrypted = encryptSecret(u.remote.fileKey);
          }
          const mimeType = mimeFromVideoExtension(name);
          if (mimeType) data.mimeType = mimeType;
          const remoteFa = parseFa(u.remote.fa);
          if (u.changes.includes('file-attributes')) {
            data.thumbnailAvailable = Boolean(remoteFa[0]);
          }
          await prisma.video.update({ where: { id: u.row.id }, data });
          updated++;
          tick();

          // New thumbnail became available? Fetch it once.
          if (u.changes.includes('file-attributes') && !u.row.thumbnail && u.remote.fileKey && remoteFa[0]) {
            await paceAttributeCall();
            const thumb = await fetchAndStoreThumbnail(api, u.row.id, u.remote.fa, u.remote.fileKey);
            if (thumb) {
              await prisma.video.update({ where: { id: u.row.id }, data: { thumbnail: thumb } });
            }
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
