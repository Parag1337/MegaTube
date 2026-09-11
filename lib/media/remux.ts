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
const PCR_TAIL_BYTES = 2 * 1024 * 1024;
/** Max extra wait for the duration probe before publishing live init. */
const PCR_PROBE_TIMEOUT_MS = 12000;

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
  let off = 0;
  let moovStart = -1;
  let moovSize = 0;
  while (off + 8 <= init.length) {
    const size = init.readUInt32BE(off);
    if (size < 8 || off + size > init.length) break;
    if (init.toString('latin1', off + 4, off + 8) === 'moov') {
      moovStart = off;
      moovSize = size;
      break;
    }
    off += size;
  }
  if (moovStart < 0) return null;
  const mvhd = findChildBox(init, moovStart, moovSize, 'mvhd');
  if (mvhd < 0) return null;
  const version = init[mvhd + 8];
  let timescale: number;
  let durationOff: number;
  let durationLen: number;
  if (version === 0) {
    if (mvhd + 24 > init.length) return null;
    timescale = init.readUInt32BE(mvhd + 20);
    durationOff = mvhd + 24;
    durationLen = 4;
  } else if (version === 1) {
    if (mvhd + 40 > init.length) return null;
    timescale = init.readUInt32BE(mvhd + 28);
    durationOff = mvhd + 32;
    durationLen = 8;
  } else {
    return null;
  }
  if (!Number.isFinite(timescale) || timescale <= 0) return null;
  const ticks = Math.round(durationSeconds * timescale);
  if (ticks <= 0) return null;
  const out = Buffer.from(init);
  if (durationLen === 4) {
    if (ticks > 0xffffffff) return null;
    out.writeUInt32BE(ticks, durationOff);
  } else {
    out.writeBigUInt64BE(BigInt(ticks), durationOff);
  }
  return out;
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

      // Exact duration via PCR differencing (head + 188-aligned tail
      // samples, fetched in parallel with the main download - typically
      // settled before ffmpeg emits the init segment, adding ~zero TTFB).
      const tailStart =
        src.size - PCR_TAIL_BYTES - ((src.size - PCR_TAIL_BYTES) % TS_PACKET);
      const durationPromise: Promise<number | null> = (async () => {
        try {
          const [headRes, tailRes] = await Promise.all([
            src.fetchCiphertext(`${src.upstreamUrl}/0-${Math.min(src.size - 1, PCR_HEAD_BYTES - 1)}`),
            src.fetchCiphertext(`${src.upstreamUrl}/${Math.max(0, tailStart)}-${src.size - 1}`),
          ]);
          if (!headRes.ok || !headRes.body || !tailRes.ok || !tailRes.body) return null;
          const [headCipher, tailCipher] = await Promise.all([
            headRes.arrayBuffer().then((b) => Buffer.from(b)),
            tailRes.arrayBuffer().then((b) => Buffer.from(b)),
          ]);
          const [headPlain, tailPlain] = await Promise.all([
            decryptBufferAtOffset(src.fileKey, headCipher, 0),
            decryptBufferAtOffset(src.fileKey, tailCipher, Math.max(0, tailStart)),
          ]);
          const found = scanTsPcrDuration(headPlain, 0, tailPlain, Math.max(0, tailStart), src.size);
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
          console.warn(
            `[media] duration probe video ${src.videoId} error: ${err instanceof Error ? `${err.name} ${err.message.slice(0, 100)}` : typeof err}`,
          );
          return null;
        }
      })();
      const durationSettled: Promise<number | null> = Promise.race([
        durationPromise,
        new Promise<number | null>((r) => setTimeout(() => r(null), PCR_PROBE_TIMEOUT_MS)),
      ]);
      // Persist exact duration even when the probe resolves after the live
      // init already went out (timeout path) - next plays use it instantly.
      durationPromise.then(
        (secs) => {
          if (secs !== null && src.durationSeconds == null) {
            try {
              src.onDurationKnown?.(secs);
            } catch {
              // persist is best-effort
            }
          }
        },
        () => {},
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
        // Publish the init segment once BOTH the raw bytes and the duration
        // verdict are in (bounded wait - first paint stays in seconds).
        // DB/fa:8 duration wins instantly; otherwise the PCR probe result.
        const publishInit = (rawInit: Buffer, tail: Buffer) => {
          if (initPublished || job.liveEnded) return;
          initPublished = true;
          const publish = (pcrSeconds: number | null) => {
            const effective = src.durationSeconds ?? pcrSeconds;
            job.initSegment =
              patchFragmentedMp4Duration(rawInit, effective) ?? rawInit;
            console.warn(
              `[livejob] ${src.videoId} init published ${job.initSegment.length}B eff=${effective ?? 'null'} at +${Date.now() - job.xStartedAt}ms`,
            );
            for (const w of job.waiters.splice(0)) w();
            if (tail.length > 0) broadcast(job, tail);
            initAccum = [];
          };
          if (src.durationSeconds != null) {
            publish(src.durationSeconds);
          } else {
            durationSettled.then(publish, () => publish(null));
          }
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
        const dir = mediaCacheDir();
        await fs.promises.rm(path.join(dir, `${src.videoId}.part.mp4`), { force: true });
        await fs.promises.rm(path.join(dir, `${src.videoId}.live.spool`), { force: true });
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
export function createLiveResponse(
  job: LiveRemuxJob,
  endByte: number | null,
  signal?: AbortSignal,
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
    console.warn(`[livejob] ${job.videoId} stream open sub=${job.subscribers.size} awaitInit`);
    try {
      // Wait for the init (guaranteed by the route's bounded preflight for
      // the FIRST viewer; a late joiner's spool replay includes it anyway).
      // NOTE: the init bytes are NOT yielded here - the spool replay below
      // starts at offset 0 and already contains them.
      await Promise.race([waitForLiveInit(job), viewerGone]);
      console.warn(`[livejob] ${job.videoId} stream init-ready at +${Date.now() - job.xStartedAt}ms`);
      let sent = 0;
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
  const webOut = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;

  const headers = new Headers({
    'Content-Type': REMUXED_MIME_TYPE,
    'Accept-Ranges': 'none',
    'Cache-Control': 'no-store',
  });
  if (endByte !== null) {
    headers.set('Content-Range', `bytes 0-${endByte}/*`);
    headers.set('X-Media-Path', 'live');
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
  const webOut = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
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
