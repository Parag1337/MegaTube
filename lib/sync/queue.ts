/**
 * Minimal in-process sync queue.
 *
 * The project has no external queue/worker infrastructure (no Redis, no
 * BullMQ, no serverless jobs) and is a personal/small-scale single-process
 * Next.js app, so synchronization runs in the Node server process:
 *
 *   - a FIFO of pending account ids
 *   - a per-account lock (an account is never synced twice at once)
 *   - a small global concurrency cap (default 1; MEGA_SYNC_CONCURRENCY)
 *   - transient failures are retried later by the scheduler with
 *     exponential backoff (see scheduler.ts); REAUTH_REQUIRED accounts are
 *     never retried automatically.
 *
 * A second simultaneous trigger (API button, scheduler, reconnect) for the
 * same account is deduplicated to a no-op. On server restart pending queue
 * entries are lost, but accounts that need work are picked up again by the
 * scheduler's first tick (due-state is stored in the database).
 *
 * Production note: if this app is ever run as multiple instances behind a
 * load balancer, exactly ONE instance must run the scheduler (e.g. pin it to
 * one process) - the database claim gate still prevents double-syncing an
 * account.
 */

import { syncMegaAccount } from './syncAccount';
import { MEGA_ACCOUNT_STATUSES } from '../megaAccounts';

export type EnqueueOutcome = 'queued' | 'already-pending' | 'not-eligible';

interface SyncRuntime {
  queue: number[];
  queued: Set<number>;
  running: Set<number>;
  active: number;
  concurrency: number;
  initialized: boolean;
}

const globalForQueue = globalThis as unknown as { __megaSyncQueue?: SyncRuntime };

function concurrency(): number {
  const n = Number(process.env.MEGA_SYNC_CONCURRENCY);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 8) : 1;
}

function rt(): SyncRuntime {
  if (!globalForQueue.__megaSyncQueue) {
    globalForQueue.__megaSyncQueue = {
      queue: [],
      queued: new Set(),
      running: new Set(),
      active: 0,
      concurrency: concurrency(),
      initialized: false,
    };
  }
  return globalForQueue.__megaSyncQueue;
}

function pump(): void {
  const r = rt();
  while (r.active < r.concurrency && r.queue.length > 0) {
    const accountId = r.queue.shift()!;
    r.queued.delete(accountId);
    if (r.running.has(accountId)) continue;
    r.active += 1;
    r.running.add(accountId);
    void runJob(accountId).finally(() => {
      r.running.delete(accountId);
      r.active = Math.max(0, r.active - 1);
      pump();
    });
  }
}

async function runJob(accountId: number): Promise<void> {
  try {
    await syncMegaAccount(accountId);
  } catch (err) {
    // syncMegaAccount handles its own error classification; this is a
    // safety net so one bad job can never wedge the queue.
    console.warn(
      `[sync] unexpected job failure for MegaAccount ${accountId}: ${err instanceof Error ? err.message : 'unknown'}`,
    );
  }
}

/**
 * Queue a sync for an account.
 *
 * @param source Where the request came from (logging only).
 * @returns 'queued' when the job was scheduled, 'already-pending' when the
 *   account is already queued or running, 'not-eligible' when the account
 *   does not exist (or is gone).
 */
export async function enqueueSync(accountId: number, source: string): Promise<EnqueueOutcome> {
  const r = rt();
  if (r.running.has(accountId) || r.queued.has(accountId)) {
    return 'already-pending';
  }

  const { prisma } = await import('../db');
  const account = await prisma.megaAccount.findUnique({
    where: { id: accountId },
    select: { id: true, status: true },
  });
  if (!account) return 'not-eligible';
  if (account.status === MEGA_ACCOUNT_STATUSES.DISCONNECTED) return 'not-eligible';
  if (account.status === MEGA_ACCOUNT_STATUSES.REAUTH_REQUIRED) return 'not-eligible';

  r.queued.add(accountId);
  r.queue.push(accountId);
  console.log(`[sync] MegaAccount ${accountId} sync queued (${source})`);
  pump();
  return 'queued';
}

/** Test/introspection helper: is a job active or pending for this account? */
export function isSyncPending(accountId: number): boolean {
  const r = rt();
  return r.running.has(accountId) || r.queued.has(accountId);
}

/** Test helper: wait until no jobs are active (with timeout). */
export async function waitForIdle(timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (rt().active > 0 || rt().queue.length > 0) {
    if (Date.now() - start > timeoutMs) throw new Error('sync queue did not become idle in time');
    await new Promise((r) => setTimeout(r, 50));
  }
}
