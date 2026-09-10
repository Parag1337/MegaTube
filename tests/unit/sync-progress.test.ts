/**
 * Phase 3 tests: real sync progress + ETA (pure modules, no DB, no MEGA).
 *
 * Spec requirements covered here:
 *   - Phase A (scanning) exposes NO percentage because totalVideos is null
 *     (a fake percentage must never be shown when the denominator is unknown)
 *   - Phase B (reconciling) has real counters that reach exactly 100%
 *   - ETA is derived from observed processing rate, never a fixed countdown
 *   - ETA is never negative or nonsensical; warm-up shows "calculating";
 *     near completion shows "almost done"
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setSyncProgress, bumpSyncProgress, getSyncProgress, clearSyncProgress, serializeSyncProgress } from '@/lib/sync/progress';
import { computeEta } from '@/lib/sync/eta';
import type { EtaSample } from '@/lib/sync/eta';

// ---------------------------------------------------------------------------
// Progress model
// ---------------------------------------------------------------------------

test('scanning phase has no total -> serializer exposes no percentage basis', () => {
  clearSyncProgress(9001);
  setSyncProgress(9001, { startedAt: 1_000, phase: 'scanning', nodesScanned: 0, totalVideos: null });

  const live = getSyncProgress(9001);
  assert.ok(live);
  assert.equal(live.phase, 'scanning');
  assert.equal(live.totalVideos, null, 'totalVideos must be null while scanning (no fake %)');

  const dto = serializeSyncProgress(9001);
  assert.ok(dto);
  assert.equal(dto.totalVideos, null);
  assert.equal(dto.nodesScanned, 0);
  clearSyncProgress(9001);
});

test('scan callback updates nodesScanned without introducing a total', () => {
  clearSyncProgress(9002);
  setSyncProgress(9002, { startedAt: 1_000, phase: 'scanning', nodesScanned: 0, totalVideos: null });
  setSyncProgress(9002, { phase: 'scanning', nodesScanned: 1_842 });

  const live = getSyncProgress(9002)!;
  assert.equal(live.nodesScanned, 1_842);
  assert.equal(live.totalVideos, null);
  assert.equal(live.startedAt, 1_000, 'startedAt is preserved across patches');
  clearSyncProgress(9002);
});

test('reconciling phase carries real totals and monotonic counters', () => {
  clearSyncProgress(9003);
  setSyncProgress(9003, {
    startedAt: 1_000,
    phase: 'scanning',
    nodesScanned: 0,
    totalVideos: null,
  });
  // Scan completes: total becomes known, counters reset for phase B.
  setSyncProgress(9003, {
    phase: 'reconciling',
    nodesScanned: 300,
    totalVideos: 300,
    processedVideos: 0,
    created: 0,
    updated: 0,
    removed: 0,
  });

  bumpSyncProgress(9003, { processedVideos: 216, created: 2, updated: 3, removed: 0 });
  let live = getSyncProgress(9003)!;
  assert.equal(live.phase, 'reconciling');
  assert.equal(live.totalVideos, 300);
  assert.equal(live.processedVideos, 216);

  // Counters are snapshots (monotonic within one job): a later snapshot with
  // only some fields still keeps the others.
  bumpSyncProgress(9003, { processedVideos: 250, created: 2, updated: 4, removed: 1 });
  live = getSyncProgress(9003)!;
  assert.equal(live.processedVideos, 250);
  assert.equal(live.updated, 4);
  assert.equal(live.removed, 1);

  // Percentage would be real, not fake: 250/300.
  assert.ok(live.processedVideos / live.totalVideos! <= 1);
  clearSyncProgress(9003);
});

test('progress reaches completion exactly: processed == total', () => {
  clearSyncProgress(9004);
  setSyncProgress(9004, { startedAt: 1_000, phase: 'reconciling', nodesScanned: 5, totalVideos: 5 });
  bumpSyncProgress(9004, { processedVideos: 5, created: 2, updated: 1, removed: 0 });

  const live = getSyncProgress(9004)!;
  assert.equal(live.processedVideos, live.totalVideos, 'worker must report every video processed');
  clearSyncProgress(9004);
});

test('progress for an unknown/finished account is null', () => {
  clearSyncProgress(9005);
  assert.equal(getSyncProgress(9005), null);
  assert.equal(serializeSyncProgress(9005), null);
});

// ---------------------------------------------------------------------------
// ETA calculation
// ---------------------------------------------------------------------------

function samples(pairs: Array<[number, number]>): EtaSample[] {
  return pairs.map(([t, processed]) => ({ t, processed }));
}

test('ETA: no samples or unknown total -> calculating (never a fake number)', () => {
  assert.equal(computeEta([], 300).kind, 'calculating');
  assert.equal(computeEta(samples([[0, 0], [5_000, 10]]), null).kind, 'calculating');
});

test('ETA: warm-up period -> calculating', () => {
  // Less than the minimum observation window.
  assert.equal(computeEta(samples([[0, 0], [1_000, 4]]), 300).kind, 'calculating');
  // Enough time but too few processed items for a stable rate.
  assert.equal(computeEta(samples([[0, 0], [10_000, 2]]), 300).kind, 'calculating');
});

test('ETA: derived from observed rate, not a fixed countdown', () => {
  // 10 items in 4s -> 0.0025/ms; 90 remaining -> 36_000ms.
  const eta = computeEta(samples([[0, 0], [4_000, 10]]), 100);
  assert.equal(eta.kind, 'estimate');
  assert.equal(eta.kind === 'estimate' ? eta.remainingMs : -1, 36_000);
});

test('ETA: faster rate -> shorter estimate', () => {
  const slow = computeEta(samples([[0, 0], [8_000, 10]]), 100);
  const fast = computeEta(samples([[0, 0], [4_000, 10]]), 100);
  assert.equal(slow.kind, 'estimate');
  assert.equal(fast.kind, 'estimate');
  assert.ok(
    (fast as { remainingMs: number }).remainingMs < (slow as { remainingMs: number }).remainingMs,
  );
});

test('ETA: near completion -> almost done (never a nonsense number)', () => {
  const eta = computeEta(samples([[0, 0], [4_000, 10]]), 12);
  assert.equal(eta.kind, 'almost-done');
  // Processed beyond total (defensive): still almost-done, never negative.
  assert.equal(computeEta(samples([[0, 0], [4_000, 20]]), 12).kind, 'almost-done');
});

test('ETA: never negative even in pathological inputs', () => {
  const eta = computeEta(samples([[5_000, 10], [4_000, 20]]), 100);
  if (eta.kind === 'estimate') {
    assert.ok(eta.remainingMs >= 0, `ETA must not be negative, got ${eta.remainingMs}`);
  } else {
    assert.ok(eta.kind === 'calculating' || eta.kind === 'almost-done');
  }
});

test('ETA: stalled progress (rate 0) -> calculating, not an inflated number', () => {
  assert.equal(computeEta(samples([[0, 0], [30_000, 0]]), 300).kind, 'calculating');
});
