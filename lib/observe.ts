/**
 * PERF_TRACE: opt-in latency/resource instrumentation for performance
 * investigations (docs/LOCALHOST-PERFORMANCE-INVESTIGATION.md).
 *
 * Enabled with PERF_TRACE=1. Emits one structured JSON line per sample to
 * stdout - NEVER credentials, keys, session material, URLs, or user data:
 * only durations, counters, and resource gauges.
 *
 * Collected:
 *   - PostgreSQL pool gauges (total/idle/waiting connections) - saturation
 *     evidence without assuming pool size is the problem.
 *   - Event-loop delay histogram (p50/p99/max) - event-loop blocking
 *     evidence (CPU-bound work, large synchronous transforms).
 *   - Process memory gauges (RSS, heap, external, ArrayBuffer).
 *   - Counts of live ffmpeg child processes.
 *
 * Prisma per-query timing is attached separately in lib/db.ts (query
 * component extension) so every query logs its duration only.
 */

import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import fs from 'node:fs';

export function perfTraceEnabled(): boolean {
  return process.env.PERF_TRACE === '1';
}

interface PoolLike {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}

let started = false;

export function startPerfTrace(pool?: PoolLike): void {
  if (started || !perfTraceEnabled()) return;
  started = true;

  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();

  const intervalMs = Number(process.env.PERF_TRACE_INTERVAL_MS) || 5000;
  const timer = setInterval(() => {
    histogram.disable();
    const p = (q: number) => {
      try {
        return Math.round((histogram.percentile(q) / 1e6) * 10) / 10; // ns -> ms
      } catch {
        return -1;
      }
    };
    const ffmpegCount = countFfmpegChildren();
    const sample = {
      t: 'perf',
      at: new Date().toISOString(),
      eventLoopMs: {
        mean: Math.round((histogram.mean / 1e6) * 10) / 10,
        p50: p(50),
        p99: p(99),
        max: Math.round((histogram.max / 1e6) * 10) / 10,
      },
      memMB: {
        rss: Math.round(process.memoryUsage().rss / 1048576),
        heapUsed: Math.round(process.memoryUsage().heapUsed / 1048576),
        external: Math.round(process.memoryUsage().external / 1048576),
        arrayBuffers: Math.round(process.memoryUsage().arrayBuffers / 1048576),
      },
      ffmpegChildren: ffmpegCount,
      pgPool: pool
        ? { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }
        : undefined,
    };
    console.log(JSON.stringify(sample));
    histogram.reset();
    histogram.enable();
  }, intervalMs);
  // Do not hold the process open for diagnostics.
  if (typeof timer.unref === 'function') timer.unref();
}

/** Count live ffmpeg children of this process (0 when none). */
function countFfmpegChildren(): number {
  try {
    const self = process.pid.toString();
    let n = 0;
    for (const pid of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(pid) || pid === self) continue;
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const name = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (fields[1] === self && name === 'ffmpeg') n++;
      } catch {
        // exited between readdir and read - ignore
      }
    }
    return n;
  } catch {
    return -1;
  }
}

/** One-shot resource snapshot for reports. */
export function snapshotNow(): string {
  const m = process.memoryUsage();
  return JSON.stringify({
    t: 'perf-snapshot',
    rssMB: Math.round(m.rss / 1048576),
    heapUsedMB: Math.round(m.heapUsed / 1048576),
    externalMB: Math.round(m.external / 1048576),
    arrayBuffersMB: Math.round(m.arrayBuffers / 1048576),
  });
}

/** Unused-but-typed helper kept for future CPU attribution work. */
export function measureCpuSampleMs(): number {
  const start = performance.now();
  return Math.round((performance.now() - start) * 100) / 100;
}
