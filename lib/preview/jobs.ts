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
import { prisma } from '@/lib/db';
import { clipPath, previewsDir, readSidecar, removePreviewAssets, spritePath } from './cache';
import {
  previewGenerationVersion,
  previewJobMaxAttempts,
  previewJobRetryBaseMs,
  previewJobRetryMaxMs,
  previewPrioritySync,
} from './config';

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
  | 'max_attempts'
  | 'internal';

export interface PreviewJobMetrics {
  transferBytes: number;
  acquisitionMs: number;
  ffmpegMs: number;
  totalMs: number;
  outputBytes: number;
  scenes: Array<{ startSec: number; durationSec: number; sourceSeekSec: number }>;
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
  const version = previewGenerationVersion();
  let sidecar: Awaited<ReturnType<typeof readSidecar>> = null;
  try {
    sidecar = await readSidecar(videoId);
  } catch {
    return false;
  }
  if (!sidecar || sidecar.generationVersion !== version) return false;
  if (sidecar.megaNodeId !== identity.megaNodeId || sidecar.sourceSize !== identity.sourceSize) return false;
  if (sidecar.status !== 'ready' || !sidecar.hover) return false;
  try {
    const st = await fs.promises.stat(clipPath(videoId));
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
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
    select: { id: true, status: true, attempts: true, maxAttempts: true, nextRetryAt: true },
  });
  if (existing) {
    const status = existing.status as PreviewJobStatus;
    const due = (existing.nextRetryAt?.getTime() ?? 0) <= Date.now();
    if (
      (status === 'failed' && input.retryEligible && due) ||
      (status === 'completed' && input.artifactValid === false)
    ) {
      await prisma.previewGenerationJob.update({
        where: { id: existing.id },
        data: {
          status: 'pending',
          stage: null,
          attempts: 0,
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
      if (options.forceTerminal || (options.retryEligibleFailed && due)) {
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
  if (result.enqueued > 0) wakePreviewWorkerSafe();
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
  attempts: number;
}

/**
 * Atomically claim the next runnable job. `FOR UPDATE SKIP LOCKED` means
 * another process already owns the row if it is mid-lease, and expired
 * leases are recovered by the caller first.
 */
export async function claimNextPreviewJob(workerId: string, leaseMs: number): Promise<ClaimedJob | null> {
  const rows = await prisma.$queryRaw<ClaimedJob[]>`WITH next AS (
      SELECT j."id", j."videoId", j."kind", j."sourceFingerprint", j."generationVersion", j."attempts"
      FROM "PreviewGenerationJob" j
      JOIN "Video" v ON v."id" = j."videoId"
      JOIN "MegaAccount" a ON a."id" = v."megaAccountId"
      JOIN "User" u ON u."id" = a."userId"
      WHERE j."status" IN ('pending', 'queued')
        AND j."nextRetryAt" <= now()
        AND u."previewPaused" = false
      ORDER BY j."priority" DESC, j."createdAt" ASC, j."id" ASC
      LIMIT 1
      FOR UPDATE OF j SKIP LOCKED
    )
    UPDATE "PreviewGenerationJob" j
    SET "status" = 'generating',
        "stage" = 'acquiring',
        "lockedBy" = ${workerId},
        "leaseExpiresAt" = now() + (${leaseMs} * interval '1 millisecond'),
        "startedAt" = COALESCE(j."startedAt", now()),
        "attempts" = j."attempts" + 1,
        "updatedAt" = now()
    FROM next
    WHERE j."id" = next."id"
    RETURNING j."id", j."videoId", j."kind", j."sourceFingerprint", j."generationVersion", j."attempts"`;
  return rows[0] ?? null;
}

/**
 * Recover jobs whose worker died mid-run. Attempts stay counted; a job that
 * exhausted its budget becomes terminal instead of retrying forever.
 */
export async function recoverExpiredPreviewLeases(): Promise<number> {
  const result = await prisma.$executeRaw`UPDATE "PreviewGenerationJob" j
    SET "status" = CASE WHEN j."attempts" >= j."maxAttempts" THEN 'failed' ELSE 'pending' END,
        "errorCode" = CASE WHEN j."attempts" >= j."maxAttempts" THEN 'max_attempts' ELSE 'lease_expired' END,
        "lastError" = CASE WHEN j."attempts" >= j."maxAttempts" THEN 'Preview generation exhausted its attempt budget.' ELSE 'Worker lease expired; job returned to the queue.' END,
        "nextRetryAt" = CASE WHEN j."attempts" >= j."maxAttempts" THEN now() + (least(2 ^ j."attempts", 16) * interval '1 minute') ELSE now() END,
        "lockedBy" = NULL,
        "leaseExpiresAt" = NULL,
        "stage" = NULL,
        "updatedAt" = now()
    WHERE j."status" = 'generating'
      AND j."leaseExpiresAt" IS NOT NULL
      AND j."leaseExpiresAt" < now()`;
  if (result > 0) console.log(`[preview] recovered ${result} abandoned preview job(s)`);
  return result;
}

export async function heartbeatPreviewJob(jobId: number, workerId: string, leaseMs: number): Promise<void> {
  await prisma.previewGenerationJob.updateMany({
    where: { id: jobId, status: 'generating', lockedBy: workerId },
    data: {
      leaseExpiresAt: new Date(Date.now() + leaseMs),
      updatedAt: new Date(),
    },
  });
}

export async function setPreviewJobStage(jobId: number, workerId: string, stage: string): Promise<void> {
  await prisma.previewGenerationJob.updateMany({
    where: { id: jobId, status: 'generating', lockedBy: workerId },
    data: { stage, updatedAt: new Date() },
  });
}

export async function completePreviewJob(
  jobId: number,
  workerId: string,
  artifactBytes: number,
  metrics: PreviewJobMetrics,
): Promise<boolean> {
  const result = await prisma.previewGenerationJob.updateMany({
    where: { id: jobId, status: 'generating', lockedBy: workerId },
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
  return result.count > 0;
}

export interface FailPreviewJobOptions {
  retryable?: boolean;
  unsupported?: boolean;
  now?: () => number;
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
    select: { attempts: true, maxAttempts: true, status: true, lockedBy: true },
  });
  if (!job || job.status !== 'generating' || (job.lockedBy && job.lockedBy !== workerId)) {
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
  await prisma.previewGenerationJob.update({
    where: { id: jobId },
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
  if (result.count > 0) wakePreviewWorkerSafe();
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

/**
 * Real library + disk statistics. Job counts come from PostgreSQL; the
 * completed/missing split is verified against the actual sidecar/clip files
 * so an ephemeral cache directory can never make the dashboard claim
 * "completed" for vanished artifacts.
 */
export async function getPreviewLibraryStats(userId: string): Promise<PreviewLibraryStats> {
  const version = previewGenerationVersion();
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
    if (await previewHoverArtifactValid(video.id, {
      megaNodeId: video.megaNodeId,
      sourceSize: Number(video.fileSize),
    })) {
      completed++;
      try {
        const st = await fs.promises.stat(clipPath(video.id));
        if (st.isFile()) previewBytes += st.size;
      } catch {
        // raced deletion; completed count stays false on the next scan
      }
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

/** Test-only helper: path of a preview artifact, for filesystem assertions. */
export function previewArtifactPath(videoId: number): string {
  return path.join(previewsDir(), `${videoId}.preview.mp4`);
}
