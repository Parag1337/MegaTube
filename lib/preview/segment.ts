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

// ---------------------------------------------------------------------------
// Phase 5.1: multi-scene montage planning
// ---------------------------------------------------------------------------

export interface MontageScenePlan {
  index: number;
  /** Absolute timeline position the scene should represent. */
  targetSec: number;
  /** Chosen start after boundary/duplicate clamping. */
  startSec: number;
  /** Scene length that will be encoded into the montage. */
  durationSec: number;
  /** True when duration metadata was unavailable and a ladder was used. */
  estimated: boolean;
}

export interface MontagePlan {
  scenes: MontageScenePlan[];
  sceneSeconds: number;
  totalSeconds: number;
  estimated: boolean;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

/**
 * Plan the representative scenes for one card montage.
 *
 * Long videos get evenly spread targets from ~10 % to ~90 % (five by
 * default) so the montage samples the whole video rather than one section.
 * Short videos automatically use fewer/shorter scenes and never produce a
 * montage longer than the meaningful source content. Unknown-duration
 * sources use the bounded 10/30/50/70/90 s ladder and are flagged
 * `estimated`.
 */
export function planMontage(
  durationSec: number | null,
  sceneCount: number,
  sceneSeconds: number,
): MontagePlan {
  const requested = Math.max(1, Math.floor(sceneCount));
  const baseScene = Math.max(0.5, sceneSeconds);
  const known = typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec > 0;
  if (!known) {
    const ladder = [10, 30, 50, 70, 90];
    const count = Math.min(requested, ladder.length);
    const scenes = ladder.slice(0, count).map((target, index) => ({
      index,
      targetSec: target,
      startSec: target,
      durationSec: baseScene,
      estimated: true,
    }));
    return { scenes, sceneSeconds: baseScene, totalSeconds: count * baseScene, estimated: true };
  }

  const duration = durationSec as number;
  let count = requested;
  let perScene = baseScene;
  if (duration <= 2.0) {
    count = 1;
    perScene = clamp(duration * 0.8, 0.4, baseScene);
  } else {
    // Leave breathing room between scenes and keep the montage bounded by
    // the source. Very short clips reduce BOTH count and per-scene length.
    const byDuration = Math.max(1, Math.floor(duration / (baseScene + 0.8)));
    count = Math.min(requested, byDuration);
    if (count < requested) {
      perScene = clamp(duration / (count + 0.5), 0.5, baseScene);
    }
  }
  count = Math.max(1, count);

  const fractions =
    count === 1 ? [0.5] : Array.from({ length: count }, (_, i) => 0.1 + (0.8 * i) / (count - 1));
  const minStart = Math.min(duration * 0.02, 1);
  const maxStart = Math.max(0, duration - perScene - Math.min(0.3, duration * 0.02));
  const scenes: MontageScenePlan[] = [];
  for (let i = 0; i < fractions.length; i++) {
    const target = duration * fractions[i];
    let start = clamp(target, minStart, maxStart);
    // Never emit duplicate/near-identical scene starts.
    for (let guard = 0; guard < 6; guard++) {
      if (!scenes.some((s) => Math.abs(s.startSec - start) < Math.max(0.4, perScene * 0.35))) break;
      start = clamp(start + perScene * 0.75, minStart, maxStart);
    }
    scenes.push({
      index: i,
      targetSec: target,
      startSec: start,
      durationSec: Math.min(perScene, Math.max(0.3, duration - start)),
      estimated: false,
    });
  }
  return {
    scenes,
    sceneSeconds: perScene,
    totalSeconds: scenes.reduce((sum, s) => sum + s.durationSec, 0),
    estimated: false,
  };
}

/**
 * Bounded alternatives for an unsuitable (black/duplicate) scene. Offsets
 * stay small enough to remain inside the already-acquired source window, so
 * trying them never triggers another MEGA range request.
 */
export function sceneAlternatives(
  scene: MontageScenePlan,
  durationSec: number | null,
  attempts: number,
): number[] {
  const known = typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec > 0;
  const maxStart = known
    ? Math.max(0, (durationSec as number) - scene.durationSec - 0.2)
    : Number.POSITIVE_INFINITY;
  const offsets = [0, 1.5, -1.5, 3, -3, 4.5, -4.5];
  const out: number[] = [];
  for (const offset of offsets) {
    const t = clamp(scene.startSec + offset, 0, maxStart);
    if (out.some((x) => Math.abs(x - t) < 0.25)) continue;
    out.push(t);
    if (out.length >= Math.max(1, attempts + 1)) break;
  }
  return out;
}

export interface MontageCanvas {
  /** Output canvas including the aspect-ratio padding. */
  width: number;
  height: number;
  /** Source area after aspect-preserving downscale (never upscaled). */
  innerWidth: number;
  innerHeight: number;
}

/** Round to an even number (H.264 yuv420p requirement). */
export function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/**
 * Aspect-preserving output canvas. Landscape caps at 640×360, portrait at
 * 360×640; small sources are never upscaled. The canvas is padded (not
 * cropped), preserving the complete frame for both orientations.
 */
export function montageCanvas(
  sourceWidth: number,
  sourceHeight: number,
  caps: { maxWidthLandscape: number; maxHeightLandscape: number; maxWidthPortrait: number; maxHeightPortrait: number },
): MontageCanvas {
  const sw = Math.max(2, Math.floor(sourceWidth));
  const sh = Math.max(2, Math.floor(sourceHeight));
  const portrait = sh > sw;
  const maxW = portrait ? caps.maxWidthPortrait : caps.maxWidthLandscape;
  const maxH = portrait ? caps.maxHeightPortrait : caps.maxHeightLandscape;
  const scale = Math.min(1, maxW / sw, maxH / sh);
  const innerWidth = even(sw * scale);
  const innerHeight = even(sh * scale);
  return {
    width: innerWidth,
    height: innerHeight,
    innerWidth,
    innerHeight,
  };
}

/** Output frame rate: cap high-fps sources, never up-convert low-fps ones. */
export function outputFps(sourceFps: number | null, cap: number): number {
  const fps = sourceFps && Number.isFinite(sourceFps) && sourceFps > 0 ? sourceFps : cap;
  // Floor, not round: a 23.976 fps source must not be converted to 24 fps
  // (that would duplicate frames for no visual benefit).
  return Math.min(cap, Math.max(1, Math.floor(fps + 0.01)));
}

/**
 * Merge byte windows that are close enough that one range request is
 * cheaper, subject to the per-range cap. Windows are absolute and aligned.
 */
export function mergeByteWindows(
  windows: Array<{ byteStart: number; byteLen: number }>,
  maxMergedLen: number,
  maxGapBytes: number,
): Array<{ byteStart: number; byteLen: number }> {
  const sorted = [...windows]
    .filter((w) => w.byteLen > 0)
    .sort((a, b) => a.byteStart - b.byteStart);
  const merged: Array<{ byteStart: number; byteLen: number }> = [];
  for (const w of sorted) {
    const last = merged[merged.length - 1];
    if (last) {
      const lastEnd = last.byteStart + last.byteLen;
      const gap = w.byteStart - lastEnd;
      const newLen = Math.max(lastEnd, w.byteStart + w.byteLen) - last.byteStart;
      if (gap <= maxGapBytes && newLen <= maxMergedLen) {
        last.byteLen = newLen;
        continue;
      }
    }
    merged.push({ ...w });
  }
  return merged;
}

/** Convert an absolute byte offset to an approximate timeline position. */
export function byteOffsetToSeconds(byteStart: number, sourceSize: number, durationSec: number | null): number {
  if (!durationSec || durationSec <= 0 || sourceSize <= 0) return 0;
  return (byteStart / sourceSize) * durationSec;
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
