/**
 * Sync progress (per account), shared between the sync worker and the API/UI.
 *
 * Two phases:
 *   A "scanning"  - the MEGA node tree is being fetched/decoded. The total
 *                   number of nodes is NOT known up front (the API response is
 *                   one big payload), so there is deliberately NO percentage
 *                   in this phase - only counters.
 *   B "applying"  - reconciliation of the discovered video nodes against the
 *                   DB. Total videos is known here, so a real percentage
 *                   (processed/total) is shown.
 *
 * Volatile by design: if the server restarts mid-sync the in-memory progress
 * is gone; the durable lastSyncMeta on the MegaAccount row (written by the
 * worker at the end of a sync, or by crash recovery) is what the UI falls
 * back to. `serverBootId` lets the API tell a client "this progress belongs
 * to a different server incarnation than the sync that is claimed to be
 * running" so the UI can stop polling.
 */

export interface SyncProgress {
  accountId: number;
  /** Epoch ms when the sync job started. */
  startedAt: number;
  /**
   * Phase A: number of MEGA nodes scanned so far (all node types).
   * Phase B: frozen at the final scan total.
   */
  nodesScanned: number | null;
  /** Phase label for the UI. */
  phase: 'starting' | 'scanning' | 'reconciling' | 'finalizing';
  /** Total video nodes discovered (null until the scan is complete). */
  totalVideos: number | null;
  /** Videos whose DB row has been created/updated/verified-unchanged. */
  processedVideos: number;
  created: number;
  updated: number;
  removed: number;
}

const globalForProgress = globalThis as unknown as {
  megaSyncProgress?: Map<number, SyncProgress>;
};

function store(): Map<number, SyncProgress> {
  if (!globalForProgress.megaSyncProgress) {
    globalForProgress.megaSyncProgress = new Map();
  }
  return globalForProgress.megaSyncProgress;
}

export function setSyncProgress(
  accountId: number,
  patch: Partial<Omit<SyncProgress, 'accountId'>>,
): void {
  const prev = store().get(accountId);
  // Explicit field-by-field merge (no spread): explicit nulls in the patch
  // (e.g. totalVideos: null while scanning) must RESET the field, while
  // omitted (undefined) fields keep their previous value.
  const next: SyncProgress = {
    accountId,
    startedAt: patch.startedAt ?? prev?.startedAt ?? Date.now(),
    phase: patch.phase ?? prev?.phase ?? 'starting',
    nodesScanned: patch.nodesScanned ?? prev?.nodesScanned ?? null,
    totalVideos: patch.totalVideos ?? prev?.totalVideos ?? null,
    processedVideos: patch.processedVideos ?? prev?.processedVideos ?? 0,
    created: patch.created ?? prev?.created ?? 0,
    updated: patch.updated ?? prev?.updated ?? 0,
    removed: patch.removed ?? prev?.removed ?? 0,
  };
  store().set(accountId, next);
}

/**
 * Bump the reconciliation counters (Phase B). Called by the worker after each
 * video is applied. Counter values replace (not add to) - the worker tracks
 * its own running totals and pushes snapshots.
 */
export function bumpSyncProgress(
  accountId: number,
  counters: { processedVideos: number; created: number; updated: number; removed: number },
): void {
  const cur = store().get(accountId);
  if (!cur) return;
  store().set(accountId, { ...cur, ...counters });
}

export function getSyncProgress(accountId: number): SyncProgress | null {
  return store().get(accountId) ?? null;
}

export function clearSyncProgress(accountId: number): void {
  store().delete(accountId);
}

/**
 * Serializes the live progress for API responses. The ETA itself is computed
 * client-side from successive samples (see lib/sync/eta.ts) so the numbers
 * remain consistent between polls even if the server is briefly busy.
 */
export function serializeSyncProgress(accountId: number): {
  phase: SyncProgress['phase'];
  startedAt: number;
  nodesScanned: number | null;
  totalVideos: number | null;
  processedVideos: number;
  created: number;
  updated: number;
  removed: number;
} | null {
  const p = getSyncProgress(accountId);
  if (!p) return null;
  return {
    phase: p.phase,
    startedAt: p.startedAt,
    nodesScanned: p.nodesScanned,
    totalVideos: p.totalVideos,
    processedVideos: p.processedVideos,
    created: p.created,
    updated: p.updated,
    removed: p.removed,
  };
}
