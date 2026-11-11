/**
 * Phase 5 preview system: bounded generation queue.
 *
 * Guarantees (design §9):
 *  - at most PREVIEW_MAX_CONCURRENT running jobs (default 1 — one ffmpeg and
 *    at most one bounded MEGA window at a time, never the remux pool);
 *  - at most PREVIEW_MAX_QUEUE waiting jobs; enqueue beyond that fails fast
 *    with QueueFullError (meta answers without degrading anything);
 *  - single-flight per `${kind}:${videoId}` key — concurrent meta calls JOIN
 *    the same job, they never duplicate work;
 *  - a QUEUED job is cancelled when its requester aborts; a RUNNING job
 *    always completes (bounded ≤ ffmpeg timeout) because its result is
 *    cached and the next hover reuses it — finishing beats wasting it.
 *
 * The queue holds no media data — only job descriptors and their promises.
 */

import { previewMaxConcurrent, previewMaxQueue } from './config';

export type PreviewJobOutcome = 'completed' | 'failed' | 'cancelled';

/** Immediate admission result for callers that do NOT wait for completion. */
export type PreviewAdmission = 'started' | 'queued' | 'rejected';

export class QueueFullError extends Error {
  constructor() {
    super('preview generation queue is full');
    this.name = 'QueueFullError';
  }
}

export interface PreviewJobStats {
  running: number;
  queued: number;
  maxConcurrent: number;
  maxQueue: number;
}

interface QueueEntry {
  key: string;
  runner: () => Promise<unknown>;
  signal: AbortSignal | null;
  onAbort: (() => void) | null;
  resolve: (outcome: PreviewJobOutcome) => void;
}

interface PendingJob {
  promise: Promise<PreviewJobOutcome>;
  entry: QueueEntry | null; // null while running
}

export class PreviewQueue {
  private pending = new Map<string, PendingJob>();
  private running = 0;
  private queue: QueueEntry[] = [];

  constructor(private maxConcurrent: number, private maxQueue: number) {}

  /**
   * Enqueue (or join) a job and wait for its outcome. Used where the caller
   * genuinely needs the result; the meta endpoint must NOT use this — it
   * would block for the whole MEGA/ffmpeg run (see `enqueueNow`).
   */
  enqueue(key: string, runner: () => Promise<unknown>, signal?: AbortSignal | null): Promise<PreviewJobOutcome> {
    const admitted = this.admit(key, runner, signal);
    if (!admitted) return Promise.reject(new QueueFullError());
    return admitted.promise;
  }

  /**
   * Admit (or join) a job and return IMMEDIATELY with the admission state:
   * the preview meta endpoint answers `generating` in milliseconds while the
   * bounded queue runs the job in the background. The completion promise is
   * intentionally not exposed; runners never reject (`start` converts
   * failures to a resolved outcome), so ignoring it cannot leak rejections.
   *
   * `rejected` means the queue is full. Joining an existing single-flight
   * job reports `started` while it is running and `queued` while it waits.
   */
  enqueueNow(key: string, runner: () => Promise<unknown>, signal?: AbortSignal | null): PreviewAdmission {
    const admitted = this.admit(key, runner, signal);
    if (!admitted) return 'rejected';
    return admitted.queued ? 'queued' : 'started';
  }

  private admit(
    key: string,
    runner: () => Promise<unknown>,
    signal?: AbortSignal | null,
  ): { promise: Promise<PreviewJobOutcome>; queued: boolean } | null {
    const existing = this.pending.get(key);
    if (existing) {
      // Single-flight join: report queued while the joined job waits.
      return { promise: existing.promise, queued: existing.entry !== null };
    }

    if (this.running >= this.maxConcurrent && this.queue.length >= this.maxQueue) {
      return null;
    }

    let resolve!: (outcome: PreviewJobOutcome) => void;
    const promise = new Promise<PreviewJobOutcome>((r) => {
      resolve = r;
    });
    const entry: QueueEntry = { key, runner, signal: signal ?? null, onAbort: null, resolve };
    const job: PendingJob = { promise, entry };

    if (signal) {
      if (signal.aborted) {
        resolve('cancelled');
        return { promise, queued: false };
      }
      entry.onAbort = () => {
        // Only QUEUED jobs are cancellable; running jobs complete regardless.
        if (job.entry !== entry) return;
        this.queue = this.queue.filter((e) => e !== entry);
        job.entry = null;
        this.pending.delete(key);
        entry.resolve('cancelled');
      };
      signal.addEventListener('abort', entry.onAbort, { once: true });
    }

    this.pending.set(key, job);
    if (this.running < this.maxConcurrent) {
      this.start(entry, job);
      return { promise, queued: false };
    }
    this.queue.push(entry);
    return { promise, queued: true };
  }

  private start(entry: QueueEntry, job: PendingJob): void {
    this.running++;
    job.entry = null;
    if (entry.onAbort && entry.signal) {
      entry.signal.removeEventListener('abort', entry.onAbort);
      entry.onAbort = null;
    }
    void entry
      .runner()
      .then(
        () => 'completed' as const,
        (err: unknown) => {
          // Unexpected runner rejections are job failures, not crashes; the
          // service layer records them in the sidecar and logs.
          if (err instanceof QueueFullError) {
            console.warn(`[preview] internal queue error for ${entry.key}`);
          }
          return 'failed' as const;
        },
      )
      .then((outcome) => {
        // Bookkeeping completes BEFORE the waiter resumes so callers observing
        // the outcome also observe the freed slot.
        this.running--;
        this.pending.delete(entry.key);
        entry.resolve(outcome);
        this.pump();
      });
  }

  private pump(): void {
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift()!;
      const job = this.pending.get(next.key);
      if (!job) continue; // cancelled while queued
      this.start(next, job);
    }
  }

  /** Is a job for this key queued or running right now? */
  has(key: string): boolean {
    return this.pending.has(key);
  }

  snapshot(): PreviewJobStats {
    return {
      running: this.running,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      maxQueue: this.maxQueue,
    };
  }

  /** Unit-test hook: drop all state (no running-runner bookkeeping needed). */
  __resetForTests(): void {
    for (const [, job] of this.pending) {
      if (job.entry) job.entry.resolve('cancelled');
    }
    this.pending.clear();
    this.queue = [];
    this.running = 0;
  }
}

/** Process-wide queue (single instance per server; tests build their own). */
let shared: PreviewQueue | null = null;

export function previewQueueSingleton(): PreviewQueue {
  if (!shared) shared = new PreviewQueue(previewMaxConcurrent(), previewMaxQueue());
  return shared;
}

/** Test/diagnostic hook. */
export function __resetPreviewQueueSingletonForTests(): void {
  if (shared) shared.__resetForTests();
  shared = null;
}
