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
   * Enqueue (or join) a job. Resolves with the job outcome; never rejects
   * except QueueFullError at admission time (before any work started).
   */
  enqueue(key: string, runner: () => Promise<unknown>, signal?: AbortSignal | null): Promise<PreviewJobOutcome> {
    const existing = this.pending.get(key);
    if (existing) return existing.promise;

    if (this.running >= this.maxConcurrent && this.queue.length >= this.maxQueue) {
      return Promise.reject(new QueueFullError());
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
        return promise;
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
    } else {
      this.queue.push(entry);
    }
    return promise;
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
