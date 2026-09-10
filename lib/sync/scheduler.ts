/**
 * Automatic synchronization scheduler (in-process).
 *
 * A single timer (default: check every 60s) asks the database which accounts
 * are DUE for a sync and enqueues them:
 *
 *   - CONNECTED accounts that have never synced (or were just (re)linked)
 *   - SYNCED accounts older than MEGA_SYNC_INTERVAL_MS (default 6h)
 *   - ERROR accounts whose exponential backoff has elapsed
 *     (5min * 2^(failures-1), capped at 6h)
 *
 * REAUTH_REQUIRED and DISCONNECTED accounts are never auto-synced.
 *
 * Crash recovery: on startup, accounts left in SYNCING by a previous
 * (crashed) process are moved to ERROR so the backoff logic retries them.
 *
 * This is deliberately a simple, single-process mechanism (the project has
 * no external job infrastructure). If the app ever runs as multiple
 * instances, pin the scheduler to exactly one instance.
 */

import { prisma } from '../db';
import { MEGA_ACCOUNT_STATUSES } from '../megaAccounts';
import { enqueueSync } from './queue';

const CHECK_INTERVAL_MS = 60_000;
const FIRST_TICK_DELAY_MS = 5_000;

function syncIntervalMs(): number {
  const n = Number(process.env.MEGA_SYNC_INTERVAL_MS);
  return Number.isFinite(n) && n >= 60_000 ? n : 6 * 60 * 60 * 1000;
}

/** Backoff before retrying an account that failed with a transient error. */
export function syncBackoffMs(consecutiveFailures: number): number {
  const n = Math.max(1, consecutiveFailures);
  return Math.min(5 * 60 * 1000 * 2 ** (n - 1), 6 * 60 * 60 * 1000);
}

interface DueAccount {
  id: number;
  status: string;
  consecutiveSyncFailures: number;
  lastSyncCompletedAt: Date | null;
  lastSyncErrorAt: Date | null;
}

async function dueAccounts(): Promise<DueAccount[]> {
  const rows = (await prisma.megaAccount.findMany({
    where: {
      status: {
        in: [
          MEGA_ACCOUNT_STATUSES.CONNECTED,
          MEGA_ACCOUNT_STATUSES.SYNCED,
          MEGA_ACCOUNT_STATUSES.ERROR,
        ],
      },
      encryptedSession: { not: '' },
    },
    select: {
      id: true,
      status: true,
      consecutiveSyncFailures: true,
      lastSyncCompletedAt: true,
      lastSyncErrorAt: true,
    },
  })) as DueAccount[];

  const now = Date.now();
  const interval = syncIntervalMs();

  return rows.filter((a) => {
    if (a.status === MEGA_ACCOUNT_STATUSES.CONNECTED) return true; // never synced yet
    if (a.status === MEGA_ACCOUNT_STATUSES.SYNCED) {
      return a.lastSyncCompletedAt === null ||
        now - a.lastSyncCompletedAt.getTime() >= interval;
    }
    if (a.status === MEGA_ACCOUNT_STATUSES.ERROR) {
      const backoff = syncBackoffMs(a.consecutiveSyncFailures);
      const base = a.lastSyncErrorAt?.getTime() ?? a.lastSyncCompletedAt?.getTime() ?? now;
      return now - base >= backoff;
    }
    return false;
  });
}

async function tick(): Promise<void> {
  try {
    const due = await dueAccounts();
    for (const account of due) {
      await enqueueSync(account.id, 'schedule');
    }
  } catch (err) {
    console.warn(`[sync] scheduler tick failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }
}

const globalForScheduler = globalThis as unknown as {
  __megaSyncSchedulerStarted?: boolean;
};

/**
 * Start the scheduler (idempotent). Also performs crash recovery for
 * accounts stuck in SYNCING.
 */
export function startSyncScheduler(): void {
  if (globalForScheduler.__megaSyncSchedulerStarted) return;
  globalForScheduler.__megaSyncSchedulerStarted = true;

  void (async () => {
    try {
      // Crash recovery: a previous process died mid-sync. Also persist an
      // 'interrupted' lastSyncMeta so the UI shows a durable result instead
      // of a stale progress bar after the restart.
      const stuckRows = await prisma.megaAccount.findMany({
        where: { status: MEGA_ACCOUNT_STATUSES.SYNCING },
        select: { id: true, lastSyncStartedAt: true, lastSyncMeta: true },
      });
      for (const row of stuckRows) {
        let startedAt = row.lastSyncStartedAt?.getTime() ?? Date.now();
        try {
          const prev = row.lastSyncMeta ? (JSON.parse(row.lastSyncMeta) as { startedAt?: string }) : null;
          if (prev?.startedAt) {
            const prevStart = new Date(prev.startedAt).getTime();
            if (Number.isFinite(prevStart) && prevStart > 0) startedAt = prevStart;
          }
        } catch {
          // ignore malformed previous meta
        }
        await prisma.megaAccount.updateMany({
          where: { id: row.id },
          data: {
            status: MEGA_ACCOUNT_STATUSES.ERROR,
            lastSyncError: 'Sync was interrupted by a server restart.',
            lastSyncErrorAt: new Date(),
            consecutiveSyncFailures: { increment: 1 },
            lastSyncMeta: JSON.stringify({
              startedAt: new Date(startedAt).toISOString(),
              completedAt: new Date().toISOString(),
              durationMs: Date.now() - startedAt,
              discovered: 0,
              totalVideos: 0,
              created: 0,
              updated: 0,
              removed: 0,
              unchanged: 0,
              outcome: 'interrupted',
            }),
          },
        });
      }
      if (stuckRows.length > 0) {
        console.log(`[sync] crash recovery: reset ${stuckRows.length} stuck SYNCING account(s) to ERROR`);
      }
    } catch (err) {
      console.warn(`[sync] crash recovery failed: ${err instanceof Error ? err.message : 'unknown'}`);
    }

    await new Promise((r) => setTimeout(r, FIRST_TICK_DELAY_MS));
    await tick();
    // unref(): the timer must never keep the process alive (e.g. during
    // `next build` or in tests).
    const timer = setInterval(() => void tick(), CHECK_INTERVAL_MS);
    timer.unref?.();
  })();
}

/** Test helper: reset the started flag. */
export function _resetSchedulerFlagForTests(): void {
  globalForScheduler.__megaSyncSchedulerStarted = false;
}

/** Test helper: expose dueAccounts logic without the timer. */
export async function _getDueAccountsForTests(): Promise<DueAccount[]> {
  return dueAccounts();
}
