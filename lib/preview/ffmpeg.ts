/**
 * Phase 5 preview system: ffmpeg encoding/probing helpers.
 *
 * Facts pinned live against this server's ffmpeg 8.1.3 build (see design doc
 * §5 and the probe notes): there is NO libx264 — the only h264 ENCODER is
 * libopenh264, and the native h264/hevc/vc1/vvc DECODERS are disabled, so
 * h264 decode also goes through libopenh264 (noisy but working, exactly as
 * lib/thumbs/repair.ts already does). libopenh264 supports `rc_mode` +
 * `-b:v` (no crf), which is what the hover encode uses.
 *
 * Every invocation:
 *  - runs with `-nostdin` (no stdin hijacking in a server process),
 *  - has a hard SIGKILL timeout (PREVIEW_FFMPEG_TIMEOUT_MS),
 *  - captures only a bounded stderr tail (a full decode log is megabytes).
 */

import { spawn } from 'node:child_process';

export function ffmpegPath(): string {
  return process.env.FFMPEG_PATH && process.env.FFMPEG_PATH.length > 0 ? process.env.FFMPEG_PATH : 'ffmpeg';
}

export function ffprobePath(): string {
  return process.env.FFMPEG_PROBE && process.env.FFMPEG_PROBE.length > 0 ? process.env.FFMPEG_PROBE : 'ffprobe';
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** Last ~2 KB of stderr (diagnostics only; never logged at full length). */
  stderrTail: string;
  /** Stdout bytes when `captureStdout` was requested. */
  stdout: Buffer | null;
}

const STDERR_TAIL_BYTES = 4096;

export async function runProcess(
  cmd: string,
  args: string[],
  timeoutMs: number,
  captureStdout = false,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', captureStdout ? 'pipe' : 'ignore', 'pipe'],
    });
    const stderrChunks: Buffer[] = [];
    let stderrLen = 0;
    const stdoutChunks: Buffer[] = [];
    let stdoutLen = 0;
    let timedOut = false;
    let settled = false;

    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrLen += chunk.length;
      while (stderrLen > STDERR_TAIL_BYTES && stderrChunks.length > 1) {
        const dropped = stderrChunks.shift()!;
        stderrLen -= dropped.length;
      }
    });
    if (captureStdout) {
      child.stdout.on('data', (chunk: Buffer) => {
        // Bounded: rawvideo 32x32 rgb24 frames only (3 frames = 9 KB).
        if (stdoutLen > 256 * 1024) return;
        stdoutChunks.push(chunk);
        stdoutLen += chunk.length;
      });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        signal,
        timedOut,
        stderrTail: Buffer.concat(stderrChunks).toString('utf8').slice(-STDERR_TAIL_BYTES),
        stdout: captureStdout ? Buffer.concat(stdoutChunks) : null,
      });
    };

    child.on('error', () => finish(null, null)); // spawn failure (ENOENT...)
    child.on('close', (code, signal) => finish(code, signal));
  });
}

export async function runFfmpeg(args: string[], timeoutMs: number, captureStdout = false): Promise<RunResult> {
  return runProcess(ffmpegPath(), ['-hide_banner', '-nostdin', '-v', 'error', ...args], timeoutMs, captureStdout);
}

export function summarizeRun(result: RunResult): string {
  const reason = result.timedOut ? 'timeout' : result.code !== null ? `exit ${result.code}` : `signal ${result.signal}`;
  const tail = result.stderrTail.replace(/\s+/g, ' ').trim().slice(0, 160);
  return tail.length > 0 ? `${reason}: ${tail}` : reason;
}

// ---------------------------------------------------------------------------
// Hover clip encoding
// ---------------------------------------------------------------------------

export const HOVER_VIDEO_BITRATE = '700k';
export const HOVER_AUDIO_BITRATE = '96k';

export interface EncodeHoverOptions {
  inputPath: string;
  /** Input-side seek (0 for TS windows — the window IS the segment). */
  seekSec: number;
  clipSeconds: number;
  height: number;
  outPath: string;
  timeoutMs: number;
}

/**
 * Encode one hover preview clip: faststart MP4, libopenh264 at a fixed
 * bitrate, AAC 48 kHz audio (dropped gracefully when the window has none).
 * Never touches the original file — the output is a small derived asset.
 */
export async function encodeHoverClip(opts: EncodeHoverOptions): Promise<{ ok: boolean; detail: string }> {
  const args: string[] = [];
  if (opts.seekSec > 0) args.push('-ss', opts.seekSec.toFixed(3));
  args.push(
    '-i', opts.inputPath,
    '-t', String(opts.clipSeconds),
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-vf', `scale=-2:${Math.round(opts.height)}`,
    '-c:v', 'libopenh264',
    '-pix_fmt', 'yuv420p',
    '-b:v', HOVER_VIDEO_BITRATE,
    '-rc_mode', 'bitrate',
    '-c:a', 'aac',
    '-b:a', HOVER_AUDIO_BITRATE,
    '-ar', '48000',
    '-ac', '2',
    '-movflags', '+faststart',
    '-f', 'mp4',
    '-y', opts.outPath,
  );
  const run = await runFfmpeg(args, opts.timeoutMs);
  const ok = run.code === 0;
  return { ok, detail: ok ? 'encoded' : summarizeRun(run) };
}

// ---------------------------------------------------------------------------
// Probing (dims / duration) + brightness
// ---------------------------------------------------------------------------

export interface MediaProbe {
  width: number;
  height: number;
  durationSec: number | null;
}

/** ffprobe the first video stream (width/height) and container duration. */
export async function probeMedia(absPath: string, timeoutMs: number): Promise<MediaProbe | null> {
  const run = await runProcess(
    ffprobePath(),
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-show_entries', 'format=duration',
      '-of', 'json',
      absPath,
    ],
    timeoutMs,
    true,
  );
  if (run.code !== 0 || !run.stdout) return null;
  try {
    const parsed = JSON.parse(run.stdout.toString('utf8')) as {
      streams?: Array<{ width?: number; height?: number }>;
      format?: { duration?: string };
    };
    const stream = parsed.streams?.[0];
    if (!stream || typeof stream.width !== 'number' || typeof stream.height !== 'number') return null;
    const durRaw = parsed.format?.duration ? Number(parsed.format.duration) : NaN;
    return {
      width: stream.width,
      height: stream.height,
      durationSec: Number.isFinite(durRaw) && durRaw > 0 ? durRaw : null,
    };
  } catch {
    return null;
  }
}

/**
 * Mean brightness (0-255) of a few sampled frames, reusing the exact probe
 * chain thumbs repair uses (`scale=32:32`, rawvideo rgb24). Returns one mean
 * per requested frame; fewer entries than requested means the decode ended
 * early (short window) — callers treat that per their policy.
 */
export async function probeBrightnessFrames(
  inputPath: string,
  opts: { seekSec?: number; frames?: number; stepSec?: number; timeoutMs: number },
): Promise<number[] | null> {
  const frames = Math.max(1, opts.frames ?? 3);
  const step = Math.max(0.5, opts.stepSec ?? 2.5);
  const args: string[] = [];
  if (opts.seekSec && opts.seekSec > 0) args.push('-ss', opts.seekSec.toFixed(3));
  args.push(
    '-i', inputPath,
    '-frames:v', String(frames),
    '-vf', `fps=1/${step},scale=32:32`,
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    '-',
  );
  const run = await runFfmpeg(args, opts.timeoutMs, true);
  if (!run.stdout || run.stdout.length === 0) return null;
  const bytesPerFrame = 32 * 32 * 3;
  const data = run.stdout;
  const out: number[] = [];
  for (let off = 0; off + bytesPerFrame <= data.length; off += bytesPerFrame) {
    let sum = 0;
    for (let i = off; i < off + bytesPerFrame; i++) sum += data[i];
    out.push(sum / bytesPerFrame);
  }
  return out.length > 0 ? out : null;
}

/** A frame is "usable" above this mean brightness (mirrors THUMB_BRIGHTNESS_MIN). */
export const PREVIEW_BRIGHTNESS_MIN = 12;

/**
 * Segment quality verdict: ≥ 2/3 sampled frames must clear the brightness
 * floor (design §3, mirroring the thumbs-repair policy).
 */
export function brightnessVerdict(means: number[] | null): 'usable' | 'black' | 'unknown' {
  if (!means || means.length === 0) return 'unknown';
  const ok = means.filter((m) => m >= PREVIEW_BRIGHTNESS_MIN).length;
  return ok * 3 >= 2 * means.length ? 'usable' : 'black';
}

// ---------------------------------------------------------------------------
// Spritesheet encoding
// ---------------------------------------------------------------------------

export interface EncodeSpriteOptions {
  inputPath: string;
  intervalSec: number;
  tileW: number;
  tileH: number;
  cols: number;
  rows: number;
  outPath: string;
  timeoutMs: number;
}

/**
 * Encode the timeline spritesheet: one JPEG canvas of `cols x rows` cells.
 * `-discard nokey` (demuxer-level) throws away non-keyframe packets BEFORE
 * decoding, so the cost is proportional to the keyframe count, not the video
 * length — measured on a 405 s 360p source: 12.1 s with `-skip_frame nokey`
 * (libopenh264 decodes everything, the flag only drops output frames) vs
 * 0.84 s with `-discard nokey`. `fps=1/interval` holds each last keyframe
 * until the next tick (duplicate cells for sparse-keyframe sources are
 * visually indistinguishable from a slower thumbnail cadence). The tile
 * filter pads a partial final grid to the full canvas (validated live).
 */
export async function encodeSprite(opts: EncodeSpriteOptions): Promise<{ ok: boolean; detail: string }> {
  const args = [
    '-discard', 'nokey',
    '-i', opts.inputPath,
    '-frames:v', '1',
    '-vf',
    `fps=1/${opts.intervalSec},scale=${opts.tileW}:${opts.tileH}:force_original_aspect_ratio=decrease,` +
      `pad=${opts.tileW}:${opts.tileH}:-1:-1:black,tile=${opts.cols}x${opts.rows}`,
    '-c:v', 'mjpeg',
    '-q:v', '4',
    '-f', 'image2',
    '-y', opts.outPath,
  ];
  const run = await runFfmpeg(args, opts.timeoutMs);
  const ok = run.code === 0;
  return { ok, detail: ok ? 'encoded' : summarizeRun(run) };
}
