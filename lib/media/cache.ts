/**
 * Media disk-cache management (P1.5).
 *
 * The remux/faststart cache in data/cache-media (see lib/media/remux.ts)
 * previously grew without any size policy. This module adds a safe,
 * self-contained eviction strategy on top of the existing layout:
 *
 *   - configurable maximum total size (MEDIA_CACHE_MAX_BYTES, default 5GiB)
 *   - LRU eviction by explicit last-access tracking in the sidecar
 *     (<id>.json gains `lastAccessedAt`; entries without it fall back to
 *     the file mtime, so pre-P1.5 caches and restarts keep working)
 *   - NEVER evicts: live remux jobs, temp/partial files (*.part.mp4,
 *     *.ts.part, *.live.spool), files currently being streamed
 *     (refcounted via trackCacheStream), or recently-written files
 *     (grace window covers in-progress publishes)
 *   - stale/corrupt entries (sidecar missing or disagreeing with the file)
 *     are reclaimed first - they are unservable anyway
 *   - eviction runs on a background interval (startMediaCacheMaintenance,
 *     wired in instrumentation.ts), never in the playback startup path;
 *     serving a warm cache only does a throttled fire-and-forget touch
 *
 * No new infrastructure: plain fs + JSON inside the existing cache dir.
 */

import fs from 'node:fs';
import path from 'node:path';
import { hasLiveRemuxJob, mediaCacheDir, writeSidecarAtomic } from './remux';

export const DEFAULT_CACHE_MAX_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB
export const DEFAULT_EVICTION_INTERVAL_MS = 15 * 60_000;
export const DEFAULT_TOUCH_INTERVAL_MS = 60_000;
export const DEFAULT_EVICTION_GRACE_MS = 5 * 60_000;

function parseSizeEnv(raw: string | undefined, fallback: number): number {
  if (!raw || raw.trim().length === 0) return fallback;
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/i);
  if (!m) return fallback;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  const unit = (m[2] ?? 'b').toLowerCase();
  const mult =
    unit === 'tb' ? 1024 ** 4 : unit === 'gb' ? 1024 ** 3 : unit === 'mb' ? 1024 ** 2 : unit === 'kb' ? 1024 : 1;
  return Math.floor(value * mult);
}

/** Maximum total bytes the media cache may occupy (env-overridable). */
export function mediaCacheMaxBytes(): number {
  return parseSizeEnv(process.env.MEDIA_CACHE_MAX_BYTES, DEFAULT_CACHE_MAX_BYTES);
}

function evictionIntervalMs(): number {
  const n = Number(process.env.MEDIA_CACHE_EVICTION_INTERVAL_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_EVICTION_INTERVAL_MS;
}

function touchIntervalMs(): number {
  const n = Number(process.env.MEDIA_CACHE_TOUCH_INTERVAL_MS);
  // 0 is valid in tests (touch on every serve); negative/non-numeric falls back.
  if (process.env.MEDIA_CACHE_TOUCH_INTERVAL_MS !== undefined && Number(process.env.MEDIA_CACHE_TOUCH_INTERVAL_MS) === 0) return 0;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TOUCH_INTERVAL_MS;
}

function evictionGraceMs(): number {
  const n = Number(process.env.MEDIA_CACHE_EVICTION_GRACE_MS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_EVICTION_GRACE_MS;
}

interface CacheSidecar {
  megaNodeId: string;
  sourceSize: number;
  outputSize: number;
  lastAccessedAt?: string;
}

function sidecarPath(videoId: number): string {
  return path.join(mediaCacheDir(), `${videoId}.json`);
}

function mp4Path(videoId: number): string {
  return path.join(mediaCacheDir(), `${videoId}.mp4`);
}

// ---------------------------------------------------------------------------
// Access tracking
// ---------------------------------------------------------------------------

/** In-memory last-touch per video: bounds sidecar rewrites under Range storms. */
const lastTouch = new Map<number, number>();

/**
 * Record that a warm cache entry was served. Throttled (TOUCH interval) and
 * never throws: eviction accuracy degrades gracefully, playback never does.
 * Fire-and-forget from the warm-serve path - never awaited there.
 */
export async function touchRemuxCache(videoId: number): Promise<void> {
  try {
    const now = Date.now();
    if (now - (lastTouch.get(videoId) ?? 0) < touchIntervalMs()) return;
    lastTouch.set(videoId, now);
    const file = sidecarPath(videoId);
    let sidecar: CacheSidecar;
    try {
      sidecar = JSON.parse(await fs.promises.readFile(file, 'utf8')) as CacheSidecar;
    } catch {
      return; // evicted/missing sidecar - nothing to touch
    }
    sidecar.lastAccessedAt = new Date(now).toISOString();
    // P1-B: atomic replace — a crash mid-touch must never leave a
    // truncated sidecar (that would turn a VALID mp4 unservable).
    await writeSidecarAtomic(file, sidecar);
  } catch {
    // best-effort only
  }
}

// ---------------------------------------------------------------------------
// Active-stream protection (refcounted)
// ---------------------------------------------------------------------------

/** Video ids with at least one open warm-cache stream right now. */
const activeReaders = new Map<number, number>();

/**
 * Mark a warm-cache stream as open; call the returned release exactly once
 * when it closes. Eviction skips ids with a positive count, so a file being
 * served is never deleted mid-stream.
 */
export function trackCacheStream(videoId: number): () => void {
  activeReaders.set(videoId, (activeReaders.get(videoId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (activeReaders.get(videoId) ?? 1) - 1;
    if (left <= 0) activeReaders.delete(videoId);
    else activeReaders.set(videoId, left);
  };
}

/** Test hook: current reader count for a video. */
export function activeCacheReaders(videoId: number): number {
  return activeReaders.get(videoId) ?? 0;
}

// ---------------------------------------------------------------------------
// Eviction
// ---------------------------------------------------------------------------

export interface EvictionResult {
  totalBytes: number;
  maxBytes: number;
  entries: number;
  evicted: number;
  evictedBytes: number;
  reclaimedStale: number;
  /** Temp orphans (abandoned *.ts.part / *.live.spool / *.part.mp4) removed. */
  reclaimedTempOrphans: number;
  /** Live temp footprint (active jobs' downloads/spools/outputs), for pressure signal only. */
  tempBytes: number;
}

interface CacheEntry {
  videoId: number;
  size: number;
  lastAccess: number;
  stale: boolean;
}

function parseVideoId(name: string): number | null {
  const m = name.match(/^(\d+)\.mp4$/);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isInteger(id) && id >= 0 ? id : null;
}

/**
 * Temp files older than this with no live job are orphans (P1-C): the owning
 * job is gone (its finally always cleans up on any in-process terminal
 * path), so only a SIGKILL-style death without a restart sweep can leave
 * them. The age bound far exceeds any legitimate job lifetime (ffmpeg file
 * phase alone times out at 30 min), and mtime tracks last WRITE activity,
 * so a slow-but-alive download is never mistaken for abandoned.
 */
export const TEMP_ORPHAN_AGE_MS = 2 * 60 * 60_000; // 2 h

const TEMP_NAME_RE = /^(\d+)\.(ts\.part|live\.spool|part\.mp4)$/;

/**
 * One eviction pass. Scans the cache dir (no full-content reads: one
 * readdir + stat/sidecar per entry), deletes stale entries first, then
 * least-recently-used entries until under budget. Never throws.
 *
 * P1-C: temp files (*.ts.part, *.live.spool, *.part.mp4) are NEVER eviction
 * victims, but their bytes count toward total pressure (temp-unaware totals
 * would let two concurrent jobs silently double the footprint), and orphans
 * older than TEMP_ORPHAN_AGE_MS with no live job are reclaimed.
 */
export async function evictMediaCache(options?: {
  maxBytes?: number;
  isProtected?: (videoId: number) => boolean;
  now?: number;
}): Promise<EvictionResult> {
  const maxBytes = options?.maxBytes ?? mediaCacheMaxBytes();
  const now = options?.now ?? Date.now();
  const isProtected = options?.isProtected ?? hasLiveRemuxJob;
  const graceMs = evictionGraceMs();
  const empty: EvictionResult = { totalBytes: 0, maxBytes, entries: 0, evicted: 0, evictedBytes: 0, reclaimedStale: 0, reclaimedTempOrphans: 0, tempBytes: 0 };

  let names: string[];
  try {
    names = await fs.promises.readdir(mediaCacheDir());
  } catch {
    return empty; // no cache dir yet
  }

  const entries: CacheEntry[] = [];
  let totalBytes = 0;
  let tempBytes = 0;
  const tempOrphans: Array<{ videoId: number; file: string; mtimeMs: number; size: number }> = [];
  for (const name of names) {
    const videoId = parseVideoId(name);
    if (videoId === null) {
      // Temp accounting (P1-C): pressure signal only, never victims here.
      const tm = name.match(TEMP_NAME_RE);
      if (tm) {
        const file = path.join(mediaCacheDir(), name);
        try {
          const stat = await fs.promises.stat(file);
          if (stat.isFile()) {
            tempBytes += stat.size;
            // Orphan candidate: old, and no live job owns it. mtime tracks
            // write activity, so an in-progress download/spool (fresh mtime)
            // is never mistaken for abandoned; future mtimes are skipped.
            const age = now - stat.mtimeMs;
            if (age >= TEMP_ORPHAN_AGE_MS) {
              let prot = false;
              try {
                prot = isProtected(Number(tm[1]));
              } catch {
                prot = true; // protector failure -> keep, never risk playback
              }
              if (!prot) tempOrphans.push({ videoId: Number(tm[1]), file, mtimeMs: stat.mtimeMs, size: stat.size });
            }
          }
        } catch {
          // raced deletion - ignore
        }
      }
      continue; // temps (*.part.mp4, *.ts.part, *.live.spool, *.json) never considered
    }
    const file = path.join(mediaCacheDir(), name);
    let stat: { size: number; mtimeMs: number; isFile: () => boolean };
    try {
      stat = await fs.promises.stat(file);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size <= 0) continue;
    totalBytes += stat.size;
    let lastAccess = stat.mtimeMs;
    let stale = false;
    try {
      const sidecar = JSON.parse(await fs.promises.readFile(sidecarPath(videoId), 'utf8')) as CacheSidecar;
      if (
        typeof sidecar.megaNodeId !== 'string' ||
        sidecar.outputSize !== stat.size ||
        stat.size <= 0
      ) {
        stale = true;
      } else if (typeof sidecar.lastAccessedAt === 'string') {
        const t = Date.parse(sidecar.lastAccessedAt);
        if (Number.isFinite(t)) lastAccess = t;
      }
    } catch {
      stale = true; // no/unreadable sidecar: unservable, reclaimable (unless protected/fresh, checked below)
    }
    entries.push({ videoId, size: stat.size, lastAccess, stale });
  }

  const result: EvictionResult = { ...empty, totalBytes: totalBytes + tempBytes, entries: entries.length, tempBytes };
  // Temp orphans are reclaimed on every pass, even under budget: they can
  // never become servable and no live job owns them.
  for (const o of tempOrphans) {
    try {
      await fs.promises.rm(o.file, { force: true });
      result.reclaimedTempOrphans++;
      result.tempBytes -= o.size;
      result.totalBytes -= o.size;
    } catch {
      // raced with a new job reusing the name - leave it
    }
  }
  if (result.totalBytes <= maxBytes && !entries.some((e) => e.stale)) return result;
  // Stale entries should always be reclaimed even under budget - they're unservable

  const deletable = (e: CacheEntry): boolean => {
    if ((activeReaders.get(e.videoId) ?? 0) > 0) return false;
    try {
      if (isProtected(e.videoId)) return false;
    } catch {
      return false; // protector failure -> keep the file, never risk playback
    }
    // Stale entries: delete immediately if grace window is 0, otherwise respect grace window
    if (e.stale) {
      return graceMs === 0 || now - e.lastAccess >= graceMs;
    }
    // Valid entries: grace window protects fresh publishes, then LRU
    if (now - e.lastAccess < graceMs) return false;
    return true;
  };

  // Stale first (dead weight), then LRU.
  const victims = entries
    .filter(deletable)
    .sort((a, b) => Number(b.stale) - Number(a.stale) || a.lastAccess - b.lastAccess);

  for (const v of victims) {
    // Stale entries are always reclaimed (never servable); live entries
    // only until the cache is back under budget.
    if (!v.stale && result.totalBytes <= maxBytes) break;
    try {
      // P1-B: remove the sidecar FIRST. A crash then leaves mp4-without-
      // sidecar (visible to the *.mp4 scan: lookup misses, stale-reclaim
      // heals it). The reverse order would leave sidecar-without-mp4,
      // which no scan ever sees and which lingers until manual cleanup.
      await fs.promises.rm(sidecarPath(v.videoId), { force: true });
      await fs.promises.rm(mp4Path(v.videoId), { force: true });
    } catch {
      continue;
    }
    result.evicted++;
    result.evictedBytes += v.size;
    result.totalBytes -= v.size;
    if (v.stale) result.reclaimedStale++;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Background scheduling (amortized: never on the playback hot path)
// ---------------------------------------------------------------------------

let maintenanceTimer: ReturnType<typeof setInterval> | null = null;
let evictInFlight = false;

/** Run one throttled eviction pass in the background (never throws). */
export function maybeEvictMediaCache(): void {
  if (evictInFlight) return;
  evictInFlight = true;
  evictMediaCache()
    .then((r) => {
      if (r.evicted > 0) {
        console.log(
          `[media] cache eviction: ${r.evicted} entr${r.evicted === 1 ? 'y' : 'ies'} ` +
            `(${(r.evictedBytes / 1048576).toFixed(1)} MB), ${(r.totalBytes / 1048576).toFixed(1)} MB remain`,
        );
      }
    })
    .catch(() => {})
    .finally(() => {
      evictInFlight = false;
    });
}

/**
 * Start periodic background eviction (once per server process). Safe to call
 * repeatedly (subsequent calls are no-ops). Disabled with
 * MEDIA_CACHE_EVICTION_DISABLED=1.
 */
export function startMediaCacheMaintenance(): void {
  if (maintenanceTimer) return;
  if (process.env.MEDIA_CACHE_EVICTION_DISABLED === '1') return;
  // Defer the first pass past startup so cold-start playback never waits.
  const firstDelay = 60_000;
  const timer = setTimeout(() => {
    maybeEvictMediaCache();
  }, firstDelay);
  if (typeof (timer as unknown as { unref?: unknown }).unref === 'function') {
    (timer as unknown as { unref(): void }).unref();
  }
  const interval = setInterval(() => {
    maybeEvictMediaCache();
  }, evictionIntervalMs());
  if (typeof (interval as unknown as { unref?: unknown }).unref === 'function') {
    (interval as unknown as { unref(): void }).unref();
  }
  maintenanceTimer = interval;
}
