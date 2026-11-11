/**
 * Phase 5 preview system: shared types.
 *
 * The disk sidecar (`data/previews/<id>.json`) is the single source of truth
 * for preview state; it is validated on every read and written atomically
 * (tmp + rename), mirroring the remux-cache sidecar conventions.
 */

export type PreviewAssetStatus = 'ready' | 'failed';

export interface HoverPreviewInfo {
  /** Timeline position (seconds) the representative segment starts at. */
  startSec: number;
  /** Actual clip length in seconds (≤ configured target). */
  durationSec: number;
  width: number;
  height: number;
  bytes: number;
  /** True when the position came from the fixed ladder (unknown duration). */
  estimated: boolean;
}

export interface TimelinePreviewInfo {
  tileW: number;
  tileH: number;
  cols: number;
  rows: number;
  /** Seconds between sprite cells (interval). */
  intervalSec: number;
  /** Usable cells (rows×cols grid may have blank padding cells). */
  count: number;
}

export interface PreviewMetrics {
  /** MEGA bytes consumed by the winning generation run. */
  transferBytes: number;
  /** Total ffmpeg wall-clock ms across the run. */
  ffmpegMs: number;
  generatedAt: string;
}

export interface PreviewSidecar {
  version: 1;
  videoId: number;
  megaNodeId: string;
  sourceSize: number;
  durationSeconds: number | null;
  status: PreviewAssetStatus;
  hover: HoverPreviewInfo | null;
  timeline: TimelinePreviewInfo | null;
  attempts: number;
  lastError: string | null;
  /** Cooldown anchor: no retry before this + PREVIEW_FAILURE_COOLDOWN_MS. */
  failedAt: string | null;
  lastAccessedAt: string;
  metrics: PreviewMetrics | null;
}

/** What the meta endpoint reports per requested asset. */
export type AssetReportStatus = 'ready' | 'generating' | 'queued' | 'unavailable' | 'rejected';

export interface MetaResponse {
  videoId: number;
  /** Hover-centric status: what a video card should do right now. */
  status: AssetReportStatus;
  hover: {
    url: string;
    startSec: number;
    durationSec: number;
    width: number;
    height: number;
    estimated: boolean;
  } | null;
  timeline: {
    status: AssetReportStatus;
    vtt: string | null;
    sprite: string | null;
    intervalSec: number | null;
    count: number | null;
    /** Human-readable reason when status is 'unavailable'. */
    reason: string | null;
  } | null;
}

/** One owned, playable video row (the only data generation is allowed to see). */
export interface OwnedVideo {
  id: number;
  megaNodeId: string;
  mimeType: string | null;
  fileSize: number | null;
  duration: number | null;
  mp4Faststart: boolean | null;
  megaAccountId: number;
  encryptedSession: string;
}

/** Validated sidecar shape (defensive: disk bytes are never trusted). */
export function isPreviewSidecar(value: unknown): value is PreviewSidecar {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return false;
  if (typeof v.videoId !== 'number' || !Number.isInteger(v.videoId) || v.videoId <= 0) return false;
  if (typeof v.megaNodeId !== 'string' || v.megaNodeId.length === 0) return false;
  if (typeof v.sourceSize !== 'number' || !Number.isInteger(v.sourceSize) || v.sourceSize <= 0) return false;
  if (v.durationSeconds !== null && (typeof v.durationSeconds !== 'number' || v.durationSeconds <= 0)) return false;
  if (v.status !== 'ready' && v.status !== 'failed') return false;
  if (typeof v.attempts !== 'number' || !Number.isInteger(v.attempts) || v.attempts < 0) return false;
  if (typeof v.lastAccessedAt !== 'string') return false;
  return true;
}
