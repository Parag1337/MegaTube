/**
 * On-demand remux of browser-incompatible containers (MPEG-TS) into MP4.
 *
 * Evidence (Sept 2026, ffprobe of decrypted MEGA bytes): the failing
 * "VOE CDN" files are MPEG-TS containers holding bog-standard h264 + AAC
 * streams. Only the container is browser-hostile, so a stream-copy remux
 * (`ffmpeg -c copy`, no re-encode) produces genuinely playable MP4.
 *
 * Path policy:
 *   - browser-compatible MP4 keeps the existing direct decrypt-and-stream
 *     path (see app/api/media/[videoId]/route.ts) - untouched;
 *   - MPEG-TS with a warm cache is served as faststart MP4 with full Range
 *     support (duration + seeking);
 *   - MPEG-TS on FIRST play (cold cache) is served as a LIVE fragmented-MP4
 *     stream: MEGA download -> decrypt -> ffmpeg transmux -> browser starts
 *     playing within seconds, while the same bytes simultaneously land in a
 *     .ts file that is remuxed to the faststart cache the moment the
 *     download completes (refresh/seeks then get full features).
 *
 * Why live-first: a cold 347 MB source at MEGA's ~2-3 MB/s takes minutes to
 * arrive, and faststart MP4 needs the whole file before byte 0 is valid, so
 * "download then respond" leaves the player at 0:00 with "Waiting for
 * localhost" for minutes (reproduced live in Chrome: 150 s of spinner).
 * Fragmented MP4 emits a playable header after milliseconds, so playback
 * starts immediately and progresses while the cache warms underneath.
 *
 * Conversion failures resolve null / error the live stream so the caller
 * falls back to the previous direct-passthrough behavior (never worse than
 * today). Auth/ownership stay in the route, ahead of everything here.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { Readable } from 'node:stream';

export const REMUXED_MIME_TYPE = 'video/mp4';

/**
 * Convert a Node Readable to a Web ReadableStream with ABORT-SAFE controller
 * handling (Bug 4).
 *
 * Why not `Readable.toWeb`: when the browser aborts a media response, the
 * adapter can observe the downstream controller already being closed by the
 * HTTP layer while it simultaneously reports the upstream destroy as an
 * error - `controller.error()` on a closed controller throws synchronously
 * from a microtask, surfacing as `uncaughtException: TypeError: Invalid
 * state: Controller is already closed`. This adapter guards every controller
 * interaction behind a `closed` flag + try/catch, so normal browser aborts
 * (navigation, reload, Range cancellation) are always harmless while genuine
 * upstream errors still reach the client (one error, never a throw).
 */
export function nodeToWebSafe(nodeStream: Readable): ReadableStream<Uint8Array> {
  let closed = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const enqueue = (chunk: Buffer): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(new Uint8Array(chunk));
        } catch {
          // Downstream closed between the flag check and the call.
          closed = true;
          nodeStream.destroy();
          return false;
        }
        // Backpressure: stop reading while the consumer is not pulling.
        const desired = controller.desiredSize;
        if (typeof desired === 'number' && desired <= 0) {
          nodeStream.pause();
          return false;
        }
        return true;
      };
      nodeStream.on('data', (c: Buffer) => {
        enqueue(c);
      });
      nodeStream.on('end', () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed - fine
        }
      });
      nodeStream.on('error', (err: Error) => {
        if (closed) {
          // Post-abort upstream error (destroy, EPIPE, ...): swallow. The
          // consumer is gone; nobody can observe the error and reporting it
          // is exactly what crashes.
          return;
        }
        closed = true;
        try {
          controller.error(err);
        } catch {
          // already closed - fine
        }
      });
      // Readable streams start paused without a flowing consumer; kick once.
      nodeStream.resume();
    },
    pull() {
      if (!closed) nodeStream.resume();
    },
    cancel() {
      // Browser abort: destroy upstream (aborts the MEGA read / file read).
      closed = true;
      nodeStream.destroy();
    },
  });
}

/** True when the source container needs remuxing before browsers can play it. */
export function needsRemuxPlayback(mimeType: string | null | undefined): boolean {
  return mimeType === 'video/mp2t';
}

/** Cache directory for remuxed MP4s (override with MEDIA_CACHE_DIR in tests). */
export function mediaCacheDir(): string {
  const override = process.env.MEDIA_CACHE_DIR;
  if (override && override.length > 0) return override;
  return path.join(process.cwd(), 'data', 'cache-media');
}

export function remuxCachePaths(videoId: number): { mp4Path: string; sidecarPath: string } {
  const dir = mediaCacheDir();
  return {
    mp4Path: path.join(dir, `${videoId}.mp4`),
    sidecarPath: path.join(dir, `${videoId}.json`),
  };
}

interface RemuxSidecar {
  megaNodeId: string;
  sourceSize: number;
  outputSize: number;
}

/** Read a warm cache entry; null when absent/stale (never starts work). */
export async function readRemuxCache(
  videoId: number,
  megaNodeId: string,
  sourceSize: number,
): Promise<{ path: string; size: number } | null> {
  const { mp4Path, sidecarPath } = remuxCachePaths(videoId);
  try {
    const raw = await fs.promises.readFile(sidecarPath, 'utf8');
    const sidecar = JSON.parse(raw) as RemuxSidecar;
    if (sidecar.megaNodeId !== megaNodeId || sidecar.sourceSize !== sourceSize) return null;
    const stat = await fs.promises.stat(mp4Path);
    if (!stat.isFile() || stat.size !== sidecar.outputSize || stat.size <= 0) return null;
    return { path: mp4Path, size: stat.size };
  } catch {
    return null;
  }
}

/** Decrypt a small ciphertext prefix through megajs (stream API) and collect it. */
export function decryptPrefixToBuffer(fileKey: Buffer, cipher: Buffer): Promise<Buffer> {
  return decryptBufferAtOffset(fileKey, cipher, 0);
}

/**
 * Decrypt an arbitrary ciphertext slice through megajs (stream API) at a
 * 16-byte-aligned `start` offset and collect the plaintext.
 */
function decryptBufferAtOffset(fileKey: Buffer, cipher: Buffer, start: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { decrypt } = require('megajs') as typeof import('megajs');
    let decryptor: ReturnType<typeof import('megajs').decrypt>;
    try {
      decryptor = decrypt(fileKey, { start, disableVerification: true });
    } catch (err) {
      reject(err);
      return;
    }
    const chunks: Buffer[] = [];
    decryptor.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    decryptor.on('end', () => resolve(Buffer.concat(chunks)));
    decryptor.on('error', reject);
    decryptor.end(Buffer.from(cipher));
  });
}

/** Head/tail sample sizes for PCR duration probing (tiny vs file size). */
const PCR_HEAD_BYTES = 1024 * 1024;
export const PCR_TAIL_BYTES = 2 * 1024 * 1024;

/**
 * Tail-sample start offset for PCR duration probing (Bug 1).
 *
 * The probe reads a tail sample and decrypts it in place; MEGA CTR
 * decryption requires the sample start to be 16-byte aligned, while the TS
 * parser inside requires 188-byte packet alignment. A naive
 * `size - TAIL - (size % 188)` offset satisfies 188 but can be ≡8 (mod 16),
 * which fails with "start argument of megaDecrypt must be a multiple of 16"
 * and silently kills the duration probe. 752 = 188 × 4 is the combined
 * alignment (divisible by both 188 and 16), so we round the offset DOWN to
 * the nearest multiple of 752.
 */
export const PCR_ALIGN = 752;

/**
 * Largest offset ≤ `size - PCR_TAIL_BYTES` that is a multiple of 752
 * (188- and 16-aligned at once). Never negative; 0 for tiny files.
 */
export function pcrTailStart(size: number): number {
  const target = size - PCR_TAIL_BYTES;
  if (target <= 0) return 0;
  return target - (target % PCR_ALIGN);
}

export interface RemuxSource {
  videoId: number;
  megaNodeId: string;
  size: number;
  fileKey: Buffer;
  upstreamUrl: string;
  fetchCiphertext: (url: string, signal?: AbortSignal) => Promise<Response>;
  signal?: AbortSignal;
  /**
   * Exact source duration in whole seconds (MEGA fa:8 media properties,
   * persisted on Video.duration). Patched into the live fMP4 mvhd so the
   * player shows the true final duration from the first bytes. Null when
   * unknown - the live then honestly reports its buffered edge.
   */
  durationSeconds?: number | null;
  /**
   * Called (fire-and-forget) with the exact PCR-probed duration once known,
   * so the route can persist it for instant use on later plays. Not called
   * when the DB/fa:8 value was already available or probing fails.
   */
  onDurationKnown?: (seconds: number) => void;
}

function ffmpegBin(): string {
  const override = process.env.FFMPEG_PATH;
  return override && override.length > 0 ? override : 'ffmpeg';
}

/** Stream-copy remux (no re-encode) into a faststart MP4 file. */
function runFfmpegRemux(inputTs: string, outputMp4: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = execFile(
      ffmpegBin(),
      [
        '-v', 'error',
        '-y',
        '-i', inputTs,
        '-map', '0:v:0',
        '-map', '0:a:0?',
        '-c', 'copy',
        // TS carries AAC in ADTS frames; MP4 needs ASC. File output adds
        // this implicitly, but be explicit so every path is correct.
        '-bsf:a', 'aac_adtstoasc',
        '-movflags', '+faststart',
        outputMp4,
      ],
      { timeout: 30 * 60 * 1000 },
      (err) => (err ? reject(err) : resolve()),
    );
    child.on('error', reject);
  });
}

/**
 * End offset (exclusive) of the fMP4 init segment (ftyp + moov boxes) in
 * `buf`, or -1 when more bytes are needed to decide.
 */
export function findFragmentedMp4InitEnd(buf: Buffer): number {
  let off = 0;
  for (;;) {
    if (off + 8 > buf.length) return off > 0 ? -1 : -1;
    const size = buf.readUInt32BE(off);
    if (size < 8) return -1;
    const type = buf.toString('latin1', off + 4, off + 8);
    if (type !== 'ftyp' && type !== 'moov') return off > 0 ? off : -1;
    if (buf.length < off + size) return -1; // box incomplete - need more
    off += size;
  }
}

export interface TsPcrDuration {
  /** Exact seconds between first and last program clock reference. */
  seconds: number;
  /** PID the PCRs were read from. */
  pid: number;
}

const TS_PACKET = 188;
const PCR_ROLLOVER_SECONDS = 2 ** 33 / 90000; // 33-bit 90 kHz clock (~26.5 h)

/**
 * Locate the mvhd duration field of an fMP4 init segment WITHOUT copying.
 * Returns the absolute byte offset of the duration field and its width,
 * or null when the init has no moov/mvhd, the version is unknown, or the
 * field does not fit in `buf` (short/truncated init).
 */
function locateMvhdDuration(buf: Buffer): { offset: number; len: 4 | 8; timescale: number } | null {
  let off = 0;
  let moovStart = -1;
  let moovSize = 0;
  while (off + 8 <= buf.length) {
    const size = buf.readUInt32BE(off);
    if (size < 8 || off + size > buf.length) break;
    if (buf.toString('latin1', off + 4, off + 8) === 'moov') {
      moovStart = off;
      moovSize = size;
      break;
    }
    off += size;
  }
  if (moovStart < 0) return null;
  const mvhd = findChildBox(buf, moovStart, moovSize, 'mvhd');
  if (mvhd < 0) return null;
  const version = buf[mvhd + 8];
  if (version === 0) {
    if (mvhd + 24 + 4 > buf.length) return null;
    const timescale = buf.readUInt32BE(mvhd + 20);
    if (!Number.isFinite(timescale) || timescale <= 0) return null;
    return { offset: mvhd + 24, len: 4, timescale };
  }
  if (version === 1) {
    if (mvhd + 32 + 8 > buf.length) return null;
    const timescale = buf.readUInt32BE(mvhd + 28);
    if (!Number.isFinite(timescale) || timescale <= 0) return null;
    return { offset: mvhd + 32, len: 8, timescale };
  }
  return null;
}

/** Collect (pid -> PCR (seconds, byte offset)) from a buffer at absolute file `offset`. */
function collectPcr(buf: Buffer, offset: number, out: Map<number, Array<{ t: number; at: number }>>): void {
  const n = Math.floor(buf.length / TS_PACKET);
  for (let k = 0; k < n; k++) {
    const i = k * TS_PACKET;
    if ((offset + i) % TS_PACKET !== 0) continue; // range must be 188-aligned
    if (buf[i] !== 0x47) continue;
    if (k + 1 < n && buf[i + TS_PACKET] !== 0x47) continue; // sync lock
    const pid = ((buf[i + 1] & 0x1f) << 8) | buf[i + 2];
    const afc = (buf[i + 3] >> 4) & 0x3;
    if (afc !== 2 && afc !== 3) continue;
    if (buf[i + 4] < 7 || !(buf[i + 5] & 0x10)) continue;
    const field48 = buf.readUInt32BE(i + 6) * 0x10000 + buf.readUInt16BE(i + 10);
    const base = Math.floor(field48 / 32768) % 0x200000000;
    const arr = out.get(pid) ?? [];
    arr.push({ t: base / 90000, at: offset + i });
    out.set(pid, arr);
  }
}

/**
 * Exact MPEG-TS duration from Program Clock References: first PCR of the
 * head sample vs last PCR of the tail sample (same PID). MEGA fa:8 media
 * attributes are unretrievable for this library (ETEMPUNAVAIL on every
 * video), and bitrate-guessing runs ~11% off, so PCR differencing is the
 * only exact source short of a full download. Returns null unless the
 * result passes a plausibility gate against the known file size.
 */
export function scanTsPcrDuration(
  head: Buffer,
  headOffset: number,
  tail: Buffer,
  tailOffset: number,
  fileSize: number,
): TsPcrDuration | null {
  try {
    const perPid = new Map<number, Array<{ t: number; at: number }>>();
    collectPcr(head, headOffset, perPid);
    collectPcr(tail, tailOffset, perPid);
    // Dominant PCR PID (the video program), present in both samples.
    const ranked = [...perPid.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [pid] of ranked) {
      const headVals = perPid.get(pid)?.filter((p) => p.at < headOffset + head.length) ?? [];
      const tailVals = perPid.get(pid)?.filter((p) => p.at >= tailOffset) ?? [];
      // Coverage proof: the first PCR must sit near the stream start and
      // the last PCR near the stream end - otherwise the samples missed an
      // edge (truncated fetch, sparse PID) and the difference understates.
      if (headVals.length < 3 || tailVals.length < 3) continue;
      const first = headVals.reduce((a, b) => (a.t < b.t ? a : b));
      const last = tailVals.reduce((a, b) => (a.t > b.t ? a : b));
      if (first.at - headOffset > head.length * 0.5) continue;
      if (tailOffset + tail.length - last.at > tail.length * 0.5) continue;
      const firstT = first.t;
      let lastT = last.t;
      if (lastT < firstT) lastT += PCR_ROLLOVER_SECONDS; // 33-bit wrap
      const seconds = lastT - firstT;
      if (!(seconds > 1) || seconds > 12 * 3600) continue;
      // Plausibility gate: implied overall bitrate within sane bounds.
      const bps = (fileSize * 8) / seconds;
      if (!(bps > 32_000 && bps < 40_000_000)) continue;
      return { seconds, pid };
    }
    return null;
  } catch {
    return null;
  }
}

/** Find a direct child box `type` inside a container box. Returns box start or -1. */
function findChildBox(buf: Buffer, parentStart: number, parentSize: number, type: string): number {
  let off = parentStart + 8;
  const end = parentStart + parentSize;
  while (off + 8 <= end && off + 8 <= buf.length) {
    const size = buf.readUInt32BE(off);
    if (size < 8 || off + size > end) return -1;
    if (buf.toString('latin1', off + 4, off + 8) === type) return off;
    off += size;
  }
  return -1;
}

/**
 * Rewrite the mvhd duration of an fMP4 init segment to an exact,
 * externally-known duration (MEGA fa:8 media properties, whole seconds).
 *
 * Why: ffmpeg writing fragmented MP4 to a pipe leaves mvhd duration 0
 * (total length unknowable mid-download), so the browser shows only the
 * buffered/live edge (e.g. 0:48 for an 18:19 video). With MEGA's exact
 * duration patched in, the player shows the true final duration from the
 * first bytes while the stream underneath stays live/progressive.
 * Returns a patched copy, or null when the init has no usable mvhd or the
 * duration is not a finite positive number (caller then serves unpatched).
 */
export function patchFragmentedMp4Duration(init: Buffer, durationSeconds: number | null | undefined): Buffer | null {
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  // Locate moov among top-level boxes.
  const loc = locateMvhdDuration(init);
  if (!loc) return null;
  const ticks = Math.round(durationSeconds * loc.timescale);
  if (ticks <= 0) return null;
  const out = Buffer.from(init);
  if (loc.len === 4) {
    if (ticks > 0xffffffff) return null;
    out.writeUInt32BE(ticks, loc.offset);
  } else {
    out.writeBigUInt64BE(BigInt(ticks), loc.offset);
  }
  return out;
}

/**
 * Patch the mvhd duration of an fMP4 init segment IN PLACE (same Buffer).
 * Used by the live pipeline when the exact duration becomes known only
 * after the init was already published/persisted: `job.initSegment` and the
 * spool copy on disk are both updated so late-attaching viewers and spool
 * replays see the true duration too.
 */
function patchMvhdDurationInPlace(init: Buffer, durationSeconds: number): boolean {
  const loc = locateMvhdDuration(init);
  if (!loc) return false;
  const ticks = Math.round(durationSeconds * loc.timescale);
  if (ticks <= 0) return false;
  if (loc.len === 4) {
    if (ticks > 0xffffffff) return false;
    init.writeUInt32BE(ticks, loc.offset);
  } else {
    init.writeBigUInt64BE(BigInt(ticks), loc.offset);
  }
  return true;
}

/**
 * Patch the mvhd duration field of a sparse spool file on disk at absolute
 * `offset` (same field located by `locateMvhdDuration` in memory). No-op on
 * any mismatch - the spool copy then simply keeps reporting the live edge.
 */
async function patchSpoolDurationOnDisk(spoolPath: string, offset: number, init: Buffer, durationSeconds: number): Promise<void> {
  const loc = locateMvhdDuration(init);
  if (!loc) return;
  const ticks = Math.round(durationSeconds * loc.timescale);
  if (ticks <= 0) return;
  try {
    const fh = await fs.promises.open(spoolPath, 'r+');
    try {
      if (loc.len === 4) {
        if (ticks > 0xffffffff) return;
        const b = Buffer.alloc(4);
        b.writeUInt32BE(ticks, 0);
        await fh.write(b, 0, 4, offset + loc.offset);
      } else {
        const b = Buffer.alloc(8);
        b.writeBigUInt64BE(BigInt(ticks), 0);
        await fh.write(b, 0, 8, offset + loc.offset);
      }
    } finally {
      await fh.close();
    }
    console.warn(
      `[livejob] spool mvhd duration patched on disk at +${offset + loc.offset}: ${durationSeconds.toFixed(1)}s`,
    );
  } catch {
    // Best-effort: a failed patch leaves the spool at duration 0.
  }
}

// ---------------------------------------------------------------------------
// Live remux jobs: one MEGA download feeds every viewer + the cache file.
// ---------------------------------------------------------------------------

interface LiveSubscriber {
  notify: () => void;
  detached: boolean;
}

export interface LiveRemuxJob {
  videoId: number;
  /** DIAG: total bytes broadcast to subscribers (live stream pacing). */
  xBroadcastBytes: number;
  /** DIAG: wall-clock ms of the job start (server-side timeline). */
  xStartedAt: number;
  /**
   * Live OUTPUT spool: every viewer replays the fMP4 byte-continuously from
   * offset 0 (init + tail + fragments). A viewer that attaches AFTER the
   * stream started - Chrome always re-issues a second start-0 request during
   * element setup - would otherwise receive a mid-fragment byte gap, which
   * corrupts the stream for Chrome (player parks at 0:00). `spoolBytes` is
   * only authoritative once the latest `spoolSynced` link has settled.
   */
  spoolPath: string;
  spoolSynced: Promise<void>;
  spoolBytes: number;
  /**
   * Resolves once the fMP4 init segment is durably at spool offset 0 (and
   * job.initSegment is set). The route awaits this before serving ANY live
   * bytes, so every viewer - including spool replays and seeks - receives a
   * byte-continuous fMP4 stream that starts with the init segment.
   */
  spoolInitWritten: Promise<void>;
  /** Absolute spool offset where the init segment ends (== init length). */
  initSpoolOffset: number;
  /** Resolves to the published faststart cache (null when unconvertible). */
  cache: Promise<{ path: string; size: number } | null>;
  /**
   * Resolves once the MEGA upstream answered OK and the pipeline is running.
   * Rejects (with `upstreamStatus` attached) when no playable bytes can ever
   * come - the route awaits this BEFORE sending response headers so 509/404
   * still produce honest JSON statuses instead of a doomed 200 stream.
   */
  ready: Promise<void>;
  /** True once the live broadcast finished (successfully or not). */
  liveEnded: boolean;
  liveError: unknown;
  initSegment: Buffer | null;
  subscribers: Set<LiveSubscriber>;
  waiters: Array<() => void>;
  /** DIAG: number of requests that joined this job after creation. */
  xJoinedCount: number;
}

const liveJobs = new Map<number, LiveRemuxJob>();
/** In-flight PCR probes per job, aborted when the job dies (no leaked fetch). */
const liveJobProbeAborts = new WeakMap<LiveRemuxJob, AbortController>();

// ---------------------------------------------------------------------------
// Bounded remux concurrency (per-process, single-Node)
// ---------------------------------------------------------------------------

const MAX_CONCURRENT_REMUX = Number(process.env.MAX_CONCURRENT_REMUX) || 2;
let activeRemux = 0;
const remuxWaiters: (() => void)[] = [];

async function acquireRemuxSlot(): Promise<void> {
  if (activeRemux < MAX_CONCURRENT_REMUX) {
    activeRemux++;
    return;
  }
  await new Promise<void>((resolve) => remuxWaiters.push(resolve));
  activeRemux++;
}

function releaseRemuxSlot(): void {
  activeRemux--;
  const next = remuxWaiters.shift();
  if (next) next();
}

export function getLiveRemuxStats(): { active: number; videoIds: number[] } {
  return {
    active: liveJobs.size,
    videoIds: [...liveJobs.keys()],
  };
}

function broadcast(job: LiveRemuxJob, chunk: Buffer): void {
  job.xBroadcastBytes += chunk.length;
  if (job.xBroadcastBytes <= chunk.length || job.xBroadcastBytes % (4 * 1024 * 1024) < chunk.length) {
    console.warn(
      `[livejob] ${job.videoId} broadcast cum=${job.xBroadcastBytes} at +${Date.now() - job.xStartedAt}ms subs=${job.subscribers.size}`,
    );
  }
  // Persist to the spool in strict order BEFORE waking readers, so after a
  // subscriber awaits `spoolSynced` the file always contains [0..spoolBytes).
  job.spoolSynced = job.spoolSynced
    .catch(() => {})
    .then(() => fs.promises.appendFile(job.spoolPath, chunk))
    .then(() => {
      job.spoolBytes += chunk.length;
    })
    .catch((err) => {
      // A failed spool append is exceptional (local temp disk). Readers may
      // see a short spool and finish early; log so it is not silent.
      console.warn(
        `[livejob] ${job.videoId} spool write failed: ${err instanceof Error ? err.message.slice(0, 120) : typeof err}`,
      );
    });
  for (const sub of job.subscribers) {
    if (!sub.detached) sub.notify();
  }
}

function endBroadcast(job: LiveRemuxJob, err: unknown): void {
  job.liveEnded = true;
  job.liveError = err ?? null;
  console.warn(
    `[livejob] ${job.videoId} endBroadcast at +${Date.now() - job.xStartedAt}ms err=${err instanceof Error ? err.message.slice(0, 60) : typeof err} sent=${job.xBroadcastBytes}`,
  );
  for (const sub of job.subscribers) sub.notify();
  for (const w of job.waiters.splice(0)) w();
}

/**
 * Get (or start) the single live remux pipeline for a video. The pipeline
 * is server-owned: it runs to completion (or bounded failure) regardless of
 * individual viewers disconnecting, so a refresh always finds a warm cache.
 */
export function getOrCreateLiveRemuxJob(src: RemuxSource): LiveRemuxJob {
  const existing = liveJobs.get(src.videoId);
  if (existing) return existing;

  const job: LiveRemuxJob = {
    videoId: src.videoId,
    xBroadcastBytes: 0,
    xStartedAt: Date.now(),
    spoolPath: '',
    spoolSynced: Promise.resolve(),
    spoolBytes: 0,
    spoolInitWritten: Promise.resolve(),
    initSpoolOffset: 0,
    cache: Promise.resolve(null),
    ready: Promise.resolve(),
    liveEnded: false,
    liveError: null,
    initSegment: null,
    subscribers: new Set(),
    waiters: [],
    xJoinedCount: 0,
  };
  console.warn(`[livejob] ${src.videoId} start size=${src.size}`);
  liveJobs.set(src.videoId, job);
  const spoolPath = path.join(mediaCacheDir(), `${src.videoId}.live.spool`);
  job.spoolPath = spoolPath;
  // The spool must start EMPTY so replay readers are byte-continuous from 0.
  // Folded into job.spoolSynced so the first broadcast's append chains
  // strictly AFTER the truncate (never interleaves).
  job.spoolSynced = job.spoolSynced
    .then(() => fs.promises.rm(spoolPath, { force: true }))
    .then(() => fs.promises.appendFile(spoolPath, Buffer.alloc(0)))
    .then(() => fs.promises.truncate(spoolPath, 0))
    .catch((err) => {
      console.warn(
        `[livejob] ${src.videoId} spool init failed: ${err instanceof Error ? err.message.slice(0, 120) : typeof err}`,
      );
    });

  const fail = (err: unknown): null => {
    const detail = err instanceof Error ? `${err.name}: ${err.message.slice(0, 200)}` : typeof err;
    console.warn(`[media] live remux video ${src.videoId} failed: ${detail}`);
    try {
      liveProc?.kill('SIGKILL');
    } catch {
      // ignore
    }
    try {
      liveJobProbeAborts.get(job)?.abort();
    } catch {
      // ignore
    }
    endBroadcast(job, err instanceof Error ? err : new Error(String(err)));
    return null;
  };

  let liveProc: ChildProcess | null = null;
  let readyResolve: () => void = () => {};
  let readyReject: (err: unknown) => void = () => {};
  job.ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  // Avoid unhandled rejection when nobody awaits ready (e.g. viewers that
  // detached before the fetch settled - cache still carries the outcome).
  job.ready.catch(() => {});

  let spoolInitWrittenResolve: () => void = () => {};
  job.spoolInitWritten = new Promise<void>((resolve) => {
    spoolInitWrittenResolve = resolve;
  });
  // Nobody may hang on this even if the pipeline dies before publishing.
  job.spoolInitWritten.catch(() => {});

  job.cache = (async (): Promise<{ path: string; size: number } | null> => {
    await acquireRemuxSlot();
    const startedAt = Date.now();
    try {
      const dir = mediaCacheDir();
      await fs.promises.mkdir(dir, { recursive: true });
      const { mp4Path, sidecarPath } = remuxCachePaths(src.videoId);
      const tsTmp = path.join(dir, `${src.videoId}.ts.part`);
      // Temp output MUST keep a .mp4 extension: ffmpeg infers the muxer
      // from the filename and rejects unknown extensions like `.part`.
      const mp4Tmp = path.join(dir, `${src.videoId}.part.mp4`);

      // 1. Sequential full download + decrypt (MAC verified, same as a
      // full-range direct GET) teed to the cache file AND live ffmpeg.
      // The fetch runs through the caller's retry wrapper; a reached-here
      // non-OK status (509 bandwidth, 404/410 gone) is reported via
      // job.ready so the route can answer honest JSON BEFORE headers.
      const upstream = await src.fetchCiphertext(`${src.upstreamUrl}/0-${src.size - 1}`);
      if (!upstream.ok || !upstream.body) {
        const err = Object.assign(new Error(`upstream ${upstream.status}`), {
          upstreamStatus: upstream.status,
          retryAfter: upstream.status === 509 ? upstream.headers.get('x-mega-time-left') : null,
        });
        readyReject(err);
        return fail(err);
      }
      readyResolve();
      console.warn(`[livejob] ${src.videoId} upstream-headers OK at +${Date.now() - job.xStartedAt}ms`);

      // Exact duration via PCR differencing (head + 752-aligned tail
      // samples - 752 = 188×4 satisfies BOTH the TS packet grid and MEGA's
      // 16-byte CTR alignment, see pcrTailStart/Bug 1). Runs fully in the
      // BACKGROUND: it must never delay init publication or first byte
      // (Bug 3). The in-flight request is tracked so a dead job (viewer
      // gone, upstream failed) can abort it instead of leaking the fetch.
      // MEGA efficiency: when the duration is already known (DB/fa:8) the
      // probe would be ~3 MB of redundant MEGA ranges per cold play - skip.
      const tailStart = pcrTailStart(src.size);
      const probeAbort = new AbortController();
      const durationPromise: Promise<number | null> = src.durationSeconds != null
        ? Promise.resolve(src.durationSeconds)
        : (async () => {
        try {
          const [headRes, tailRes] = await Promise.all([
            src.fetchCiphertext(`${src.upstreamUrl}/0-${Math.min(src.size - 1, PCR_HEAD_BYTES - 1)}`, probeAbort.signal),
            src.fetchCiphertext(`${src.upstreamUrl}/${tailStart}-${src.size - 1}`, probeAbort.signal),
          ]);
          if (!headRes.ok || !headRes.body || !tailRes.ok || !tailRes.body) return null;
          const [headCipher, tailCipher] = await Promise.all([
            headRes.arrayBuffer().then((b) => Buffer.from(b)),
            tailRes.arrayBuffer().then((b) => Buffer.from(b)),
          ]);
          const [headPlain, tailPlain] = await Promise.all([
            decryptBufferAtOffset(src.fileKey, headCipher, 0),
            decryptBufferAtOffset(src.fileKey, tailCipher, tailStart),
          ]);
          const found = scanTsPcrDuration(headPlain, 0, tailPlain, tailStart, src.size);
          if (found) {
            console.log(
              `[media] duration probe video ${src.videoId}: pid=${found.pid} ${found.seconds.toFixed(1)}s`,
            );
          } else {
            console.log(
              `[media] duration probe video ${src.videoId}: no PCR duration (head=${headPlain.length} tail=${tailPlain.length})`,
            );
          }
          return found?.seconds ?? null;
        } catch (err) {
          if (!probeAbort.signal.aborted) {
            console.warn(
              `[media] duration probe video ${src.videoId} error: ${err instanceof Error ? `${err.name} ${err.message.slice(0, 100)}` : typeof err}`,
            );
          }
          return null;
        }
      })();
      liveJobProbeAborts.set(job, probeAbort);
      // Background duration landing (Bug 3): patch job.initSegment IN PLACE
      // (already-attached viewers read it live) and the spool copy on disk
      // (late viewers replay it), then persist via onDurationKnown. The
      // probe no longer gates anything - playback started long before.
      durationPromise.then(
        (secs) => {
          liveJobProbeAborts.delete(job);
          if (secs === null || src.durationSeconds != null) return;
          if (job.initSegment && patchMvhdDurationInPlace(job.initSegment, secs)) {
            console.warn(`[livejob] ${src.videoId} init duration patched in memory: ${secs.toFixed(1)}s`);
          }
          const patchRec = (job as unknown as { spoolDurationPatch?: { at: number; init: Buffer } }).spoolDurationPatch;
          if (patchRec) {
            void patchSpoolDurationOnDisk(job.spoolPath, patchRec.at, patchRec.init, secs);
          }
          try {
            src.onDurationKnown?.(secs);
          } catch {
            // persist is best-effort
          }
        },
        () => {
          liveJobProbeAborts.delete(job);
        },
      );
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { decrypt } = require('megajs') as typeof import('megajs');
      const decryptor = decrypt(src.fileKey, { start: 0, disableVerification: false });
      const nodeUpstream = Readable.fromWeb(
        upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0],
      );

      liveProc = spawn(ffmpegBin(), [
        '-v', 'error',
        '-i', 'pipe:0',
        '-map', '0:v:0',
        '-map', '0:a:0?',
        '-c', 'copy',
        '-bsf:a', 'aac_adtstoasc',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-f', 'mp4',
        'pipe:1',
      ]);
      const ffOut = liveProc.stdout;
      const ffIn = liveProc.stdin;
      if (!ffOut || !ffIn) return fail(new Error('ffmpeg stdio unavailable'));
      ffIn.on('error', () => {
        // EPIPE when ffmpeg exits early (e.g. corrupt input) - the exit
        // handler below reports the real cause.
      });

      let initAccum: Buffer[] = [];
      let initLen = 0;
      let liveFailed = false;
      let initPublished = false;
      const liveDone = new Promise<void>((resolveLive) => {
        /**
         * Publish the init segment AS SOON AS its bytes are complete (Bug 3):
         * the init must never wait for duration probing. The PCR probe then
         * runs in the background; when it lands, the duration is patched
         * into job.initSegment in place AND into the spool copy on disk, so
         * every viewer (already attached or late) sees the true duration.
         * The MEGA-side probe (fa:8 / DB) never blocks publication either:
         * its result only rides along if it arrived before this call.
         */
        const publishInit = (rawInit: Buffer, tail: Buffer) => {
          if (initPublished || job.liveEnded) return;
          initPublished = true;
          const preKnown = src.durationSeconds;
          job.initSegment = preKnown != null
            ? (patchFragmentedMp4Duration(rawInit, preKnown) ?? rawInit)
            : rawInit;
          job.initSpoolOffset = job.initSegment.length;
          console.warn(
            `[livejob] ${src.videoId} init published ${job.initSegment.length}B eff=${preKnown ?? 'null'} at +${Date.now() - job.xStartedAt}ms`,
          );
          // DURABLE FIRST (Bug 2 correctness): persist init+tail to the
          // spool so every current/future viewer replays byte-continuously
          // from offset 0. Init bytes are broadcast through the same ordered
          // chain as fragments - no second writer can interleave.
          job.spoolSynced = job.spoolSynced
            .catch(() => {})
            .then(() => fs.promises.appendFile(job.spoolPath, job.initSegment as Buffer))
            .then(() => {
              job.spoolBytes += (job.initSegment as Buffer).length;
              if (preKnown == null) {
                // Remember where the mvhd duration field lives in the spool
                // so the on-disk copy can be patched when the probe lands.
                const loc = locateMvhdDuration(job.initSegment as Buffer);
                if (loc) {
                  (job as unknown as { spoolDurationPatch?: { at: number; init: Buffer } }).spoolDurationPatch = {
                    at: job.spoolBytes - (job.initSegment as Buffer).length + loc.offset,
                    init: job.initSegment as Buffer,
                  };
                }
              }
              if (tail.length > 0) {
                job.spoolSynced = job.spoolSynced
                  .then(() => fs.promises.appendFile(job.spoolPath, tail))
                  .then(() => {
                    job.spoolBytes += tail.length;
                  })
                  .catch((err) => {
                    console.warn(
                      `[livejob] ${src.videoId} spool write failed: ${err instanceof Error ? err.message.slice(0, 120) : typeof err}`,
                    );
                  });
              }
            })
            .then(() => {
              spoolInitWrittenResolve();
            })
          	.catch((err) => {
            	console.warn(
              `[livejob] ${src.videoId} spool init write failed: ${err instanceof Error ? err.message.slice(0, 120) : typeof err}`,
            );
            spoolInitWrittenResolve();
          });
          for (const w of job.waiters.splice(0)) w();
          initAccum = [];
        };
        ffOut.on('data', (c: Buffer) => {
          const chunk = Buffer.from(c);
          if (!initPublished) {
            initAccum.push(chunk);
            initLen += chunk.length;
            const joined = Buffer.concat(initAccum);
            const end = findFragmentedMp4InitEnd(joined);
            if (end > 0) {
              publishInit(joined.subarray(0, end), joined.subarray(end));
            } else if (initLen > 4 * 1024 * 1024) {
              liveFailed = true;
              endBroadcast(job, new Error('fMP4 init segment not found in first 4 MB'));
            }
          } else {
            broadcast(job, chunk);
          }
        });
        ffOut.on('end', () => resolveLive());
        ffOut.on('error', (err) => {
          liveFailed = true;
          endBroadcast(job, err);
          resolveLive();
        });
        liveProc.on('error', (err) => {
          liveFailed = true;
          endBroadcast(job, err);
          resolveLive();
        });
        liveProc.on('close', (code) => {
          if (code !== 0 && code !== null) {
            liveFailed = true;
            endBroadcast(job, new Error(`ffmpeg live exited with code ${code}`));
          }
          resolveLive();
        });
      });

      const downloadDone = new Promise<void>((resolveDl, rejectDl) => {
        const ws = fs.createWriteStream(tsTmp);
        nodeUpstream.on('error', rejectDl);
        decryptor.on('error', rejectDl);
        ws.on('finish', () => resolveDl());
        ws.on('error', rejectDl);
        decryptor.on('data', (c: Buffer) => {
          if (!ffIn.destroyed) {
            try {
              ffIn.write(c);
            } catch {
              // stdin already gone - download still completes for the cache
            }
          }
        });
        decryptor.on('end', () => {
          try {
            ffIn.end();
          } catch {
            // ignore
          }
        });
        nodeUpstream.pipe(decryptor).pipe(ws);
      });

      await downloadDone;
      // A clean early-EOF (MEGA closing a throttled connection, e.g. mid-
      // download 509 pressure) resolves the pipe WITHOUT error - but the
      // file is then short. Verify exact size; anything else fails the job
      // instead of publishing a truncated cache / ending live early.
      const tsStat = await fs.promises.stat(tsTmp);
      if (tsStat.size !== src.size) {
        return fail(
          new Error(`truncated download: got ${tsStat.size} of ${src.size} bytes`),
        );
      }
      console.log(
        `[media] live remux download video ${src.videoId}: ${(src.size / 1048576).toFixed(1)} MB in ${Date.now() - startedAt}ms`,
      );
      await liveDone;
      endBroadcast(job, liveFailed ? job.liveError ?? new Error('live transmux failed') : null);

      // 2. Faststart cache publish for seeks/refresh (stream-copy, fast).
      await runFfmpegRemux(tsTmp, mp4Tmp);
      const stat = await fs.promises.stat(mp4Tmp);
      if (stat.size <= 0) throw new Error('ffmpeg produced an empty file');
      await fs.promises.rename(mp4Tmp, mp4Path);
      await fs.promises.writeFile(
        sidecarPath,
        JSON.stringify({ megaNodeId: src.megaNodeId, sourceSize: src.size, outputSize: stat.size }),
      );
      await fs.promises.rm(tsTmp, { force: true });
      return { path: mp4Path, size: stat.size };
    } catch (err) {
      readyReject(err);
      return fail(err);
    } finally {
      releaseRemuxSlot();
      if (liveJobs.get(src.videoId) === job) liveJobs.delete(src.videoId);
      try {
        liveJobProbeAborts.get(job)?.abort();
      } catch {
        // ignore
      }
      // Bug 6: this job's temp files must never outlive it. The temp .ts
      // download is removed here whether the remux succeeded, failed, or was
      // interrupted - a successful cache (mp4Path + sidecar) is untouched.
      try {
        const dir = mediaCacheDir();
        await Promise.all([
          fs.promises.rm(path.join(dir, `${src.videoId}.part.mp4`), { force: true }),
          fs.promises.rm(path.join(dir, `${src.videoId}.ts.part`), { force: true }),
          fs.promises.rm(path.join(dir, `${src.videoId}.live.spool`), { force: true }),
        ]);
      } catch {
        // ignore cleanup errors
      }
    }
  })();

  return job;
}

/**
 * True when a live remux pipeline is already running for this video.
 */
export function hasLiveRemuxJob(videoId: number): boolean {
  return liveJobs.has(videoId);
}

/**
 * Bug 6 sweep: delete orphaned temp files from jobs killed by a crash or a
 * hard process exit (the per-job finally cannot run for those). Runs once
 * per process at startup, BEFORE the media route can start new jobs, so it
 * never races a live job's own cleanup. Successful caches (<id>.mp4 +
 * <id>.json) are never touched; only *.ts.part, *.part.mp4 and *.live.spool
 * are removed.
 */
export async function cleanupOrphanedTempFiles(): Promise<void> {
  const dir = mediaCacheDir();
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return; // no cache dir yet - nothing to sweep
  }
  const tempRe = /\.(ts\.part|part\.mp4|live\.spool)$/;
  let removed = 0;
  for (const name of names) {
    if (!tempRe.test(name)) continue;
    try {
      await fs.promises.rm(path.join(dir, name), { force: true });
      removed++;
    } catch {
      // ignore individual failures
    }
  }
  if (removed > 0) console.warn(`[media] orphaned temp cleanup: removed ${removed} file(s) from ${dir}`);
}

/**
 * Mark that an additional request has joined an existing live remux job.
 * No-op if no job exists for this video.
 */
export function joinLiveRemuxJob(videoId: number): void {
  const job = liveJobs.get(videoId);
  if (job) job.xJoinedCount++;
}

/**
 * Wait until the live init segment is available (or the live fails).
 * Exported so the route can preflight "bytes will actually flow" before
 * committing response headers (an init-less 200 makes Chrome abort the
 * request a few seconds later and park the player at 0:00).
 */
export function waitForLiveInit(job: LiveRemuxJob): Promise<Buffer> {
  if (job.initSegment) return Promise.resolve(job.initSegment);
  if (job.liveEnded) return Promise.reject(job.liveError ?? new Error('live stream ended'));
  return new Promise<Buffer>((resolve, reject) => {
    job.waiters.push(() => {
      if (job.initSegment) resolve(job.initSegment);
      else reject(job.liveError ?? new Error('live stream ended'));
    });
  });
}

/**
 * Build a live fMP4 Response for one viewer.
 *
 * `endByte` is the last byte the viewer asked for (inclusive) or null for
 * an open-ended stream. Small start-0 ranges (Safari's `bytes=0-1` probe)
 * are satisfied from the live bytes with `Content-Range: bytes 0-N/*`
 * (`*` = total unknown while warming - valid per RFC 7233).
 */
/**
 * Resolve once the spool holds at least `offset` bytes (or the live has
 * ended / the viewer is gone). Returns the actual frontier at settle time.
 *
 * Used by the route for cold MPEG-TS seeks: a position inside the already
 * spooled fMP4 window can be served from the live stream without waiting
 * for the full cache (Bug 2).
 */
export function waitForSpoolOffset(
  job: LiveRemuxJob,
  offset: number,
  signal?: AbortSignal,
): Promise<number> {
  if (job.spoolBytes >= offset) return Promise.resolve(job.spoolBytes);
  if (job.liveEnded) return Promise.resolve(job.spoolBytes);
  return new Promise<number>((resolve) => {
    let done = false;
    let waiter: (() => void) | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      const idx = waiter ? job.waiters.indexOf(waiter) : -1;
      if (waiter) {
        const w = waiter;
        waiter = null;
        if (idx >= 0) job.waiters.splice(idx, 1);
        w();
      }
      signal?.removeEventListener('abort', onAbort);
      resolve(job.spoolBytes);
    };
    const check = () => {
      if (done) return; // settled via abort/end - never re-register
      // A notify consumes the registered entry; drop it before deciding.
      const idx = waiter ? job.waiters.indexOf(waiter) : -1;
      if (waiter && idx >= 0) job.waiters.splice(idx, 1);
      waiter = null;
      if (job.spoolBytes >= offset || job.liveEnded) {
        finish();
        return;
      }
      // Not there yet: re-register for the next broadcast/end notification.
      waiter = check;
      job.waiters.push(check);
    };
    const onAbort = () => finish();
    signal?.addEventListener('abort', onAbort);
    check();
  });
}

/**
 * True when `start` falls inside the fMP4 window the live spool can serve:
 * past the init segment and either already buffered or the live is still
 * running (bytes will arrive). False at 0 (the normal live path) and when
 * the start is beyond anything the live can provide (finished job with a
 * short spool).
 */
export function canServeSeekFromSpool(job: LiveRemuxJob, start: number): boolean {
  if (start <= 0) return false;
  if (start < job.initSpoolOffset) return false;
  if (job.spoolBytes > start) return true;
  // Not buffered yet: only the still-running live can ever reach it.
  return !job.liveEnded;
}

export function createLiveResponse(
  job: LiveRemuxJob,
  endByte: number | null,
  signal?: AbortSignal,
  startOffset: number = 0,
): Response {
  const sub: LiveSubscriber = { notify: () => {}, detached: false };
  job.subscribers.add(sub);
  let waiter: (() => void) | null = null;
  let aborted = false;
  let abortReject: ((err: Error) => void) | null = null;
  const viewerGone = new Promise<never>((_, reject) => {
    abortReject = reject;
  });
  // Swallow: it only loses the race once the viewer is served or detached.
  viewerGone.catch(() => {});

  const detach = () => {
    if (!sub.detached) {
      sub.detached = true;
      job.subscribers.delete(sub);
      if (waiter) {
        const w = waiter;
        waiter = null;
        w();
      }
      const rej = abortReject;
      abortReject = null;
      rej?.(Object.assign(new Error('viewer detached'), { name: 'AbortError' }));
    }
  };
  if (signal) {
    signal.addEventListener('abort', () => {
      aborted = true;
      detach();
    });
  }

  async function* streamBytes(): AsyncGenerator<Buffer> {
    console.warn(`[livejob] ${job.videoId} stream open sub=${job.subscribers.size} start=${startOffset} awaitInit`);
    try {
      // The init bytes MUST be durable in the spool before anything is read
      // from it (the spool is the single source of byte-continuous truth).
      await Promise.race([job.spoolInitWritten, viewerGone]);
      console.warn(`[livejob] ${job.videoId} stream init-ready at +${Date.now() - job.xStartedAt}ms`);
      let sent = startOffset;
      for (;;) {
        if (aborted || sub.detached) return;
        // The spool is the single truth: every viewer replays the stream
        // byte-continuously from offset 0, so a request that arrives after
        // streaming started (Chrome always re-issues a start-0 request
        // during element setup) still receives a valid fMP4 from the very
        // first byte. Await the chain snapshot so appends are durable.
        const synced = job.spoolSynced;
        await Promise.race([synced, viewerGone]);
        if (aborted || sub.detached) return;
        const frontier = job.spoolBytes;
        if (frontier > sent) {
          const rs = fs.createReadStream(job.spoolPath, {
            start: sent,
            end: frontier - 1,
          });
          // A start>0 viewer skipped the spool's [0..startOffset) - the
          // existing fMP4 window. Byte-continuity comes from the HTTP
          // Content-Range contract, not from replaying those bytes.
          let readErr: Error | null = null;
          rs.on('error', (e: Error) => {
            readErr = e;
            (rs as { destroy?: () => void }).destroy?.();
          });
          for await (const chunk of rs as unknown as AsyncIterable<Buffer>) {
            if (aborted || sub.detached) return;
            if (endByte !== null && sent + chunk.length > endByte + 1) {
              const head = chunk.subarray(0, endByte + 1 - sent);
              sent += head.length;
              yield head;
              return;
            }
            sent += chunk.length;
            yield chunk;
          }
          if (readErr) throw readErr;
        }
        if (job.liveEnded) {
          if (job.liveError && sent === 0) throw job.liveError;
          return;
        }
        if (aborted || sub.detached) return;
        // Wait for more spool bytes (or the live ending).
        await new Promise<void>((r) => {
          waiter = r;
          sub.notify = () => {
            if (waiter) {
              const w = waiter;
              waiter = null;
              w();
            }
          };
        });
      }
    } catch {
      // Viewer gone or downstream torn down: never propagate (the Response
      // stream machinery treats a generator throw as a stream error, and a
      // post-abort yield crashes with "Controller is already closed").
      console.warn(`[livejob] ${job.videoId} stream threw (aborted=${aborted} detached=${sub.detached})`);
    } finally {
      console.warn(`[livejob] ${job.videoId} stream closed (aborted=${aborted} detached=${sub.detached})`);
      detach();
    }
  }

  const nodeStream = Readable.from(streamBytes() as unknown as Iterable<Uint8Array>);
  nodeStream.on('error', () => detach());
  const webOut = nodeToWebSafe(nodeStream);

  const headers = new Headers({
    'Content-Type': REMUXED_MIME_TYPE,
    'Accept-Ranges': 'none',
    'Cache-Control': 'no-store',
  });
  if (endByte !== null || startOffset > 0) {
    // Total is unknown while the live warms ('*' is valid per RFC 7233).
    // Once the live has ended the total is final: clamp the end (a viewer
    // may have asked beyond what the source actually produced).
    const effectiveEnd = endByte !== null ? Math.min(endByte, job.spoolBytes - 1) : job.spoolBytes - 1;
    const total = job.liveEnded
      ? `bytes ${startOffset}-${Math.max(startOffset, effectiveEnd)}/${job.spoolBytes}`
      : `bytes ${startOffset}-${endByte ?? ''}/*`;
    headers.set('Content-Range', total);
    headers.set('X-Media-Path', 'live-spool');
    return new Response(webOut, { status: 206, headers });
  }
  headers.set('X-Media-Path', 'live');
  return new Response(webOut, { status: 200, headers });
}

/**
 * Serve a byte range of a cached remuxed MP4. `start`/`end` must already be
 * validated against `size` (use the route's parseRange); 416 handling stays
 * with the caller so both paths share identical Range semantics.
 */
export function createCachedFileResponse(
  absPath: string,
  start: number,
  end: number,
  size: number,
  signal?: AbortSignal,
): Response {
  const nodeStream = fs.createReadStream(absPath, { start, end });
  let aborted = false;
  if (signal) {
    signal.addEventListener('abort', () => {
      aborted = true;
      nodeStream.destroy();
    });
  }
  nodeStream.on('error', (err: Error) => {
    if (!aborted && err.name !== 'AbortError') {
      console.warn(`[media] cached file stream error: ${err.name}: ${err.message.slice(0, 80)}`);
    }
  });
  const webOut = nodeToWebSafe(nodeStream);
  const partial = !(start === 0 && end === size - 1);
  const headers = new Headers({
    'Content-Type': REMUXED_MIME_TYPE,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Length': String(end - start + 1),
    'X-Media-Path': 'warm-cache',
  });
  if (partial) headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  return new Response(webOut, { status: partial ? 206 : 200, headers });
}
