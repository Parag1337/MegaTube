/**
 * P2.3 thumbnail repair: detect black/missing/broken thumbnails and replace
 * them with a real frame extracted from the actual video.
 *
 * Deliberately simple - NO face detection, NO ML, NO computer vision. A
 * "good" thumbnail is simply a decodable image whose mean brightness clears
 * a small floor (measured on a 32x32 ffmpeg downscale, so one number per
 * file regardless of size or format).
 *
 * Frame sources reuse the existing media pipeline and nothing else:
 * MEGA session resume, short-lived download URLs, HTTP ranges, megajs
 * CTR decryption and the system ffmpeg binary (already required by remux).
 * Bytes are ALWAYS streamed to temp files - a large video is never held
 * in RAM, and only a small prefix is fetched first (covers faststart MP4
 * and MPEG-TS, whose streams self-synchronize); the full file is streamed
 * only when the prefix yields no usable frame.
 *
 * Generated frames persist exactly like sync-time thumbnails
 * (data/thumbs/<videoId>.jpg, served owner-only), so they survive reloads
 * and restarts with no duplicate storage and no per-render regeneration.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { decrypt } from 'megajs';
import { prisma } from '../db';
import { decryptSecret } from '../mega/envelope';
import { getTemporaryDownloadUrl } from '../mega/account';
import { withMegaSession } from '../sync/session-cache';
import { keepAliveFetch } from '../net-resilience';
import { MEGA_ACCOUNT_STATUSES } from '../megaAccounts';

const execFileAsync = promisify(execFile);

export const THUMBS_DIR = path.resolve(process.cwd(), 'data/thumbs');

let thumbsDirOverride: string | null = null;

/** Test hook: redirect thumbnail file storage (unit tests only). */
export function __setThumbsDirForTests(dir: string | null): void {
  thumbsDirOverride = dir;
}

function thumbsDir(): string {
  return thumbsDirOverride ?? THUMBS_DIR;
}

/** Mean 0-255 brightness below this counts as black/unusable. */
export const THUMB_BRIGHTNESS_MIN = 12;
/** Stored frame width; height follows the source aspect. */
export const THUMB_WIDTH = 640;
/** First-pass download: covers faststart MP4 moov + MPEG-TS headers. */
export const PREFIX_BYTES = 64 * 1024 * 1024;
/** Videos larger than this are skipped with a logged reason. */
export const MAX_VIDEO_BYTES = 8 * 1024 * 1024 * 1024;
/** Max videos repaired per endpoint call (keeps one call bounded). */
export const REPAIR_BATCH_LIMIT = 20;
/** Safety cap for a full-library repair scan (private library: bounded by size). */
export const FULL_SCAN_LIMIT = 5000;
/** Per-ffmpeg-invocation timeout. */
const FFMPEG_TIMEOUT_MS = 120_000;

function ffmpegBin(): string {
  const override = process.env.FFMPEG_BIN;
  return override && override.length > 0 ? override : 'ffmpeg';
}

export interface ThumbRepairDeps {
  fetchCiphertext: (url: string, signal?: AbortSignal) => Promise<Response>;
  withSession: typeof withMegaSession;
  getUrl: typeof getTemporaryDownloadUrl;
}

const defaultDeps: ThumbRepairDeps = {
  fetchCiphertext: (url, signal) => keepAliveFetch(url, { signal }),
  withSession: withMegaSession,
  getUrl: (storage, nodeId) =>
    getTemporaryDownloadUrl(storage as Parameters<typeof getTemporaryDownloadUrl>[0], nodeId),
};

/** Injectable frame extractor (unit tests substitute a fake; production uses ffmpeg). */
export type ExtractFrame = (
  decryptedFile: string,
  seekSeconds: number,
  outJpg: string,
) => Promise<boolean>;

async function defaultExtractFrame(
  decryptedFile: string,
  seekSeconds: number,
  outJpg: string,
): Promise<boolean> {
  // NOTE: success is judged by the OUTPUT FILE, never the exit code -
  // lossy decoders (e.g. openh264 on MPEG-TS seeks) routinely exit
  // non-zero over packet warnings while still writing a good frame.
  try {
    await execFileAsync(
      ffmpegBin(),
      [
        '-v', 'error',
        '-y',
        '-ss', String(seekSeconds),
        '-i', decryptedFile,
        '-frames:v', '1',
        '-q:v', '4',
        '-vf', `scale=${THUMB_WIDTH}:-1`,
        outJpg,
      ],
      { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
    );
  } catch {
    // Fall through to the file check below.
  }
  try {
    const stat = await fs.promises.stat(outJpg);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

let extractImpl: ExtractFrame = defaultExtractFrame;

/** Test hook: replace the ffmpeg frame extractor (mirrors existing patterns). */
export function __setExtractFrameForTests(fn: ExtractFrame | null): void {
  extractImpl = fn ?? defaultExtractFrame;
}

type ExtractBest = typeof extractBestFrame;
let extractBestImpl: ExtractBest | null = null;

/** Test hook: replace whole-video frame extraction (unit tests only). */
export function __setExtractBestForTests(fn: ExtractBest | null): void {
  extractBestImpl = fn;
}

/**
 * Mean 0-255 brightness of raw RGB24 bytes. Pure function - the single
 * arbiter of "black vs usable" everywhere below.
 */
export function meanBrightness(rgb: Buffer): number {
  if (rgb.length === 0) return -1;
  let sum = 0;
  for (let i = 0; i < rgb.length; i++) sum += rgb[i];
  return sum / rgb.length;
}

/**
 * Decode any image ffmpeg reads (PNG/JPEG/BMP/...) to mean brightness via
 * a 32x32 downscale. Null when the file is missing, empty or undecodable.
 */
export async function thumbMeanBrightness(absPath: string): Promise<number | null> {
  let stat: fs.Stats | null = null;
  try {
    stat = await fs.promises.stat(absPath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size === 0) return null;
  try {
    const { stdout } = await execFileAsync(
      ffmpegBin(),
      ['-v', 'error', '-i', absPath, '-vf', 'scale=32:32', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
      { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: 'buffer' },
    );
    if (!Buffer.isBuffer(stdout) || stdout.length === 0) return null;
    return meanBrightness(stdout);
  } catch {
    return null;
  }
}

/** True for a decodable thumbnail bright enough to show content. */
export function isUsableBrightness(mean: number | null): boolean {
  return mean !== null && mean >= THUMB_BRIGHTNESS_MIN;
}

export type ThumbVerdict = 'usable' | 'black' | 'unknown';

/**
 * Single classification rule for a probed mean brightness:
 * - usable: decodable and bright enough to keep
 * - black: decodable but overwhelmingly dark - replace like a missing thumb
 * - unknown: missing/undecodable (probe failed) - callers decide fail-open
 *   (sync keeps the file) or repair-path (repair attempts a replacement)
 */
export function verdictThumbMean(mean: number | null): ThumbVerdict {
  if (mean === null) return 'unknown';
  return mean >= THUMB_BRIGHTNESS_MIN ? 'usable' : 'black';
}

/** Existing on-disk thumbnail file for a video, if any. */
export async function existingThumbPath(videoId: number): Promise<string | null> {
  for (const ext of ['jpg', 'png']) {
    const p = path.join(thumbsDir(), `${videoId}.${ext}`);
    try {
      const stat = await fs.promises.stat(p);
      if (stat.isFile() && stat.size > 0) return p;
    } catch {
      // try next extension
    }
  }
  return null;
}

/**
 * Candidate seek positions (seconds), newest-first preference. Fractions of
 * the known duration when available, else a small fixed ladder. Capped at
 * five candidates - never hundreds of frames.
 */
export function candidateSeeks(durationSec: number | null): number[] {
  let raw: number[];
  if (typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec > 4) {
    const d = durationSec;
    raw = [0.05 * d, 0.25 * d, 0.5 * d, 0.75 * d, Math.max(0, d - 2)];
  } else {
    raw = [2, 10, 30, 60, 180];
  }
  const out: number[] = [];
  for (const t of raw) {
    const r = Math.max(1, Math.round(t));
    if (!out.includes(r)) out.push(r);
  }
  return out.slice(0, 5);
}

export interface FrameCandidate {
  seek: number;
  /** Null when the frame could not be decoded. */
  brightness: number | null;
}

/**
 * Pick the winning frame: the BRIGHTEST sufficiently non-black candidate
 * (a first usable frame is often a dim fade-in - all candidates cost the
 * same bounded work, so take the best); if none clears the floor, the
 * brightest decodable one as a best-effort fallback; -1 when undecodable.
 */
export function pickFrame(candidates: FrameCandidate[]): number {
  let bestUsable = -1;
  let bestUsableBrightness = -1;
  let best = -1;
  let bestBrightness = -1;
  for (let i = 0; i < candidates.length; i++) {
    const b = candidates[i].brightness;
    if (b === null) continue;
    if (b >= THUMB_BRIGHTNESS_MIN && b > bestUsableBrightness) {
      bestUsableBrightness = b;
      bestUsable = i;
    }
    if (b > bestBrightness) {
      bestBrightness = b;
      best = i;
    }
  }
  return bestUsable >= 0 ? bestUsable : best;
}

interface ResolvedSource {
  accountId: number;
  encryptedSession: string;
  nodeId: string;
  fileKey: Buffer;
  fileSize: number | null;
  durationSec: number | null;
}

async function streamToFile(stream: NodeJS.ReadableStream, absPath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
  await pipeline(stream, fs.createWriteStream(absPath));
}

async function streamToFile2(
  cipher: NodeJS.ReadableStream,
  decryptor: NodeJS.ReadWriteStream,
  absPath: string,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
  await pipeline(cipher, decryptor, fs.createWriteStream(absPath));
}

/**
 * Extract the best frame for one video into outDir (file named
 * `frame-<seek>.jpg`; the winner is returned). Streams bytes to disk -
 * never buffers a whole video in RAM.
 */
export async function extractBestFrame(
  src: ResolvedSource,
  outDir: string,
  deps: ThumbRepairDeps = defaultDeps,
): Promise<{ jpg: string; seek: number; brightness: number } | null> {
  if (src.fileSize !== null && src.fileSize > MAX_VIDEO_BYTES) {
    console.warn(`[thumbs] video over size cap, skipping frame extraction (${src.fileSize} bytes)`);
    return null;
  }

  const { upstreamUrl, size } = await deps.withSession(
    src.accountId,
    src.encryptedSession,
    async (storage) => {
      const resolved = await deps.getUrl(storage, src.nodeId);
      return { upstreamUrl: resolved.url, size: resolved.size };
    },
  );
  const totalSize = size ?? src.fileSize;
  if (totalSize === null || totalSize <= 0) return null;

  const seeks = candidateSeeks(src.durationSec);
  await fs.promises.mkdir(outDir, { recursive: true });
  const candidates: Array<FrameCandidate & { jpg: string }> = [];

  // Phase A: prefix only (faststart MP4 moov + MPEG-TS sync bytes live here).
  const prefixEnd = Math.min(PREFIX_BYTES, totalSize) - 1;
  const prefixFile = path.join(outDir, 'prefix.bin');
  const prefixOk = await fetchDecryptToFile(deps, upstreamUrl, 0, prefixEnd, src.fileKey, prefixFile, false);
  if (prefixOk) {
    // All candidates are evaluated (bounded: five seeks) and the brightest
    // usable frame wins - the first usable one is often a dim fade-in.
    for (const seek of seeks) {
      const jpg = path.join(outDir, `frame-${seek}.jpg`);
      const ok = await extractImpl(prefixFile, seek, jpg);
      candidates.push({ seek, jpg, brightness: ok ? await thumbMeanBrightness(jpg) : null });
    }
    console.log(
      `[thumbs] prefix candidates: ${candidates.map((c) => `${c.seek}s=${c.brightness === null ? 'x' : Math.round(c.brightness)}`).join(' ')}`,
    );
    const usable = pickFrame(candidates);
    if (usable >= 0 && isUsableBrightness(candidates[usable].brightness)) {
      const win = candidates[usable];
      return { jpg: win.jpg, seek: win.seek, brightness: win.brightness as number };
    }
  } else {
    console.warn('[thumbs] prefix download/decrypt failed, trying full download');
  }

  // Phase B: full stream to disk (needed for moov-at-end MP4), then seeks.
  if (totalSize <= prefixEnd + 1) {
    // Prefix already covered the whole file: fall back to the brightest
    // prefix frame instead of re-downloading.
    const fallback = pickFrame(candidates);
    if (fallback >= 0 && candidates[fallback].brightness !== null) {
      const win = candidates[fallback];
      return { jpg: win.jpg, seek: win.seek, brightness: win.brightness as number };
    }
    return null;
  }
  const fullFile = path.join(outDir, 'full.bin');
  if (!(await fetchDecryptToFile(deps, upstreamUrl, 0, totalSize - 1, src.fileKey, fullFile, true))) {
    const fallback = pickFrame(candidates);
    if (fallback >= 0 && candidates[fallback].brightness !== null) {
      const win = candidates[fallback];
      return { jpg: win.jpg, seek: win.seek, brightness: win.brightness as number };
    }
    return null;
  }
  const fullCandidates: Array<FrameCandidate & { jpg: string }> = [];
  for (const seek of seeks) {
    const jpg = path.join(outDir, `full-${seek}.jpg`);
    const ok = await extractImpl(fullFile, seek, jpg);
    fullCandidates.push({ seek, jpg, brightness: ok ? await thumbMeanBrightness(jpg) : null });
  }
  const winner = pickFrame(fullCandidates);
  if (winner < 0 || fullCandidates[winner].brightness === null) return null;
  const win = fullCandidates[winner];
  return { jpg: win.jpg, seek: win.seek, brightness: win.brightness as number };
}

/** GET one ciphertext range and stream-decrypt it to disk. False on any failure. */
async function fetchDecryptToFile(
  deps: ThumbRepairDeps,
  upstreamUrl: string,
  start: number,
  end: number,
  fileKey: Buffer,
  absPath: string,
  verifyMac: boolean,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10 * 60_000);
  try {
    const res = await deps.fetchCiphertext(`${upstreamUrl}/${start}-${end}`, controller.signal);
    if (!res.ok || !res.body) return false;
    // Same convention as the media route: MAC verification only for
    // complete (start 0 through end-of-file) downloads; partial ranges
    // (the prefix fast-path) would always fail verification.
    const decryptor = decrypt(fileKey, { start, disableVerification: !verifyMac });
    const cipher = Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
    await streamToFile2(cipher, decryptor, absPath);
    const stat = await fs.promises.stat(absPath).catch(() => null);
    return !!stat && stat.size > 0;
  } catch (err) {
    console.warn(`[thumbs] fetch/decrypt failed: ${err instanceof Error ? err.message.slice(0, 120) : typeof err}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export type RepairStatus = 'skipped-good' | 'repaired-missing' | 'repaired-black' | 'repaired-broken' | 'repaired-problematic' | 'repaired' | 'failed' | 'not-found' | 'skipped-cap';

export interface RepairResult {
  videoId: number;
  status: RepairStatus;
  /** Mean brightness of the stored thumbnail (when known). */
  brightness?: number | null;
  detail?: string;
  /** Video title at repair time (for the live progress log). */
  title?: string | null;
  /** Wall-clock ms spent on this video (skip or repair). */
  elapsedMs?: number;
}

/**
 * Live lifecycle events emitted while a repair run is actually happening.
 * The UI renders these incrementally - they must correspond to real work:
 * - `video-start`: classification of this video begins (cheap local checks).
 * - `video-phase` with phase `repairing`: real repair work started (MEGA
 *   source access + frame extraction about to run). Never emitted for
 *   videos that are skipped.
 * - `video-phase` with phase `extracting`: the frame extraction process
 *   (ffmpeg over real video bytes) is running now.
 * - `video-done`: terminal state for this video with its status + elapsed.
 */
export type RepairPhase = 'repairing' | 'extracting';

export interface RepairEvent {
  type: 'video-start' | 'video-phase' | 'video-done';
  videoId: number;
  title?: string | null;
  phase?: RepairPhase;
  /** Repair category decided before extraction (mirrors RepairStatus). */
  category?: RepairStatus;
  status?: RepairStatus;
  detail?: string;
  elapsedMs?: number;
  /** 1-based position in this run. */
  index?: number;
  /** Total videos in this run. */
  total?: number;
}

/**
 * Repair one video's thumbnail for one user. Ownership is enforced: videos
 * outside the user's own non-disconnected accounts behave as not-found.
 * Usable thumbnails are never rewritten unless `force` is set. Failures
 * never throw - they are returned for logging/retry.
 */
export async function repairVideoThumbnail(
  userId: string,
  videoId: number,
  opts?: {
    force?: boolean;
    deps?: ThumbRepairDeps;
    /** Live lifecycle hook: called when real repair/extraction actually starts. */
    onPhase?: (phase: RepairPhase, info: { category: RepairStatus }) => void;
  },
): Promise<RepairResult> {
  const t0 = Date.now();
  const deps = opts?.deps ?? defaultDeps;
  const video = await prisma.video.findFirst({
    where: {
      id: videoId,
      megaAccount: { userId, status: { not: MEGA_ACCOUNT_STATUSES.DISCONNECTED } },
    },
    select: {
      id: true,
      title: true,
      megaNodeId: true,
      fileKeyEncrypted: true,
      fileSize: true,
      duration: true,
      thumbnail: true,
      thumbnailAvailable: true,
      megaAccount: { select: { id: true, encryptedSession: true } },
    },
  });
  const elapsedMs = () => Date.now() - t0;
  if (!video || !video.megaAccount || !video.megaNodeId || !video.fileKeyEncrypted) {
    return { videoId, status: 'not-found', detail: 'source unavailable', elapsedMs: elapsedMs() };
  }

  let repairType: RepairStatus = 'repaired';
  if (!opts?.force) {
    const existing = await existingThumbPath(video.id);
    if (existing && verdictThumbMean(await thumbMeanBrightness(existing)) === 'usable') {
      return { videoId, status: 'skipped-good', title: video.title, elapsedMs: elapsedMs() };
    }
    if (!existing) {
      if (!video.thumbnailAvailable) {
        repairType = 'repaired-problematic';
      } else {
        repairType = 'repaired-missing';
      }
    } else {
      const mean = await thumbMeanBrightness(existing);
      const verdict = verdictThumbMean(mean);
      if (verdict === 'black') {
        repairType = 'repaired-black';
      } else if (verdict === 'unknown') {
        repairType = 'repaired-broken';
      } else {
        repairType = 'repaired';
      }
    }
  }

  let fileKey: Buffer;
  try {
    fileKey = decryptSecret(video.fileKeyEncrypted);
  } catch {
    return { videoId, status: 'failed', title: video.title, detail: 'unreadable playback key', elapsedMs: elapsedMs() };
  }

  // Real work starts here: the category above was decided from local
  // checks only; everything below touches the actual video source.
  opts?.onPhase?.('repairing', { category: repairType });
  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `thumb-repair-${video.id}-`));
  try {
    opts?.onPhase?.('extracting', { category: repairType });
    const best = await (extractBestImpl ?? extractBestFrame)(
      {
        accountId: video.megaAccount.id,
        encryptedSession: video.megaAccount.encryptedSession,
        nodeId: video.megaNodeId,
        fileKey,
        fileSize: video.fileSize === null ? null : Number(video.fileSize),
        durationSec: video.duration,
      },
      workDir,
      deps,
    );
    if (!best) return { videoId, status: 'failed', title: video.title, detail: 'no usable frame', elapsedMs: elapsedMs() };

    await fs.promises.mkdir(thumbsDir(), { recursive: true });
    const dest = path.join(thumbsDir(), `${video.id}.jpg`);
    await fs.promises.copyFile(best.jpg, dest);
    // Success is judged by the STORED file: it must exist on disk and be
    // a bright-enough decodable image served by the thumbnail endpoint.
    // Anything less is a failure, never a reported success.
    const storedMean = await thumbMeanBrightness(dest);
    if (!isUsableBrightness(storedMean)) {
      await fs.promises.rm(dest, { force: true }).catch(() => {});
      return { videoId, status: 'failed', title: video.title, detail: 'extracted frame unusable', elapsedMs: elapsedMs() };
    }
    // Remove a stale sibling extension so exactly one file backs the video.
    await fs.promises.rm(path.join(thumbsDir(), `${video.id}.png`), { force: true });
    await prisma.video.update({
      where: { id: video.id },
      data: { thumbnail: `/api/media/thumbs/${video.id}`, thumbnailAvailable: true },
    });
    return { videoId, status: repairType, title: video.title, brightness: storedMean, detail: `seek=${best.seek}s`, elapsedMs: elapsedMs() };
  } catch (err) {
    console.warn(
      `[thumbs] repair failed for video ${video.id}: ${err instanceof Error ? err.message.slice(0, 120) : typeof err}`,
    );
    return { videoId, status: 'failed', title: video.title, detail: 'extraction error', elapsedMs: elapsedMs() };
  } finally {
    if (!process.env.THUMB_KEEP_WORKDIR) {
      await fs.promises.rm(workDir, { recursive: true, force: true });
    } else {
      console.log(`[thumbs] keeping workdir ${workDir}`);
    }
  }
}

export interface RepairSummary {
  scanned: number;
  repaired: number;
  repairedMissing: number;
  repairedBlack: number;
  repairedBroken: number;
  repairedProblematic: number;
  skippedGood: number;
  notFound: number;
  failed: number;
  results: RepairResult[];
}
/**
 * Repair a user's library sequentially (concurrency 1 - never competes
 * with playback/remux). Without explicit `videoIds` the WHOLE library is
 * scanned: videos whose thumbnail is known-missing (`thumbnailAvailable`
 * false, i.e. previously problematic) go first so the important work is
 * never starved by an early batch cap, then the rest by id. Good
 * thumbnails are skipped with cheap local checks only (no MEGA/video
 * work); only repair candidates perform extraction. Safe to re-run:
 * repaired videos are skipped next time, failures only logged.
 *
 * With explicit `videoIds` the run stays bounded by `limit`
 * (post-sync background batches use this path). Emits live lifecycle
 * events via `onEvent` as real work happens.
 */
export async function repairUserThumbnails(
  userId: string,
  opts?: { limit?: number; videoIds?: number[]; force?: boolean; deps?: ThumbRepairDeps; onEvent?: (e: RepairEvent) => void },
): Promise<RepairSummary> {
  const explicitIds = opts?.videoIds && opts.videoIds.length > 0;
  const limit = explicitIds
    ? Math.max(1, Math.min(opts?.limit ?? REPAIR_BATCH_LIMIT, REPAIR_BATCH_LIMIT))
    : Math.max(1, Math.min(opts?.limit ?? FULL_SCAN_LIMIT, FULL_SCAN_LIMIT));
  const emit = opts?.onEvent;
  const where = explicitIds
    ? { megaAccount: { userId, status: { not: MEGA_ACCOUNT_STATUSES.DISCONNECTED } }, id: { in: opts.videoIds } }
    : { megaAccount: { userId, status: { not: MEGA_ACCOUNT_STATUSES.DISCONNECTED } } };
  // Previously problematic videos (thumbnailAvailable false) first - they
  // are the reason this run exists - then everything else by id.
  const videos = await prisma.video.findMany({
    where,
    select: { id: true, title: true, thumbnailAvailable: true },
    orderBy: explicitIds ? { id: 'asc' } : [{ thumbnailAvailable: 'asc' }, { id: 'asc' }],
    take: limit,
  });

  const summary: RepairSummary = {
    scanned: 0,
    repaired: 0,
    repairedMissing: 0,
    repairedBlack: 0,
    repairedBroken: 0,
    repairedProblematic: 0,
    skippedGood: 0,
    notFound: 0,
    failed: 0,
    results: [],
  };
  for (const v of videos) {
    const index = summary.scanned + 1;
    emit?.({ type: 'video-start', videoId: v.id, title: v.title, index, total: videos.length });
    const r = await repairVideoThumbnail(userId, v.id, {
      force: opts?.force,
      deps: opts?.deps,
      onPhase: (phase, info) => {
        emit?.({ type: 'video-phase', videoId: v.id, title: v.title, phase, category: info.category, index, total: videos.length });
      },
    });
    emit?.({
      type: 'video-done',
      videoId: v.id,
      title: r.title ?? v.title,
      status: r.status,
      detail: r.detail,
      elapsedMs: r.elapsedMs,
      index,
      total: videos.length,
    });
    summary.scanned++;
    summary.results.push(r);
    switch (r.status) {
      case 'repaired':
      case 'repaired-missing':
      case 'repaired-black':
      case 'repaired-broken':
      case 'repaired-problematic':
        summary.repaired++;
        if (r.status === 'repaired-missing') summary.repairedMissing++;
        else if (r.status === 'repaired-black') summary.repairedBlack++;
        else if (r.status === 'repaired-broken') summary.repairedBroken++;
        else if (r.status === 'repaired-problematic') summary.repairedProblematic++;
        break;
      case 'skipped-good':
        summary.skippedGood++;
        break;
      case 'not-found':
        summary.notFound++;
        break;
      case 'failed':
      case 'skipped-cap':
        summary.failed++;
        break;
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Shared repair mutex + post-sync background scheduling (Part 8).
//
// New videos without a MEGA thumbnail attribute never receive one from sync
// itself. Sync hands their ids to schedulePostSyncRepair() and returns
// immediately; the actual extraction runs later, bounded and sequential, so
// a slow frame grab can never block or fail the sync job. The manual repair
// endpoint shares the same mutex, so background and manual runs never
// parallelize expensive MEGA downloads.
// ---------------------------------------------------------------------------

let activeRepairOwner: string | null = null;

/** Claim the single in-process repair slot. False when a repair is running. */
export function tryBeginRepair(owner: string): boolean {
  if (activeRepairOwner !== null) return false;
  activeRepairOwner = owner;
  return true;
}

/** Release the repair slot (only the owning run can release it). */
export function endRepair(owner: string): void {
  if (activeRepairOwner === owner) activeRepairOwner = null;
}

/** Delay before a post-sync repair run starts (lets sync fully settle). */
export const POST_SYNC_DELAY_MS = 30_000;
/** Cap on ids waiting for a post-sync run (older ids ride the next sync). */
const POST_SYNC_PENDING_CAP = 80;

let postSyncUser: string | null = null;
let postSyncPending: number[] = [];
let postSyncTimer: ReturnType<typeof setTimeout> | null = null;

function armPostSyncTimer(deps: ThumbRepairDeps | undefined, delayMs: number): void {
  if (postSyncTimer) return;
  postSyncTimer = setTimeout(() => {
    void runPostSyncBatch(deps);
  }, delayMs);
  // Never keep a test runner or server shutdown waiting on this best-effort
  // timer; the dev/prod server event loop always outlives the delay.
  const t = postSyncTimer as unknown as { unref?: () => void };
  if (typeof t.unref === 'function') t.unref();
}

async function runPostSyncBatch(deps?: ThumbRepairDeps): Promise<void> {
  postSyncTimer = null;
  const userId = postSyncUser;
  if (!userId || postSyncPending.length === 0) {
    postSyncPending = [];
    postSyncUser = null;
    return;
  }
  if (!tryBeginRepair('post-sync')) {
    // A manual repair is running - retry once it likely finished. Ids stay
    // queued; the next sync or the manual button also covers them.
    armPostSyncTimer(deps, POST_SYNC_DELAY_MS);
    return;
  }
  try {
    const batch = postSyncPending.slice(0, REPAIR_BATCH_LIMIT);
    if (batch.length > 0) {
      const summary = await repairUserThumbnails(userId, { videoIds: batch, limit: batch.length, deps });
      console.log(
        `[thumbs] post-sync repair: scanned=${summary.scanned} repaired=${summary.repaired} skippedGood=${summary.skippedGood} failed=${summary.failed}`,
      );
      postSyncPending = postSyncPending.slice(batch.length);
    }
  } catch (err) {
    console.warn(
      `[thumbs] post-sync repair failed: ${err instanceof Error ? err.message.slice(0, 120) : typeof err}`,
    );
  } finally {
    endRepair('post-sync');
    if (postSyncPending.length > 0) {
      armPostSyncTimer(deps, POST_SYNC_DELAY_MS);
    } else {
      postSyncUser = null;
    }
  }
}

export interface PostSyncScheduleOpts {
  /** Override the start delay (unit tests use a few ms). */
  delayMs?: number;
  /** Injected MEGA boundary (unit tests only). */
  deps?: ThumbRepairDeps;
}

/**
 * Queue video ids for a bounded background repair run. Returns immediately
 * and never throws - sync must never wait for, or fail because of,
 * thumbnails.
 */
export function schedulePostSyncRepair(
  userId: string,
  videoIds: number[],
  opts?: PostSyncScheduleOpts,
): void {
  try {
    if (!userId) return;
    const ids = videoIds.filter((n) => Number.isInteger(n) && n > 0);
    if (ids.length === 0) return;
    if (postSyncUser !== null && postSyncUser !== userId) return;
    postSyncUser = userId;
    for (const id of ids) {
      if (!postSyncPending.includes(id) && postSyncPending.length < POST_SYNC_PENDING_CAP) {
        postSyncPending.push(id);
      }
    }
    armPostSyncTimer(opts?.deps, opts?.delayMs ?? POST_SYNC_DELAY_MS);
  } catch {
    // Scheduling is best-effort; sync success never depends on it.
  }
}

/** Test hook: drop any pending post-sync timer/queue (unit tests only). */
export function __clearPostSyncForTests(): void {
  if (postSyncTimer) clearTimeout(postSyncTimer);
  postSyncTimer = null;
  postSyncPending = [];
  postSyncUser = null;
  if (activeRepairOwner === 'post-sync') activeRepairOwner = null;
}
