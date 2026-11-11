/**
 * Phase 5 preview system: env-tunable bounds.
 *
 * Every limit is env-overridable so ops can tune without code changes, and
 * every default is chosen so preview work can never starve normal playback
 * (see docs/PHASE-5-PREVIEW-DESIGN.md §9).
 */

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

/** Target hover clip length in seconds (spec: ~5–10 s). */
export function previewClipSeconds(): number {
  return numEnv('PREVIEW_CLIP_SECONDS', 8, 3, 15);
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
  return Math.floor(numEnv('PREVIEW_EVICTION_GRACE_MS', 60_000, 0, 3600_000));
}

/** Kill switch: meta answers `unavailable (disabled)` without any work. */
export function previewDisabled(): boolean {
  return process.env.PREVIEW_DISABLED === '1';
}
