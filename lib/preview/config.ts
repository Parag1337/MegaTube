/**
 * Phase 5 preview system: env-tunable bounds.
 *
 * Every limit is env-overridable so ops can tune without code changes, and
 * every default is chosen so preview work can never starve normal playback
 * (see docs/PHASE-5-PREVIEW-DESIGN.md §9).
 */

import crypto from 'node:crypto';

function numEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(raw, min), max);
}

function bytesEnv(name: string, fallback: number): number {
  const raw = process.env[name];
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

/** Total disk budget for data/previews (LRU-evicted beyond this). */
export function previewCacheMaxBytes(): number {
  return bytesEnv('PREVIEW_CACHE_MAX_BYTES', 512 * 1024 * 1024);
}

/** Max simultaneously RUNNING generation jobs (each = 1 ffmpeg + ≤1 window). */
export function previewMaxConcurrent(): number {
  return Math.floor(numEnv('PREVIEW_MAX_CONCURRENT', 1, 1, 4));
}

/** Max queued-but-not-started jobs; beyond this meta answers `rejected`. */
export function previewMaxQueue(): number {
  return Math.floor(numEnv('PREVIEW_MAX_QUEUE', 8, 0, 64));
}

/** Max ciphertext bytes fetched from MEGA per hover-preview window. */
export function previewSourceMaxBytes(): number {
  return bytesEnv('PREVIEW_SOURCE_MAX_BYTES', 24 * 1024 * 1024);
}

/** Max bytes spent fetching the MP4 moov atom (head or tail). */
export function previewMoovMaxBytes(): number {
  return bytesEnv('PREVIEW_MOOV_MAX_BYTES', 4 * 1024 * 1024);
}

/** Target hover clip length in seconds (legacy single-scene fallback). */
export function previewClipSeconds(): number {
  return numEnv('PREVIEW_CLIP_SECONDS', 8, 3, 15);
}

// ---------------------------------------------------------------------------
// Phase 5.1: multi-scene montage generation (card previews)
// ---------------------------------------------------------------------------

/** Number of representative scenes in one card montage (before short-video
 * reduction). 5 scenes × 1.2 s ≈ 6 s, matching the 5–7 s target. */
export function previewSceneCount(): number {
  return Math.floor(numEnv('PREVIEW_SCENE_COUNT', 5, 1, 6));
}

/** Target duration of one scene in the montage (seconds). */
export function previewSceneSeconds(): number {
  return numEnv('PREVIEW_SCENE_SECONDS', 1.2, 0.6, 1.6);
}

/** Hard cap for the combined montage file (LRU integrity bound). */
export function previewMontageMaxFileBytes(): number {
  return bytesEnv('PREVIEW_MONTAGE_MAX_FILE_BYTES', 2 * 1024 * 1024);
}

/** Total MEGA ciphertext budget for one montage generation run. */
export function previewMontageSourceBudgetBytes(): number {
  return bytesEnv('PREVIEW_MONTAGE_SOURCE_BUDGET_BYTES', 48 * 1024 * 1024);
}

/** Per-range MEGA ciphertext cap (keeps high-bitrate sources bounded). */
export function previewMontageWindowMaxBytes(): number {
  return bytesEnv('PREVIEW_MONTAGE_WINDOW_MAX_BYTES', 12 * 1024 * 1024);
}

/** Maximum merged MEGA range requests per montage run. */
export function previewMontageMaxRanges(): number {
  return Math.floor(numEnv('PREVIEW_MONTAGE_MAX_RANGES', 6, 1, 10));
}

/** Brightness/duplicate alternatives tried around an unsuitable scene. */
export function previewSceneAlternatives(): number {
  return Math.floor(numEnv('PREVIEW_SCENE_ALTERNATIVES', 2, 0, 4));
}

/** Target H.264 average bitrate (Kbps) for the montage. */
export function previewVideoBitrateKbps(): number {
  return Math.floor(numEnv('PREVIEW_VIDEO_BITRATE_KBPS', 450, 200, 1200));
}

/** Output frame-rate cap (never up-converts a lower-fps source). */
export function previewFpsCap(): number {
  return numEnv('PREVIEW_FPS_CAP', 24, 10, 30);
}

/** Durable worker: attempts per job before terminal failure. */
export function previewJobMaxAttempts(): number {
  return Math.floor(numEnv('PREVIEW_JOB_MAX_ATTEMPTS', 3, 1, 6));
}

/** Worker lease duration; heartbeats renew it while ffmpeg/MEGA work runs. */
export function previewJobLeaseMs(): number {
  return Math.floor(numEnv('PREVIEW_JOB_LEASE_MS', 180_000, 30_000, 30 * 60_000));
}

export function previewJobHeartbeatMs(): number {
  return Math.floor(numEnv('PREVIEW_JOB_HEARTBEAT_MS', 30_000, 5_000, 5 * 60_000));
}

/** Idle worker poll interval. */
export function previewJobPollMs(): number {
  return Math.floor(numEnv('PREVIEW_JOB_POLL_MS', 3_000, 500, 60_000));
}

/** Bounded exponential retry delay. */
export function previewJobRetryBaseMs(): number {
  return Math.floor(numEnv('PREVIEW_JOB_RETRY_BASE_MS', 60_000, 1_000, 10 * 60_000));
}

export function previewJobRetryMaxMs(): number {
  return Math.floor(numEnv('PREVIEW_JOB_RETRY_MAX_MS', 30 * 60_000, 10_000, 24 * 3600_000));
}

/** Priorities (higher wins): hover > manual bulk > sync. */
export function previewPriorityHover(): number {
  return Math.floor(numEnv('PREVIEW_PRIORITY_HOVER', 100, 0, 1000));
}
export function previewPriorityManual(): number {
  return Math.floor(numEnv('PREVIEW_PRIORITY_MANUAL', 50, 0, 1000));
}
export function previewPrioritySync(): number {
  return Math.floor(numEnv('PREVIEW_PRIORITY_SYNC', 10, 0, 1000));
}

/** Stop enqueueing sync/manual work while the durable backlog is huge. */
export function previewBacklogMaxJobs(): number {
  return Math.floor(numEnv('PREVIEW_BACKLOG_MAX_JOBS', 5000, 100, 100_000));
}

/** Worker kill switch (generation still enqueues; nothing runs). */
export function previewWorkerDisabled(): boolean {
  const raw = process.env.PREVIEW_WORKER_DISABLED;
  return raw === '1';
}

export interface PreviewGenerationConfig {
  version: string;
  sceneCount: number;
  sceneSeconds: number;
  bitrateKbps: number;
  fpsCap: number;
  maxWidthLandscape: number;
  maxHeightLandscape: number;
  maxWidthPortrait: number;
  maxHeightPortrait: number;
}

/**
 * Fingerprint of everything that changes the generated bytes. Stored on
 * every sidecar and job. Bumping it (or changing an env value) makes old
 * artifacts stale without touching unrelated previews.
 */
export function previewGenerationConfig(): PreviewGenerationConfig {
  const parts = {
    schema: 'p51-montage-v1',
    sceneCount: previewSceneCount(),
    sceneSeconds: previewSceneSeconds(),
    bitrateKbps: previewVideoBitrateKbps(),
    fpsCap: previewFpsCap(),
  };
  // Deterministic short hash (no secrets involved). Kept in this module so
  // both the service and the durable job store compute the same identity.
  const digest = crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 10);
  return {
    version: `p51-${digest}`,
    sceneCount: previewSceneCount(),
    sceneSeconds: previewSceneSeconds(),
    bitrateKbps: previewVideoBitrateKbps(),
    fpsCap: previewFpsCap(),
    maxWidthLandscape: 640,
    maxHeightLandscape: 360,
    maxWidthPortrait: 360,
    maxHeightPortrait: 640,
  };
}

export function previewGenerationVersion(): string {
  return previewGenerationConfig().version;
}

/** Minimum decodable clip length for an attempt to count as usable. */
export function previewClipMinSeconds(): number {
  return numEnv('PREVIEW_CLIP_MIN_SECONDS', 4, 1, 15);
}

/** Hard cap on the finished clip file (LRU-evicted store integrity). */
export function previewClipMaxFileBytes(): number {
  return bytesEnv('PREVIEW_CLIP_MAX_FILE_BYTES', 3 * 1024 * 1024);
}

/** Preview clip height (width follows the source aspect). */
export function previewClipHeight(): number {
  return Math.floor(numEnv('PREVIEW_CLIP_HEIGHT', 360, 144, 720));
}

/** Max generation attempts per video before the failure cooldown. */
export function previewMaxAttempts(): number {
  return Math.floor(numEnv('PREVIEW_MAX_ATTEMPTS', 2, 1, 5));
}

/** Cooldown after exhausting attempts (no MEGA/ffmpeg work during it). */
export function previewFailureCooldownMs(): number {
  return Math.floor(numEnv('PREVIEW_FAILURE_COOLDOWN_MS', 30 * 60_000, 0, 24 * 3600_000));
}

/** Per-ffmpeg-invocation timeout (SIGKILL). */
export function previewFfmpegTimeoutMs(): number {
  return Math.floor(numEnv('PREVIEW_FFMPEG_TIMEOUT_MS', 90_000, 5_000, 15 * 60_000));
}

/** Heap admission gate: refuse new jobs above this fraction of total RAM. */
export function previewMaxHeapRatio(): number {
  return numEnv('PREVIEW_MAX_HEAP_RATIO', 0.85, 0.1, 1);
}

/** Spritesheet tile size / grid bounds. */
export function previewSpriteTileW(): number {
  return Math.floor(numEnv('PREVIEW_SPRITE_TILE_W', 160, 80, 480));
}
export function previewSpriteCols(): number {
  return Math.floor(numEnv('PREVIEW_SPRITE_COLS', 10, 2, 20));
}
export function previewSpriteMaxTiles(): number {
  return Math.floor(numEnv('PREVIEW_SPRITE_MAX_TILES', 100, 4, 400));
}
export function previewSpriteMinIntervalSec(): number {
  return numEnv('PREVIEW_SPRITE_MIN_INTERVAL_SEC', 4, 1, 60);
}

/** Eviction knobs (mirrors lib/media/cache.ts patterns). */
export function previewEvictionIntervalMs(): number {
  return Math.floor(numEnv('PREVIEW_EVICTION_INTERVAL_MS', 10 * 60_000, 1_000, 24 * 3600_000));
}
export function previewTouchIntervalMs(): number {
  return Math.floor(numEnv('PREVIEW_TOUCH_INTERVAL_MS', 60_000, 0, 3600_000));
}
export function previewEvictionGraceMs(): number {
  // Phase 5.1: a bulk backlog publishes many artifacts in a row. Keep fresh
  // publishes out of the victim set long enough that LRU churn only touches
  // genuinely older previews while the backlog runs.
  return Math.floor(numEnv('PREVIEW_EVICTION_GRACE_MS', 10 * 60_000, 0, 24 * 3600_000));
}

/** Kill switch: meta answers `unavailable (disabled)` without any work. */
export function previewDisabled(): boolean {
  return process.env.PREVIEW_DISABLED === '1';
}
