/**
 * Phase 5 preview system: bounded source acquisition.
 *
 * Resolves a DECODABLE source for one candidate segment, cheapest first
 * (design doc §2):
 *
 *   1. warm media cache  (`data/cache-media/<id>.mp4`)      0 MEGA bytes
 *   2. local TS prefix   (`data/cache-media/<id>.ts.part`)  0 MEGA bytes
 *   3. MEGA TS window    (self-synchronizing, 752-aligned)  ≤ source cap
 *   4. MEGA MP4 sparse   (moov + window at absolute offsets) ≤ source cap + moov cap
 *
 * The MP4 sparse trick (validated live against this exact ffmpeg build):
 * moov bytes are fetched separately and written at their ABSOLUTE offsets
 * into a sparse file; the media window is decrypted at its absolute offset
 * (CTR keystream is positioned by file offset, so plaintext maps 1:1); a
 * sparse hole keeps the file the right length without storing absent
 * bytes. ffmpeg then seeks through moov's own index directly into the
 * present bytes (`-ss` input seek) and decodes until the window ends.
 *
 * No buffers of media are ever held in Node memory: everything streams
 * through bounded temp files.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { decrypt } from 'megajs';
import { needsRemuxForContainer } from '../media/container';
import { loadSourceFrontier, tsPartPath } from '../media/source-acquisition';
import type { OwnedVideo } from './types';
import {
  alignDown,
  byteOffsetToSeconds,
  byteWindowAtFraction,
  byteWindowFor,
  mergeByteWindows,
} from './segment';
import { findMoovInChunk, readMp4DurationSeconds } from './mp4-index';
import { probeMedia } from './ffmpeg';
import {
  previewFfmpegTimeoutMs,
  previewMoovMaxBytes,
  previewMontageMaxRanges,
  previewMontageSourceBudgetBytes,
  previewMontageWindowMaxBytes,
  previewSourceMaxBytes,
} from './config';

export interface PreviewSourceDeps {
  fetchCiphertext: (url: string, signal?: AbortSignal) => Promise<Response>;
  withSession: <T>(
    accountId: number,
    encryptedSession: string,
    fn: (storage: unknown) => Promise<T>,
  ) => Promise<T>;
  getDownloadUrl: (storage: unknown, nodeId: string) => Promise<{ url: string; size: number | null }>;
  /** Injectable warm-cache reader (default: lib/media readRemuxCache). */
  readWarmCache: (
    videoId: number,
    megaNodeId: string,
    sourceSize: number,
  ) => Promise<{ path: string; size: number } | null>;
}

export type SourceKind = 'local-mp4' | 'ts-window' | 'sparse-mp4';

export interface PreviewSourcePlan {
  kind: SourceKind;
  /** File to hand to ffmpeg. */
  path: string;
  /** Input-side `-ss` value (0 for TS windows — the window IS the segment). */
  seekSec: number;
  /** MEGA bytes this plan consumed (0 for fully local plans). */
  transferBytes: number;
  /** Remove all temp files owned by this plan. */
  cleanup: () => Promise<void>;
}

export class SourceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceUnavailableError';
  }
}

/** Cooperative deadline check between bounded acquisition phases. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('preview job deadline exceeded');
    err.name = 'AbortError';
    throw err;
  }
}

/** Per-job temp directory: `<previewsDir>/<id>.tmp-<rand>/` (orphan-swept). */
export async function createWorkDir(videoId: number): Promise<string> {
  const base = path.join(previewsDirForTemp(), `${videoId}.tmp-`);
  await fs.promises.mkdir(path.dirname(base), { recursive: true });
  return fs.promises.mkdtemp(base);
}

function previewsDirForTemp(): string {
  const override = process.env.PREVIEW_CACHE_DIR;
  return override && override.length > 0 ? override : path.join(process.cwd(), 'data', 'previews');
}

/** Remove a temp directory tree (never throws). */
export async function removeWorkDir(dir: string | null): Promise<void> {
  if (!dir) return;
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/**
 * Stream-decrypt one ciphertext range to a file. The decryptor start is the
 * ABSOLUTE ciphertext offset (CTR keystream position), so the plaintext maps
 * 1:1 onto source offsets. Partial ranges cannot MAC-verify (same convention
 * as the remux pipeline); transport integrity still applies.
 */
async function decryptRangeToFile(
  deps: PreviewSourceDeps,
  url: string,
  start: number,
  end: number,
  fileKey: Buffer,
  destPath: string,
  signal?: AbortSignal,
): Promise<number> {
  const res = await deps.fetchCiphertext(`${url}/${start}-${end}`, signal);
  if (!res.ok || !res.body) {
    throw new SourceUnavailableError(`ciphertext fetch failed with status ${res.status}`);
  }
  const decryptor = decrypt(fileKey, { start, disableVerification: true });
  const nodeUpstream = Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
  let written = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      written += chunk.length;
      cb(null, chunk);
    },
  });
  await pipeline(nodeUpstream, decryptor as unknown as NodeJS.WritableStream, counter, fs.createWriteStream(destPath));
  return written;
}

/** Stream-copy a local file slice (TS window cut from the acquisition prefix). */
async function copySlice(srcPath: string, start: number, len: number, destPath: string): Promise<void> {
  await pipeline(
    fs.createReadStream(srcPath, { start, end: start + len - 1 }),
    fs.createWriteStream(destPath),
  );
}

interface ResolvedUrl {
  url: string;
  size: number;
}

async function resolveDownloadUrl(
  video: OwnedVideo,
  deps: PreviewSourceDeps,
): Promise<ResolvedUrl> {
  const resolved = await deps.withSession(video.megaAccountId, video.encryptedSession, (storage) =>
    deps.getDownloadUrl(storage, video.megaNodeId),
  );
  const size = resolved.size ?? (video.fileSize !== null ? Number(video.fileSize) : 0);
  if (!size || size <= 0) throw new SourceUnavailableError('source size unknown');
  return { url: resolved.url, size };
}

/**
 * Resolve the source plan for one candidate. Throws SourceUnavailableError
 * when nothing bounded can decode this candidate (caller tries the next
 * candidate, the budget decides how many).
 */
export async function resolvePreviewSource(
  video: OwnedVideo,
  candidateT: number,
  workDir: string,
  fileKey: Buffer,
  deps: PreviewSourceDeps,
): Promise<PreviewSourcePlan> {
  const size = video.fileSize !== null ? Number(video.fileSize) : 0;
  const tmpFiles: string[] = [];
  const cleanup = async (): Promise<void> => {
    await Promise.all(tmpFiles.map((f) => fs.promises.rm(f, { force: true })));
  };

  // 1. Warm media cache: full local MP4, any timestamp, zero MEGA bytes.
  if (size > 0) {
    const warm = await deps.readWarmCache(video.id, video.megaNodeId, size);
    if (warm) {
      return { kind: 'local-mp4', path: warm.path, seekSec: candidateT, transferBytes: 0, cleanup };
    }
  }

  const isTs = needsRemuxForContainer(video.mimeType);

  // 2. Local TS acquisition prefix: cut the same byte window the MEGA path
  //    would fetch, but from disk (0 transfer). Requires the frontier to
  //    already cover the whole window.
  if (isTs && size > 0) {
    try {
      const { byteStart, byteLen } = byteWindowFor(candidateT, video.duration, size, previewSourceMaxBytes(), 752);
      if (byteLen > 0 && byteStart + byteLen <= size) {
        const frontier = await loadSourceFrontier(video.id);
        const part = tsPartPath(video.id);
        const partStat = await fs.promises.stat(part).catch(() => null);
        if (frontier && partStat?.isFile() && frontier.frontier >= byteStart + byteLen) {
          const win = path.join(workDir, 'window.ts');
          await copySlice(part, byteStart, byteLen, win);
          tmpFiles.push(win);
          return { kind: 'ts-window', path: win, seekSec: 0, transferBytes: 0, cleanup };
        }
      }
    } catch {
      // fall through to the MEGA window
    }
  }

  // 3./4. Bounded MEGA windows.
  const { url, size: resolvedSize } = await resolveDownloadUrl(video, deps);
  const totalSize = resolvedSize || size;
  if (isTs) {
    const { byteStart, byteLen } = byteWindowFor(
      candidateT,
      video.duration,
      totalSize,
      previewSourceMaxBytes(),
      752,
    );
    if (byteLen <= 0) throw new SourceUnavailableError('empty TS window');
    const win = path.join(workDir, 'window.ts');
    await decryptRangeToFile(deps, url, byteStart, byteStart + byteLen - 1, fileKey, win);
    tmpFiles.push(win);
    return {
      kind: 'ts-window',
      path: win,
      seekSec: 0,
      transferBytes: byteLen,
      cleanup,
    };
  }

  // MP4: moov + media window into a sparse file. Layout decision order:
  // stored probe verdict -> direct inspection of a small head fetch.
  const moovMax = previewMoovMaxBytes();
  const headLen = Math.min(moovMax, totalSize);
  const head = path.join(workDir, 'head.bin');
  await decryptRangeToFile(deps, url, 0, headLen - 1, fileKey, head);
  tmpFiles.push(head);
  const headBuf = await fs.promises.readFile(head);
  let moov = findMoovInChunk(headBuf, 0, totalSize);
  let moovEnd = moov?.complete ? moov.end : null;
  if (!moovEnd) {
    // Non-faststart (or moov larger than the head): fetch the tail and look
    // there. moov sits before mdat-less trailing bytes; the tail chunk
    // covers it fully in practice (index sizes are well under the cap).
    // CTR constraint: the fetch start must be 16-byte aligned.
    const tailLen = Math.min(moovMax, totalSize);
    const tailStart = Math.max(0, alignDown(totalSize - tailLen, 16));
    const tail = path.join(workDir, 'tail.bin');
    await decryptRangeToFile(deps, url, tailStart, totalSize - 1, fileKey, tail);
    tmpFiles.push(tail);
    const tailBuf = await fs.promises.readFile(tail);
    moov = findMoovInChunk(tailBuf, tailStart, totalSize);
    if (!moov) throw new SourceUnavailableError('moov not found in head or tail');
    if (!moov.complete) throw new SourceUnavailableError('moov incomplete in tail chunk');
    moovEnd = moov.end;
    // Sparse file: write the head at 0 as well. The demuxer must be able to
    // walk a valid top-level box chain from offset 0 (ftyp + mdat header) to
    // reach the moov; the bytes in between are a hole and are never read
    // except through moov's index, which points into the window below.
    const sparse = path.join(workDir, 'source.mp4');
    const fh = await fs.promises.open(sparse, 'w');
    try {
      await fh.truncate(totalSize);
      await fh.write(headBuf, 0, headBuf.length, 0);
      await fh.write(tailBuf, 0, tailBuf.length, tailStart);
    } finally {
      await fh.close();
    }
    tmpFiles.push(sparse);
    // Media window inside [0, moov.start) — already 16-aligned in absolute
    // coordinates (the region starts at file offset 0).
    const regionLen = Math.max(0, moov.start);
    const { byteStart, byteLen } = byteWindowFor(
      candidateT,
      video.duration,
      regionLen,
      previewSourceMaxBytes(),
      16,
    );
    if (byteLen <= 0) throw new SourceUnavailableError('empty MP4 window');
    const winPath = path.join(workDir, 'window.bin');
    await decryptRangeToFile(deps, url, byteStart, byteStart + byteLen - 1, fileKey, winPath);
    tmpFiles.push(winPath);
    const winBuf = await fs.promises.readFile(winPath);
    const fh2 = await fs.promises.open(sparse, 'r+');
    try {
      await fh2.write(winBuf, 0, winBuf.length, byteStart);
    } finally {
      await fh2.close();
    }
    return {
      kind: 'sparse-mp4',
      path: sparse,
      seekSec: candidateT,
      transferBytes: headLen + (totalSize - tailStart) + byteLen,
      cleanup,
    };
  }

  // Faststart: head chunk already contains ftyp + moov. Write it at offset 0.
  const sparse = path.join(workDir, 'source.mp4');
  const fh = await fs.promises.open(sparse, 'w');
  try {
    await fh.truncate(totalSize);
    await fh.write(headBuf, 0, Math.min(moovEnd, headBuf.length), 0);
  } finally {
    await fh.close();
  }
  tmpFiles.push(sparse);
  // Media window inside [moovEnd, totalSize). CTR needs a 16-aligned fetch
  // start, and moovEnd itself is arbitrary — round the region start UP to
  // the next 16-byte boundary (the sparse hole absorbs the skipped bytes).
  const regionStart = Math.ceil(moovEnd / 16) * 16;
  const avail = Math.max(0, totalSize - regionStart);
  const { byteStart, byteLen } = byteWindowFor(
    candidateT,
    video.duration,
    avail,
    previewSourceMaxBytes(),
    16,
  );
  if (byteLen <= 0) throw new SourceUnavailableError('empty MP4 window');
  const winStart = regionStart + byteStart;
  const winPath = path.join(workDir, 'window.bin');
  await decryptRangeToFile(deps, url, winStart, winStart + byteLen - 1, fileKey, winPath);
  tmpFiles.push(winPath);
  const winBuf = await fs.promises.readFile(winPath);
  const fh2 = await fs.promises.open(sparse, 'r+');
  try {
    await fh2.write(winBuf, 0, winBuf.length, winStart);
  } finally {
    await fh2.close();
  }
  return {
    kind: 'sparse-mp4',
    path: sparse,
    seekSec: candidateT,
    transferBytes: headLen + byteLen,
    cleanup,
  };
}

// ---------------------------------------------------------------------------
// Phase 5.1: multi-scene source plan (one bounded acquisition for N scenes)
// ---------------------------------------------------------------------------

export interface MontageSceneRequest {
  index: number;
  /** Scene start on the source timeline (estimated when duration is unknown). */
  startSec: number;
  durationSec: number;
  /** File-relative position for sources without a reliable timeline. */
  fraction?: number | null;
  /** Set by the planner when the position is only an estimate. */
  estimated?: boolean;
}

export interface MontageSceneSource {
  index: number;
  path: string;
  /** Input-side seek for ffmpeg (0 for TS windows, absolute for MP4). */
  seekSec: number;
  durationSec: number;
  startSec: number;
  /**
   * True when `startSec` is only an estimate (byte-fraction selection on a
   * source with no reliable timeline), never an exact source timestamp.
   */
  estimated: boolean;
  /** File-relative position used for unknown-duration TS selection. */
  byteFraction: number | null;
}

export interface MontageSourcePlan {
  kind: SourceKind;
  segments: MontageSceneSource[];
  transferBytes: number;
  /** Scenes dropped because no bounded window could cover them. */
  omittedScenes: number[];
  /** True when at least one scene was positioned by byte fraction. */
  degradedSelection: boolean;
  cleanup: () => Promise<void>;
}

export interface MontageSourceOptions {
  /**
   * Reliable duration discovered by `probeMontageSourceDuration()`. When
   * omitted, the database duration is used. When both are absent, TS
   * sources use the bounded byte-fraction fallback.
   */
  durationSec?: number | null;
  /**
   * Metadata bytes already spent by the caller's probe. `head.bin`/`tail.bin`
   * left in the work dir by the probe are reused instead of re-downloaded,
   * and these bytes are added back to the plan's transfer accounting.
   */
  prefetchedTransferBytes?: number;
  signal?: AbortSignal;
}

interface PreparedSceneWindow {
  scene: MontageSceneRequest;
  startSec: number;
  byteStart: number;
  byteLen: number;
  estimated: boolean;
  fraction: number | null;
}

/** Keep a scene start inside the known source timeline. */
function clampSceneStart(startSec: number, durationSec: number | null, sceneDurationSec: number): number {
  if (!durationSec || durationSec <= 0) return Math.max(0, startSec);
  const tail = Math.max(0.2, Math.min(sceneDurationSec, durationSec));
  const maxStart = Math.max(0, durationSec - tail);
  return Math.max(0, Math.min(startSec, maxStart));
}

/**
 * One scene → one bounded byte window.
 *
 * Known duration: timeline-positioned window (existing behaviour). Unknown
 * duration: file-fraction window, explicitly marked estimated/degraded —
 * never the removed `t * 64_000` fixed-bitrate guess.
 */
function planMontageSceneWindow(
  scene: MontageSceneRequest,
  durationSec: number | null,
  sourceSize: number,
  maxBytes: number,
  align: number,
  coverageSeconds: number,
): PreparedSceneWindow {
  const startSec = clampSceneStart(scene.startSec, durationSec, scene.durationSec);
  if (durationSec && durationSec > 0) {
    const window = byteWindowFor(startSec, durationSec, sourceSize, maxBytes, align, coverageSeconds, 1.6);
    return {
      scene,
      startSec,
      byteStart: window.byteStart,
      byteLen: window.byteLen,
      estimated: scene.estimated === true,
      fraction: null,
    };
  }
  const fraction =
    typeof scene.fraction === 'number' && Number.isFinite(scene.fraction)
      ? Math.min(1, Math.max(0, scene.fraction))
      : null;
  const window = byteWindowAtFraction(fraction ?? 0, sourceSize, maxBytes, align);
  return {
    scene,
    startSec,
    byteStart: window.byteStart,
    byteLen: window.byteLen,
    estimated: true,
    fraction,
  };
}

/**
 * Read a metadata range from the job work dir when the duration probe already
 * fetched exactly this range; otherwise download it. Reuse is what keeps the
 * head/tail bytes out of the MEGA budget twice.
 */
async function readOrFetchRange(
  filePath: string,
  start: number,
  endExclusive: number,
  fetch: () => Promise<unknown>,
  signal?: AbortSignal,
): Promise<{ buf: Buffer; reused: boolean }> {
  const expected = endExclusive - start;
  const st = await fs.promises.stat(filePath).catch(() => null);
  if (st?.isFile() && st.size === expected) {
    throwIfAborted(signal);
    return { buf: await fs.promises.readFile(filePath), reused: true };
  }
  throwIfAborted(signal);
  await fetch();
  return { buf: await fs.promises.readFile(filePath), reused: false };
}

export interface SourceDurationProbe {
  durationSec: number | null;
  source: 'database' | 'warm-cache' | 'mp4-mvhd' | 'ts-unknown' | 'unavailable';
  /** MEGA bytes spent on the bounded metadata probe (reused later). */
  transferBytes: number;
}

/**
 * Resolve a reliable duration for a source whose database row has none.
 *
 * This is deliberately bounded and cached in the job's work dir:
 *  - warm media cache: ffprobe the local file (0 MEGA bytes);
 *  - MP4: fetch only the moov-bearing head (or tail), parse `mvhd`;
 *  - TS: there is no global index, so report `ts-unknown` instead of
 *    inventing a duration from a fixed bitrate.
 *
 * The head/tail files are left in `workDir` with the exact names
 * `resolveMontageSources()` uses, so the later acquisition pass reuses them
 * instead of downloading the same metadata twice.
 */
export async function probeMontageSourceDuration(
  video: OwnedVideo,
  workDir: string,
  fileKey: Buffer,
  deps: PreviewSourceDeps,
  signal?: AbortSignal,
): Promise<SourceDurationProbe> {
  if (video.duration && video.duration > 0) {
    return { durationSec: video.duration, source: 'database', transferBytes: 0 };
  }
  const size = video.fileSize !== null ? Number(video.fileSize) : 0;
  if (size <= 0) return { durationSec: null, source: 'unavailable', transferBytes: 0 };
  throwIfAborted(signal);

  const warm = await deps.readWarmCache(video.id, video.megaNodeId, size);
  if (warm) {
    const probe = await probeMedia(warm.path, previewFfmpegTimeoutMs(), signal);
    if (probe?.durationSec && probe.durationSec > 0) {
      return { durationSec: probe.durationSec, source: 'warm-cache', transferBytes: 0 };
    }
  }

  if (needsRemuxForContainer(video.mimeType)) {
    return { durationSec: null, source: 'ts-unknown', transferBytes: 0 };
  }

  const { url, size: resolvedSize } = await resolveDownloadUrl(video, deps);
  const totalSize = resolvedSize || size;
  const moovMax = previewMoovMaxBytes();
  const headLen = Math.min(moovMax, totalSize);
  const head = path.join(workDir, 'head.bin');
  await decryptRangeToFile(deps, url, 0, headLen - 1, fileKey, head, signal);
  let transfer = headLen;
  const headBuf = await fs.promises.readFile(head);
  const headMoov = findMoovInChunk(headBuf, 0, totalSize);
  if (headMoov?.complete) {
    const duration = readMp4DurationSeconds(headBuf, 0, totalSize);
    return {
      durationSec: duration,
      source: duration ? 'mp4-mvhd' : 'unavailable',
      transferBytes: transfer,
    };
  }

  const tailLen = Math.min(moovMax, totalSize);
  const tailStart = Math.max(0, alignDown(totalSize - tailLen, 16));
  const tail = path.join(workDir, 'tail.bin');
  await decryptRangeToFile(deps, url, tailStart, totalSize - 1, fileKey, tail, signal);
  transfer += totalSize - tailStart;
  const tailBuf = await fs.promises.readFile(tail);
  const duration = readMp4DurationSeconds(tailBuf, tailStart, totalSize);
  return {
    durationSec: duration,
    source: duration ? 'mp4-mvhd' : 'unavailable',
    transferBytes: transfer,
  };
}

/**
 * Acquire the media windows for every montage scene in ONE bounded pass.
 *
 * The important difference from calling `resolvePreviewSource` per scene:
 * the MP4 moov/head/tail bytes are fetched once, and media windows are merged
 * before hitting MEGA (nearby scenes become one aligned range request).
 * Total bytes are clamped to PREVIEW_MONTAGE_SOURCE_BUDGET_BYTES and the
 * number of requests to PREVIEW_MONTAGE_MAX_RANGES.
 */
export async function resolveMontageSources(
  video: OwnedVideo,
  scenes: MontageSceneRequest[],
  workDir: string,
  fileKey: Buffer,
  deps: PreviewSourceDeps,
  opts: MontageSourceOptions = {},
): Promise<MontageSourcePlan> {
  const signal = opts.signal;
  throwIfAborted(signal);
  const size = video.fileSize !== null ? Number(video.fileSize) : 0;
  if (size <= 0) throw new SourceUnavailableError('source size unknown');
  const maxRanges = previewMontageMaxRanges();
  if (scenes.length === 0) throw new SourceUnavailableError('no montage scenes');
  const tmpFiles: string[] = [];
  const cleanup = async (): Promise<void> => {
    await Promise.all(tmpFiles.map((f) => fs.promises.rm(f, { force: true })));
  };
  const probeBytes = Math.max(0, opts.prefetchedTransferBytes ?? 0);
  const duration =
    opts.durationSec !== undefined
      ? opts.durationSec !== null && opts.durationSec > 0
        ? opts.durationSec
        : null
      : video.duration !== null && video.duration > 0
        ? video.duration
        : null;
  const coverageSeconds = Math.max(8, ...scenes.map((s) => s.durationSec + 8));
  const perWindowMax = Math.max(
    2 * 1024 * 1024,
    Math.min(previewMontageWindowMaxBytes(), Math.floor(previewMontageSourceBudgetBytes() / scenes.length)),
  );
  const isTs = needsRemuxForContainer(video.mimeType);
  const align = isTs ? 752 : 16;

  const windowsFor = (sourceSize: number, durationSec: number | null): PreparedSceneWindow[] =>
    scenes.map((scene) =>
      planMontageSceneWindow(scene, durationSec, sourceSize, perWindowMax, align, coverageSeconds),
    );

  /**
   * Map planned byte windows onto merged requested ranges. TS seeks are
   * relative to the cut window; fraction-selected scenes always seek to 0
   * and keep their estimated timeline flag.
   */
  const segmentsFromTs = (
    tsWindows: PreparedSceneWindow[],
    sourceSize: number,
    ranges: Array<{ byteStart: number; byteLen: number }>,
    files: string[],
  ): { segments: MontageSceneSource[]; omittedScenes: number[] } => {
    const segments: MontageSceneSource[] = [];
    const omittedScenes: number[] = [];
    for (const window of tsWindows) {
      const rIndex = ranges.findIndex(
        (r) => window.byteStart >= r.byteStart && window.byteStart < r.byteStart + r.byteLen,
      );
      if (rIndex < 0) {
        omittedScenes.push(window.scene.index);
        continue;
      }
      const rangeStartSec =
        duration && duration > 0
          ? byteOffsetToSeconds(ranges[rIndex].byteStart, sourceSize, duration)
          : 0;
      const seekSec =
        duration && duration > 0 && window.fraction === null
          ? Math.max(0, window.startSec - rangeStartSec)
          : 0;
      segments.push({
        index: window.scene.index,
        path: files[rIndex],
        seekSec,
        durationSec: window.scene.durationSec,
        startSec: window.startSec,
        estimated: window.estimated,
        byteFraction: window.fraction,
      });
    }
    return { segments, omittedScenes };
  };

  // 1. Warm media cache: one local MP4 serves every scene (0 MEGA bytes).
  if (size > 0) {
    const warm = await deps.readWarmCache(video.id, video.megaNodeId, size);
    if (warm) {
      const windows = windowsFor(size, duration);
      return {
        kind: 'local-mp4',
        segments: windows.map((w) => ({
          index: w.scene.index,
          path: warm.path,
          seekSec: w.startSec,
          durationSec: w.scene.durationSec,
          startSec: w.startSec,
          estimated: w.estimated,
          byteFraction: w.fraction,
        })),
        transferBytes: probeBytes,
        omittedScenes: [],
        degradedSelection: windows.some((w) => w.fraction !== null),
        cleanup,
      };
    }
  }

  // 2. Local TS acquisition prefix: cut all merged windows from disk.
  if (isTs) {
    const windows = windowsFor(size, duration);
    const ranges = mergeByteWindows(
      windows.map((w) => ({ byteStart: w.byteStart, byteLen: w.byteLen })),
      perWindowMax,
      1024 * 1024,
    ).slice(0, maxRanges);
    const frontier = await loadSourceFrontier(video.id).catch(() => null);
    const part = tsPartPath(video.id);
    const partStat = await fs.promises.stat(part).catch(() => null);
    const coveredAll =
      ranges.length > 0 &&
      ranges.every((r) => frontier && partStat?.isFile() && frontier.frontier >= r.byteStart + r.byteLen);
    if (coveredAll) {
      throwIfAborted(signal);
      const files: string[] = [];
      for (let i = 0; i < ranges.length; i++) {
        throwIfAborted(signal);
        const f = path.join(workDir, `local-${i}.ts`);
        await copySlice(part, ranges[i].byteStart, ranges[i].byteLen, f);
        files.push(f);
        tmpFiles.push(f);
      }
      const { segments, omittedScenes } = segmentsFromTs(windows, size, ranges, files);
      return {
        kind: 'ts-window',
        segments,
        transferBytes: probeBytes,
        omittedScenes,
        degradedSelection: windows.some((w) => w.fraction !== null),
        cleanup,
      };
    }
  }

  // 3./4. Bounded MEGA acquisition: one download URL, one moov pass.
  throwIfAborted(signal);
  const { url, size: resolvedSize } = await resolveDownloadUrl(video, deps);
  const totalSize = resolvedSize || size;
  if (isTs) {
    const windows = windowsFor(totalSize, duration);
    const ranges = mergeByteWindows(
      windows.map((w) => ({ byteStart: w.byteStart, byteLen: w.byteLen })),
      perWindowMax,
      1024 * 1024,
    ).slice(0, maxRanges);
    if (ranges.length === 0) throw new SourceUnavailableError('empty TS window');
    let transfer = 0;
    const files: string[] = [];
    for (let i = 0; i < ranges.length; i++) {
      throwIfAborted(signal);
      const f = path.join(workDir, `mega-${i}.ts`);
      await decryptRangeToFile(
        deps,
        url,
        ranges[i].byteStart,
        ranges[i].byteStart + ranges[i].byteLen - 1,
        fileKey,
        f,
        signal,
      );
      transfer += ranges[i].byteLen;
      files.push(f);
      tmpFiles.push(f);
    }
    const { segments, omittedScenes } = segmentsFromTs(windows, totalSize, ranges, files);
    return {
      kind: 'ts-window',
      segments,
      transferBytes: probeBytes + transfer,
      omittedScenes,
      degradedSelection: windows.some((w) => w.fraction !== null),
      cleanup,
    };
  }

  // MP4: head/tail + one sparse file, media windows merged before fetch.
  // The duration probe may already have written exactly these ranges into
  // the work dir; reuse them and account for their bytes once.
  const moovMax = previewMoovMaxBytes();
  const headLen = Math.min(moovMax, totalSize);
  const head = path.join(workDir, 'head.bin');
  const headData = await readOrFetchRange(
    head,
    0,
    headLen,
    () => decryptRangeToFile(deps, url, 0, headLen - 1, fileKey, head, signal),
    signal,
  );
  tmpFiles.push(head);
  const headBuf = headData.buf;
  let transfer = headData.reused ? 0 : headLen;

  let moov = findMoovInChunk(headBuf, 0, totalSize);
  let moovEnd = moov?.complete ? moov.end : null;
  let regionStart = 0;
  let regionLen = 0;
  const sparse = path.join(workDir, 'source.mp4');
  let effectiveDuration = duration;

  if (!moovEnd) {
    const tailLen = Math.min(moovMax, totalSize);
    const tailStart = Math.max(0, alignDown(totalSize - tailLen, 16));
    const tail = path.join(workDir, 'tail.bin');
    const tailData = await readOrFetchRange(
      tail,
      tailStart,
      totalSize,
      () => decryptRangeToFile(deps, url, tailStart, totalSize - 1, fileKey, tail, signal),
      signal,
    );
    tmpFiles.push(tail);
    if (!tailData.reused) transfer += totalSize - tailStart;
    moov = findMoovInChunk(tailData.buf, tailStart, totalSize);
    if (!moov) throw new SourceUnavailableError('moov not found in head or tail');
    if (!moov.complete) throw new SourceUnavailableError('moov incomplete in tail chunk');
    moovEnd = moov.end;
    if (!effectiveDuration) {
      effectiveDuration = readMp4DurationSeconds(tailData.buf, tailStart, totalSize);
    }
    const fh = await fs.promises.open(sparse, 'w');
    try {
      await fh.truncate(totalSize);
      await fh.write(headBuf, 0, headBuf.length, 0);
      await fh.write(tailData.buf, 0, tailData.buf.length, tailStart);
    } finally {
      await fh.close();
    }
    tmpFiles.push(sparse);
    regionStart = 0;
    regionLen = Math.max(0, moov.start);
  } else {
    if (!effectiveDuration) {
      effectiveDuration = readMp4DurationSeconds(headBuf, 0, totalSize);
    }
    const fh = await fs.promises.open(sparse, 'w');
    try {
      await fh.truncate(totalSize);
      await fh.write(headBuf, 0, Math.min(moovEnd, headBuf.length), 0);
    } finally {
      await fh.close();
    }
    tmpFiles.push(sparse);
    regionStart = Math.ceil(moovEnd / 16) * 16;
    regionLen = Math.max(0, totalSize - regionStart);
  }

  // A complete moov normally yields mvhd. If it does not, do not pretend a
  // byte offset is a timestamp: MP4 seeking needs the index.
  if (!effectiveDuration || effectiveDuration <= 0) {
    throw new SourceUnavailableError('mp4 duration unknown');
  }
  if (regionLen <= 0) throw new SourceUnavailableError('empty MP4 media region');
  const windows = windowsFor(regionLen, effectiveDuration);
  throwIfAborted(signal);
  const ranges = mergeByteWindows(
    windows.map((w) => ({ byteStart: w.byteStart + regionStart, byteLen: w.byteLen })),
    perWindowMax,
    1024 * 1024,
  ).slice(0, maxRanges);
  if (ranges.length === 0) throw new SourceUnavailableError('empty MP4 window');
  const fh = await fs.promises.open(sparse, 'r+');
  try {
    for (let i = 0; i < ranges.length; i++) {
      throwIfAborted(signal);
      const r = ranges[i];
      const f = path.join(workDir, `media-${i}.bin`);
      await decryptRangeToFile(deps, url, r.byteStart, r.byteStart + r.byteLen - 1, fileKey, f, signal);
      transfer += r.byteLen;
      tmpFiles.push(f);
      const buf = await fs.promises.readFile(f);
      await fh.write(buf, 0, buf.length, r.byteStart);
    }
  } finally {
    await fh.close();
  }

  const segments: MontageSceneSource[] = [];
  const omittedScenes: number[] = [];
  for (const window of windows) {
    const absStart = window.byteStart + regionStart;
    const r = ranges.find((r) => absStart >= r.byteStart && absStart < r.byteStart + r.byteLen);
    if (!r) {
      omittedScenes.push(window.scene.index);
      continue;
    }
    segments.push({
      index: window.scene.index,
      path: sparse,
      seekSec: window.startSec,
      durationSec: window.scene.durationSec,
      startSec: window.startSec,
      estimated: window.estimated,
      byteFraction: window.fraction,
    });
  }
  return {
    kind: 'sparse-mp4',
    segments,
    transferBytes: probeBytes + transfer,
    omittedScenes,
    degradedSelection: windows.some((w) => w.fraction !== null),
    cleanup,
  };
}

/** Test hook: expose the work-dir root (unit tests set PREVIEW_CACHE_DIR). */
export function previewTempRoot(): string {
  return previewsDirForTemp();
}

const WORK_DIR_RE = /^\d+\.tmp-/;

/**
 * Startup orphan sweep: work dirs belong to one generation job each and are
 * removed by its finally, but a crash/hard exit can strand them. Runs once
 * per server start, BEFORE any request can start a new job, so it cannot
 * race a live job. Dirs newer than 10 minutes are left alone (clock skew /
 * restart-during-job safety) — they get swept by the next restart or
 * reclaimed by normal eviction pressure.
 */
export async function sweepOrphanWorkDirs(): Promise<number> {
  let names: string[];
  try {
    names = await fs.promises.readdir(previewsDirForTemp());
  } catch {
    return 0;
  }
  let swept = 0;
  const cutoff = Date.now() - 10 * 60_000;
  for (const name of names) {
    if (!WORK_DIR_RE.test(name)) continue;
    const abs = path.join(previewsDirForTemp(), name);
    try {
      const st = await fs.promises.stat(abs);
      if (!st.isDirectory() || st.mtimeMs >= cutoff) continue;
      await fs.promises.rm(abs, { recursive: true, force: true });
      swept++;
    } catch {
      // raced deletion - leave
    }
  }
  if (swept > 0) console.log(`[preview] swept ${swept} orphan work dir(s)`);
  return swept;
}

/** Default deps: production MEGA boundaries (mirror the media route's). */
import { withMegaSession } from '../sync/session-cache';
import { getTemporaryDownloadUrl } from '../mega/account';
import { keepAliveFetch } from '../net-resilience';
import { readRemuxCache } from '../media/remux';

export const defaultPreviewSourceDeps: PreviewSourceDeps = {
  fetchCiphertext: (url, signal) => keepAliveFetch(url, { signal }),
  withSession: withMegaSession as unknown as PreviewSourceDeps['withSession'],
  getDownloadUrl: (storage, nodeId) =>
    getTemporaryDownloadUrl(storage as Parameters<typeof getTemporaryDownloadUrl>[0], nodeId),
  readWarmCache: readRemuxCache,
};
