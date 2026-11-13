/**
 * Phase 5.1 durable preview-generation backlog.
 *
 * PostgreSQL is the only queue store. Job rows survive Next.js restarts and
 * are claimed with `FOR UPDATE SKIP LOCKED`, so multiple worker processes
 * can safely share one library backlog without duplicating ffmpeg work.
 *
 * A row is uniquely identified by (video, kind, source fingerprint,
 * generation version). Repeated sync events, hover requests and manual
 * scans therefore converge on the same job instead of spawning duplicates.
 * No MEGA URL, session token or file key is ever stored here.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Prisma } from '@/generated/client';
import { prisma } from '@/lib/db';
import {
  activePreviewReaders,
  clipPath,
  flushPreviewAccessTimes,
  previewsDir,
  readSidecar,
  removePreviewAssets,
  spritePath,
  cleanupFailedPreviewArtifacts,
} from './cache';
import {
  previewDeleteAllBatchSize,
  previewGenerationVersion,
  previewJobMaxAttempts,
  previewJobMaxRecoveries,
  previewJobRecoveryBaseMs,
  previewJobRecoveryJitterMs,
  previewJobRecoveryMaxMs,
  previewJobRetryBaseMs,
  previewJobRetryMaxMs,
  previewJobStarvationMs,
  previewPrioritySync,
  previewStatsCacheTtlMs,
  previewStatsMinRefreshMs,
} from './config';
import {
  getCachedStats,
  invalidatePreviewStatsCache,
} from './stats-cache';

/**
 * PostgreSQL TIMESTAMP columns are read as UTC by Prisma. `now()` returns a
 * timestamptz rendered in the session timezone, so writing it directly into
 * a TIMESTAMP column silently skews every retry/lease deadline whenever the
 * server timezone is not UTC (e.g. Asia/Kolkata +05:30). Normalize at the
 * SQL boundary instead of relying on deployment configuration.
 */
const utcNow = Prisma.sql`(now() AT TIME ZONE 'UTC')`;

export type PreviewJobStatus =
  | 'pending'
  | 'queued'
  | 'generating'
  | 'completed'
  | 'failed'
  | 'unsupported';

export type PreviewJobErrorCode =
  | 'source_unavailable'
  | 'source_size_unknown'
  | 'source_changed'
  | 'moov_missing'
  | 'unsupported_codec'
  | 'unsupported_container'
  | 'download_failed'
  | 'download_timeout'
  | 'ffmpeg_timeout'
  | 'encode_failed'
  | 'output_invalid'
  | 'output_too_large'
  | 'artifact_missing'
  | 'publication_failed'
  | 'lease_expired'
  | 'lease_lost'
  | 'job_timeout'
  | 'worker_shutdown'
  | 'worker_recovery_exhausted'
  | 'max_attempts'
  | 'internal';

export interface PreviewJobMetrics {
  transferBytes: number;
  acquisitionMs: number;
  ffmpegMs: number;
  totalMs: number;
  outputBytes: number;
  scenes: Array<{
    startSec: number;
    durationSec: number;
    sourceSeekSec: number;
    estimated?: boolean;
    byteFraction?: number | null;
  }>;
  sourceKind: string;
  generationVersion: string;
}

export interface PreviewJobEnsureInput {
  videoId: number;
  sourceFingerprint: string;
  kind?: 'hover';
  priority?: number;
  generationVersion?: string;
  maxAttempts?: number;
  /** When true, a failed row whose backoff has elapsed returns to pending. */
  retryEligible?: boolean;
  /** False when the caller already verified the artifact is missing. */
  artifactValid?: boolean;
}

export interface PreviewJobEnsureResult {
  key: string;
  jobId: number | null;
  status: PreviewJobStatus | 'superseded';
  enqueued: boolean;
}

export interface PreviewLibraryVideoRow {
  id: number;
  megaNodeId: string | null;
  fileSize: bigint | null;
  duration: number | null;
  mp4Faststart: boolean | null;
  mimeType: string | null;
  megaAccountId: number | null;
}

export function sourceFingerprintFor(video: Pick<PreviewLibraryVideoRow, 'megaNodeId' | 'fileSize'>): string {
  return `${video.megaNodeId ?? 'missing'}:${video.fileSize === null ? 'unknown' : Number(video.fileSize)}`;
}

export function previewJobKey(videoId: number, sourceFingerprint: string, generationVersion: string): string {
  return `${videoId}:hover:${sourceFingerprint}:${generationVersion}`;
}

function sanitizeReason(input: unknown, max = 240): string {
  const text = input instanceof Error ? input.message : String(input);
  return text.replace(/https?:\/\/\S+/g, '[url]').replace(/\s+/g, ' ').trim().slice(0, max);
}

function retryDelayMs(attempts: number): number {
  const n = Math.max(1, attempts);
  return Math.min(previewJobRetryBaseMs() * 2 ** (n - 1), previewJobRetryMaxMs());
}

/**
 * True only when the current-version hover montage sidecar AND its clip are
 * present and byte-readable. Database completion alone is not enough on a
 * host whose local preview directory is ephemeral.
 */
export async function previewHoverArtifactValid(
  videoId: number,
  identity: { megaNodeId: string; sourceSize: number },
): Promise<boolean> {
  return (await previewHoverArtifactInfo(videoId, identity)).valid;
}

/**
 * One filesystem pass per video: read the sidecar and stat the clip once,
 * returning both validity and the real on-disk size. Dashboard statistics
 * use this to avoid the previous valid+bytes double stat.
 */
export async function previewHoverArtifactInfo(
  videoId: number,
  identity: { megaNodeId: string; sourceSize: number },
): Promise<{ valid: boolean; bytes: number }> {
  const version = previewGenerationVersion();
  let sidecar: Awaited<ReturnType<typeof readSidecar>> = null;
  try {
    sidecar = await readSidecar(videoId);
  } catch {
    return { valid: false, bytes: 0 };
  }
  if (!sidecar || sidecar.generationVersion !== version) return { valid: false, bytes: 0 };
  if (sidecar.megaNodeId !== identity.megaNodeId || sidecar.sourceSize !== identity.sourceSize) {
    return { valid: false, bytes: 0 };
  }
  if (sidecar.status !== 'ready' || !sidecar.hover) return { valid: false, bytes: 0 };
  try {
    const st = await fs.promises.stat(clipPath(videoId));
    return st.isFile() && st.size > 0
      ? { valid: true, bytes: st.size }
      : { valid: false, bytes: 0 };
  } catch {
    return { valid: false, bytes: 0 };
  }
}

/**
 * Terminal infrastructure/retry-budget failures must not be resurrected by
 * an ordinary hover or sync scan. They require an explicit administrator
 * retry (or a full job reset because the artifact vanished).
 */
export function autoRetryBlockedError(errorCode: string | null | undefined): boolean {
  return (
    errorCode === 'max_attempts' ||
    errorCode === 'worker_recovery_exhausted' ||
    errorCode === 'unsupported_codec'
  );
}

/**
 * Idempotently ensure a hover job exists for the current source/generation
 * configuration. Never throws for a duplicate-race: the unique key makes the
 * second insert converge on the existing row.
 */
export async function ensurePreviewJob(input: PreviewJobEnsureInput): Promise<PreviewJobEnsureResult> {
  const version = input.generationVersion ?? previewGenerationVersion();
  const key = previewJobKey(input.videoId, input.sourceFingerprint, version);
  const existing = await prisma.previewGenerationJob.findUnique({
    where: { idempotencyKey: key },
    select: {
      id: true,
      status: true,
      attempts: true,
      maxAttempts: true,
      nextRetryAt: true,
      errorCode: true,
    },
  });
  if (existing) {
    const status = existing.status as PreviewJobStatus;
    const due = (existing.nextRetryAt?.getTime() ?? 0) <= Date.now();
    if (
      (status === 'failed' &&
        input.retryEligible &&
        due &&
        existing.attempts < existing.maxAttempts &&
        !autoRetryBlockedError(existing.errorCode)) ||
      (status === 'completed' && input.artifactValid === false)
    ) {
      await prisma.previewGenerationJob.update({
        where: { id: existing.id },
        data: {
          status: 'pending',
          stage: null,
          attempts: 0,
          recoveryCount: 0,
          maxAttempts: input.maxAttempts ?? previewJobMaxAttempts(),
          nextRetryAt: new Date(),
          queuedAt: new Date(),
          lockedBy: null,
          leaseExpiresAt: null,
          startedAt: null,
          completedAt: null,
          errorCode: status === 'completed' ? 'artifact_missing' : 'retry',
          lastError:
            status === 'completed'
              ? 'Preview artifact was missing on disk; job requeued.'
              : 'Retry backoff elapsed; job requeued.',
          updatedAt: new Date(),
        },
      });
      invalidatePreviewStatsCache();
      return { key, jobId: existing.id, status: 'pending', enqueued: true };
    }
    return {
      key,
      jobId: existing.id,
      status,
      enqueued: existing.status === 'pending' || existing.status === 'queued',
    };
  }
  try {
    const created = await prisma.previewGenerationJob.create({
      data: {
        videoId: input.videoId,
        kind: input.kind ?? 'hover',
        sourceFingerprint: input.sourceFingerprint,
        generationVersion: version,
        idempotencyKey: key,
        status: 'pending',
        priority: input.priority ?? 0,
        attempts: 0,
        maxAttempts: input.maxAttempts ?? previewJobMaxAttempts(),
        nextRetryAt: new Date(),
        queuedAt: new Date(),
      },
      select: { id: true },
    });
    return { key, jobId: created.id, status: 'pending', enqueued: true };
  } catch (err) {
    // Concurrent duplicate (sync + hover): the unique key already serializes
    // the insert, so requery and report the existing job.
    const raced = await prisma.previewGenerationJob.findUnique({
      where: { idempotencyKey: key },
      select: { id: true, status: true },
    });
    if (raced) {
      return {
        key,
        jobId: raced.id,
        status: raced.status as PreviewJobStatus,
        enqueued: raced.status === 'pending' || raced.status === 'queued',
      };
    }
    throw err;
  }
}

export interface EnsureManyOptions {
  userId: string;
  /** Scope the scan to one MEGA account (sync); omit for the whole library. */
  megaAccountId?: number;
  kind?: 'hover';
  priority?: number;
  /** Also retry failed/unsupported rows whose backoff has elapsed. */
  retryEligibleFailed?: boolean;
  /** Explicit manual retry of terminal jobs (admin only). */
  forceTerminal?: boolean;
  /** Verify the actual artifact, not just the completed job row. */
  verifyArtifacts?: boolean;
  /** Limit how many jobs are inserted/updated in this scan. */
  maxJobs?: number;
  now?: () => number;
}

export interface EnsureManyResult {
  scanned: number;
  enqueued: number;
  alreadyQueued: number;
  skippedComplete: number;
  skippedUnsupported: number;
  skippedFailed: number;
  failed: number;
}

/**
 * Bulk enqueue every video in the user's library that lacks a current
 * artifact. Durable DB inserts only — the worker consumes the backlog
 * one job at a time, so this can never launch 400 ffmpeg processes.
 */
export async function ensureMissingPreviewJobs(options: EnsureManyOptions): Promise<EnsureManyResult> {
  const now = options.now?.() ?? Date.now();
  const version = previewGenerationVersion();
  const result: EnsureManyResult = {
    scanned: 0,
    enqueued: 0,
    alreadyQueued: 0,
    skippedComplete: 0,
    skippedUnsupported: 0,
    skippedFailed: 0,
    failed: 0,
  };

  const rows = await prisma.video.findMany({
    where: {
      megaAccount: { userId: options.userId },
      ...(options.megaAccountId ? { megaAccountId: options.megaAccountId } : {}),
      megaNodeId: { not: null },
      fileSize: { not: null },
    },
    select: {
      id: true,
      megaNodeId: true,
      fileSize: true,
      duration: true,
      mp4Faststart: true,
      mimeType: true,
      megaAccountId: true,
    },
  });
  const owned = rows.filter((r) => r.megaNodeId !== null && r.fileSize !== null);
  result.scanned = owned.length;
  if (owned.length === 0) return result;

  const fingerprints = new Map<number, string>();
  const keys: string[] = [];
  for (const row of owned) {
    const fp = sourceFingerprintFor(row);
    fingerprints.set(row.id, fp);
    keys.push(previewJobKey(row.id, fp, version));
  }
  const existing = await prisma.previewGenerationJob.findMany({
    where: { idempotencyKey: { in: keys } },
    select: {
      idempotencyKey: true,
      status: true,
      attempts: true,
      maxAttempts: true,
      nextRetryAt: true,
      errorCode: true,
    },
  });
  const byKey = new Map(existing.map((j) => [j.idempotencyKey, j]));

  const validById = new Map<number, boolean>();
  if (options.verifyArtifacts) {
    await runBounded(owned, 8, async (row) => {
      validById.set(row.id, await previewHoverArtifactValid(row.id, {
        megaNodeId: row.megaNodeId as string,
        sourceSize: Number(row.fileSize as bigint),
      }));
    });
  }

  const creates: Array<Record<string, unknown>> = [];
  const pendingKeys: string[] = [];
  const failedKeys: string[] = [];
  const unsupportedKeys: string[] = [];
  const nowDate = new Date(now);

  for (const row of owned) {
    if (result.enqueued >= (options.maxJobs ?? Number.POSITIVE_INFINITY)) break;
    const fp = fingerprints.get(row.id)!;
    const key = previewJobKey(row.id, fp, version);
    const job = byKey.get(key);
    if (job) {
      if (job.status === 'pending' || job.status === 'queued' || job.status === 'generating') {
        result.alreadyQueued++;
        continue;
      }
      if (job.status === 'completed') {
        if (options.verifyArtifacts && validById.get(row.id) === false) {
          pendingKeys.push(key);
          result.enqueued++;
          continue;
        }
        result.skippedComplete++;
        continue;
      }
      if (job.status === 'unsupported') {
        if (options.forceTerminal) {
          unsupportedKeys.push(key);
          result.enqueued++;
          continue;
        }
        result.skippedUnsupported++;
        continue;
      }
      // failed
      const due = (job.nextRetryAt?.getTime() ?? 0) <= now;
      const blocked =
        autoRetryBlockedError(job.errorCode) || job.attempts >= job.maxAttempts;
      if (options.forceTerminal || (options.retryEligibleFailed && due && !blocked)) {
        failedKeys.push(key);
        result.enqueued++;
      } else {
        result.skippedFailed++;
      }
      continue;
    }
    // A completed previous-generation row with this key cannot exist (the
    // key contains the version); only a missing sidecar/clip lands here.
    if (options.verifyArtifacts && validById.get(row.id)) {
      result.skippedComplete++;
      continue;
    }
    creates.push({
      videoId: row.id,
      kind: options.kind ?? 'hover',
      sourceFingerprint: fp,
      generationVersion: version,
      idempotencyKey: key,
      status: 'pending',
      priority: options.priority ?? 0,
      attempts: 0,
      maxAttempts: previewJobMaxAttempts(),
      nextRetryAt: nowDate,
      queuedAt: nowDate,
    });
    result.enqueued++;
  }

  if (creates.length > 0) {
    // A full-library sync may remove a video between this scan and the
    // insert; the FK would then reject the whole batch. Re-filter to rows
    // that still exist and retry once instead of failing the enqueue.
    const insert = async (batch: Array<Record<string, unknown>>) =>
      prisma.previewGenerationJob.createMany({ data: batch as never, skipDuplicates: true });
    try {
      const created = await insert(creates);
      result.enqueued = Math.max(0, result.enqueued - (creates.length - created.count));
    } catch {
      const ids = creates.map((c) => Number(c.videoId));
      const alive = await prisma.video.findMany({
        where: { id: { in: ids } },
        select: { id: true },
      });
      const aliveIds = new Set(alive.map((v) => v.id));
      const filtered = creates.filter((c) => aliveIds.has(Number(c.videoId)));
      result.enqueued = Math.max(0, result.enqueued - (creates.length - filtered.length));
      if (filtered.length > 0) {
        const created = await insert(filtered);
        result.enqueued = Math.max(0, result.enqueued - (filtered.length - created.count));
      }
    }
  }
  if (pendingKeys.length > 0) {
    await prisma.previewGenerationJob.updateMany({
      where: { idempotencyKey: { in: pendingKeys }, status: { in: ['completed', 'failed', 'unsupported'] } },
      data: {
        status: 'pending',
        stage: null,
        attempts: 0,
        recoveryCount: 0,
        maxAttempts: previewJobMaxAttempts(),
        nextRetryAt: nowDate,
        queuedAt: nowDate,
        lockedBy: null,
        leaseExpiresAt: null,
        startedAt: null,
        completedAt: null,
        errorCode: 'artifact_missing',
        lastError: 'Preview artifact was missing on disk.',
      },
    });
  }
  if (failedKeys.length > 0) {
    await prisma.previewGenerationJob.updateMany({
      where: { idempotencyKey: { in: failedKeys }, status: 'failed' },
      data: {
        status: 'pending',
        stage: null,
        attempts: 0,
        recoveryCount: 0,
        nextRetryAt: nowDate,
        queuedAt: nowDate,
        lockedBy: null,
        leaseExpiresAt: null,
        startedAt: null,
        completedAt: null,
        errorCode: null,
        lastError: null,
      },
    });
  }
  if (unsupportedKeys.length > 0) {
    await prisma.previewGenerationJob.updateMany({
      where: { idempotencyKey: { in: unsupportedKeys }, status: 'unsupported' },
      data: {
        status: 'pending',
        stage: null,
        attempts: 0,
        recoveryCount: 0,
        nextRetryAt: nowDate,
        queuedAt: nowDate,
        lockedBy: null,
        leaseExpiresAt: null,
        startedAt: null,
        completedAt: null,
        errorCode: null,
        lastError: null,
      },
    });
  }
  if (result.enqueued > 0) {
    invalidatePreviewStatsCache();
    wakePreviewWorkerSafe();
  }
  return result;
}

/**
 * Non-blocking sync hook: after a MEGA sync has already committed its video
 * rows, discover which videos still lack a current hover montage and insert
 * idempotent durable jobs. Never awaits ffmpeg/MEGA work, never throws into
 * the sync path, and does nothing when the user disabled automatic preview
 * generation in Settings.
 */
export async function enqueueSyncPreviewJobs(
  userId: string,
  megaAccountId: number,
): Promise<EnsureManyResult | null> {
  const prefs = await prisma.user.findUnique({
    where: { id: userId },
    select: { previewAutoGenerate: true, previewPaused: true },
  });
  if (!prefs || prefs.previewAutoGenerate === false) return null;
  // Paused bulk generation still records the backlog; the worker stays idle.
  return ensureMissingPreviewJobs({
    userId,
    megaAccountId,
    priority: previewPrioritySync(),
    retryEligibleFailed: false,
    verifyArtifacts: true,
  });
}

/** Run async work with at most `limit` concurrent callbacks. */
export async function runBounded<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
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

// ---------------------------------------------------------------------------
// Worker claiming / lease / completion
// ---------------------------------------------------------------------------

export interface ClaimedJob {
  id: number;
  videoId: number;
  kind: string;
  sourceFingerprint: string;
  generationVersion: string;
  claimCount: number;
  attempts: number;
  recoveryCount: number;
}

/**
 * Atomically claim the next runnable job. `FOR UPDATE SKIP LOCKED` means
 * another process already owns the row if it is mid-lease, and expired
 * leases are recovered by the caller first.
 *
 * Claiming only increments `claimCount`. `attempts` is incremented later by
 * `beginPreviewGenerationAttempt()`, so a worker that dies between claim and
 * acquisition does not consume a generation attempt.
 *
 * Ordering gives a job that has waited longer than the starvation threshold
 * precedence over newer work; within each group the existing priority and
 * FIFO order apply. Hover jobs can therefore not starve the sync backlog.
 */
export async function claimNextPreviewJob(workerId: string, leaseMs: number): Promise<ClaimedJob | null> {
  const starvationMs = previewJobStarvationMs();
  return prisma.$transaction(async (tx) => {
    // One global generation slot, not one slot per process. Two web/worker
    // processes can run this transaction at the same time; the advisory lock
    // serializes the "is anything already generating?" check, and the
    // NOT EXISTS predicate then refuses the second claim. Without both, a
    // worker that throws after claiming (e.g. a Prisma validation error)
    // immediately claims the next row, leaving a whole backlog generating
    // and forcing lease recovery to clean it up.
    const [lock] = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT
      pg_try_advisory_xact_lock(hashtext('megatube.preview.claim')::bigint) AS locked`;
    if (!lock?.locked) return null;

    const rows = await tx.$queryRaw<ClaimedJob[]>`WITH next AS (
      SELECT j."id", j."videoId", j."kind", j."sourceFingerprint", j."generationVersion"
      FROM "PreviewGenerationJob" j
      JOIN "Video" v ON v."id" = j."videoId"
      JOIN "MegaAccount" a ON a."id" = v."megaAccountId"
      JOIN "User" u ON u."id" = a."userId"
      WHERE j."status" IN ('pending', 'queued')
        AND j."nextRetryAt" <= ${utcNow}
        AND u."previewPaused" = false
        -- A revoked session cannot generate previews; keep the durable
        -- backlog pending until the owner reconnects instead of burning
        -- attempts against guaranteed failures.
        AND a."status" NOT IN ('DISCONNECTED', 'REAUTH_REQUIRED')
        -- Do not claim a second job while any process still owns a live
        -- generation lease. An expired lease is recovered before the next
        -- claim attempt by the worker tick.
        AND NOT EXISTS (
          SELECT 1 FROM "PreviewGenerationJob" active
          WHERE active."status" = 'generating'
            AND active."leaseExpiresAt" IS NOT NULL
            AND active."leaseExpiresAt" >= ${utcNow}
        )
      ORDER BY
        CASE WHEN j."queuedAt" < ${utcNow} - (${starvationMs} * interval '1 millisecond')
             THEN 1 ELSE 0 END DESC,
        j."priority" DESC,
        j."createdAt" ASC,
        j."id" ASC
      LIMIT 1
      FOR UPDATE OF j SKIP LOCKED
    )
    UPDATE "PreviewGenerationJob" j
    SET "status" = 'generating',
        "stage" = 'claimed',
        "claimCount" = j."claimCount" + 1,
        "lockedBy" = ${workerId},
        "leaseExpiresAt" = ${utcNow} + (${leaseMs} * interval '1 millisecond'),
        "updatedAt" = ${utcNow}
    FROM next
    WHERE j."id" = next."id"
    RETURNING j."id", j."videoId", j."kind", j."sourceFingerprint", j."generationVersion",
              j."claimCount", j."attempts", j."recoveryCount"`;
    if (rows.length === 0) return null;
    const job = rows[0];
    return {
      ...job,
      claimCount: Number(job.claimCount),
      attempts: Number(job.attempts),
      recoveryCount: Number(job.recoveryCount),
    };
  });
}

/**
 * Mark the moment real generation work starts. This is the only place that
 * increments `attempts`, and it is atomic with the claim-owner/fencing
 * check, so a stale worker cannot start work after another worker reclaimed
 * the job.
 */
export async function beginPreviewGenerationAttempt(
  jobId: number,
  workerId: string,
  claimCount: number,
  leaseMs: number,
): Promise<number | null> {
  const rows = await prisma.$queryRaw<Array<{ attempts: number }>>`UPDATE "PreviewGenerationJob" j
    SET "attempts" = j."attempts" + 1,
        "stage" = 'acquiring',
        "startedAt" = COALESCE(j."startedAt", ${utcNow}),
        "leaseExpiresAt" = ${utcNow} + (${leaseMs} * interval '1 millisecond'),
        "updatedAt" = ${utcNow}
    WHERE j."id" = ${jobId}
      AND j."status" = 'generating'
      AND j."lockedBy" = ${workerId}
      AND j."claimCount" = ${claimCount}
      AND j."attempts" < j."maxAttempts"
    RETURNING j."attempts"`;
  if (rows.length === 0) return null;
  invalidatePreviewStatsCache();
  return Number(rows[0].attempts);
}

/**
 * Recover jobs whose worker died mid-run. `attempts` stay counted; a job
 * that exhausted its generation budget becomes terminal instead of retrying
 * forever. Recovery itself is bounded separately and backed off
 * exponentially (1, 2, 4, 8 … minutes, capped, plus jitter), so a repeatedly
 * crashing worker cannot cause an immediate reclaim loop. Recovery does NOT
 * reset `attempts`.
 */
export async function recoverExpiredPreviewLeases(): Promise<number> {
  const maxRecoveries = previewJobMaxRecoveries();
  const baseMs = previewJobRecoveryBaseMs();
  const maxMs = previewJobRecoveryMaxMs();
  const jitterMs = previewJobRecoveryJitterMs();
  const maxFactor = Math.max(1, Math.ceil(maxMs / Math.max(1, baseMs)));
  const result = await prisma.$executeRaw`UPDATE "PreviewGenerationJob" j
    SET "status" = CASE
          WHEN j."attempts" >= j."maxAttempts" THEN 'failed'
          WHEN j."recoveryCount" + 1 >= ${maxRecoveries} THEN 'failed'
          ELSE 'pending'
        END,
        "recoveryCount" = j."recoveryCount" + 1,
        "errorCode" = CASE
          WHEN j."attempts" >= j."maxAttempts" THEN 'max_attempts'
          WHEN j."recoveryCount" + 1 >= ${maxRecoveries} THEN 'worker_recovery_exhausted'
          ELSE 'lease_expired'
        END,
        "lastError" = CASE
          WHEN j."attempts" >= j."maxAttempts" THEN 'Preview generation exhausted its attempt budget.'
          WHEN j."recoveryCount" + 1 >= ${maxRecoveries} THEN 'Worker recovery budget exhausted; administrative retry required.'
          ELSE 'Worker lease expired; job returned to the queue with backoff.'
        END,
        "nextRetryAt" = CASE
          WHEN j."attempts" >= j."maxAttempts" OR j."recoveryCount" + 1 >= ${maxRecoveries}
            THEN ${utcNow}
          ELSE ${utcNow} + (
            (least(pow(2, j."recoveryCount"), ${maxFactor}) * ${baseMs}
              + floor(random() * ${jitterMs})) * interval '1 millisecond'
          )
        END,
        "lockedBy" = NULL,
        "leaseExpiresAt" = NULL,
        "stage" = NULL,
        "updatedAt" = ${utcNow}
    WHERE j."status" = 'generating'
      -- A generating row without a lease cannot be alive: the claim that made
      -- it generating always writes a lease atomically. Treat it as abandoned
      -- rather than letting it block the global generation slot forever.
      AND (j."leaseExpiresAt" IS NULL OR j."leaseExpiresAt" < ${utcNow})`;
  if (result > 0) {
    invalidatePreviewStatsCache();
    console.log(`[preview] recovered ${result} abandoned preview job(s)`);
  }
  return result;
}

/**
 * Renew a live lease. Returns false when the row is no longer ours (expired
 * and recovered, cancelled, or claimed by another worker); the caller must
 * then abort the in-flight job instead of continuing blind.
 */
export async function heartbeatPreviewJob(
  jobId: number,
  workerId: string,
  leaseMs: number,
  claimCount?: number,
): Promise<boolean> {
  const result = await prisma.previewGenerationJob.updateMany({
    where: {
      id: jobId,
      status: 'generating',
      lockedBy: workerId,
      ...(claimCount === undefined ? {} : { claimCount }),
    },
    data: {
      leaseExpiresAt: new Date(Date.now() + leaseMs),
      updatedAt: new Date(),
    },
  });
  return result.count > 0;
}

export async function setPreviewJobStage(
  jobId: number,
  workerId: string,
  stage: string,
  claimCount?: number,
): Promise<boolean> {
  const result = await prisma.previewGenerationJob.updateMany({
    where: {
      id: jobId,
      status: 'generating',
      lockedBy: workerId,
      ...(claimCount === undefined ? {} : { claimCount }),
    },
    data: { stage, updatedAt: new Date() },
  });
  return result.count > 0;
}

/**
 * Fencing check immediately before artifact publication. It both verifies
 * that this worker still owns the current claim and extends the lease, so a
 * worker that lost its lease (expired, recovered, reclaimed) can never
 * rename its temp artifact over a newer one.
 */
export async function assertPreviewJobOwnership(
  jobId: number,
  workerId: string,
  claimCount: number,
  leaseMs: number,
): Promise<boolean> {
  const result = await prisma.previewGenerationJob.updateMany({
    where: {
      id: jobId,
      status: 'generating',
      lockedBy: workerId,
      claimCount,
      leaseExpiresAt: { gt: new Date() },
    },
    data: {
      stage: 'publishing',
      leaseExpiresAt: new Date(Date.now() + leaseMs),
      updatedAt: new Date(),
    },
  });
  return result.count > 0;
}

export async function completePreviewJob(
  jobId: number,
  workerId: string,
  artifactBytes: number,
  metrics: PreviewJobMetrics,
  expectedClaimCount?: number,
): Promise<boolean> {
  const result = await prisma.previewGenerationJob.updateMany({
    where: {
      id: jobId,
      status: 'generating',
      lockedBy: workerId,
      ...(expectedClaimCount === undefined ? {} : { claimCount: expectedClaimCount }),
    },
    data: {
      status: 'completed',
      stage: null,
      completedAt: new Date(),
      nextRetryAt: null,
      lockedBy: null,
      leaseExpiresAt: null,
      artifactBytes,
      metrics: JSON.stringify(metrics),
      lastError: null,
      errorCode: null,
      updatedAt: new Date(),
    },
  });
  if (result.count > 0) invalidatePreviewStatsCache();
  return result.count > 0;
}

export interface FailPreviewJobOptions {
  retryable?: boolean;
  unsupported?: boolean;
  now?: () => number;
  /** Fencing token from the claim that owns this execution. */
  claimCount?: number;
}

export async function failPreviewJob(
  jobId: number,
  workerId: string,
  code: PreviewJobErrorCode,
  message: string,
  opts: FailPreviewJobOptions = {},
): Promise<{ status: PreviewJobStatus; willRetry: boolean }> {
  const now = opts.now?.() ?? Date.now();
  const job = await prisma.previewGenerationJob.findUnique({
    where: { id: jobId },
    select: {
      attempts: true,
      maxAttempts: true,
      status: true,
      lockedBy: true,
      claimCount: true,
    },
  });
  if (
    !job ||
    job.status !== 'generating' ||
    (job.lockedBy && job.lockedBy !== workerId) ||
    (opts.claimCount !== undefined && job.claimCount !== opts.claimCount)
  ) {
    return { status: job?.status as PreviewJobStatus, willRetry: false };
  }
  const exhausted = job.attempts >= job.maxAttempts;
  const willRetry = !opts.unsupported && opts.retryable !== false && !exhausted;
  const finalStatus: PreviewJobStatus = opts.unsupported
    ? 'unsupported'
    : willRetry
      ? 'pending'
      : 'failed';
  const nextRetry = new Date(now + retryDelayMs(job.attempts));
  const result = await prisma.previewGenerationJob.updateMany({
    where: {
      id: jobId,
      status: 'generating',
      lockedBy: workerId,
      ...(opts.claimCount === undefined ? {} : { claimCount: opts.claimCount }),
    },
    data: {
      status: finalStatus,
      stage: null,
      errorCode: code,
      lastError: sanitizeReason(message),
      nextRetryAt: finalStatus === 'pending' ? nextRetry : finalStatus === 'unsupported' ? null : nextRetry,
      completedAt: finalStatus === 'pending' ? null : new Date(now),
      lockedBy: null,
      leaseExpiresAt: null,
      updatedAt: new Date(now),
    },
  });
  if (result.count > 0) invalidatePreviewStatsCache();
  return { status: finalStatus, willRetry };
}

/** Move a completed job back to pending because its artifact vanished. */
export async function requeueMissingPreviewJob(jobId: number): Promise<boolean> {
  const result = await prisma.previewGenerationJob.updateMany({
    where: { id: jobId, status: 'completed' },
    data: {
      status: 'pending',
      stage: null,
      attempts: 0,
      recoveryCount: 0,
      maxAttempts: previewJobMaxAttempts(),
      nextRetryAt: new Date(),
      queuedAt: new Date(),
      lockedBy: null,
      leaseExpiresAt: null,
      startedAt: null,
      completedAt: null,
      errorCode: 'artifact_missing',
      lastError: 'Preview artifact was missing on disk; job requeued.',
      updatedAt: new Date(),
    },
  });
  if (result.count > 0) {
    invalidatePreviewStatsCache();
    wakePreviewWorkerSafe();
  }
  return result.count > 0;
}

function wakePreviewWorkerSafe(): void {
  void import('./worker').then((m) => m.wakePreviewWorker(), () => {});
}

/** Manually retry terminal jobs (admin). Unsupported requires an explicit opt-in. */
export async function retryPreviewJobs(opts: {
  userId: string;
  jobIds?: number[];
  videoIds?: number[];
  includeUnsupported?: boolean;
  limit?: number;
}): Promise<{ retried: number; skipped: number }> {
  const where: Record<string, unknown> = {
    video: { megaAccount: { userId: opts.userId } },
    kind: 'hover',
    ...(opts.jobIds && opts.jobIds.length > 0
      ? { id: { in: opts.jobIds } }
      : {}),
    ...(opts.videoIds && opts.videoIds.length > 0
      ? { videoId: { in: opts.videoIds } }
      : {}),
    status: { in: opts.includeUnsupported ? ['failed', 'unsupported'] : ['failed'] },
  };
  const rows = await prisma.previewGenerationJob.findMany({
    where: where as never,
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: opts.limit ?? 100,
  });
  if (rows.length === 0) return { retried: 0, skipped: 0 };
  await prisma.previewGenerationJob.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: {
      status: 'pending',
      stage: null,
      attempts: 0,
      recoveryCount: 0,
      nextRetryAt: new Date(),
      queuedAt: new Date(),
      lockedBy: null,
      leaseExpiresAt: null,
      startedAt: null,
      completedAt: null,
      errorCode: null,
      lastError: null,
      updatedAt: new Date(),
    },
  });
  if (rows.length > 0) {
    invalidatePreviewStatsCache();
    wakePreviewWorkerSafe();
  }
  return { retried: rows.length, skipped: 0 };
}

// ---------------------------------------------------------------------------
// Library scan + dashboard statistics
// ---------------------------------------------------------------------------

export interface PreviewLibraryStats {
  totalVideos: number;
  completedPreviews: number;
  missingPreviews: number;
  pending: number;
  queued: number;
  generating: number;
  failed: number;
  unsupported: number;
  completedJobs: number;
  previewBytes: number;
  cacheBytes: number;
  cacheMaxBytes: number;
  oldestPendingAgeMs: number | null;
  currentGenerationVersion: string;
  /** Settings toggles (server-side source of truth). */
  autoGenerate: boolean;
  paused: boolean;
  /** The job currently inside ffmpeg/MEGA acquisition, when there is one. */
  current: {
    jobId: number;
    videoId: number;
    title: string;
    stage: string | null;
    startedAt: string | null;
  } | null;
}

interface JobStatusCount {
  status: string;
  /** Prisma 7 returns `{ _all: n }` for `_count: { _all: true }`. */
  _count: number | { _all: number };
}

/** Number of Prisma read calls a cold statistics refresh performs. */
export const PREVIEW_STATS_DB_CALLS_PER_REFRESH = 5;

/**
 * Real library + disk statistics. Job counts come from PostgreSQL; the
 * completed/missing split is verified against the actual sidecar/clip files
 * so an ephemeral cache directory can never make the dashboard claim
 * "completed" for vanished artifacts.
 *
 * The expensive filesystem pass is wrapped in a short-lived, single-flight
 * cache: the ~5 s Settings poll normally reads memory, while each TTL window
 * still re-verifies the disk. Artifact publication/removal/eviction marks
 * the cache stale so the next refresh cannot keep a vanished file "ready".
 */
export async function getPreviewLibraryStats(userId: string): Promise<PreviewLibraryStats> {
  const version = previewGenerationVersion();
  const key = `library:${userId}:${version}`;
  return getCachedStats(
    key,
    { ttlMs: previewStatsCacheTtlMs(), minRefreshMs: previewStatsMinRefreshMs() },
    () => loadPreviewLibraryStats(userId, version),
  );
}

async function loadPreviewLibraryStats(
  userId: string,
  version: string,
): Promise<PreviewLibraryStats> {
  // Periodic access-metadata flush: touchPreview() is memory-only, so this
  // is the bounded point where LRU timestamps become durable again.
  await flushPreviewAccessTimes().catch(() => {});
  const [videos, statusCounts] = await Promise.all([
    prisma.video.findMany({
      where: { megaAccount: { userId }, megaNodeId: { not: null } },
      select: { id: true, megaNodeId: true, fileSize: true },
    }),
    prisma.previewGenerationJob.groupBy({
      by: ['status'],
      where: { kind: 'hover', video: { megaAccount: { userId } } },
      _count: { _all: true },
    }) as unknown as Promise<JobStatusCount[]>,
  ]);
  const counts = new Map(
    statusCounts.map((r) => [
      r.status,
      typeof r._count === 'number' ? r._count : Number(r._count?._all ?? 0),
    ]),
  );

  let completed = 0;
  let previewBytes = 0;
  await runBounded(videos, 8, async (video) => {
    if (video.megaNodeId === null || video.fileSize === null) return;
    const info = await previewHoverArtifactInfo(video.id, {
      megaNodeId: video.megaNodeId,
      sourceSize: Number(video.fileSize),
    });
    if (info.valid) {
      completed++;
      previewBytes += info.bytes;
    }
  });

  let oldestPending: Date | null = null;
  const oldest = await prisma.previewGenerationJob.findFirst({
    where: { kind: 'hover', video: { megaAccount: { userId } }, status: { in: ['pending', 'queued'] } },
    orderBy: [{ priority: 'desc' }, { queuedAt: 'asc' }],
    select: { queuedAt: true },
  });
  if (oldest) oldestPending = oldest.queuedAt;

  const { previewStoreStats } = await import('./cache');
  const store = await previewStoreStats();

  const prefs = await prisma.user.findUnique({
    where: { id: userId },
    select: { previewAutoGenerate: true, previewPaused: true },
  });
  const active = await prisma.previewGenerationJob.findFirst({
    where: {
      kind: 'hover',
      status: 'generating',
      video: { megaAccount: { userId } },
    },
    orderBy: { startedAt: 'asc' },
    select: {
      id: true,
      videoId: true,
      stage: true,
      startedAt: true,
      video: { select: { title: true, megaFilename: true } },
    },
  });

  return {
    totalVideos: videos.length,
    completedPreviews: completed,
    missingPreviews: videos.length - completed,
    pending: counts.get('pending') ?? 0,
    queued: counts.get('queued') ?? 0,
    generating: counts.get('generating') ?? 0,
    failed: counts.get('failed') ?? 0,
    unsupported: counts.get('unsupported') ?? 0,
    completedJobs: counts.get('completed') ?? 0,
    previewBytes,
    cacheBytes: store.entryBytes,
    cacheMaxBytes: store.maxBytes,
    oldestPendingAgeMs: oldestPending ? Math.max(0, Date.now() - oldestPending.getTime()) : null,
    currentGenerationVersion: version,
    autoGenerate: prefs?.previewAutoGenerate ?? true,
    paused: prefs?.previewPaused ?? false,
    current: active
      ? {
          jobId: active.id,
          videoId: active.videoId,
          title: active.video.title || active.video.megaFilename,
          stage: active.stage,
          startedAt: active.startedAt ? active.startedAt.toISOString() : null,
        }
      : null,
  };
}

export interface PreviewFailureItem {
  jobId: number;
  videoId: number;
  status: string;
  errorCode: string | null;
  lastError: string | null;
  attempts: number;
  completedAt: string | null;
  queuedAt: string;
}

export async function getPreviewFailures(userId: string, limit = 20): Promise<PreviewFailureItem[]> {
  const rows = await prisma.previewGenerationJob.findMany({
    where: {
      kind: 'hover',
      status: { in: ['failed', 'unsupported'] },
      video: { megaAccount: { userId } },
    },
    select: {
      id: true,
      videoId: true,
      status: true,
      errorCode: true,
      lastError: true,
      attempts: true,
      completedAt: true,
      queuedAt: true,
    },
    orderBy: [{ updatedAt: 'desc' }],
    take: Math.min(limit, 100),
  });
  return rows.map((r) => ({
    jobId: r.id,
    videoId: r.videoId,
    status: r.status,
    errorCode: r.errorCode,
    lastError: r.lastError,
    attempts: r.attempts,
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    queuedAt: r.queuedAt.toISOString(),
  }));
}

/** Delete stale/old artifacts for a video (never throws). */
export async function removeVideoPreviewAssets(videoId: number): Promise<void> {
  await removePreviewAssets(videoId).catch(() => {});
}

/** Remove sidecar + clip for superseded source versions. */
export async function sweepPreviewSidecarOnly(videoId: number): Promise<void> {
  const sidecar = await readSidecar(videoId).catch(() => null);
  if (!sidecar) return;
  const version = previewGenerationVersion();
  if (sidecar.generationVersion !== version) {
    await removePreviewAssets(videoId).catch(() => {});
  }
}

/** Path helper used by sync to invalidate a changed source. */
export function previewClipPath(videoId: number): string {
  return clipPath(videoId);
}

/** Ensure the preview directory exists (worker startup/tests). */
export async function ensurePreviewStorage(): Promise<string> {
  await fs.promises.mkdir(previewsDir(), { recursive: true });
  return previewsDir();
}

/** Test hook: reset all in-memory state (no-op; DB is reset per test DB). */
export function __resetPreviewJobsForTests(): void {
  // Intentionally empty: durable state lives in PostgreSQL.
}

/** Test-only helper used by diagnostics; never exposes paths/URLs. */
export function previewSpritePath(videoId: number): string {
  return spritePath(videoId);
}

/**
 * Delete all preview artifacts and reset queue for a user's entire library.
 *
 * Scopes the operation to the authenticated user's videos only.
 * Removes all preview artifacts (clips, spritesheets, VTT, sidecars) and resets
 * the preview job queue for those videos. Active workers are safely handled.
 */
export async function deleteAllUserPreviews(userId: string): Promise<{
  filesDeleted: number;
  bytesFreed: number;
  jobsDeleted: number;
  skippedActiveVideos: number;
}> {
  const batchSize = previewDeleteAllBatchSize();
  let cursor = 0;
  let filesDeleted = 0;
  let bytesFreed = 0;
  let jobsDeleted = 0;
  let skippedActiveVideos = 0;

  // Process bounded batches. A library can contain thousands of videos; one
  // giant IN-list + transaction would hold locks and build an oversized
  // parameter list. Cursor pagination also lets the route return progress
  // without re-scanning earlier rows.
  for (;;) {
    const videos = await prisma.video.findMany({
      where: { megaAccount: { userId }, id: { gt: cursor } },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: batchSize,
    });
    if (videos.length === 0) break;
    cursor = videos[videos.length - 1].id;
    const videoIds = videos.map((v) => v.id);

    // Serialize against the durable worker. The claim query uses
    // FOR UPDATE SKIP LOCKED, so rows locked here cannot be claimed while
    // the deletion transaction runs. A job already in `generating` belongs
    // to a live worker: its video is skipped entirely (artifact + job)
    // rather than deleting the row out from under the encoder.
    const batch = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: number; videoId: number; status: string }>>(
        Prisma.sql`SELECT "id", "videoId", "status"
          FROM "PreviewGenerationJob"
          WHERE "videoId" IN (${Prisma.join(videoIds)})
          FOR UPDATE`,
      );
      const active = new Set<number>();
      for (const job of locked) {
        if (job.status === 'generating') active.add(Number(job.videoId));
      }
      // A local active stream must not have its files unlinked. (This is
      // process-local; see the cross-process limitation in the audit report.)
      for (const id of videoIds) {
        if (activePreviewReaders(id) > 0) active.add(id);
      }
      const deletable = videoIds.filter((id) => !active.has(id));
      if (deletable.length === 0) {
        return { deletableVideoIds: deletable, jobsDeleted: 0, skippedActiveVideos: active.size };
      }
      const deleted = await tx.previewGenerationJob.deleteMany({
        where: { videoId: { in: deletable } },
      });
      return {
        deletableVideoIds: deletable,
        jobsDeleted: deleted.count,
        skippedActiveVideos: active.size,
      };
    });

    jobsDeleted += batch.jobsDeleted;
    skippedActiveVideos += batch.skippedActiveVideos;

    // Delete only known preview artifacts for the deletable videos. The
    // cache helper reports what actually existed, so partial failures and
    // already-absent files are reflected honestly.
    for (const videoId of batch.deletableVideoIds) {
      try {
        const removed = await removePreviewAssets(videoId);
        filesDeleted += removed.filesDeleted;
        bytesFreed += removed.bytesFreed;
      } catch {
        // Continue on individual failures; the response reports the rest.
      }
    }

    // Reclaim interrupted work dirs / temp files belonging to these videos.
    if (batch.deletableVideoIds.length > 0) {
      await cleanupFailedPreviewArtifacts({ videoIds: batch.deletableVideoIds });
    }
  }

  // Invalidate stats cache so the dashboard reflects the deletion now.
  invalidatePreviewStatsCache();

  return { filesDeleted, bytesFreed, jobsDeleted, skippedActiveVideos };
}

/** Test-only helper: path of a preview artifact, for filesystem assertions. */
export function previewArtifactPath(videoId: number): string {
  return path.join(previewsDir(), `${videoId}.preview.mp4`);
}

export {
  invalidatePreviewStatsCache,
  previewStatsCacheMetrics,
  __resetPreviewStatsCacheForTests,
} from './stats-cache';
