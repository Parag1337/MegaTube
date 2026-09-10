/**
 * Public entry point for the MEGA sync engine.
 *
 * Importing this module (from server-side route handlers) starts the
 * background scheduler exactly once per process - but NOT during
 * `next build` (NEXT_PHASE is set) so the build never spawns timers.
 */

import { startSyncScheduler } from './scheduler';

if (typeof process.env.NEXT_PHASE === 'undefined') {
  startSyncScheduler();
}

export { enqueueSync, isSyncPending, waitForIdle } from './queue';
export type { EnqueueOutcome } from './queue';
export { syncMegaAccount } from './syncAccount';
export type { SyncResult } from './syncAccount';
export { getSyncProgress } from './progress';
export { planReconciliation } from './reconcile';
export { syncBackoffMs, startSyncScheduler } from './scheduler';
