/**
 * Phase 5 preview system: bounded disk store (`data/previews/`).
 *
 * Layout:
 *   <id>.preview.mp4   hover clip (small transcoded asset)
 *   <id>.sprite.jpg    timeline spritesheet
 *   <id>.json          sidecar (status, identity, metadata) — atomic writes
 *   <id>.tmp.*         in-progress temp files (job-owned, never evicted,
 *                      removed by the owning job's finally)
 *
 * Conventions deliberately mirror `lib/media/cache.ts` (the media cache):
 * LRU by lastAccessedAt with a throttled touch, eviction never touches
 * files being streamed (refcounted) or fresh publishes (grace window), and
 * sidecar-first deletion ordering. Preview work NEVER touches the media
 * cache directory itself.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  previewArtifactCleanupGraceMs,
  previewArtifactCleanupMaxEntries,
  previewCacheMaxBytes,
  previewEvictionGraceMs,
  previewEvictionIntervalMs,
  previewGenerationVersion,
  previewTouchIntervalMs,
} from './config';
import { isPreviewSidecar, type PreviewSidecar } from './types';
import { invalidatePreviewStatsCache } from './stats-cache';

function previewsDirOverride(): string | null {
  const override = process.env.PREVIEW_CACHE_DIR;
  return override && override.length > 0 ? override : null;
}

export function previewsDir(): string {
  return previewsDirOverride() ?? path.join(process.cwd(), 'data', 'previews');
}

export function sidecarPath(videoId: number): string {
  return path.join(previewsDir(), `${videoId}.json`);
}
export function clipPath(videoId: number): string {
  return path.join(previewsDir(), `${videoId}.preview.mp4`);
}
export function spritePath(videoId: number): string {
  return path.join(previewsDir(), `${videoId}.sprite.jpg`);
}

export async function ensureDir(): Promise<void> {
  await fs.promises.mkdir(previewsDir(), { recursive: true });
}

/** Atomic sidecar write (tmp on the same filesystem + rename). */
export async function writeSidecarAtomic(sidecar: PreviewSidecar): Promise<void> {
  await ensureDir();
  const target = sidecarPath(sidecar.videoId);
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(sidecar));
  await fs.promises.rename(tmp, target);
}

/**
 * Phase 5 v1 sidecars (single-scene hover clips, optional timeline sprite)
 * are migrated on read so timeline functionality is never lost by the Phase
 * 5.1 format change. The old hover is deliberately dropped: its bytes were
 * produced by a different scene-selection/encoding configuration and must
 * not be served as a current montage.
 */
export function isLegacyPreviewSidecar(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    typeof v.videoId === 'number' &&
    typeof v.megaNodeId === 'string' &&
    typeof v.sourceSize === 'number' &&
    (v.status === 'ready' || v.status === 'failed') &&
    typeof v.lastAccessedAt === 'string'
  );
}

/** Read + validate a sidecar; null when absent/corrupt (never throws). */
export async function readSidecar(videoId: number): Promise<PreviewSidecar | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.promises.readFile(sidecarPath(videoId), 'utf8'));
    if (isPreviewSidecar(parsed) && parsed.videoId === videoId) return parsed;
    if (!isLegacyPreviewSidecar(parsed) || (parsed as { videoId?: unknown }).videoId !== videoId) return null;
    const legacy = parsed as unknown as {
      megaNodeId: string;
      sourceSize: number;
      durationSeconds: number | null;
      status: 'ready' | 'failed';
      hover: unknown;
      timeline: PreviewSidecar['timeline'];
      attempts: number;
      lastError: string | null;
      lastAccessedAt: string;
      metrics: PreviewSidecar['metrics'];
    };
    const migrated: PreviewSidecar = {
      version: 2,
      videoId,
      megaNodeId: legacy.megaNodeId,
      sourceSize: legacy.sourceSize,
      durationSeconds: legacy.durationSeconds,
      status: legacy.timeline ? 'ready' : 'failed',
      hover: null,
      timeline: legacy.timeline ?? null,
      attempts: 0,
      lastError: legacy.lastError ?? null,
      failedAt: null,
      lastAccessedAt: legacy.lastAccessedAt,
      metrics: legacy.metrics ?? null,
      generationVersion: previewGenerationVersion(),
    };
    await writeSidecarAtomic(migrated).catch(() => {});
    return migrated;
  } catch {
    return null;
  }
}

/**
 * Content identity: a preview is valid only while the MEGA node and its
 * byte size are unchanged. A re-synced/changed video invalidates the cached
 * assets automatically (the sidecar simply stops matching).
 */
export function identityMatches(
  sidecar: PreviewSidecar,
  identity: { megaNodeId: string; sourceSize: number },
): boolean {
  return sidecar.megaNodeId === identity.megaNodeId && sidecar.sourceSize === identity.sourceSize;
}

export interface RemovedPreviewAssets {
  filesDeleted: number;
  bytesFreed: number;
}

/**
 * Delete every preview asset + sidecar for a video (never throws).
 *
 * Returns the number of files that actually existed and were removed, so
 * administrative reporting (Delete All Previews) never claims to have
 * deleted artifacts that were already absent.
 */
export async function removePreviewAssets(videoId: number): Promise<RemovedPreviewAssets> {
  const targets = [sidecarPath(videoId), clipPath(videoId), spritePath(videoId)];
  const removed = await Promise.all(
    targets.map(async (target) => {
      try {
        const st = await fs.promises.stat(target);
        if (!st.isFile()) return { deleted: false, bytes: 0 };
        await fs.promises.rm(target, { force: true });
        return { deleted: true, bytes: st.size };
      } catch {
        return { deleted: false, bytes: 0 };
      }
    }),
  );
  pendingTouches.delete(videoId);
  // Artifact availability just changed: the dashboard must not keep
  // reporting the previous completed/missing split for a full TTL.
  invalidatePreviewStatsCache();
  return {
    filesDeleted: removed.filter((r) => r.deleted).length,
    bytesFreed: removed.reduce((sum, r) => sum + r.bytes, 0),
  };
}

// ---------------------------------------------------------------------------
// Access tracking (LRU) — mirrors media-cache touch semantics
// ---------------------------------------------------------------------------

const lastTouch = new Map<number, number>();
/**
 * Access timestamps that have not been written to their sidecars yet.
 *
 * `touchPreview()` is called on every meta poll, clip request and VTT
 * request. Rewriting the sidecar each time is unnecessary write
 * amplification (and SSD wear) for a value that only LRU eviction consumes.
 * Instead, remember the newest access in memory; `flushPreviewAccessTimes()`
 * persists it during the periodic eviction/statistics work. Eviction itself
 * reads this map so the in-memory value still drives LRU ordering before it
 * is persisted.
 */
const pendingTouches = new Map<number, number>();

/** Test/diagnostic: is there an access timestamp waiting to be persisted? */
export function pendingPreviewTouchCount(): number {
  return pendingTouches.size;
}

/** Test/diagnostic: the in-memory last-access value for one video. */
export function pendingPreviewTouchAt(videoId: number): number | null {
  return pendingTouches.get(videoId) ?? null;
}

/**
 * Record an access. Memory-only and throttled; never throws, never writes.
 * The timestamp is persisted later by `flushPreviewAccessTimes()` (periodic
 * eviction / stats refresh).
 */
export async function touchPreview(videoId: number): Promise<void> {
  try {
    const now = Date.now();
    if (now - (lastTouch.get(videoId) ?? 0) < previewTouchIntervalMs()) return;
    lastTouch.set(videoId, now);
    pendingTouches.set(videoId, now);
  } catch {
    // best-effort only
  }
}

/**
 * Persist pending access timestamps with atomic sidecar writes. Called by
 * periodic eviction and statistics refresh, so a high-frequency viewer
 * workload produces at most one write per video per flush interval.
 * Returns how many sidecars were actually rewritten.
 */
export async function flushPreviewAccessTimes(): Promise<number> {
  if (pendingTouches.size === 0) return 0;
  const batch = Array.from(pendingTouches.entries());
  let written = 0;
  const CHUNK = 8;
  for (let i = 0; i < batch.length; i += CHUNK) {
    await Promise.all(
      batch.slice(i, i + CHUNK).map(async ([videoId, at]) => {
        try {
          const sidecar = await readSidecar(videoId);
          if (!sidecar) {
            pendingTouches.delete(videoId);
            return;
          }
          const previous = Date.parse(sidecar.lastAccessedAt);
          if (Number.isFinite(previous) && previous >= at) {
            pendingTouches.delete(videoId);
            return;
          }
          sidecar.lastAccessedAt = new Date(at).toISOString();
          await writeSidecarAtomic(sidecar);
          // Only clear when no newer touch arrived while the write was in
          // flight (touchPreview never awaits this function).
          if ((pendingTouches.get(videoId) ?? 0) <= at) pendingTouches.delete(videoId);
          written++;
        } catch {
          // Keep the pending value; the next flush retries it.
        }
      }),
    );
  }
  return written;
}

// ---------------------------------------------------------------------------
// Active-stream protection (refcounted, like trackCacheStream)
// ---------------------------------------------------------------------------

const activeReaders = new Map<number, number>();

/**
 * Mark a preview stream open; call the returned release exactly once when
 * it closes. Eviction skips ids with a positive count so a served clip or
 * spritesheet is never deleted mid-stream.
 */
export function trackPreviewStream(videoId: number): () => void {
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

/** Test/diagnostic hook: current reader count for a video. */
export function activePreviewReaders(videoId: number): number {
  return activeReaders.get(videoId) ?? 0;
}

// ---------------------------------------------------------------------------
// Active generation work-dir registry (P-02)
// ---------------------------------------------------------------------------

/**
 * Work dirs owned by live generation jobs in THIS process. The age-based
 * grace period protects jobs in other processes; this registry additionally
 * makes an in-process cleanup pass unable to touch a running job even if its
 * directory mtime is old (clock skew, long acquisition, tests).
 */
const activeWorkDirs = new Set<string>();

export function registerPreviewWorkDir(dir: string): void {
  activeWorkDirs.add(path.resolve(dir));
}

export function unregisterPreviewWorkDir(dir: string): void {
  activeWorkDirs.delete(path.resolve(dir));
}

/** Test/diagnostic hook. */
export function isPreviewWorkDirActive(dir: string): boolean {
  return activeWorkDirs.has(path.resolve(dir));
}

/** Test hook: reset all in-memory eviction state (unit tests only). */
export function __resetPreviewStoreStateForTests(): void {
  lastTouch.clear();
  pendingTouches.clear();
  activeReaders.clear();
  activeWorkDirs.clear();
}

// ---------------------------------------------------------------------------
// Eviction
// ---------------------------------------------------------------------------

export interface PreviewEvictionResult {
  totalBytes: number;
  maxBytes: number;
  entries: number;
  evicted: number;
  evictedBytes: number;
  reclaimedStale: number;
}

interface PreviewEntry {
  videoId: number;
  size: number;
  lastAccess: number;
  stale: boolean;
}

const CLIP_RE = /^(\d+)\.preview\.mp4$/;
const SPRITE_RE = /^(\d+)\.sprite\.jpg$/;

/**
 * One eviction pass over the preview store: deletes stale entries (sidecar
 * missing/unreadable) then LRU-evicts until under the store budget. Temp
 * files and actively streamed files are never victims. Never throws.
 */
export async function evictPreviewCache(options?: {
  maxBytes?: number;
  now?: number;
}): Promise<PreviewEvictionResult> {
  const maxBytes = options?.maxBytes ?? previewCacheMaxBytes();
  const now = options?.now ?? Date.now();
  const graceMs = previewEvictionGraceMs();
  const empty: PreviewEvictionResult = {
    totalBytes: 0,
    maxBytes,
    entries: 0,
    evicted: 0,
    evictedBytes: 0,
    reclaimedStale: 0,
  };
  let names: string[];
  try {
    names = await fs.promises.readdir(previewsDir());
  } catch {
    return empty;
  }
  const idsWithAssets = new Set<number>();
  for (const name of names) {
    const m = CLIP_RE.exec(name) ?? SPRITE_RE.exec(name);
    if (m) idsWithAssets.add(Number(m[1]));
  }
  const entries: PreviewEntry[] = [];
  let totalBytes = 0;
  for (const videoId of idsWithAssets) {
    let size = 0;
    try {
      const st = await fs.promises.stat(clipPath(videoId));
      if (st.isFile() && st.size > 0) size += st.size;
    } catch {
      // no clip
    }
    try {
      const st = await fs.promises.stat(spritePath(videoId));
      if (st.isFile() && st.size > 0) size += st.size;
    } catch {
      // no sprite
    }
    if (size <= 0) continue;
    totalBytes += size;
    let lastAccess = pendingTouches.get(videoId) ?? 0;
    let stale = false;
    const sidecar = await readSidecar(videoId);
    if (!sidecar) {
      stale = true;
    } else {
      const t = Date.parse(sidecar.lastAccessedAt);
      // The in-memory touch is newer than the persisted sidecar until the
      // flush below; LRU must consider it so a frequently played preview is
      // not evicted just because its last write is amortized.
      if (Number.isFinite(t)) lastAccess = Math.max(lastAccess, t);
    }
    if (lastAccess === 0) lastAccess = now; // unreadable timestamp -> newest
    entries.push({ videoId, size, lastAccess, stale });
  }
  const result: PreviewEvictionResult = { ...empty, totalBytes, entries: entries.length };
  if (result.totalBytes <= maxBytes && !entries.some((e) => e.stale)) {
    await flushPreviewAccessTimes();
    return result;
  }
  const deletable = (e: PreviewEntry): boolean => {
    if ((activeReaders.get(e.videoId) ?? 0) > 0) return false;
    if (e.stale) return true; // unservable: reclaim immediately
    return now - e.lastAccess >= graceMs;
  };
  const victims = entries
    .filter(deletable)
    .sort((a, b) => Number(b.stale) - Number(a.stale) || a.lastAccess - b.lastAccess);
  for (const v of victims) {
    if (!v.stale && result.totalBytes <= maxBytes) break;
    try {
      await removePreviewAssets(v.videoId);
      result.evicted++;
      result.evictedBytes += v.size;
      result.totalBytes -= v.size;
      if (v.stale) result.reclaimedStale++;
    } catch {
      // raced deletion - leave
    }
  }
  // Persist what remains after the eviction pass (bounded, periodic).
  await flushPreviewAccessTimes();
  return result;
}

// ---------------------------------------------------------------------------
// Failed/unpublished artifact cleanup (Phase A / P-02)
// ---------------------------------------------------------------------------

export interface PreviewArtifactCleanupResult {
  /** Directory entries inspected in this bounded pass. */
  scannedEntries: number;
  removedWorkDirs: number;
  removedTempFiles: number;
  removedOrphanClips: number;
  removedOrphanSprites: number;
  skippedActive: number;
  skippedRecent: number;
  /** Per-entry failures are counted and swallowed; cleanup never throws. */
  failures: number;
}

export interface PreviewArtifactCleanupOptions {
  now?: number;
  graceMs?: number;
  maxEntries?: number;
  /** Restrict the pass to these video ids (targeted post-failure cleanup). */
  videoIds?: number[];
  /** Test hook: inject a failing/observable remover. */
  remove?: (target: string, options: { recursive?: boolean; force?: boolean }) => Promise<void>;
}

const WORK_DIR_RE = /^(\d+)\.tmp-/;
/** `<id>.<name>.<pid>.tmp` left by an interrupted atomic write/rename. */
const ATOMIC_TMP_RE = /^(\d+)\..+\.tmp$/;
const CLEANUP_CLIP_RE = /^(\d+)\.preview\.mp4$/;
const CLEANUP_SPRITE_RE = /^(\d+)\.sprite\.jpg$/;

interface FileStat {
  size: number;
  mtimeMs: number;
}

async function statFileOrNull(absPath: string): Promise<FileStat | null> {
  try {
    const st = await fs.promises.stat(absPath);
    return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

/**
 * Reclaim artifacts that can never be served and temporary files left by
 * failed, aborted or killed generation jobs.
 *
 * Safety rules:
 *  - only names matching the known preview patterns in `data/previews/` are
 *    considered; nothing outside that directory is scanned or deleted;
 *  - a conservative age grace (default 30 min > the 10 min job deadline)
 *    protects live workers in other processes; live work dirs in this
 *    process are additionally skipped by registry;
 *  - published clips are deleted only when the sidecar says they cannot be
 *    served (missing/failed/old hover), never when a current ready hover
 *    sidecar references them;
 *  - sprites referenced by a timeline sidecar are preserved even when hover
 *    generation failed;
 *  - active preview streams are skipped by the existing refcount;
 *  - sidecars are never deleted here (only interrupted `.tmp` writes), so
 *    failure diagnostics and valid timeline metadata survive.
 *
 * The pass is bounded, idempotent, and never throws.
 */
export async function cleanupFailedPreviewArtifacts(
  options: PreviewArtifactCleanupOptions = {},
): Promise<PreviewArtifactCleanupResult> {
  const now = options.now ?? Date.now();
  const graceMs = options.graceMs ?? previewArtifactCleanupGraceMs();
  const cutoff = now - graceMs;
  const maxEntries = options.maxEntries ?? previewArtifactCleanupMaxEntries();
  const videoFilter = options.videoIds ? new Set(options.videoIds) : null;
  const remove =
    options.remove ?? ((target: string, removeOptions: { recursive?: boolean; force?: boolean }) =>
      fs.promises.rm(target, removeOptions));
  const result: PreviewArtifactCleanupResult = {
    scannedEntries: 0,
    removedWorkDirs: 0,
    removedTempFiles: 0,
    removedOrphanClips: 0,
    removedOrphanSprites: 0,
    skippedActive: 0,
    skippedRecent: 0,
    failures: 0,
  };

  let names: string[];
  try {
    names = await fs.promises.readdir(previewsDir());
  } catch {
    return result;
  }

  // Bounded even if someone drops thousands of unrelated files in the dir.
  names.sort();
  if (names.length > maxEntries) names = names.slice(0, maxEntries);
  result.scannedEntries = names.length;

  const assetIds = new Set<number>();
  for (const name of names) {
    const workDirMatch = WORK_DIR_RE.exec(name);
    if (workDirMatch) {
      const videoId = Number(workDirMatch[1]);
      if (videoFilter && !videoFilter.has(videoId)) continue;
      const abs = path.join(previewsDir(), name);
      if (activeWorkDirs.has(path.resolve(abs))) {
        result.skippedActive++;
        continue;
      }
      try {
        const st = await fs.promises.stat(abs);
        if (!st.isDirectory()) continue;
        if (st.mtimeMs > cutoff) {
          result.skippedRecent++;
          continue;
        }
        await remove(abs, { recursive: true, force: true });
        result.removedWorkDirs++;
      } catch {
        result.failures++;
      }
      continue;
    }

    const tmpMatch = ATOMIC_TMP_RE.exec(name);
    if (tmpMatch) {
      const videoId = Number(tmpMatch[1]);
      if (videoFilter && !videoFilter.has(videoId)) continue;
      const abs = path.join(previewsDir(), name);
      try {
        const st = await fs.promises.stat(abs);
        if (!st.isFile() || st.mtimeMs > cutoff) {
          result.skippedRecent++;
          continue;
        }
        await remove(abs, { force: true });
        result.removedTempFiles++;
      } catch {
        result.failures++;
      }
      continue;
    }

    const assetMatch = CLEANUP_CLIP_RE.exec(name) ?? CLEANUP_SPRITE_RE.exec(name);
    if (assetMatch) {
      const videoId = Number(assetMatch[1]);
      if (videoFilter && !videoFilter.has(videoId)) continue;
      assetIds.add(videoId);
    }
  }

  for (const videoId of assetIds) {
    if ((activeReaders.get(videoId) ?? 0) > 0) {
      // A clip/sprite is being streamed right now; never unlink it.
      result.skippedActive++;
      continue;
    }

    const sidecar = await readSidecar(videoId).catch(() => null);
    const version = previewGenerationVersion();
    const versionCurrent = sidecar !== null && sidecar.generationVersion === version;
    const clip = await statFileOrNull(clipPath(videoId));
    const sprite = await statFileOrNull(spritePath(videoId));

    const clipUnservable =
      clip !== null &&
      (!sidecar || !versionCurrent || sidecar.status !== 'ready' || !sidecar.hover);
    if (clipUnservable) {
      if (clip.mtimeMs > cutoff) {
        result.skippedRecent++;
      } else {
        try {
          await remove(clipPath(videoId), { force: true });
          result.removedOrphanClips++;
        } catch {
          result.failures++;
        }
      }
    }

    const spriteUnservable = sprite !== null && (!sidecar || !versionCurrent || !sidecar.timeline);
    if (spriteUnservable) {
      if (sprite.mtimeMs > cutoff) {
        result.skippedRecent++;
      } else {
        try {
          await remove(spritePath(videoId), { force: true });
          result.removedOrphanSprites++;
        } catch {
          result.failures++;
        }
      }
    }
  }

  if (
    result.removedWorkDirs > 0 ||
    result.removedTempFiles > 0 ||
    result.removedOrphanClips > 0 ||
    result.removedOrphanSprites > 0
  ) {
    console.log(
      `[preview] artifact cleanup: ${result.removedWorkDirs} work dir(s), ` +
        `${result.removedTempFiles} temp file(s), ${result.removedOrphanClips} unservable clip(s), ` +
        `${result.removedOrphanSprites} orphan sprite(s)`,
    );
  }
  if (result.failures > 0) {
    console.warn(`[preview] artifact cleanup had ${result.failures} recoverable failure(s)`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Background scheduling (amortized; mirrors startMediaCacheMaintenance)
// ---------------------------------------------------------------------------

let maintenanceTimer: ReturnType<typeof setInterval> | null = null;
let evictInFlight = false;

export function maybeEvictPreviewCache(): void {
  if (evictInFlight) return;
  evictInFlight = true;
  // P-02: reclaim failed/unpublished artifacts before the LRU pass. Both
  // operations are bounded and never throw; a cleanup failure must not stop
  // eviction, and neither runs in the queue worker's critical path.
  cleanupFailedPreviewArtifacts()
    .catch(() => {})
    .then(() => evictPreviewCache())
    .then((r) => {
      if (r.evicted > 0) {
        console.log(
          `[preview] cache eviction: ${r.evicted} entr${r.evicted === 1 ? 'y' : 'ies'} ` +
            `(${(r.evictedBytes / 1048576).toFixed(1)} MB), ${(r.totalBytes / 1048576).toFixed(1)} MB remain`,
        );
      }
    })
    .catch(() => {})
    .finally(() => {
      evictInFlight = false;
    });
}

/** Start periodic eviction (once per server process; safe to call repeatedly). */
export function startPreviewMaintenance(): void {
  if (maintenanceTimer) return;
  const firstDelay = 90_000;
  const timer = setTimeout(() => {
    maybeEvictPreviewCache();
  }, firstDelay);
  if (typeof (timer as unknown as { unref?: unknown }).unref === 'function') {
    (timer as unknown as { unref(): void }).unref();
  }
  const interval = setInterval(() => {
    maybeEvictPreviewCache();
  }, previewEvictionIntervalMs());
  if (typeof (interval as unknown as { unref?: unknown }).unref === 'function') {
    (interval as unknown as { unref(): void }).unref();
  }
  maintenanceTimer = interval;
}

/** Stop periodic eviction (unit tests). */
export function stopPreviewMaintenance(): void {
  if (maintenanceTimer) {
    clearInterval(maintenanceTimer);
    maintenanceTimer = null;
  }
}

/** Read-only store statistics (diagnostics; never mutates). */
export interface PreviewStoreStats {
  dir: string;
  entries: number;
  entryBytes: number;
  maxBytes: number;
}

export async function previewStoreStats(): Promise<PreviewStoreStats> {
  const stats: PreviewStoreStats = {
    dir: previewsDir(),
    entries: 0,
    entryBytes: 0,
    maxBytes: previewCacheMaxBytes(),
  };
  let names: string[];
  try {
    names = await fs.promises.readdir(previewsDir());
  } catch {
    return stats;
  }
  for (const name of names) {
    const m = CLIP_RE.exec(name) ?? SPRITE_RE.exec(name);
    if (!m) continue;
    try {
      const st = await fs.promises.stat(path.join(previewsDir(), name));
      if (st.isFile() && st.size > 0) {
        stats.entryBytes += st.size;
        if (CLIP_RE.test(name)) stats.entries++;
      }
    } catch {
      // raced deletion
    }
  }
  return stats;
}
