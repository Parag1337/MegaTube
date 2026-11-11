/**
 * Phase 5.1 durable preview worker.
 *
 * One process-wide worker loop per Next.js Node server. It claims at most
 * one durable job at a time, delegates the actual ffmpeg run to the existing
 * bounded PreviewQueue (so preview generation still shares the single
 * generation slot with timeline work), renews its database lease while a
 * long MEGA/ffmpeg run is active, and publishes the job state back to
 * PostgreSQL on success/failure.
 *
 * Crash semantics: a killed worker leaves `generating` + `leaseExpiresAt`;
 * `recoverExpiredPreviewLeases` returns the job to the queue once the lease
 * expires. Nothing is ever marked completed without a validated artifact.
 */

import { prisma } from '@/lib/db';
import {
  defaultPreviewServiceDeps,
  generateHoverForWorker,
  type HoverGenerationOutcome,
} from './service';
import { previewQueueSingleton } from './queue';
import {
  claimNextPreviewJob,
  completePreviewJob,
  failPreviewJob,
  heartbeatPreviewJob,
  previewHoverArtifactValid,
  recoverExpiredPreviewLeases,
  setPreviewJobStage,
  sourceFingerprintFor,
  type ClaimedJob,
  type PreviewJobErrorCode,
} from './jobs';
import {
  previewGenerationVersion,
  previewJobHeartbeatMs,
  previewJobLeaseMs,
  previewJobPollMs,
  previewWorkerDisabled,
} from './config';

const globalForWorker = globalThis as unknown as {
  __megaPreviewWorkerStarted?: boolean;
  __megaPreviewWorkerId?: string;
};

function workerId(): string {
  if (!globalForWorker.__megaPreviewWorkerId) {
    globalForWorker.__megaPreviewWorkerId = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
  return globalForWorker.__megaPreviewWorkerId;
}

let running = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

/** Test/diagnostic: is the worker loop currently executing a job? */
export function previewWorkerBusy(): boolean {
  return running;
}

/** Test/diagnostic: stop the loop between test cases. */
export function stopPreviewWorkerForTests(): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  globalForWorker.__megaPreviewWorkerStarted = false;
}

/** Wake the worker after an enqueue without waiting for the poll timer. */
export function wakePreviewWorker(): void {
  if (previewWorkerDisabled()) return;
  if (typeof process.env.NEXT_PHASE !== 'undefined') return; // build-time
  void import('./worker').then(
    (m) => {
      if (!m.previewWorkerStarted()) m.startPreviewWorker();
    },
    () => {},
  );
}

/** True once startPreviewWorker has run in this process. */
export function previewWorkerStarted(): boolean {
  return globalForWorker.__megaPreviewWorkerStarted === true;
}

interface WorkerVideoRow {
  id: number;
  megaNodeId: string | null;
  fileKeyEncrypted: string | null;
  mimeType: string | null;
  fileSize: bigint | null;
  duration: number | null;
  mp4Faststart: boolean | null;
  megaAccount: {
    id: number;
    userId: string;
    status: string;
    encryptedSession: string;
  } | null;
}

async function loadJobVideo(videoId: number): Promise<WorkerVideoRow | null> {
  return prisma.video.findFirst({
    where: { id: videoId, megaAccount: { userId: { not: null } } },
    select: {
      id: true,
      megaNodeId: true,
      fileKeyEncrypted: true,
      mimeType: true,
      fileSize: true,
      duration: true,
      mp4Faststart: true,
      megaAccount: { select: { id: true, userId: true, status: true, encryptedSession: true } },
    },
  });
}

function mapOutcomeError(detail: string): { code: PreviewJobErrorCode; retryable: boolean } {
  const text = detail.toLowerCase();
  if (text.includes('unsupported') || text.includes('unknown decoder') || text.includes('invalid data')) {
    return { code: 'unsupported_codec', retryable: false };
  }
  if (text.includes('moov not found') || text.includes('moov incomplete')) {
    return { code: 'moov_missing', retryable: true };
  }
  if (text.includes('source size unknown')) return { code: 'source_size_unknown', retryable: false };
  if (text.includes('timeout') || text.includes('timed out')) return { code: 'download_timeout', retryable: true };
  if (text.includes('ciphertext fetch failed') || text.includes('source unavailable')) {
    return { code: 'download_failed', retryable: true };
  }
  if (text.includes('encode failed') || text.includes('ffmpeg')) return { code: 'encode_failed', retryable: true };
  if (text.includes('output')) return { code: 'output_invalid', retryable: true };
  if (text.includes('attempt budget exhausted')) return { code: 'max_attempts', retryable: false };
  return { code: 'internal', retryable: true };
}

async function runJob(job: ClaimedJob): Promise<void> {
  const deps = defaultPreviewServiceDeps;
  const video = await loadJobVideo(job.videoId);
  if (!video || !video.megaAccount || !video.megaNodeId || !video.fileKeyEncrypted) {
    await failPreviewJob(job.id, workerId(), 'source_unavailable', 'Video or its MEGA source is no longer playable.', {
      retryable: false,
    });
    return;
  }
  if (video.megaAccount.status === 'DISCONNECTED') {
    await failPreviewJob(job.id, workerId(), 'source_unavailable', 'MEGA account is disconnected.', {
      retryable: false,
    });
    return;
  }

  const currentFingerprint = sourceFingerprintFor(video);
  const currentVersion = previewGenerationVersion();
  if (currentFingerprint !== job.sourceFingerprint || currentVersion !== job.generationVersion) {
    await failPreviewJob(job.id, workerId(), 'source_changed', 'Source changed while the job was queued; a newer job owns it.', {
      retryable: false,
    });
    return;
  }

  const identity = {
    megaNodeId: video.megaNodeId,
    sourceSize: video.fileSize !== null ? Number(video.fileSize) : 0,
  };
  if (identity.sourceSize > 0 && (await previewHoverArtifactValid(job.videoId, identity))) {
    // Another worker/process published it while we were waiting for a slot.
    const sidecar = await import('./cache').then((m) => m.readSidecar(job.videoId));
    const metrics = sidecar?.metrics;
    await completePreviewJob(job.id, workerId(), sidecar?.hover?.bytes ?? 0, {
      transferBytes: metrics?.transferBytes ?? 0,
      acquisitionMs: metrics?.acquisitionMs ?? 0,
      ffmpegMs: metrics?.ffmpegMs ?? 0,
      totalMs: metrics?.totalMs ?? 0,
      outputBytes: sidecar?.hover?.bytes ?? 0,
      scenes: sidecar?.hover?.scenes ?? [],
      sourceKind: metrics?.sourceKind ?? 'local',
      generationVersion: job.generationVersion,
    });
    return;
  }

  let outcome: HoverGenerationOutcome | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  try {
    heartbeat = setInterval(() => {
      void heartbeatPreviewJob(job.id, workerId(), previewJobLeaseMs()).catch(() => {});
    }, Math.min(previewJobHeartbeatMs(), Math.max(5_000, Math.floor(previewJobLeaseMs() / 3))));

    const serviceDeps = deps;
    const run = async (): Promise<unknown> => {
      outcome = await generateHoverForWorker(video, serviceDeps, {
        onStage: (stage) => {
          void setPreviewJobStage(job.id, workerId(), stage).catch(() => {});
        },
      });
      return outcome;
    };

    const admission = await previewQueueSingleton().enqueue(`hover:${job.videoId}`, run);
    if (admission === 'failed') {
      await failPreviewJob(job.id, workerId(), 'internal', 'Preview generation runner failed unexpectedly.');
      return;
    }
    if (outcome && !outcome.ok) {
      // Preserve the classified failure (unsupported codec vs. transient
      // MEGA/ffmpeg error) instead of collapsing everything to one label.
      await failPreviewJob(
        job.id,
        workerId(),
        (outcome.errorCode as PreviewJobErrorCode | undefined) ?? 'internal',
        outcome.detail,
        { retryable: outcome.retryable, unsupported: outcome.unsupported },
      );
      return;
    }
    // Success still requires a real, readable, current artifact on disk.
    const sidecar = await import('./cache').then((m) => m.readSidecar(job.videoId));
    if (!sidecar || sidecar.status !== 'ready' || !sidecar.hover) {
      await failPreviewJob(
        job.id,
        workerId(),
        'encode_failed',
        'Generation completed without a readable preview artifact.',
        { retryable: true },
      );
      return;
    }
    const metrics = sidecar.metrics;
    await completePreviewJob(job.id, workerId(), sidecar.hover.bytes, {
      transferBytes: metrics?.transferBytes ?? 0,
      acquisitionMs: metrics?.acquisitionMs ?? 0,
      ffmpegMs: metrics?.ffmpegMs ?? 0,
      totalMs: metrics?.totalMs ?? 0,
      outputBytes: sidecar.hover.bytes,
      scenes: sidecar.hover.scenes ?? [],
      sourceKind: metrics?.sourceKind ?? 'local',
      generationVersion: job.generationVersion,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const { code, retryable } = mapOutcomeError(detail);
    await failPreviewJob(job.id, workerId(), code, detail, { retryable }).catch(() => {});
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await recoverExpiredPreviewLeases().catch(() => {});
    const job = await claimNextPreviewJob(workerId(), previewJobLeaseMs()).catch(() => null);
    if (!job) {
      running = false;
      schedulePoll();
      return;
    }
    await runJob(job);
  } catch (err) {
    console.warn(`[preview] worker tick error: ${err instanceof Error ? err.message.slice(0, 120) : 'unknown'}`);
  } finally {
    running = false;
  }
  // Immediately look for more work; a timer covers the idle case.
  setImmediate(() => void tick());
}

function schedulePoll(): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void tick();
  }, previewJobPollMs());
  if (typeof pollTimer.unref === 'function') pollTimer.unref();
}

/**
 * Start the durable preview worker (idempotent). Never started during a
 * Next.js production build; development HMR is guarded by a globalThis flag
 * so reloading modules cannot launch a second loop.
 */
export function startPreviewWorker(): void {
  if (previewWorkerDisabled()) return;
  if (typeof process.env.NEXT_PHASE !== 'undefined') return;
  if (globalForWorker.__megaPreviewWorkerStarted) return;
  globalForWorker.__megaPreviewWorkerStarted = true;
  console.log(`[preview] durable worker started (${workerId()})`);
  void recoverExpiredPreviewLeases().catch(() => {});
  schedulePoll();
}

