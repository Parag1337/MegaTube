/**
 * ETA calculation for the reconciliation phase, derived from REAL observed
 * processing speed - never a fixed countdown or timer-based fake percentage.
 *
 * The worker pushes {t, processed} samples; we estimate the current
 * processing rate from the observed window and project
 * remaining / rate. Rate is measured over a sliding window (min 3 s span)
 * to smooth out per-item spikes (thumbnail fetches are much slower than
 * metadata-only updates), and a warm-up minimum of processed items is
 * required before showing a number instead of "Calculating...".
 */

export interface EtaSample {
  /** Epoch ms of the sample. */
  t: number;
  /** Cumulative processed items at that time. */
  processed: number;
}

export const ETA_WARMUP_MS = 4_000;
export const ETA_WARMUP_ITEMS = 5;
/** Remaining items at or below this are "almost done". */
export const ETA_ALMOST_DONE_THRESHOLD = 3;

export type EtaResult =
  | { kind: 'calculating' }
  | { kind: 'almost-done' }
  | { kind: 'estimate'; remainingMs: number };

export function computeEta(
  samples: EtaSample[],
  total: number | null,
): EtaResult {
  if (total === null) return { kind: 'calculating' };
  const last = samples[samples.length - 1];
  if (!last) return { kind: 'calculating' };
  const remaining = total - last.processed;
  if (remaining <= 0) return { kind: 'almost-done' };
  if (remaining <= ETA_ALMOST_DONE_THRESHOLD) return { kind: 'almost-done' };

  if (!samples.length) return { kind: 'calculating' };
  const first = samples[0];
  const spanMs = last.t - first.t;
  const done = last.processed - first.processed;

  if (spanMs < ETA_WARMUP_MS || done < ETA_WARMUP_ITEMS) {
    return { kind: 'calculating' };
  }

  const ratePerMs = done / spanMs;
  const remainingMs = Math.ceil(remaining / ratePerMs);
  if (!Number.isFinite(remainingMs) || remainingMs < 0) {
    return { kind: 'calculating' };
  }
  return { kind: 'estimate', remainingMs };
}
