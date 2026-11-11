/**
 * Phase 5 preview system: pure segment/window math.
 *
 * Everything here is deterministic and side-effect free so the segment
 * selection strategy can be pinned by unit tests without any I/O, crypto or
 * ffmpeg. The strategy (design doc §3):
 *
 *  - representative positions at 25 % / 50 % / 75 % of the KNOWN duration,
 *    never inside the first 10 % (intro/black-lead-in zone);
 *  - a fixed fallback ladder (10 s / 30 s / 60 s) when the duration is
 *    unknown, flagged `estimated` end-to-end;
 *  - byte windows aligned to 752 bytes for MPEG-TS (188 × 4 satisfies BOTH
 *    the TS packet grid and MEGA's 16-byte CTR alignment — the same trick as
 *    remux.ts `pcrTailStart`) and to 16 bytes for MP4 sparse windows;
 *  - window sizes sized from the source bitrate with a safety margin and
 *    hard-clamped to PREVIEW_SOURCE_MAX_BYTES.
 */

/**
 * Common alignment for a TS window start: divisible by 188 (TS packets) AND
 * by 16 (MEGA CTR decryption offset requirement).
 */
export const TS_WINDOW_ALIGN = 752;

export function alignDown(n: number, align: number): number {
  return n - (n % align);
}

export interface SegmentCandidate {
  /** Timeline position in seconds. */
  t: number;
  /** True when the position came from the unknown-duration ladder. */
  estimated: boolean;
}

/**
 * Candidate segment positions, in preference order. Positions are clamped so
 * a full clip still fits before the end of the video, and deduplicated.
 */
export function candidatePositions(
  durationSec: number | null,
  clipSeconds: number,
): SegmentCandidate[] {
  const clip = Math.max(1, clipSeconds);
  if (typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec > 0) {
    const lastStart = Math.max(0, durationSec - clip - 1);
    const raw = [0.25, 0.5, 0.75].map((f) => Math.min(Math.round(durationSec * f), lastStart));
    const out: SegmentCandidate[] = [];
    for (const t of raw) {
      const clamped = Math.max(0, t);
      if (!out.some((c) => c.t === clamped)) out.push({ t: clamped, estimated: false });
    }
    return out;
  }
  // Unknown duration: fixed ladder, estimated. Later positions win over the
  // classic intro zone; the ladder is bounded (3 attempts like the known case).
  const ladder = [10, 30, 60];
  const out: SegmentCandidate[] = [];
  for (const t of ladder) {
    if (!out.some((c) => c.t === t)) out.push({ t, estimated: true });
  }
  return out;
}

export interface ByteWindow {
  /** Absolute ciphertext start offset (aligned per the source type). */
  byteStart: number;
  /** Window length in bytes (≤ sourceSize - byteStart). */
  byteLen: number;
}

/**
 * Byte window for one candidate on a given source.
 *
 * `coverageSeconds` is how much source content the window should ideally
 * contain (clip + keyframe-skip margin), `safetyFactor` covers bitrate
 * variance, and the result is clamped to [min(2 MB, source), maxBytes] and to
 * the actual file size. For MPEG-TS the window start also honours the 752
 * alignment; callers pass align=16 for MP4 sparse windows.
 */
export function byteWindowFor(
  t: number,
  durationSec: number | null,
  sourceSize: number,
  maxBytes: number,
  align: number,
  coverageSeconds = 18,
  safetyFactor = 1.8,
): ByteWindow {
  const size = Math.max(0, Math.floor(sourceSize));
  if (size <= 0) return { byteStart: 0, byteLen: 0 };
  const floorBytes = Math.min(2 * 1024 * 1024, size);
  let want = floorBytes;
  if (durationSec && durationSec > 0) {
    want = Math.ceil((size * coverageSeconds * safetyFactor) / durationSec);
    if (!Number.isFinite(want) || want <= 0) want = floorBytes;
  }
  want = Math.min(Math.max(want, floorBytes), maxBytes);
  // Position the window so the clip can still be covered by the file end.
  const maxStart = Math.max(0, size - want);
  const rawStart = durationSec && durationSec > 0 ? (t / durationSec) * size : t > 0 ? Math.min(t * 64_000, maxStart) : 0;
  const start = Math.min(alignDown(Math.floor(rawStart), align), alignDown(maxStart, align));
  const byteStart = Math.max(0, start);
  return { byteStart, byteLen: Math.min(want, size - byteStart) };
}

export interface SpritePlan {
  intervalSec: number;
  /** Usable cells = min(maxTiles, floor(duration/interval)); ≥ 1. */
  count: number;
  cols: number;
  rows: number;
  tileW: number;
}

/**
 * Spritesheet geometry: interval derived from the duration and the tile
 * budget, count floored (never references a frame beyond the video), grid
 * sized to hold exactly `count` cells.
 */
export function spritePlan(
  durationSec: number,
  tileW: number,
  cols: number,
  maxTiles: number,
  minIntervalSec: number,
): SpritePlan {
  const d = Math.max(0.5, durationSec);
  const interval = Math.max(minIntervalSec, Math.ceil(d / maxTiles));
  const count = Math.min(maxTiles, Math.floor(d / interval));
  const safeCount = Math.max(1, count);
  const rows = Math.ceil(safeCount / cols);
  return { intervalSec: interval, count: safeCount, cols, rows, tileW };
}

/**
 * Timestamp of sprite cell k (0-based). Cell k covers [k*interval, (k+1)*interval).
 */
export function spriteCellTime(k: number, intervalSec: number): number {
  return k * intervalSec;
}

/** Format seconds as a WebVTT timestamp (HH:MM:SS.mmm). */
export function vttTimestamp(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)}.${pad(ms, 3)}`;
}

export interface SpriteVttInput {
  /** Absolute URL path of the sprite image. */
  spriteUrl: string;
  durationSec: number;
  intervalSec: number;
  count: number;
  cols: number;
  tileW: number;
  tileH: number;
}

/**
 * Build the WebVTT document consumed by Vidstack's timeline thumbnails
 * (`DefaultVideoLayout thumbnails`). Cues never reference blank padding
 * cells and never extend beyond the video duration.
 */
export function buildSpriteVtt(input: SpriteVttInput): string {
  const cues: string[] = [];
  for (let k = 0; k < input.count; k++) {
    const start = spriteCellTime(k, input.intervalSec);
    const end = Math.min(start + input.intervalSec, input.durationSec);
    if (end <= start) break;
    const x = (k % input.cols) * input.tileW;
    const y = Math.floor(k / input.cols) * input.tileH;
    cues.push(
      `${vttTimestamp(start)} --> ${vttTimestamp(end)}` +
        `\n${input.spriteUrl}#xywh=${x},${y},${input.tileW},${input.tileH}`,
    );
  }
  return ['WEBVTT', '', cues.join('\n\n'), ''].join('\n');
}
