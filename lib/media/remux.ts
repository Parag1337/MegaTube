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
import { Readable, Transform } from 'node:stream';
import {
  MAX_SOURCE_FETCH_ATTEMPTS,
  isResumeableUpstreamStatus,
  maxSourceFetchAttempts,
  reconcileSourcePrefix,
  removeSourceFrontier,
  resumeBackoffMs,
  resumeRequestParams,
  sleepAbortable,
  storeSourceFrontierAtomic,
} from './source-acquisition';

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

/**
 * Atomically replace a sidecar file (P1-B): write to a unique temp name on
 * the same filesystem, then rename over the target. Readers (cache lookup,
 * eviction, LRU touch) always see the old or the new document — never a
 * truncated partial from a crash/kill mid-write. A partial that loses its
 * writer would otherwise turn a VALID mp4 unservable until stale-reclaim
 * deletes it. Temp residue (crashed writer) matches no cache pattern and is
 * ignored by every reader; the orphan sweep removes it by age.
 */
export async function writeSidecarAtomic(sidecarPath: string, value: unknown): Promise<void> {
  const tmpPath = `${sidecarPath}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmpPath, JSON.stringify(value));
  await fs.promises.rename(tmpPath, sidecarPath);
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
   * Resolve a FRESH MEGA download URL/session for the same node (used by the
   * resumable acquisition path after a failure: stale/expired g-URLs are a
   * common cause of mid-download stalls). Called only on the failure path —
   * never for videos whose acquisition succeeds normally. Must reject when
   * no fresh URL can be obtained (the resume loop treats that as a failed
   * attempt and backs off).
   */
  refreshUpstreamUrl?: () => Promise<string>;
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

/** Drop the first `n` plaintext bytes of a stream (CTR resume overlap). */
function skipFirstBytes(n: number): Transform {
  let remaining = n;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (remaining <= 0) return cb(null, chunk);
      if (chunk.length <= remaining) {
        remaining -= chunk.length;
        return cb(null);
      }
      const rest = chunk.subarray(remaining);
      remaining = 0;
      cb(null, rest);
    },
  });
}

/**
 * Truncate a stream to exactly `n` bytes (drops any surplus tail). Guards
 * resume appends against a storage server that ignores the Range and sends
 * more than requested: the source file can never grow past the known source
 * size, so a duplicated/overlong tail cannot corrupt the prefix.
 */
function capBytes(n: number): Transform {
  let remaining = n;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (remaining <= 0) return cb(null);
      if (chunk.length <= remaining) {
        remaining -= chunk.length;
        return cb(null, chunk);
      }
      const head = chunk.subarray(0, remaining);
      remaining = 0;
      cb(null, head);
    },
  });
}

/**
 * Best-effort fsync of a file (durability before the frontier manifest is
 * allowed to advance). Never throws: callers treat fsync failure as a
 * non-fatal degradation, never as playback breakage.
 */
async function fsyncFileBestEffort(absPath: string): Promise<void> {
  try {
    const fh = await fs.promises.open(absPath, 'r');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch {
    // ignore: OS flush on close still applies; manifest ordering is kept
  }
}

/**
 * Best-effort frontier persist after bytes are durable. Records the ACTUAL
 * file length (never a speculative value). Never throws.
 */
async function persistFrontierBestEffort(
  videoId: number,
  megaNodeId: string,
  sourceSize: number,
): Promise<number> {
  try {
    const { tsPartPath } = await import('./source-acquisition');
    const stat = await fs.promises.stat(tsPartPath(videoId));
    const frontier = Math.max(0, Math.min(stat.size, sourceSize));
    if (frontier > 0 && frontier < sourceSize) {
      await fsyncFileBestEffort(tsPartPath(videoId));
      await storeSourceFrontierAtomic({ videoId, megaNodeId, sourceSize, frontier, updatedAt: '' });
    } else if (frontier >= sourceSize) {
      await removeSourceFrontier(videoId);
    }
    return frontier;
  } catch {
    return 0;
  }
}

/**
 * Pump an already-acquired plaintext prefix into ffmpeg stdin (resume jobs):
 * the new live process receives the byte-exact sequential source
 * (prefix + incoming tail), so it transmuxes exactly as if the download had
 * never been interrupted. Resolves when the prefix is fully fed; never ends
 * the destination (the tail follows).
 */
function pumpPrefixInto(prefixPath: string, frontier: number, dest: NodeJS.WritableStream): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (frontier <= 0) {
      resolve();
      return;
    }
    const rs = fs.createReadStream(prefixPath, { start: 0, end: frontier - 1 });
    rs.on('error', reject);
    rs.on('end', () => resolve());
    rs.on('data', (c: Buffer) => {
      try {
        (dest as unknown as { write: (c: Buffer) => void }).write(c);
      } catch {
        // stdin already gone - the exit handler reports the real cause
      }
    });
  });
}

/**
 * Append one ciphertext range body (plaintext after decrypt) to the source
 * file. Returns the plaintext bytes appended. Rejects on any stream error;
 * bytes already written stay on disk (the caller re-stats and resumes from
 * the true frontier — never re-fetches from 0).
 *
 * Exported for unit tests (byte-exact resume reconstruction); production
 * callers use it only through getOrCreateLiveRemuxJob.
 */
export function appendCipherRangeBody(
  body: ReadableStream<Uint8Array>,
  fileKey: Buffer,
  decryptStart: number,
  skipBytes: number,
  destPath: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { decrypt } = require('megajs') as typeof import('megajs');
    let decryptor: ReturnType<typeof import('megajs').decrypt>;
    try {
      // Partial ranges cannot MAC-verify (the MAC covers the whole file);
      // transport integrity (TLS/TCP) still applies, and the final file
      // remux validates container parsability before anything is published.
      decryptor = decrypt(fileKey, { start: decryptStart, disableVerification: true });
    } catch (err) {
      reject(err);
      return;
    }
    const nodeUpstream = Readable.fromWeb(
      body as unknown as Parameters<typeof Readable.fromWeb>[0],
    );
    const ws = fs.createWriteStream(destPath, { flags: 'a' });
    let written = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        // Never grow the source past its known size, even if upstream
        // ignores the Range and sends surplus bytes.
        const remaining = maxBytes - written;
        if (remaining <= 0) return cb(null);
        const head = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        written += head.length;
        cb(null, head);
      },
    });
    const onAbort = () => {
      try {
        nodeUpstream.destroy();
      } catch {
        // ignore
      }
      try {
        decryptor.destroy();
      } catch {
        // ignore
      }
      try {
        ws.destroy();
      } catch {
        // ignore
      }
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    // Mid-body failure (connection reset, decrypt error): preserve whatever
    // arrived BEFORE the break, then report the error. The caller re-stats
    // the file and resumes from the true frontier, so a torn tail can never
    // become a gap or a ghost claim — at worst a few KB are re-fetched with
    // the 16-byte overlap.
    //
    // Drain, don't destroy, on UPSTREAM failure: bytes already handed to the
    // decryptor are still in its input buffer (pipe delivery is synchronous;
    // transform processing is not), so destroying it would vaporize them.
    // Half-closing lets them flush through the tail into the file
    // deterministically; the file stream ends via the normal pipe cascade
    // and its finish reports the ORIGINAL error. On DECRYPTOR failure the
    // input itself is corrupt, so destroy + end (in-flight bytes are
    // untrustworthy anyway).
    let errored: unknown = null;
    let errorReported = false;
    const failAfterFlush = (err: unknown, corrupt: boolean) => {
      if (errorReported) return;
      errorReported = true;
      errored = err;
      signal?.removeEventListener('abort', onAbort);
      try {
        nodeUpstream.destroy();
      } catch {
        // ignore
      }
      if (corrupt) {
        try {
          decryptor.destroy();
        } catch {
          // ignore
        }
        try {
          ws.end();
        } catch {
          reject(err);
        }
      } else {
        // Drain the healthy decryptor: buffered ciphertext still transforms
        // out through tail -> counter -> ws; ws finishes via the cascade.
        try {
          decryptor.end();
        } catch {
          try {
            decryptor.destroy();
          } catch {
            // ignore
          }
          try {
            ws.end();
          } catch {
            reject(err);
          }
        }
      }
    };
    nodeUpstream.on('error', (err) => {
      failAfterFlush(err, false);
    });
    decryptor.on('error', (err) => {
      failAfterFlush(err, true);
    });
    ws.on('finish', () => {
      signal?.removeEventListener('abort', onAbort);
      // A finish AFTER a mid-body error is the flush completing: report the
      // original error (bytes preserved on disk) rather than success.
      if (errorReported) {
        reject(errored);
        return;
      }
      resolve(written);
    });
    ws.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      if (errorReported) {
        reject(errored);
        return;
      }
      reject(err);
    });
    let tail: Readable = decryptor as unknown as Readable;
    if (skipBytes > 0) tail = (decryptor as unknown as Readable).pipe(skipFirstBytes(skipBytes));
    nodeUpstream.pipe(decryptor as unknown as NodeJS.WritableStream);
    tail.pipe(counter).pipe(ws);
  });
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
  /**
   * One-shot waiters for init publication / live end (waitForLiveInit).
   * Woken only at init publish or endBroadcast — never per chunk.
   */
  waiters: Array<() => void>;
  /**
   * Spool-growth waiters (waitForSpoolOffset). Woken on EVERY spool growth
   * (broadcast append, init durable) and at live end via wakeSpoolWaiters;
   * each entry re-checks the frontier and re-registers itself while
   * unsatisfied, so over-waking is harmless and no waiter can be stranded
   * by growth it missed. Kept separate from `waiters`: init waiters must
   * NOT fire per chunk (an early wake would reject them as failed).
   */
  spoolWaiters: Array<() => void>;
  /**
   * Zero-subscriber shutdown state (subscriber-aware lifecycle):
   * - `dying`: shutdown decided (grace expired or explicit cancel). New
   *   requests must not join this job; getOrCreate treats it as absent.
   * - `cancelling`: teardown in progress (guards against double shutdown).
   * - `settled`: terminal teardown ran (slot released, registry cleaned).
   * - `graceTimer`: pending zero-subscriber grace countdown, if any.
   */
  dying: boolean;
  cancelling: boolean;
  settled: boolean;
  graceTimer: ReturnType<typeof setTimeout> | null;
  /** Aborts the upstream MEGA download + dependent work on cancellation. */
  abortController: AbortController;
  /** Rejects `ready` when cancelled before upstream headers arrive. */
  xReadyReject: ((err: unknown) => void) | null;
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

/**
 * Bounded slot acquisition (P0 remux-starvation fix): rejects with
 * RemuxSlotUnavailableError when no slot frees within `timeoutMs` (or when
 * `signal` aborts first), so a route handler can degrade to serving media
 * bytes another way instead of waiting forever behind an expiring preflight
 * timeout. Waiters that time out are removed from the FIFO (never handed a
 * phantom slot later); aborted browser requests release their queue place
 * the same way, so dead requests never consume a slot.
 */
export class RemuxSlotUnavailableError extends Error {
  constructor() {
    super('remux slot unavailable');
    this.name = 'RemuxSlotUnavailableError';
  }
}

export const REMUX_SLOT_WAIT_MS = 10_000;

// ---------------------------------------------------------------------------
// Temporary-media budget (P1-C): one cold job transiently holds up to ~3x
// the source size (ts.part download + live spool + part.mp4 file output)
// before publishing the final mp4. The finished-cache budget does not cover
// these, so admission also gates on temp pressure + real disk space and
// fails fast (retryable) instead of filling the disk mid-download.
// ---------------------------------------------------------------------------

/** Max bytes of temp media (*.ts.part, *.live.spool, *.part.mp4) allowed (env-overridable). */
export const DEFAULT_MEDIA_TEMP_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

export function mediaTempMaxBytes(): number {
  const raw = process.env.MEDIA_TEMP_MAX_BYTES;
  if (raw !== undefined) {
    const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/i);
    if (m) {
      const value = Number(m[1]);
      const unit = (m[2] ?? 'b').toLowerCase();
      const mult = unit === 'tb' ? 1024 ** 4 : unit === 'gb' ? 1024 ** 3 : unit === 'mb' ? 1024 ** 2 : unit === 'kb' ? 1024 : 1;
      if (Number.isFinite(value) && value > 0) return Math.floor(value * mult);
    }
  }
  return DEFAULT_MEDIA_TEMP_MAX_BYTES;
}

/** Peak temp multiplier vs source size (download + spool + file output). */
export const MEDIA_TEMP_PEAK_FACTOR = 3;
/** Floor of free disk kept for OS health beyond one job's peak need. */
export const MEDIA_TEMP_DISK_HEADROOM_BYTES = 256 * 1024 * 1024; // 256 MiB

export class MediaTempBudgetError extends Error {
  constructor() {
    super('temporary media budget exhausted');
    this.name = 'MediaTempBudgetError';
  }
}

const TEMP_FILE_RE = /^(\d+)\.(ts\.part|live\.spool|part\.mp4|ts\.frontier\.json)$/;

/** Current temp-media footprint (never throws; best-effort accounting). */
export function mediaTempUsage(): { bytes: number; files: number } {
  try {
    const dir = mediaCacheDir();
    const names = fs.readdirSync(dir);
    let bytes = 0;
    let files = 0;
    for (const name of names) {
      if (!TEMP_FILE_RE.test(name)) continue;
      try {
        const stat = fs.statSync(path.join(dir, name));
        if (stat.isFile()) {
          bytes += stat.size;
          files++;
        }
      } catch {
        // raced deletion - ignore
      }
    }
    return { bytes, files };
  } catch {
    return { bytes: 0, files: 0 };
  }
}

function diskFreeBytes(dir: string): number | null {
  try {
    const st = (fs as unknown as { statfsSync?: (p: string) => { bfree: number; bsize: number } }).statfsSync;
    if (typeof st !== 'function') return null;
    const { bfree, bsize } = st.call(fs, dir);
    if (!Number.isFinite(bfree) || !Number.isFinite(bsize) || bfree < 0 || bsize <= 0) return null;
    return bfree * bsize;
  } catch {
    return null;
  }
}

/**
 * Fail-fast admission for a new cold job (P1-C): throws
 * MediaTempBudgetError when temp pressure or real disk space cannot cover
 * this job's peak (~3x source + headroom). Fail-OPEN on any telemetry
 * failure: never break playback because a stat call failed. Callers map
 * the error to a retryable 503 (the job warms nothing and registers
 * nothing, so a retry later can succeed).
 */
export function checkMediaTempBudget(sourceSize: number): void {
  const need = Math.ceil(Number(sourceSize) * MEDIA_TEMP_PEAK_FACTOR);
  if (!Number.isFinite(need) || need < 0) return;
  const dir = mediaCacheDir();
  try {
    const usage = mediaTempUsage();
    if (usage.bytes + need > mediaTempMaxBytes()) {
      throw new MediaTempBudgetError();
    }
  } catch (err) {
    if (err instanceof MediaTempBudgetError) throw err;
    // accounting failure -> fall through to the disk check, then fail open
  }
  const free = diskFreeBytes(dir);
  if (free !== null && free < need + MEDIA_TEMP_DISK_HEADROOM_BYTES) {
    throw new MediaTempBudgetError();
  }
}

export async function tryAcquireRemuxSlot(
  timeoutMs: number = REMUX_SLOT_WAIT_MS,
  signal?: AbortSignal,
): Promise<void> {
  // A pre-aborted viewer must never consume a slot: check BEFORE the
  // fast-path grant, otherwise an aborted request steals pool capacity.
  if (signal?.aborted) throw new RemuxSlotUnavailableError();
  if (activeRemux < MAX_CONCURRENT_REMUX) {
    activeRemux++;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = remuxWaiters.indexOf(onGrant);
      if (idx >= 0) remuxWaiters.splice(idx, 1);
      cleanup();
      reject(new RemuxSlotUnavailableError());
    }, timeoutMs);
    const onAbort = () => {
      const idx = remuxWaiters.indexOf(onGrant);
      if (idx >= 0) remuxWaiters.splice(idx, 1);
      cleanup();
      reject(new RemuxSlotUnavailableError());
    };
    const onGrant = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    // FIFO note: timed waiters reuse the same queue as unbounded waiters.
    // A timed waiter that reaches the head is granted the slot immediately
    // like any other waiter; only expiry/abort removes it early.
    remuxWaiters.push(onGrant);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  activeRemux++;
}

function releaseRemuxSlot(): void {
  // Guarded: timed-out/aborted waiters are removed from the FIFO before they
  // are ever granted a slot, but release paths run in finally blocks that can
  // overlap job teardown — never let the counter go negative and poison
  // future admission.
  activeRemux = Math.max(0, activeRemux - 1);
  const next = remuxWaiters.shift();
  if (next) next();
}

/** Admission stats for the route's fail-fast path (P0: never burn the whole
 *  preflight budget queued behind a saturated remux pool). */
export function getRemuxSlotStats(): { active: number; max: number; queued: number } {
  return { active: activeRemux, max: MAX_CONCURRENT_REMUX, queued: remuxWaiters.length };
}

export function getLiveRemuxStats(): { active: number; videoIds: number[] } {
  return {
    active: liveJobs.size,
    videoIds: [...liveJobs.keys()],
  };
}

/**
 * Wake every registered spool-offset waiter. Each waiter re-checks the
 * frontier against its target and re-registers itself while unsatisfied, so
 * waking early or often is harmless; never waking strands seekers. Called
 * on every spool growth (broadcast append, init durable) and at live end.
 */
export function wakeSpoolWaiters(job: LiveRemuxJob): void {
  for (const w of job.spoolWaiters.splice(0)) {
    try {
      w();
    } catch {
      // A waiter must never break the broadcast loop.
    }
  }
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
      // P0-B: spool growth must wake offset waiters (they re-check the
      // frontier and re-register while unsatisfied).
      wakeSpoolWaiters(job);
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
  wakeSpoolWaiters(job);
}

/**
 * Zero-subscriber grace period (subscriber-aware lifecycle): when the last
 * viewer leaves, the job is NOT killed immediately — a short window absorbs
 * remounts/retries/refreshes (the P1.3 player typically returns within
 * seconds). Only a job still unwatched when the window expires is
 * cancelled. Configurable; default 10 s.
 */
export const ZERO_SUBSCRIBER_GRACE_MS = 10_000;

export function zeroSubscriberGraceMs(): number {
  const n = Number(process.env.MEDIA_ZERO_SUBSCRIBER_GRACE_MS);
  return Number.isFinite(n) && n >= 0 ? n : ZERO_SUBSCRIBER_GRACE_MS;
}

/**
 * Intentional lifecycle cancellation (zero subscribers, grace expired).
 * Named (not a generic Error) so logs/teardown treat it as normal cleanup
 * rather than a server failure — never a 502/503 cause by itself.
 */
export class LiveJobCancelledError extends Error {
  constructor(reason = 'zero subscribers') {
    super(`live remux cancelled: ${reason}`);
    this.name = 'LiveJobCancelledError';
  }
}

/**
 * A viewer attached: cancel any pending grace shutdown. Idempotent —
 * attaching twice (or attaching to a job with no timer) is a no-op.
 */
export function noteSubscriberAttached(job: LiveRemuxJob): void {
  cancelGraceTimer(job);
}

/**
 * A viewer detached: when the count reaches zero, arm the grace countdown.
 * Detaching an already-removed viewer is harmless (set semantics + size
 * check), so duplicate cleanup can never corrupt the lifecycle.
 */
export function noteSubscriberDetached(job: LiveRemuxJob): void {
  if (job.subscribers.size === 0) armGraceTimer(job);
}

/** Cancel a pending grace countdown (new interest arrived). */
export function cancelGraceTimer(job: LiveRemuxJob): void {
  if (job.graceTimer !== null) {
    clearTimeout(job.graceTimer);
    job.graceTimer = null;
  }
}

/**
 * Arm the zero-subscriber grace countdown. No-op unless the job is alive,
 * unwatched, and has no timer running. At expiry the job is cancelled iff
 * still unwatched (a concurrent attach cancels first — see
 * noteSubscriberAttached); expiry always re-checks instead of trusting
 * decade-old state.
 */
function armGraceTimer(job: LiveRemuxJob): void {
  if (job.graceTimer !== null) return;
  if (job.dying || job.cancelling || job.settled || job.liveEnded) return;
  if (job.subscribers.size > 0) return;
  const waitMs = zeroSubscriberGraceMs();
  job.graceTimer = setTimeout(() => {
    job.graceTimer = null;
    // Re-verify: an attach racing expiry cancels the timer, so reaching
    // here with subscribers means the cancel was missed — stand down and
    // let the next detach re-arm instead of killing a watched job.
    if (job.subscribers.size > 0 || job.dying || job.cancelling || job.settled || job.liveEnded) return;
    cancelLiveRemuxJob(job, 'zero-subscriber grace expired');
  }, waitMs);
}

/**
 * Retain a job for server-owned background work (e.g. the MP4 cache-warm
 * path, which never creates a viewer response). The holder counts as a
 * subscriber so the grace logic leaves warm jobs alone; release it when
 * the job settles. The returned release is idempotent.
 */
export function retainLiveRemuxJob(job: LiveRemuxJob): () => void {
  const holder: LiveSubscriber = { notify: () => {}, detached: false };
  job.subscribers.add(holder);
  cancelGraceTimer(job);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holder.detached = true;
    job.subscribers.delete(holder);
    noteSubscriberDetached(job);
  };
}

/**
 * Cancel a live job: abort upstream work, end the broadcast, remove the
 * registry entry. Idempotent via cancelling/settled guards — safe to call
 * from the grace timer, error paths, and tests concurrently.
 *
 * Slot release is DELIBERATELY not done here: the job's own finally owns
 * the single releaseRemuxSlot call, so cancellation can never double-
 * release (or leak: aborting the download forces the pipeline through
 * catch -> fail -> finally promptly).
 */
export function cancelLiveRemuxJob(job: LiveRemuxJob, reason = 'zero subscribers'): void {
  if (job.cancelling || job.settled) return;
  job.cancelling = true;
  job.dying = true;
  cancelGraceTimer(job);
  if (liveJobs.get(job.videoId) === job) liveJobs.delete(job.videoId);
  const err = new LiveJobCancelledError(reason);
  try {
    job.abortController.abort();
  } catch {
    // ignore
  }
  try {
    job.xReadyReject?.(err);
  } catch {
    // ignore
  }
  console.log(`[livejob] ${job.videoId} cancelled (${reason}) at +${Date.now() - job.xStartedAt}ms`);
  endBroadcast(job, err);
}

/**
 * Get (or start) the single live remux pipeline for a video. The pipeline
 * is server-owned: it runs to completion (or bounded failure) regardless of
 * individual viewers disconnecting, so a refresh always finds a warm cache.
 */
export function getOrCreateLiveRemuxJob(src: RemuxSource): LiveRemuxJob {
  const existing = liveJobs.get(src.videoId);
  // A dying job (grace-expired shutdown in progress) must never be handed
  // out: the caller creates a fresh pipeline instead. Brief download
  // overlap during teardown is bounded and safe (old upstream is aborted;
  // temp cleanup is identity-guarded in the job finally).
  if (existing && !existing.dying) return existing;

  // P1-C admission BEFORE registering: a rejected job warms nothing,
  // registers nothing, and holds no slot — callers answer retryable 503
  // and a later retry can succeed. Joins of running jobs bypass this
  // (their resources are already committed).
  checkMediaTempBudget(src.size);

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
    spoolWaiters: [],
    dying: false,
    cancelling: false,
    settled: false,
    graceTimer: null,
    abortController: new AbortController(),
    xReadyReject: null,
    xJoinedCount: 0,
  };
  console.warn(`[livejob] ${src.videoId} start size=${src.size}`);
  liveJobs.set(src.videoId, job);
  // NOTE: no grace timer is armed here. Arming happens only when interest
  // demonstrably empties: a subscriber detaching to zero, a waiter settling
  // with nobody attached, or a request leaving the live section without
  // attaching (route finally). Arming at creation would race the creator's
  // own preflight (session + a=g + sniff + ready + init can exceed any
  // safe grace bound on slow MEGA) and self-cancel healthy new jobs.
  // Warm jobs retain an explicit holder instead (see retainLiveRemuxJob).
  armGraceTimer(job);
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
    // Intentional lifecycle cancellation is normal cleanup, not a server
    // failure: log quietly so it never looks like a 502/503 cause. This
    // covers both the explicit cancel error and an AbortError arriving
    // after cancellation was decided (abort racing a genuine fetch).
    const quiet =
      err instanceof LiveJobCancelledError ||
      (job.cancelling && err instanceof Error && err.name === 'AbortError');
    if (quiet) {
      console.log(`[livejob] ${src.videoId} cancelled: ${detail}`);
    } else {
      console.warn(`[media] live remux video ${src.videoId} failed: ${detail}`);
    }
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
    // The cancellation path already broadcast the terminal state; a second
    // endBroadcast would only re-notify (harmless but noisy), so skip it.
    if (!job.liveEnded) {
      endBroadcast(job, err instanceof Error ? err : new Error(String(err)));
    }
    return null;
  };

  let liveProc: ChildProcess | null = null;
  let readyResolve: () => void = () => {};
  let readyReject: (err: unknown) => void = () => {};
  job.ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  // Cancellation before upstream headers must fail the preflight promptly
  // (instead of hanging it until the route timeout): rejecting a settled
  // promise is a no-op, so no resolved-state tracking is needed.
  job.xReadyReject = (err: unknown) => readyReject(err);
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
    // P0: bounded admission — a saturated pool must fail this job fast (so
    // the route can answer honestly with 503+Retry-After) instead of parking
    // it in an unbounded FIFO while every viewer-facing timeout expires.
    //
    // Phase 6 invariant: the finally below is the ONLY releaser, but it
    // must release ONLY what was acquired — a failed acquisition followed
    // by an unconditional release would hand out a phantom slot.
    let slotHeld = false;
    try {
      await tryAcquireRemuxSlot(REMUX_SLOT_WAIT_MS);
      slotHeld = true;
    } catch (err) {
      readyReject(err);
      return fail(err);
    }
    const startedAt = Date.now();
    try {
      const dir = mediaCacheDir();
      await fs.promises.mkdir(dir, { recursive: true });
      const { mp4Path, sidecarPath } = remuxCachePaths(src.videoId);
      const tsTmp = path.join(dir, `${src.videoId}.ts.part`);
      // Temp output MUST keep a .mp4 extension: ffmpeg infers the muxer
      // from the filename and rejects unknown extensions like `.part`.
      const mp4Tmp = path.join(dir, `${src.videoId}.part.mp4`);

      // Publish a fully-acquired source to the faststart cache (shared by
      // the first-attempt path and the background resume path below).
      const publishFinishedCache = async (): Promise<{ path: string; size: number } | null> => {
        try {
          await runFfmpegRemux(tsTmp, mp4Tmp);
        } catch (err) {
          // Poison valve: a complete source that cannot be remuxed is either
          // corrupt (e.g. resumed bytes that fail the container parse) or
          // untransmuxable input. Keeping it would poison every future visit
          // (the locally-complete shortcut would trust it forever without
          // ever hitting MEGA again). Discard prefix + manifest so the next
          // job retries from scratch — exactly today's failure outcome.
          console.warn(
            `[livejob] ${src.videoId} cache publish failed — discarding source prefix: ${err instanceof Error ? `${err.name} ${err.message.slice(0, 100)}` : typeof err}`,
          );
          await fs.promises.rm(tsTmp, { force: true });
          try {
            await removeSourceFrontier(src.videoId);
          } catch {
            // ignore cleanup errors
          }
          throw err;
        }
        const stat = await fs.promises.stat(mp4Tmp);
        if (stat.size <= 0) throw new Error('ffmpeg produced an empty file');
        await fs.promises.rename(mp4Tmp, mp4Path);
        // P1-B: the mp4 rename above is atomic; the sidecar MUST be too (see
        // the original comment preserved on the call below).
        await writeSidecarAtomic(sidecarPath, {
          megaNodeId: src.megaNodeId,
          sourceSize: src.size,
          outputSize: stat.size,
          lastAccessedAt: new Date().toISOString(),
        });
        await fs.promises.rm(tsTmp, { force: true });
        try {
          await removeSourceFrontier(src.videoId);
        } catch {
          // ignore cleanup errors
        }
        return { path: mp4Path, size: stat.size };
      };

      /**
       * Background source recovery (Phase 1): extend the preserved plaintext
       * prefix `startFrontier -> src.size` with sequential, 16-aligned range
       * fetches against a fresh URL when needed. File-only work: the live
       * ffmpeg/spool from Phase A is already settled (current viewers keep
       * their valid prefix); this loop only completes the source file and
       * then rejoins the normal publish path. Bounded attempts + backoff, no
       * parallel fan-out, no restart from 0. On exhaustion the partial prefix
       * is KEPT (fail preserves it in the finally below).
       */
      const runBackgroundResume = async (
        startFrontier: number,
      ): Promise<{ path: string; size: number } | null> => {
        let frontier = startFrontier;
        let baseUrl = src.upstreamUrl;
        let consecutiveFailures = 0;
        // 403/404 budget: a genuinely gone node must fail fast with its
        // status (so seekers get an honest answer) instead of burning every
        // attempt on fresh-URL retries. Transport stalls keep the full budget.
        let notFoundCount = 0;
        let attempts = 1; // Phase A counts as the first attempt
        const maxAttempts = maxSourceFetchAttempts();
        while (frontier < src.size) {
          if (attempts >= maxAttempts) {
            console.warn(
              `[livejob] ${src.videoId} resume budget exhausted at frontier=${frontier}/${src.size} — keeping partial prefix`,
            );
            return fail(new Error(`incomplete source: got ${frontier} of ${src.size} bytes after ${attempts} attempts`));
          }
          if (job.abortController.signal.aborted) {
            return fail(new LiveJobCancelledError('zero subscribers'));
          }
          attempts++;
          const p = resumeRequestParams(frontier, src.size);
          let res: Response | null = null;
          try {
            res = await src.fetchCiphertext(
              `${baseUrl}/${p.rangeStart}-${src.size - 1}`,
              job.abortController.signal,
            );
          } catch (err) {
            consecutiveFailures++;
            console.warn(
              `[livejob] ${src.videoId} resume fetch threw (attempt ${attempts}/${MAX_SOURCE_FETCH_ATTEMPTS}): ${err instanceof Error ? `${err.name} ${err.message.slice(0, 80)}` : typeof err}`,
            );
            if (src.refreshUpstreamUrl) {
              try {
                baseUrl = await src.refreshUpstreamUrl();
              } catch {
                // refresh failure is just another failed attempt
              }
            }
            await sleepAbortable(resumeBackoffMs(consecutiveFailures), job.abortController.signal).catch(() => {});
            continue;
          }
          if (!res.ok || !res.body) {
            const st = res.status;
            try {
              await res.body?.cancel();
            } catch {
              // ignore
            }
            consecutiveFailures++;
            if (st === 403 || st === 404) {
              notFoundCount++;
              if (notFoundCount > 2) {
                console.warn(
                  `[livejob] ${src.videoId} resume upstream ${st} persists at frontier=${frontier} — failing with status`,
                );
                return fail(Object.assign(new Error(`upstream ${st}`), { upstreamStatus: st }));
              }
            }
            if (isResumeableUpstreamStatus(st)) {
              console.warn(
                `[livejob] ${src.videoId} resume upstream ${st} at frontier=${frontier} (attempt ${attempts}/${MAX_SOURCE_FETCH_ATTEMPTS}) — backing off`,
              );
              if ((st === 403 || st === 404 || (st >= 500 && st !== 509)) && src.refreshUpstreamUrl) {
                try {
                  baseUrl = await src.refreshUpstreamUrl();
                } catch {
                  // refresh failure is just another failed attempt
                }
              }
              await sleepAbortable(resumeBackoffMs(consecutiveFailures), job.abortController.signal).catch(() => {});
              continue;
            }
            return fail(Object.assign(new Error(`upstream ${st}`), { upstreamStatus: st }));
          }
          try {
            const written = await appendCipherRangeBody(
              res.body as unknown as ReadableStream<Uint8Array>,
              src.fileKey,
              p.decryptStart,
              p.skipBytes,
              tsTmp,
              Math.max(0, src.size - frontier),
              job.abortController.signal,
            );
            const st = await fs.promises.stat(tsTmp).catch(() => null);
            frontier = st ? Math.max(0, Math.min(st.size, src.size)) : frontier + written;
            await fsyncFileBestEffort(tsTmp);
            try {
              await storeSourceFrontierAtomic({
                videoId: src.videoId,
                megaNodeId: src.megaNodeId,
                sourceSize: src.size,
                frontier,
                updatedAt: '',
              });
            } catch {
              // manifest lag is safe: the file length stays the truth
            }
            consecutiveFailures = 0;
            console.warn(`[livejob] ${src.videoId} resume progress frontier=${frontier}/${src.size}`);
          } catch (err) {
            if (
              job.abortController.signal.aborted ||
              (err instanceof Error && (err.name === 'AbortError' || err instanceof LiveJobCancelledError))
            ) {
              return fail(err);
            }
            consecutiveFailures++;
            const st = await fs.promises.stat(tsTmp).catch(() => null);
            if (st) {
              frontier = Math.max(0, Math.min(st.size, src.size));
              try {
                await storeSourceFrontierAtomic({
                  videoId: src.videoId,
                  megaNodeId: src.megaNodeId,
                  sourceSize: src.size,
                  frontier,
                  updatedAt: '',
                });
              } catch {
                // ignore
              }
            }
            console.warn(
              `[livejob] ${src.videoId} resume append failed at frontier=${frontier} (attempt ${attempts}/${MAX_SOURCE_FETCH_ATTEMPTS}): ${err instanceof Error ? `${err.name} ${err.message.slice(0, 80)}` : typeof err}`,
            );
            if (src.refreshUpstreamUrl) {
              try {
                baseUrl = await src.refreshUpstreamUrl();
              } catch {
                // ignore
              }
            }
            await sleepAbortable(resumeBackoffMs(consecutiveFailures), job.abortController.signal).catch(() => {});
            continue;
          }
        }
        console.log(
          `[media] live remux download video ${src.videoId}: ${(src.size / 1048576).toFixed(1)} MB in ${Date.now() - startedAt}ms (completed via resume)`,
        );
        return publishFinishedCache();
      };

      // 1. Resumable source acquisition (Phase 1): reconcile any preserved
      // prefix from an earlier interrupted attempt. Fresh videos reconcile
      // to frontier 0 and behave EXACTLY as before (single 0..SIZE-1 fetch,
      // MAC-verified, teed to the cache file AND live ffmpeg). Resume jobs
      // start from the actual file length with a 16-aligned range and skip
      // the CTR overlap AFTER decryption — never a restart from 0.
      // The fetch runs through the caller's retry wrapper; a reached-here
      // non-OK status (509 bandwidth, 404/410 gone) is reported via
      // job.ready so the route can answer honest JSON BEFORE headers.
      // The job abort signal lets zero-subscriber cancellation stop the
      // download promptly instead of running it to completion unwatched.
      const reconciled = await reconcileSourcePrefix(src.videoId, src.megaNodeId, src.size);
      const initialFrontier = reconciled.frontier;
      if (reconciled.resumed) {
        console.warn(`[livejob] ${src.videoId} resuming source acquisition at frontier=${initialFrontier}/${src.size}`);
      }
      const firstParams = resumeRequestParams(initialFrontier, src.size);
      // Crash-between-download-and-publish recovery: the source is already
      // complete on disk — serve live from the file and skip MEGA entirely
      // (no fetch, no extra request).
      const sourceCompleteLocally = src.size > 0 && initialFrontier >= src.size;
      const upstream = sourceCompleteLocally
        ? null
        : await src.fetchCiphertext(
            `${src.upstreamUrl}/${firstParams.rangeStart}-${src.size - 1}`,
            job.abortController.signal,
          );
      if (!sourceCompleteLocally && (!upstream || !upstream.ok || !upstream.body)) {
        const st = upstream?.status ?? 0;
        const err = Object.assign(new Error(`upstream ${st}`), {
          upstreamStatus: st,
          retryAfter: st === 509 ? (upstream?.headers.get('x-mega-time-left') ?? null) : null,
        });
        if (initialFrontier > 0) {
          // A preserved prefix exists: keep it (persist the frontier for
          // crash safety) and recover in the background against a fresh URL.
          // The route already answers honestly from `ready`.
          await persistFrontierBestEffort(src.videoId, src.megaNodeId, src.size);
          readyReject(err);
          return runBackgroundResume(initialFrontier);
        }
        readyReject(err);
        return fail(err);
      }
      if (sourceCompleteLocally) {
        console.warn(`[livejob] ${src.videoId} source already complete locally (${src.size}B) — skipping MEGA download`);
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
      // Resumable acquisition (Phase 1): MAC verification is ALWAYS off in
      // the live pipeline. The MAC covers the whole file and can only be
      // checked at stream end — after the viewer already consumed the prefix
      // — so it never protected live viewers; and any truncation (the 1:17
      // stall shape) turns into a MAC error that destroys the prefix instead
      // of a clean EOF we can resume from. Integrity is enforced where it
      // matters: exact source size + successful container remux before
      // anything is published to the cache (poison valve discards
      // complete-but-untransmuxable sources). The direct-MP4 path keeps its
      // own MAC convention untouched.
      const resumeMode = !sourceCompleteLocally && initialFrontier > 0;
      const decryptor = decrypt(src.fileKey, {
        start: resumeMode ? firstParams.decryptStart : 0,
        disableVerification: true,
      });
      const nodeUpstream = sourceCompleteLocally || !upstream?.body
        ? null
        : Readable.fromWeb(
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
          // from offset 0.
          //
          // ATOMICITY (P0-A root cause): init AND tail are appended inside a
          // SINGLE chain link that never re-reads job.spoolSynced. The old
          // code chained the tail append onto the then-current spoolSynced,
          // so a fragment broadcast landing between the two microtask steps
          // chained AHEAD of the tail: the first post-init chunk (moof #1)
          // ended up at EOF and every viewer received init + raw mdat
          // payload with no moof -> Chrome FFmpegDemuxer seek failure at
          // readyState 0. With one link, broadcasts can only chain after the
          // complete init+tail unit, so the spool is always a byte-exact
          // prefix of ffmpeg's stdout.
          job.spoolSynced = job.spoolSynced
            .catch(() => {})
            .then(async () => {
              await fs.promises.appendFile(job.spoolPath, job.initSegment as Buffer);
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
                await fs.promises.appendFile(job.spoolPath, tail);
                job.spoolBytes += tail.length;
              }
              wakeSpoolWaiters(job);
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

      // Phase A: live download attempt. Fresh jobs (frontier 0) run EXACTLY
      // the original pipeline: network plaintext tees to the cache file and
      // live ffmpeg. Resume jobs first pump the preserved prefix into the
      // new ffmpeg stdin (byte-exact sequential source), then tee the tail.
      // Locally-complete sources pump the whole file with no network at all.
      const downloadDone = (async (): Promise<void> => {
        if (sourceCompleteLocally || initialFrontier > 0) {
          if (job.abortController.signal.aborted) {
            throw new LiveJobCancelledError('zero subscribers');
          }
          await pumpPrefixInto(tsTmp, initialFrontier, ffIn);
        }
        if (sourceCompleteLocally || !nodeUpstream) {
          try {
            if (!ffIn.destroyed) ffIn.end();
          } catch {
            // ignore
          }
          return;
        }
        await new Promise<void>((resolvePipe, rejectPipe) => {
          const ws = fs.createWriteStream(tsTmp, { flags: initialFrontier > 0 ? 'a' : 'w' });
          // Mid-body failure: preserve what arrived (drain, then report) so
          // the background resume inherits the true frontier instead of a
          // torn shortfall. A finish after an error is the drain completing —
          // the original error still wins. Drain (not destroy) on upstream
          // failure; destroy only on corrupt decryptor output. See
          // appendCipherRangeBody for the full rationale.
          let pipeError: unknown = null;
          let pipeErrored = false;
          const failPipeAfterFlush = (err: unknown, corrupt: boolean) => {
            if (pipeErrored) return;
            pipeErrored = true;
            pipeError = err;
            try {
              nodeUpstream.destroy();
            } catch {
              // ignore
            }
            if (corrupt) {
              try {
                decryptor.destroy();
              } catch {
                // ignore
              }
              try {
                ws.end();
              } catch {
                rejectPipe(err);
              }
            } else {
              try {
                decryptor.end();
              } catch {
                try {
                  decryptor.destroy();
                } catch {
                  // ignore
                }
                try {
                  ws.end();
                } catch {
                  rejectPipe(err);
                }
              }
            }
          };
          nodeUpstream.on('error', (err) => failPipeAfterFlush(err, false));
          decryptor.on('error', (err) => failPipeAfterFlush(err, true));
          ws.on('finish', () => {
            if (pipeErrored) {
              rejectPipe(pipeError);
              return;
            }
            resolvePipe();
          });
          ws.on('error', (err) => {
            if (pipeErrored) {
              rejectPipe(pipeError);
              return;
            }
            rejectPipe(err);
          });
          // Zero-subscriber cancellation tears the pipeline down promptly.
          // Stream destroy alone does not reliably reject (plain destroy()
          // emits 'close', not 'error'), so reject explicitly too: promise
          // settlement is once-only, so a later genuine outcome is unaffected.
          // Rejection flows through the normal fail -> finally path (single
          // slot release, guarded temp cleanup). No-ops when already finished.
          const onJobAbort = () => {
            try {
              nodeUpstream.destroy();
            } catch {
              // ignore
            }
            try {
              decryptor.destroy();
            } catch {
              // ignore
            }
            try {
              ws.destroy();
            } catch {
              // ignore
            }
            rejectPipe(new LiveJobCancelledError('zero subscribers'));
          };
          if (job.abortController.signal.aborted) {
            onJobAbort();
          } else {
            job.abortController.signal.addEventListener('abort', onJobAbort, { once: true });
          }
          // The CTR overlap (resumeMode) is skipped AFTER decryption: the
          // keystream is positioned by decryptStart, so the decryptor must
          // see the ciphertext exactly as stored, and ffmpeg/the file must
          // see only the new bytes.
          let tailPlain: Readable = decryptor as unknown as Readable;
          if (firstParams.skipBytes > 0) {
            tailPlain = (decryptor as unknown as Readable).pipe(skipFirstBytes(firstParams.skipBytes));
          }
          // Cap the tail at exactly the missing bytes (same surplus guard as
          // the background path): the file can never exceed the source size.
          const cappedTail = tailPlain.pipe(capBytes(Math.max(0, src.size - initialFrontier)));
          cappedTail.on('data', (c: Buffer) => {
            if (!ffIn.destroyed) {
              try {
                ffIn.write(c);
              } catch {
                // stdin already gone - download still completes for the cache
              }
            }
          });
          cappedTail.on('end', () => {
            try {
              ffIn.end();
            } catch {
              // ignore
            }
          });
          nodeUpstream.pipe(decryptor as unknown as NodeJS.WritableStream);
          cappedTail.pipe(ws);
        });
      })();

      let phaseAErr: unknown = null;
      try {
        await downloadDone;
      } catch (err) {
        phaseAErr = err;
      }
      // Trustworthy frontier: the actual durable file length (the manifest
      // may lag; it is healed here). Never a speculative value.
      const acquired = await persistFrontierBestEffort(src.videoId, src.megaNodeId, src.size);
      const cancelled =
        job.abortController.signal.aborted ||
        phaseAErr instanceof LiveJobCancelledError ||
        (phaseAErr instanceof Error && phaseAErr.name === 'AbortError');
      if (cancelled) {
        return fail(phaseAErr ?? new LiveJobCancelledError('zero subscribers'));
      }
      if (phaseAErr || acquired !== src.size) {
        if (acquired > 0 && acquired < src.size) {
          // Partial prefix preserved (the 1:17 stall shape, whether the pipe
          // errored or EOFed cleanly short). Current viewers keep their valid
          // output; recovery continues in the background and rejoins the
          // normal publish path when the source completes.
          console.warn(
            `[livejob] ${src.videoId} phase-A incomplete at frontier=${acquired}/${src.size} — continuing in background`,
          );
          try {
            if (!ffIn.destroyed) ffIn.end();
          } catch {
            // ignore
          }
          await Promise.race([liveDone, sleepAbortable(15_000).catch(() => {})]);
          if (!job.liveEnded) {
            endBroadcast(job, phaseAErr ?? new Error(`truncated download: got ${acquired} of ${src.size} bytes`));
          }
          try {
            liveProc?.kill('SIGKILL');
          } catch {
            // ignore
          }
          // Await (not bare-return): the finally below tears down the
          // registry entry, slot, and temps, so it must run AFTER the
          // background recovery + publish settle — otherwise
          // hasLiveRemuxJob==false would be observable while recovery is
          // still running (duplicate jobs, premature temp assertions).
           
          return await runBackgroundResume(acquired);
        }
        if (phaseAErr && acquired >= src.size && src.size > 0) {
          // Complete-but-broken: every byte arrived yet the pipe failed
          // (decrypt/MAC failure on untransmuxable input). Resuming cannot
          // help (nothing is missing) and keeping it would poison the
          // locally-complete shortcut — discard so the next job retries
          // from scratch. The finally below then finds no residue.
          await fs.promises.rm(tsTmp, { force: true });
          try {
            await removeSourceFrontier(src.videoId);
          } catch {
            // ignore cleanup errors
          }
        }
        return fail(
          phaseAErr ?? new Error(`truncated download: got ${acquired} of ${src.size} bytes`),
        );
      }
      console.log(
        `[media] live remux download video ${src.videoId}: ${(src.size / 1048576).toFixed(1)} MB in ${Date.now() - startedAt}ms`,
      );
      await liveDone;
      endBroadcast(job, liveFailed ? job.liveError ?? new Error('live transmux failed') : null);

      // 2. Faststart cache publish for seeks/refresh (stream-copy, fast).
      // Await (not bare-return): the finally below must run AFTER publish
      // settles, so hasLiveRemuxJob==false implies the final temp state.
       
      return await publishFinishedCache();
    } catch (err) {
      readyReject(err);
      return fail(err);
    } finally {
      // Single slot release: this finally is the ONLY releaser, and only
      // when acquisition succeeded. Cancellation never releases directly —
      // it aborts the download, which funnels through catch -> fail ->
      // here exactly once per job.
      if (slotHeld) releaseRemuxSlot();
      job.settled = true;
      cancelGraceTimer(job);
      // NOTE: the registry entry is removed AFTER temp cleanup below (not
      // here): tests and the route poll hasLiveRemuxJob to know the job is
      // fully torn down, and the temp-file assertions must observe the final
      // state (poison-valve discard / prefix preserve), not a mid-cleanup
      // window. The identity guard on cleanup still sees this job in the map
      // while it runs, which is exactly the "own files" case.
      try {
        liveJobProbeAborts.get(job)?.abort();
      } catch {
        // ignore
      }
      // Bug 6: this job's temp files must never outlive it — EXCEPT the
      // resumable source prefix. The .ts.part bytes + frontier manifest are
      // intentionally PRESERVED on failure/cancel so the next job resumes
      // from the true frontier instead of restarting at 0 (Phase 1). They
      // are removed only by publish (success), identity mismatch
      // (reconcile), or the 2h temp-orphan sweep. The spool is still removed
      // (the next job rebuilds it from the preserved source); a successful
      // cache (mp4Path + sidecar) is untouched.
      //
      // Identity-guarded: temp names are per-videoId, so a FRESHER job for
      // the same video (created after this one was evicted/cancelled) may
      // already own them — never delete another live job's working files.
      // (A fresher job cleans its own temps in its own finally.)
      try {
        if (liveJobs.get(src.videoId) === undefined || liveJobs.get(src.videoId) === job) {
          const dir = mediaCacheDir();
          await Promise.all([
            fs.promises.rm(path.join(dir, `${src.videoId}.part.mp4`), { force: true }),
            fs.promises.rm(path.join(dir, `${src.videoId}.live.spool`), { force: true }),
          ]);
          // Preserve genuine progress; drop only empty/absent prefixes (same
          // residue-free outcome as before when nothing was obtained).
          const partPath = path.join(dir, `${src.videoId}.ts.part`);
          const partStat = await fs.promises.stat(partPath).catch(() => null);
          if (!partStat || partStat.size <= 0) {
            await fs.promises.rm(partPath, { force: true });
            try {
              await removeSourceFrontier(src.videoId);
            } catch {
              // ignore
            }
          } else {
            await persistFrontierBestEffort(src.videoId, src.megaNodeId, src.size);
          }
        }
      } catch {
        // ignore cleanup errors
      }
      // Registry removal LAST: hasLiveRemuxJob==false now implies temp
      // cleanup (including poison-valve discard) already ran.
      if (liveJobs.get(src.videoId) === job) liveJobs.delete(src.videoId);
    }
  })();

  return job;
}

/**
 * Evict a dead live remux job so a retry can start fresh (P0 transient-404
 * handling: the failed job's upstream URL may be stale; the replacement job
 * is created against a freshly resolved URL and cannot be poisoned by the
 * old one). Only removes the exact job object passed — never a newer job
 * that raced in for the same video. No-op when the map already holds
 * something else (e.g. the dead job already tore down).
 */
export function evictLiveRemuxJob(videoId: number, job: LiveRemuxJob): void {
  if (liveJobs.get(videoId) === job) liveJobs.delete(videoId);
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
 * <id>.json) are never touched.
 *
 * Resumable-acquisition aware: a `<id>.ts.part` WITH a plausible frontier
 * manifest (`<id>.ts.frontier.json` parsing + frontier > 0 + file length >
 * 0) is a crash-interrupted download, NOT garbage — it is KEPT so the next
 * job resumes from the true frontier (process-restart recovery). The next
 * job re-validates identity (node/size) before trusting a single byte.
 * Dangling manifests (no surviving part) and writer tmp residue are removed.
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
  const nameSet = new Set(names);
  let removed = 0;
  let kept = 0;
  const resumablePart = async (name: string): Promise<boolean> => {
    const m = name.match(/^(\d+)\.ts\.part$/);
    if (!m) return false;
    try {
      const manifestRaw = await fs.promises.readFile(
        path.join(dir, `${m[1]}.ts.frontier.json`),
        'utf8',
      );
      const manifest = JSON.parse(manifestRaw) as {
        frontier?: unknown;
        sourceSize?: unknown;
        videoId?: unknown;
      };
      if (
        typeof manifest.frontier !== 'number' ||
        !Number.isInteger(manifest.frontier) ||
        manifest.frontier <= 0 ||
        typeof manifest.sourceSize !== 'number' ||
        manifest.frontier > manifest.sourceSize ||
        manifest.videoId !== Number(m[1])
      ) {
        return false;
      }
      const stat = await fs.promises.stat(path.join(dir, name));
      return stat.isFile() && stat.size > 0;
    } catch {
      return false;
    }
  };
  for (const name of names) {
    if (/\.ts\.frontier\.json(\.\d+\.tmp)?$/.test(name) || /\.tmp$/.test(name)) {
      // Frontier manifest handling below (dangling vs resumable); writer tmp
      // residue (pid tmp from atomic writes) is always safe to remove.
      if (/\.tmp$/.test(name)) {
        try {
          await fs.promises.rm(path.join(dir, name), { force: true });
          removed++;
        } catch {
          // ignore individual failures
        }
      }
      continue;
    }
    if (!tempRe.test(name)) continue;
    try {
      if (await resumablePart(name)) {
        kept++;
        continue;
      }
      await fs.promises.rm(path.join(dir, name), { force: true });
      removed++;
    } catch {
      // ignore individual failures
    }
  }
  // Dangling manifests (their .ts.part is gone or was just swept): remove.
  for (const name of names) {
    const m = name.match(/^(\d+)\.ts\.frontier\.json$/);
    if (!m) continue;
    if (!nameSet.has(`${m[1]}.ts.part`)) {
      try {
        const stillThere = await fs.promises
          .stat(path.join(dir, `${m[1]}.ts.part`))
          .then((s) => s.isFile())
          .catch(() => false);
        if (!stillThere) {
          await fs.promises.rm(path.join(dir, name), { force: true });
          removed++;
        }
      } catch {
        // ignore individual failures
      }
    }
  }
  if (removed > 0 || kept > 0) {
    console.warn(`[media] orphaned temp cleanup: removed ${removed} file(s), kept ${kept} resumable prefix(es) in ${dir}`);
  }
}

/**
 * Mark that an additional request has joined an existing live remux job.
 * No-op if no job exists for this video.
 */
export function joinLiveRemuxJob(videoId: number): void {
  const job = liveJobs.get(videoId);
  if (!job) return;
  job.xJoinedCount++;
  // A join is interest: the request is heading for preflight and will
  // subscribe on success, so a running grace countdown must not kill the
  // job underneath it. No-op when no timer is armed.
  cancelGraceTimer(job);
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
 * Bound on a single spool-offset wait (P0-B): a broken frontier (stalled
 * ffmpeg, wedged download) must settle instead of hanging a request until
 * browser abort. Settles with the current frontier like every other
 * non-growth outcome, so the caller falls through to the cache/honest-503
 * path instead of serving a lie.
 */
export const SPOOL_WAIT_TIMEOUT_MS = 30_000;

/**
 * Resolve once the spool holds at least `offset` bytes (or the live has
 * ended / the waiter times out / the viewer is gone). Returns the actual
 * frontier at settle time.
 *
 * Used by the route for cold MPEG-TS seeks: a position inside the already
 * spooled fMP4 window can be served from the live stream without waiting
 * for the full cache (Bug 2).
 */
export function waitForSpoolOffset(
  job: LiveRemuxJob,
  offset: number,
  signal?: AbortSignal,
  timeoutMs: number = SPOOL_WAIT_TIMEOUT_MS,
): Promise<number> {
  if (job.spoolBytes >= offset) return Promise.resolve(job.spoolBytes);
  if (job.liveEnded) return Promise.resolve(job.spoolBytes);
  return new Promise<number>((resolve) => {
    let done = false;
    let waiter: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const idx = waiter ? job.spoolWaiters.indexOf(waiter) : -1;
      if (waiter) {
        const w = waiter;
        waiter = null;
        if (idx >= 0) job.spoolWaiters.splice(idx, 1);
        w();
      }
      signal?.removeEventListener('abort', onAbort);
      // A waiter that settles by timeout/abort on a still-running,
      // unwatched job re-arms the grace check (growth/end settlements
      // either subscribe or observe a finished job — no arm needed then,
      // and armGraceTimer self-guards regardless).
      if (job.subscribers.size === 0) armGraceTimer(job);
      resolve(job.spoolBytes);
    };
    const check = () => {
      if (done) return; // settled via abort/end/timeout - never re-register
      // A notify consumes the registered entry; drop it before deciding.
      const idx = waiter ? job.spoolWaiters.indexOf(waiter) : -1;
      if (waiter && idx >= 0) job.spoolWaiters.splice(idx, 1);
      waiter = null;
      if (job.spoolBytes >= offset || job.liveEnded) {
        finish();
        return;
      }
      // Not there yet: re-register for the next growth/end notification.
      // Active waiting is interest in the job: cancel any grace countdown
      // so a seeker watching the frontier cannot lose the job underneath.
      waiter = check;
      job.spoolWaiters.push(check);
      cancelGraceTimer(job);
    };
    const onAbort = () => finish();
    const onTimeout = () => finish();
    signal?.addEventListener('abort', onAbort);
    // No unref: a pending bounded wait is real work and must keep the loop
    // alive until it settles (at most timeoutMs); finish() always clears it.
    timer = setTimeout(onTimeout, timeoutMs);
    check();
  });
}

/**
 * True when `start` is an fMP4-spool offset this live can serve: any offset
 * below the current frontier, or any offset while the live is still running
 * (bytes may still arrive — the caller waits bounded via waitForSpoolOffset).
 * False at 0 (the normal start-0 live path owns it) and when the start is
 * beyond anything a finished live produced.
 *
 * Coordinate warning: `start` MUST be an fMP4 output offset (byte position
 * in the representation being served), never a source-TS offset. The two
 * compressions have different sizes and unrelated per-offset meanings.
 */
export function canServeSeekFromSpool(job: LiveRemuxJob, start: number): boolean {
  if (start <= 0) return false;
  // A dying job (shutdown decided) serves nothing live: fall through to the
  // finished-cache / honest-503 path instead of attaching to a teardown.
  if (job.dying) return false;
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
  // A viewer that went away during preflight must not leave a phantom
  // subscriber: the abort listener below would never fire for an
  // already-aborted signal, pinning the viewer count above zero forever
  // (grace shutdown could never arm). Serve nothing and register nothing —
  // nobody is listening anymore.
  if (signal?.aborted) {
    return new Response(null, { status: 204 });
  }
  const sub: LiveSubscriber = { notify: () => {}, detached: false };
  job.subscribers.add(sub);
  // Subscriber-aware lifecycle: this viewer keeps the job alive; its
  // departure may arm the zero-subscriber grace countdown.
  noteSubscriberAttached(job);
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
      noteSubscriberDetached(job);
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
    // Spool-backed range (P0-C): offsets are fMP4 OUTPUT coordinates into
    // the representation being served — the same byte space the start-0
    // live response emits, which is also the space the browser's own Range
    // refers to (it never saw source-TS bytes). Total is unknown while the
    // live warms ('*' is valid per RFC 7233).
    // Once the live has ended the total is final: clamp the end (a viewer
    // may have asked beyond what the source actually produced).
    const effectiveEnd = endByte !== null ? Math.min(endByte, job.spoolBytes - 1) : job.spoolBytes - 1;
    const total = job.liveEnded
      ? `bytes ${startOffset}-${Math.max(startOffset, effectiveEnd)}/${job.spoolBytes}`
      : `bytes ${startOffset}-${endByte ?? ''}/*`;
    headers.set('Content-Range', total);
    // Unlike the open-ended live stream, a spool slice IS a satisfiable,
    // stable byte range of a concrete prefix — advertise it honestly.
    headers.set('Accept-Ranges', 'bytes');
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
  onDone?: () => void,
): Response {
  const nodeStream = fs.createReadStream(absPath, { start, end });
  if (onDone) nodeStream.once('close', onDone);
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
