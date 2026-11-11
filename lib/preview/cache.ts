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
  previewCacheMaxBytes,
  previewEvictionGraceMs,
  previewEvictionIntervalMs,
  previewTouchIntervalMs,
} from './config';
import { isPreviewSidecar, type PreviewSidecar } from './types';

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

/** Read + validate a sidecar; null when absent/corrupt (never throws). */
export async function readSidecar(videoId: number): Promise<PreviewSidecar | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.promises.readFile(sidecarPath(videoId), 'utf8'));
    if (!isPreviewSidecar(parsed) || parsed.videoId !== videoId) return null;
    return parsed;
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

/** Delete every preview asset + sidecar for a video (never throws). */
export async function removePreviewAssets(videoId: number): Promise<void> {
  await Promise.all([
    fs.promises.rm(sidecarPath(videoId), { force: true }),
    fs.promises.rm(clipPath(videoId), { force: true }),
    fs.promises.rm(spritePath(videoId), { force: true }),
  ]);
}

// ---------------------------------------------------------------------------
// Access tracking (LRU) — mirrors media-cache touch semantics
// ---------------------------------------------------------------------------

const lastTouch = new Map<number, number>();

/** Throttled, fire-and-forget access recording; never throws. */
export async function touchPreview(videoId: number): Promise<void> {
  try {
    const now = Date.now();
    if (now - (lastTouch.get(videoId) ?? 0) < previewTouchIntervalMs()) return;
    lastTouch.set(videoId, now);
    const sidecar = await readSidecar(videoId);
    if (!sidecar) return;
    sidecar.lastAccessedAt = new Date(now).toISOString();
    await writeSidecarAtomic(sidecar);
  } catch {
    // best-effort only
  }
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

/** Test hook: reset all in-memory eviction state (unit tests only). */
export function __resetPreviewStoreStateForTests(): void {
  lastTouch.clear();
  activeReaders.clear();
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
    let lastAccess = now; // no sidecar -> newest (deleted below as stale)
    let stale = false;
    const sidecar = await readSidecar(videoId);
    if (!sidecar) {
      stale = true;
    } else {
      const t = Date.parse(sidecar.lastAccessedAt);
      if (Number.isFinite(t)) lastAccess = t;
    }
    entries.push({ videoId, size, lastAccess, stale });
  }
  const result: PreviewEvictionResult = { ...empty, totalBytes, entries: entries.length };
  if (result.totalBytes <= maxBytes && !entries.some((e) => e.stale)) return result;
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
  evictPreviewCache()
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
