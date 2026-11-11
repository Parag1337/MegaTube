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
import fs from 'node:fs';
import { faststartVerdict } from './mp4-index';

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
// Phase 5.1: multi-scene montage encoding
// ---------------------------------------------------------------------------

export interface MontageInput {
  path: string;
  /** Input-side seek (keyframe-aware; 0 for TS windows). */
  seekSec: number;
  /** Exact scene duration to consume from this input. */
  durationSec: number;
}

export interface EncodeMontageOptions {
  inputs: MontageInput[];
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  outPath: string;
  timeoutMs: number;
}

/**
 * Encode one combined, silent, faststart MP4 montage from N scene inputs.
 *
 * Each input is seeked at the input side (ffmpeg starts decoding at the
 * nearest usable keyframe), trimmed to the scene duration, normalized to
 * the same canvas/aspect/fps, then concatenated in one filter graph. The
 * output is H.264/yuv420p, no audio, and browser-compatible.
 */
export async function encodeMontage(opts: EncodeMontageOptions): Promise<{ ok: boolean; detail: string }> {
  if (opts.inputs.length === 0) return { ok: false, detail: 'no scene inputs' };
  const args: string[] = [];
  for (const input of opts.inputs) {
    if (input.seekSec > 0) args.push('-ss', input.seekSec.toFixed(3));
    args.push('-t', Math.max(0.2, input.durationSec).toFixed(3), '-i', input.path);
  }
  const normalized = opts.inputs.map((_, i) =>
    `[${i}:v]setpts=PTS-STARTPTS,fps=${opts.fps},` +
    `scale=${opts.width}:${opts.height}:force_original_aspect_ratio=decrease,` +
    `pad=${opts.width}:${opts.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v${i}]`,
  );
  const labels = opts.inputs.map((_, i) => `[v${i}]`).join('');
  const filter = `${normalized.join(';')};${labels}concat=n=${opts.inputs.length}:v=1:a=0[outv]`;
  args.push(
    '-filter_complex', filter,
    '-map', '[outv]',
    '-an',
    '-c:v', 'libopenh264',
    '-pix_fmt', 'yuv420p',
    '-b:v', `${Math.round(opts.bitrateKbps)}k`,
    '-rc_mode', 'bitrate',
    '-r', String(opts.fps),
    '-movflags', '+faststart',
    '-f', 'mp4',
    '-y', opts.outPath,
  );
  const run = await runFfmpeg(args, opts.timeoutMs);
  const ok = run.code === 0;
  return { ok, detail: ok ? 'encoded' : summarizeRun(run) };
}

export interface MontageValidation {
  ok: boolean;
  reason: string;
  durationSec: number | null;
  width: number;
  height: number;
  bytes: number;
  faststart: boolean;
  hasAudio: boolean;
}

/**
 * Validate a freshly encoded montage BEFORE it is published. Completion
 * requires a real, decodable, silent, faststart MP4 — not merely ffmpeg
 * exit code 0.
 */
export async function validateMontageFile(
  absPath: string,
  opts: { minDurationSec: number; maxBytes: number; timeoutMs: number },
): Promise<MontageValidation> {
  const fail = (reason: string): MontageValidation => ({
    ok: false,
    reason,
    durationSec: null,
    width: 0,
    height: 0,
    bytes: 0,
    faststart: false,
    hasAudio: false,
  });
  let bytes = 0;
  try {
    const st = await fs.promises.stat(absPath);
    if (!st.isFile() || st.size <= 0) return fail('output missing or empty');
    if (st.size > opts.maxBytes) return fail(`output too large (${st.size} B)`);
    bytes = st.size;
  } catch {
    return fail('output missing');
  }
  const probe = await probeMedia(absPath, opts.timeoutMs);
  if (!probe) return fail('output probe failed');
  if (probe.durationSec === null || probe.durationSec < opts.minDurationSec) {
    return fail(`output too short (${probe.durationSec?.toFixed(2) ?? '?'}s)`);
  }
  if (probe.hasAudio) return fail('output unexpectedly has audio');
  let faststart = false;
  try {
    const buf = await fs.promises.readFile(absPath);
    const verdict = faststartVerdict(buf);
    if (verdict === 'not-faststart') return fail('output is not faststart');
    faststart = verdict === 'faststart';
  } catch {
    return fail('output unreadable');
  }
  return {
    ok: true,
    reason: 'ok',
    durationSec: probe.durationSec,
    width: probe.width,
    height: probe.height,
    bytes,
    faststart,
    hasAudio: probe.hasAudio,
  };
}

// ---------------------------------------------------------------------------
// Probing (dims / duration) + brightness
// ---------------------------------------------------------------------------

export interface MediaProbe {
  width: number;
  height: number;
  durationSec: number | null;
  /** First video stream frame rate when ffprobe reports a usable value. */
  fps: number | null;
  /** True when the container has at least one audio stream. */
  hasAudio: boolean;
  /** First video codec label (diagnostics only). */
  codec: string | null;
}

function parseRate(raw: unknown): number | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const [num, den] = raw.split('/').map(Number);
  if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
    const value = num / den;
    return value > 0 && value < 1000 ? value : null;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** ffprobe the first video stream (dims/fps/audio) and container duration. */
export async function probeMedia(absPath: string, timeoutMs: number): Promise<MediaProbe | null> {
  const run = await runProcess(
    ffprobePath(),
    [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate:format=duration',
      '-of', 'json',
      absPath,
    ],
    timeoutMs,
    true,
  );
  if (run.code !== 0 || !run.stdout) return null;
  try {
    const parsed = JSON.parse(run.stdout.toString('utf8')) as {
      streams?: Array<{
        codec_type?: string;
        codec_name?: string;
        width?: number;
        height?: number;
        avg_frame_rate?: string;
        r_frame_rate?: string;
      }>;
      format?: { duration?: string };
    };
    const stream = parsed.streams?.find((s) => s.codec_type === 'video');
    if (!stream || typeof stream.width !== 'number' || typeof stream.height !== 'number') return null;
    const durRaw = parsed.format?.duration ? Number(parsed.format.duration) : NaN;
    return {
      width: stream.width,
      height: stream.height,
      durationSec: Number.isFinite(durRaw) && durRaw > 0 ? durRaw : null,
      fps: parseRate(stream.avg_frame_rate) ?? parseRate(stream.r_frame_rate),
      hasAudio: (parsed.streams ?? []).some((s) => s.codec_type === 'audio'),
      codec: typeof stream.codec_name === 'string' ? stream.codec_name : null,
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

export interface SceneSample {
  /** Mean brightness (0-255) per sampled frame. */
  means: number[];
  /** Crude 8×8 luminance signature used to reject near-identical scenes. */
  signature: number[];
}

/**
 * Sample a candidate scene once: a few 32×32 RGB frames provide both the
 * brightness gate and a compact visual signature. This replaces separate
 * brightness + duplicate probes, keeping at most one ffmpeg invocation per
 * scene attempt.
 */
export async function probeSceneSample(
  inputPath: string,
  opts: { seekSec?: number; durationSec?: number; timeoutMs: number },
): Promise<SceneSample | null> {
  const frames = 3;
  const args: string[] = [];
  if (opts.seekSec && opts.seekSec > 0) args.push('-ss', opts.seekSec.toFixed(3));
  if (opts.durationSec && opts.durationSec > 0) args.push('-t', opts.durationSec.toFixed(3));
  args.push(
    '-i', inputPath,
    '-frames:v', String(frames),
    '-vf', 'fps=2,scale=32:32',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    '-',
  );
  const run = await runFfmpeg(args, opts.timeoutMs, true);
  if (!run.stdout || run.stdout.length === 0) return null;
  const bytesPerFrame = 32 * 32 * 3;
  const data = run.stdout;
  const means: number[] = [];
  const signatures: number[][] = [];
  for (let off = 0; off + bytesPerFrame <= data.length; off += bytesPerFrame) {
    let sum = 0;
    const sig: number[] = [];
    for (let by = 0; by < 8; by++) {
      for (let bx = 0; bx < 8; bx++) {
        let block = 0;
        for (let y = by * 4; y < by * 4 + 4; y++) {
          for (let x = bx * 4; x < bx * 4 + 4; x++) {
            const i = off + (y * 32 + x) * 3;
            const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            block += lum;
          }
        }
        const value = block / 16;
        sig.push(value);
        sum += value * 16;
      }
    }
    means.push(sum / (32 * 32));
    signatures.push(sig);
  }
  if (means.length === 0) return null;
  return { means, signature: signatures[0] };
}

/** Mean absolute difference between two 8×8 luminance signatures (0-255). */
export function sceneSignatureDistance(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return Number.POSITIVE_INFINITY;
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i]);
  return sum / n;
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
