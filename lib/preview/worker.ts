/**
 * Phase 5.1 durable preview worker.
 *
 * One process-wide worker loop per Next.js Node server. Claims are
 * serialized in PostgreSQL (advisory lock + live-lease predicate), so at
 * most one worker across all web/worker processes owns the single global
 * generation slot. The loop delegates the actual ffmpeg run to the existing
 * bounded PreviewQueue (so preview generation still shares that slot with
 * timeline work), renews its database lease while a long MEGA/ffmpeg run is
 * active, and publishes the job state back to PostgreSQL on success/failure.
 *
 * Failure domains are deliberately separate:
 *  - claimCount   = how many workers have picked the row up (fencing token);
 *  - attempts     = real generation runs started (bounded work budget);
 *  - recoveryCount= expired-lease recoveries, with bounded backoff.
 *
 * An absolute per-job deadline covers acquisition → ffmpeg → publication and
 * is independent of lease heartbeats, so a live-but-stuck worker cannot keep
 * a job forever. Losing the lease aborts the in-flight run, and publication
 * requires a final fencing check.
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
  assertPreviewJobOwnership,
  beginPreviewGenerationAttempt,
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
  previewJobDeadlineMs,
  previewJobHeartbeatMs,
  previewJobLeaseMs,
  previewJobPollMs,
  previewWorkerDisabled,
} from './config';

const globalForWorker = globalThis as unknown as {
  __megaPreviewWorkerStarted?: boolean;
  __megaPreviewWorkerId?: string;
  __megaPreviewWorkerSignals?: boolean;
};

function workerId(): string {
  if (!globalForWorker.__megaPreviewWorkerId) {
    globalForWorker.__megaPreviewWorkerId = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
  return globalForWorker.__megaPreviewWorkerId;
}

let running = false;
let shuttingDown = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let activeRun: { controller: AbortController; reason: 'deadline' | 'lease_lost' | 'shutdown' | null } | null =
  null;

/** Test/diagnostic: is the worker loop currently executing a job? */
export function previewWorkerBusy(): boolean {
  return running;
}

/** Test/diagnostic: stop the loop between test cases. */
export function stopPreviewWorkerForTests(): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  shuttingDown = false;
  globalForWorker.__megaPreviewWorkerStarted = false;
}

/**
 * Graceful shutdown: stop claiming, cancel a queued run through the shared
 * signal, and abort the active in-flight run (ffmpeg kills its child with
 * SIGTERM then SIGKILL; MEGA reads observe the abort between phases).
 */
export function stopPreviewWorker(): void {
  shuttingDown = true;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (activeRun) {
    activeRun.reason = 'shutdown';
    activeRun.controller.abort(new Error('preview job aborted by worker shutdown'));
  }
}

/** Wake the worker after an enqueue without waiting for the poll timer. */
export function wakePreviewWorker(): void {
  if (previewWorkerDisabled()) return;
  if (shuttingDown) return;
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

type LoadJobVideo = (videoId: number) => Promise<WorkerVideoRow | null>;

async function loadJobVideo(videoId: number): Promise<WorkerVideoRow | null> {
  return prisma.video.findFirst({
    where: { id: videoId, megaAccount: { isNot: null } },
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
  if (text.includes('deadline exceeded') || text.includes('aborted by worker shutdown')) {
    return { code: 'job_timeout', retryable: true };
  }
  if (text.includes('unsupported') || text.includes('unknown decoder') || text.includes('invalid data')) {
    return { code: 'unsupported_codec', retryable: false };
  }
  if (text.includes('moov not found') || text.includes('moov incomplete')) {
    return { code: 'moov_missing', retryable: true };
  }
  if (text.includes('source size unknown')) return { code: 'source_size_unknown', retryable: false };
  if (
    text.includes('session expired') ||
    text.includes('session could not be decrypted') ||
    text.includes('reconnect required')
  ) {
    return { code: 'source_unavailable', retryable: false };
  }
  if (text.includes('timeout') || text.includes('timed out')) return { code: 'download_timeout', retryable: true };
  if (text.includes('ciphertext fetch failed') || text.includes('ciphertext fetch truncated') || text.includes('source unavailable')) {
    return { code: 'download_failed', retryable: true };
  }
  if (text.includes('encode failed') || text.includes('ffmpeg')) return { code: 'encode_failed', retryable: true };
  if (text.includes('output')) return { code: 'output_invalid', retryable: true };
  if (text.includes('attempt budget exhausted')) return { code: 'max_attempts', retryable: false };
  return { code: 'internal', retryable: true };
}

/** Stable identity for this process's worker claim/lease fencing token. */
export function previewWorkerId(): string {
  return workerId();
}

/**
 * Execute one claimed job. Exported (with an injectable video loader) so the
 * regression suite can force a failure before generation starts and prove the
 * job is finalized instead of being left `generating` for lease recovery.
 */
export async function runClaimedPreviewJob(
  job: ClaimedJob,
  overrides: { loadVideo?: LoadJobVideo } = {},
): Promise<void> {
  try {
    await runJob(job, overrides.loadVideo ?? loadJobVideo);
  } catch (err) {
    // Last-resort guard. `runJob` handles its own errors; this covers a throw
    // from the handler itself so a claimed row can never strand indefinitely.
    const detail = err instanceof Error ? err.message : String(err);
    await failPreviewJob(job.id, workerId(), 'internal', detail, {
      retryable: false,
      claimCount: job.claimCount,
    }).catch(() => {});
  }
}

async function runJob(job: ClaimedJob, loadVideo: LoadJobVideo = loadJobVideo): Promise<void> {
  const deps = defaultPreviewServiceDeps;
  const fail = (
    code: PreviewJobErrorCode,
    message: string,
    retryable = false,
  ): Promise<{ status: string; willRetry: boolean }> =>
    failPreviewJob(job.id, workerId(), code, message, {
      retryable,
      claimCount: job.claimCount,
    });

  const controller = new AbortController();
  const runState: { controller: AbortController; reason: 'deadline' | 'lease_lost' | 'shutdown' | null } = {
    controller,
    reason: null,
  };
  activeRun = runState;
  const abortRun = (reason: 'deadline' | 'lease_lost' | 'shutdown'): void => {
    if (runState.reason === null) runState.reason = reason;
    if (!controller.signal.aborted) {
      controller.abort(
        new Error(
          reason === 'deadline'
            ? 'preview job deadline exceeded'
            : reason === 'shutdown'
              ? 'preview job aborted by worker shutdown'
              : 'preview job lease lost',
        ),
      );
    }
  };

  // Heartbeat and deadline cover the whole post-claim lifetime, including
  // loading the video row. A database/query error here used to escape before
  // the heartbeat existed, leaving the job `generating` until lease recovery.
  const deadlineTimer = setTimeout(() => abortRun('deadline'), previewJobDeadlineMs());
  if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();
  const heartbeat = setInterval(
    () => {
      void heartbeatPreviewJob(job.id, workerId(), previewJobLeaseMs(), job.claimCount)
        .then((alive) => {
          if (!alive) abortRun('lease_lost');
        })
        .catch(() => {
          // Transient DB error: the lease expiry/recovery path is the
          // authority; keep the current run alive.
        });
    },
    Math.min(previewJobHeartbeatMs(), Math.max(5_000, Math.floor(previewJobLeaseMs() / 3))),
  );
  let attemptStarted = false;
  let outcome: HoverGenerationOutcome | null = null;

  try {
    const video = await loadVideo(job.videoId);
    if (!video || !video.megaAccount || !video.megaNodeId || !video.fileKeyEncrypted) {
      await fail('source_unavailable', 'Video or its MEGA source is no longer playable.');
      return;
    }
    if (video.megaAccount.status === 'DISCONNECTED' || video.megaAccount.status === 'REAUTH_REQUIRED') {
      await fail('source_unavailable', 'MEGA account is disconnected or needs to be reconnected.');
      return;
    }

    const currentFingerprint = sourceFingerprintFor(video);
    const currentVersion = previewGenerationVersion();
    if (currentFingerprint !== job.sourceFingerprint || currentVersion !== job.generationVersion) {
      await fail('source_changed', 'Source changed while the job was queued; a newer job owns it.');
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
      await completePreviewJob(
        job.id,
        workerId(),
        sidecar?.hover?.bytes ?? 0,
        {
          transferBytes: metrics?.transferBytes ?? 0,
          acquisitionMs: metrics?.acquisitionMs ?? 0,
          ffmpegMs: metrics?.ffmpegMs ?? 0,
          totalMs: metrics?.totalMs ?? 0,
          outputBytes: sidecar?.hover?.bytes ?? 0,
          scenes: sidecar?.hover?.scenes ?? [],
          sourceKind: metrics?.sourceKind ?? 'local',
          generationVersion: job.generationVersion,
        },
        job.claimCount,
      );
      return;
    }

    const queueOutcome = await previewQueueSingleton().enqueue(
      `hover:${job.videoId}`,
      async () => {
        // Claiming does not consume a generation attempt; starting real work
        // does. The claimCount fence makes this a no-op for a stale worker.
        const attempts = await beginPreviewGenerationAttempt(
          job.id,
          workerId(),
          job.claimCount,
          previewJobLeaseMs(),
        );
        if (attempts === null) {
          outcome = {
            ok: false,
            detail: 'preview job could not begin generation (ownership lost or attempt budget exhausted)',
            errorCode: 'lease_lost',
            retryable: false,
          };
          return outcome;
        }
        attemptStarted = true;
        outcome = await generateHoverForWorker(video, deps, {
          signal: controller.signal,
          onStage: (stage) => {
            void setPreviewJobStage(job.id, workerId(), stage, job.claimCount).catch(() => {});
          },
          guardPublish: () =>
            assertPreviewJobOwnership(job.id, workerId(), job.claimCount, previewJobLeaseMs()),
        });
        return outcome;
      },
      controller.signal,
    );

    if (queueOutcome === 'cancelled') {
      const reason = runState.reason ?? 'deadline';
      if (reason === 'shutdown') {
        await fail('worker_shutdown', 'Worker stopped before the job started.', true);
      } else if (reason === 'lease_lost') {
        await fail('lease_lost', 'Lease was lost before the job started.');
      } else {
        await fail('job_timeout', 'Preview job exceeded its absolute deadline before starting.', attemptStarted);
      }
      return;
    }
    if (queueOutcome === 'failed' && !outcome) {
      await fail('internal', 'Preview generation runner failed unexpectedly.', attemptStarted);
      return;
    }
    if (outcome && !outcome.ok) {
      // A revoked MEGA session is an account-level state, not a per-video
      // failure. Surface it once so the UI offers Reconnect, and let the
      // claim query stop handing out the rest of this account's backlog.
      if (
        outcome.errorCode === 'source_unavailable' &&
        /session expired|reconnect required|session could not be decrypted/i.test(outcome.detail)
      ) {
        try {
          const [{ evictMegaSession }, { markAccountReauthRequired }] = await Promise.all([
            import('@/lib/sync/session-cache'),
            import('@/lib/megaAccounts'),
          ]);
          evictMegaSession(video.megaAccount.id);
          await markAccountReauthRequired(
            video.megaAccount.id,
            'MEGA session expired or was revoked. Reconnect required.',
          );
        } catch {
          // Never let account-state bookkeeping hide the generation failure.
        }
      }
      const reason = runState.reason;
      const code: PreviewJobErrorCode =
        reason === 'shutdown'
          ? 'worker_shutdown'
          : reason === 'lease_lost'
            ? 'lease_lost'
            : ((outcome.errorCode as PreviewJobErrorCode | undefined) ?? 'internal');
      const retryable = reason === 'shutdown' ? true : (outcome.retryable ?? false);
      await fail(code, outcome.detail, retryable);
      return;
    }
    // Success still requires a real, readable, current artifact on disk.
    const sidecar = await import('./cache').then((m) => m.readSidecar(job.videoId));
    if (!sidecar || sidecar.status !== 'ready' || !sidecar.hover) {
      await fail('encode_failed', 'Generation completed without a readable preview artifact.', true);
      return;
    }
    const metrics = sidecar.metrics;
    const completed = await completePreviewJob(
      job.id,
      workerId(),
      sidecar.hover.bytes,
      {
        transferBytes: metrics?.transferBytes ?? 0,
        acquisitionMs: metrics?.acquisitionMs ?? 0,
        ffmpegMs: metrics?.ffmpegMs ?? 0,
        totalMs: metrics?.totalMs ?? 0,
        outputBytes: sidecar.hover.bytes,
        scenes: sidecar.hover.scenes ?? [],
        sourceKind: metrics?.sourceKind ?? 'local',
        generationVersion: job.generationVersion,
      },
      job.claimCount,
    );
    if (!completed && runState.reason === null) {
      console.warn(`[preview] job ${job.id} finished but its claim was no longer current`);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const { code, retryable } = mapOutcomeError(detail);
    const finalCode: PreviewJobErrorCode = runState.reason === 'shutdown' ? 'worker_shutdown' : code;
    // A failure before beginPreviewGenerationAttempt() has consumed no
    // attempts. Retrying that state forever would be an endless loop, so it
    // is terminal unless the process is shutting down (then the job must be
    // returned to the queue for the next process).
    const canRetry = runState.reason === 'shutdown' ? true : attemptStarted && retryable;
    await fail(finalCode, detail, canRetry).catch(() => {});
  } finally {
    clearTimeout(deadlineTimer);
    if (heartbeat) clearInterval(heartbeat);
    if (activeRun === runState) activeRun = null;
  }
}

async function tick(): Promise<void> {
  if (running || shuttingDown) return;
  running = true;
  try {
    await recoverExpiredPreviewLeases().catch(() => {});
    const job = await claimNextPreviewJob(workerId(), previewJobLeaseMs()).catch(() => null);
    if (!job) {
      running = false;
      schedulePoll();
      return;
    }
    await runClaimedPreviewJob(job);
  } catch (err) {
    console.warn(`[preview] worker tick error: ${err instanceof Error ? err.message.slice(0, 120) : 'unknown'}`);
  } finally {
    running = false;
  }
  if (shuttingDown) return;
  // Immediately look for more work; a timer covers the idle case.
  setImmediate(() => void tick());
}

function schedulePoll(): void {
  if (shuttingDown) return;
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
  shuttingDown = false;
  globalForWorker.__megaPreviewWorkerStarted = true;
  if (!globalForWorker.__megaPreviewWorkerSignals) {
    globalForWorker.__megaPreviewWorkerSignals = true;
    // Abort the active run/queue, then re-deliver the signal so the host
    // (Next.js) or the default OS action still decides the process exit.
    const forward = (signal: NodeJS.Signals): void => {
      stopPreviewWorker();
      process.removeListener(signal, forward);
      try {
        process.kill(process.pid, signal);
      } catch {
        // process is already gone
      }
    };
    process.once('SIGTERM', forward);
    process.once('SIGINT', forward);
  }
  console.log(`[preview] durable worker started (${workerId()})`);
  void recoverExpiredPreviewLeases().catch(() => {});
  schedulePoll();
}
