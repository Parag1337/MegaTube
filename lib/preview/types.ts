/**
 * Phase 5.1 preview system: shared types.
 *
 * The disk sidecar (`data/previews/<id>.json`) is the source of truth for
 * the generated artifact; PostgreSQL job rows are the durable backlog.
 * Every sidecar carries the generation-version fingerprint, so changing the
 * montage/encoding rules makes old artifacts stale without touching other
 * videos. Writes are atomic (tmp + rename) like the remux-cache sidecars.
 */

export type PreviewAssetStatus = 'ready' | 'failed';

/** One representative segment inside the combined card montage. */
export interface HoverScene {
  /** Absolute timeline position of the scene start in the source. */
  startSec: number;
  /** Played duration of this scene in the montage. */
  durationSec: number;
  /** Actual input seek used for extraction (keyframe-aware). */
  sourceSeekSec: number;
  /** True when this scene's position is estimated (no reliable timeline). */
  estimated?: boolean;
  /** File-relative selection used for unknown-duration sources. */
  byteFraction?: number | null;
}

export interface HoverPreviewInfo {
  /** First scene start (kept for older clients/diagnostics). */
  startSec: number;
  /** Total montage length in seconds (≤ configured target). */
  durationSec: number;
  width: number;
  height: number;
  bytes: number;
  /** True when at least one position came from the unknown-duration ladder. */
  estimated: boolean;
  /** Generation configuration fingerprint that produced this artifact. */
  generationVersion?: string;
  /** Scenes in playback order. */
  scenes?: HoverScene[];
  /** True when the output MP4 has moov before mdat. */
  faststart?: boolean;
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
  /** MEGA ciphertext bytes consumed by the winning generation run. */
  transferBytes: number;
  /** Total ffmpeg wall-clock ms across the run (probes + encode). */
  ffmpegMs: number;
  /** Bounded MEGA acquisition wall-clock ms (0 for warm/local sources). */
  acquisitionMs?: number;
  /** End-to-end generation wall-clock ms. */
  totalMs?: number;
  /** Source strategy used for the winning run. */
  sourceKind?: string;
  generatedAt: string;
}

export interface PreviewSidecar {
  version: 2;
  videoId: number;
  megaNodeId: string;
  sourceSize: number;
  durationSeconds: number | null;
  /** Ready when either the hover montage or the timeline sprite is usable. */
  status: PreviewAssetStatus;
  hover: HoverPreviewInfo | null;
  timeline: TimelinePreviewInfo | null;
  attempts: number;
  lastError: string | null;
  /** Cooldown anchor: no retry before this + PREVIEW_FAILURE_COOLDOWN_MS. */
  failedAt: string | null;
  lastAccessedAt: string;
  metrics: PreviewMetrics | null;
  /** Set for both hover and timeline writes; required for current artifacts. */
  generationVersion: string;
}

/** What the meta endpoint reports per requested asset. */
export type AssetReportStatus =
  | 'ready'
  | 'pending'
  | 'queued'
  | 'generating'
  | 'failed'
  | 'unsupported'
  | 'unavailable'
  | 'rejected';

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
    scenes?: HoverScene[];
  } | null;
  /** Sanitized failure classification; never contains source URLs. */
  errorCode: string | null;
  /** Short human-readable status label (safe to log/show). */
  reason: string | null;
  timeline: {
    status: AssetReportStatus;
    vtt: string | null;
    sprite: string | null;
    intervalSec: number | null;
    count: number | null;
    /** Human-readable reason when status is not ready. */
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
  if (v.version !== 2) return false;
  if (typeof v.videoId !== 'number' || !Number.isInteger(v.videoId) || v.videoId <= 0) return false;
  if (typeof v.megaNodeId !== 'string' || v.megaNodeId.length === 0) return false;
  if (typeof v.sourceSize !== 'number' || !Number.isInteger(v.sourceSize) || v.sourceSize <= 0) return false;
  if (typeof v.generationVersion !== 'string' || v.generationVersion.length === 0) return false;
  if (v.durationSeconds !== null && (typeof v.durationSeconds !== 'number' || v.durationSeconds <= 0)) return false;
  if (v.status !== 'ready' && v.status !== 'failed') return false;
  if (typeof v.attempts !== 'number' || !Number.isInteger(v.attempts) || v.attempts < 0) return false;
  if (typeof v.lastAccessedAt !== 'string') return false;
  return true;
}
