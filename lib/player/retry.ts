/**
 * Bounded automatic recovery for retryable media-warming failures (P1.3).
 *
 * Problem: when a cold video is still warming, the media route honestly
 * answers 503 + Retry-After — but a bare <video>/Vidstack element surfaces
 * that only as a generic network error with NO status attached. The player
 * therefore probes the endpoint itself (one tiny `bytes=0-0` fetch per
 * error episode, never per play) to learn whether the failure is warming
 * (retry with backoff) or permanent (410/4xx: error panel, never auto-retry).
 *
 * This module is framework-free so every behavior is unit-testable with
 * fake timers: the React component is a thin wiring layer (remount,
 * panels, countdown display) over WarmingRetryController.
 *
 * Hard bounds (no infinite loops by construction):
 *  - MAX_AUTO_RETRIES automatic remounts per playback attempt;
 *  - Retry-After honored when present, else 1s -> 2s -> 4s backoff;
 *  - 410/4xx/aborts never auto-retry;
 *  - unmount / video change / manual retry / success cancel everything.
 */

export const MAX_AUTO_RETRIES = 3;

/** Fallback backoff per auto-retry index (0-based): 1s -> 2s -> 4s. */
export const FALLBACK_BACKOFF_MS = [1000, 2000, 4000] as const;

const RETRY_AFTER_MIN_MS = 1000;
const RETRY_AFTER_MAX_MS = 30_000;

export const UNAVAILABLE_MESSAGE = 'This video is no longer available on MEGA.';
export const PREPARING_EXHAUSTED_MESSAGE =
  'The video is still being prepared. Automatic retries are exhausted — you can retry manually.';
export const GENERIC_RETRYABLE_MESSAGE = 'The video is still being prepared.';

/** Legacy media-element messages, kept for genuinely permanent file failures. */
export const ERROR_MESSAGES: Record<number, string> = {
  1: 'Video loading was aborted',
  2: 'Network error occurred while loading the video',
  3: 'Video decoding failed',
  4: 'Video format not supported by this browser',
};

/** Parse a Retry-After response header (seconds form) into clamped milliseconds. */
export function parseRetryAfterMs(header: string | null | undefined): number | null {
  if (header === null || header === undefined) return null;
  const m = header.trim().match(/^(\d+)$/);
  if (!m) return null;
  const seconds = Number(m[1]);
  if (!Number.isFinite(seconds)) return null;
  return Math.min(Math.max(seconds * 1000, RETRY_AFTER_MIN_MS), RETRY_AFTER_MAX_MS);
}

/** Fallback backoff for the nth auto-retry (0-based), capped. */
export function backoffForAttemptMs(attempt: number): number {
  const i = Math.max(0, Math.min(attempt, FALLBACK_BACKOFF_MS.length - 1));
  return FALLBACK_BACKOFF_MS[i];
}

/** Raw endpoint probe outcome (one tiny ranged fetch per error episode). */
export type EndpointProbeResult =
  | { status: number; retryAfter: string | null }
  | { fetchFailed: true };

export type RetryDecision =
  | { action: 'retry'; delayMs: number }
  | { action: 'unavailable' }
  | { action: 'fatal'; message: string };

/**
 * Decide what to do about a media-element error given the endpoint's honest
 * status. The probe — not the generic media error code — is the source of
 * truth: a torn live stream can surface as a decode error while the endpoint
 * is merely warming (retryable), and a 410 can surface as "not supported"
 * (never retryable). Aborts never reach here (filtered by the controller).
 */
export function decideRetry(probe: EndpointProbeResult | null, attempt: number): RetryDecision {
  if (probe === null) {
    return { action: 'fatal', message: GENERIC_RETRYABLE_MESSAGE };
  }
  if ('fetchFailed' in probe) {
    // Endpoint unreachable ~ the network itself is down: bounded backoff.
    return { action: 'retry', delayMs: backoffForAttemptMs(attempt) };
  }
  const { status, retryAfter } = probe;
  if (status === 410) return { action: 'unavailable' };
  if (status === 503 || status === 429) {
    return { action: 'retry', delayMs: parseRetryAfterMs(retryAfter) ?? backoffForAttemptMs(attempt) };
  }
  if (status >= 500 && status <= 599) {
    return { action: 'retry', delayMs: backoffForAttemptMs(attempt) };
  }
  if (status === 200 || status === 206) {
    // Endpoint serves: the failure was a transient tear, not warming.
    // Short fuse — a stable file that truly cannot decode will burn the
    // small budget and land on the manual panel.
    return { action: 'retry', delayMs: backoffForAttemptMs(attempt) };
  }
  return { action: 'fatal', message: GENERIC_RETRYABLE_MESSAGE };
}

export interface WarmingRetryCallbacks {
  /** A retry was scheduled: show the preparing state with countdown. */
  onPreparing: (attempt: number, delayMs: number) => void;
  /** Timer fired: remount the player; resume near resumeTime when set. */
  onRetry: (attempt: number, resumeTime: number | null) => void;
  /** No more automatic retries: show the manual panel. */
  onExhausted: (kind: 'unavailable' | 'fatal', message: string) => void;
}

export interface WarmingRetryClock {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const systemClock: WarmingRetryClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Per-playback-attempt retry state machine. All timing/probe I/O is
 * injected; the component supplies remount + panels. Remounts happen ONLY
 * via onRetry (timer) — never per render, never per event — so no
 * error -> src -> error loop can form beyond MAX_AUTO_RETRIES.
 */
export class WarmingRetryController {
  /** Completed automatic retries in the current attempt. */
  attempts = 0;
  /** Seek target to restore after a recovery remount (null = none). */
  pendingSeek: number | null = null;
  /** Last media error code seen in the current attempt (for messaging). */
  lastCode: number | undefined = undefined;
  /**
   * True once any probe in the current attempt looked retryable (503/5xx/
   * transient). Lets the UI tell warming-exhaustion ("still preparing")
   * apart from an instantly-fatal decode error with precise messaging.
   */
  sawRetryable = false;

  private busy = false;
  private timer: unknown = null;
  private generation = 0;
  private probeAbort: AbortController | null = null;

  constructor(
    private readonly probe: (signal: AbortSignal) => Promise<EndpointProbeResult>,
    private readonly cb: WarmingRetryCallbacks,
    private readonly maxAttempts: number = MAX_AUTO_RETRIES,
    private readonly clock: WarmingRetryClock = systemClock,
  ) {}

  /**
   * A media-element error occurred. Media error code 1 (abort: navigation,
   * remount, superseded Range) is normal client behavior — ignored
   * entirely, never probed, never retried. Everything else probes the
   * endpoint once per episode (concurrent errors while busy are dropped).
   */
  handleError(code: number | undefined, currentTime: number | null): void {
    if (code === 1) return;
    if (this.busy) return;
    this.lastCode = code;
    if (this.attempts >= this.maxAttempts) {
      // Budget spent: no probe, no timer — straight to manual recovery.
      this.cb.onExhausted('fatal', PREPARING_EXHAUSTED_MESSAGE);
      return;
    }
    this.busy = true;
    if (typeof currentTime === 'number' && Number.isFinite(currentTime) && currentTime > 1) {
      this.pendingSeek = currentTime;
    }
    const gen = this.generation;
    const abort = new AbortController();
    this.probeAbort = abort;
    const attempt = this.attempts;
    this.probe(abort.signal).then(
      (result) => {
        if (gen !== this.generation) return; // cancelled meanwhile
        this.busy = false;
        this.probeAbort = null;
        this.applyDecision(decideRetry(result, attempt), attempt, gen);
      },
      (err) => {
        if (gen !== this.generation) return;
        this.busy = false;
        this.probeAbort = null;
        if ((err as Error | null)?.name === 'AbortError') return; // cancel() won
        // Probe itself threw (non-abort): treat as transient, bounded.
        this.sawRetryable = true;
        this.applyDecision({ action: 'retry', delayMs: backoffForAttemptMs(attempt) }, attempt, gen);
      },
    );
  }

  private applyDecision(decision: RetryDecision, attempt: number, gen: number): void {
    if (gen !== this.generation) return;
    if (decision.action === 'retry') {
      this.sawRetryable = true;
      this.cb.onPreparing(attempt + 1, decision.delayMs);
      this.timer = this.clock.setTimeout(() => {
        this.timer = null;
        if (gen !== this.generation) return;
        this.attempts = attempt + 1;
        this.cb.onRetry(attempt + 1, this.pendingSeek);
      }, decision.delayMs);
    } else if (decision.action === 'unavailable') {
      this.cb.onExhausted('unavailable', UNAVAILABLE_MESSAGE);
    } else {
      // A decode/format code with NO retryable probe behind it is a genuine
      // file problem: keep its precise message instead of the generic one.
      const precise =
        (this.lastCode === 3 || this.lastCode === 4) && !this.sawRetryable
          ? ERROR_MESSAGES[this.lastCode]
          : null;
      this.cb.onExhausted('fatal', precise ?? decision.message);
    }
  }

  /** Fire a pending scheduled retry immediately (consumes budget). No-op when idle. */
  retryNow(): void {
    if (this.timer === null) return;
    this.clock.clearTimeout(this.timer);
    // Re-arm through the same path the timer would have taken: find the
    // pending attempt from the current count (the timer always represents
    // attempts+1).
    this.timer = null;
    this.attempts += 1;
    this.cb.onRetry(this.attempts, this.pendingSeek);
  }

  /** Playback succeeded: reset budget, forget saved state, drop pending episodes. */
  notifyPlaying(): void {
    // A success invalidates any in-flight probe or scheduled retry: a late
    // probe decision must never remount a healthy playing video. The
    // generation bump drops continuations; the abort stops the fetch.
    this.generation += 1;
    this.probeAbort?.abort();
    this.probeAbort = null;
    this.busy = false;
    this.clearTimer();
    this.attempts = 0;
    this.pendingSeek = null;
    this.sawRetryable = false;
    this.lastCode = undefined;
  }

  /** Discard a saved seek target (e.g. after applying it post-remount). */
  clearPendingSeek(): void {
    this.pendingSeek = null;
  }

  /**
   * User pressed manual Retry: reset the automatic budget (a fresh attempt)
   * but KEEP the saved seek target so recovery still lands near it.
   * Returns the target for the caller to apply after remount.
   */
  manualRetry(): number | null {
    this.clearTimer();
    this.busy = false;
    this.attempts = 0;
    this.sawRetryable = false;
    this.lastCode = undefined;
    return this.pendingSeek;
  }

  /** Unmount / video change: everything stops, nothing fires afterwards. */
  cancel(): void {
    this.generation += 1;
    this.clearTimer();
    this.probeAbort?.abort();
    this.probeAbort = null;
    this.busy = false;
    this.attempts = 0;
    this.pendingSeek = null;
    this.sawRetryable = false;
    this.lastCode = undefined;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
