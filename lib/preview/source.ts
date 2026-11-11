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
  byteWindowFor,
  mergeByteWindows,
} from './segment';
import { findMoovInChunk } from './mp4-index';
import {
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
  /** Scene start on the source timeline. */
  startSec: number;
  durationSec: number;
}

export interface MontageSceneSource {
  index: number;
  path: string;
  /** Input-side seek for ffmpeg (0 for TS windows, absolute for MP4). */
  seekSec: number;
  durationSec: number;
  startSec: number;
}

export interface MontageSourcePlan {
  kind: SourceKind;
  segments: MontageSceneSource[];
  transferBytes: number;
  /** Scenes dropped because no bounded window could cover them. */
  omittedScenes: number[];
  cleanup: () => Promise<void>;
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
): Promise<MontageSourcePlan> {
  const size = video.fileSize !== null ? Number(video.fileSize) : 0;
  if (size <= 0) throw new SourceUnavailableError('source size unknown');
  const maxRanges = previewMontageMaxRanges();
  if (scenes.length === 0) throw new SourceUnavailableError('no montage scenes');
  const tmpFiles: string[] = [];
  const cleanup = async (): Promise<void> => {
    await Promise.all(tmpFiles.map((f) => fs.promises.rm(f, { force: true })));
  };
  const coverageSeconds = Math.max(8, ...scenes.map((s) => s.durationSec + 8));
  const perWindowMax = Math.max(
    2 * 1024 * 1024,
    Math.min(previewMontageWindowMaxBytes(), Math.floor(previewMontageSourceBudgetBytes() / scenes.length)),
  );

  // 1. Warm media cache: one local MP4 serves every scene (0 MEGA bytes).
  if (size > 0) {
    const warm = await deps.readWarmCache(video.id, video.megaNodeId, size);
    if (warm) {
      return {
        kind: 'local-mp4',
        segments: scenes.map((s) => ({
          index: s.index,
          path: warm.path,
          seekSec: s.startSec,
          durationSec: s.durationSec,
          startSec: s.startSec,
        })),
        transferBytes: 0,
        omittedScenes: [],
        cleanup,
      };
    }
  }

  const isTs = needsRemuxForContainer(video.mimeType);
  const duration = video.duration;

  // 2. Local TS acquisition prefix: cut all merged windows from disk.
  if (isTs) {
    const windows = scenes.map((s) => ({
      scene: s,
      window: byteWindowFor(s.startSec, duration, size, perWindowMax, 752, coverageSeconds, 1.6),
    }));
    const ranges = mergeByteWindows(
      windows.map((w) => ({ byteStart: w.window.byteStart, byteLen: w.window.byteLen })),
      perWindowMax,
      1024 * 1024,
    ).slice(0, maxRanges);
    const frontier = await loadSourceFrontier(video.id).catch(() => null);
    const part = tsPartPath(video.id);
    const partStat = await fs.promises.stat(part).catch(() => null);
    const coveredAll = ranges.length > 0 && ranges.every((r) => frontier && partStat?.isFile() && frontier.frontier >= r.byteStart + r.byteLen);
    if (coveredAll && ranges.length > 0) {
      const files: string[] = [];
      for (let i = 0; i < ranges.length; i++) {
        const f = path.join(workDir, `local-${i}.ts`);
        await copySlice(part, ranges[i].byteStart, ranges[i].byteLen, f);
        files.push(f);
        tmpFiles.push(f);
      }
      const segments: MontageSceneSource[] = [];
      const omitted: number[] = [];
      for (const { scene, window } of windows) {
        const r = ranges.find((r) => window.byteStart >= r.byteStart && window.byteStart < r.byteStart + r.byteLen);
        if (!r) { omitted.push(scene.index); continue; }
        const relStart = Math.max(0, scene.startSec - byteOffsetToSeconds(r.byteStart, size, duration));
        segments.push({
          index: scene.index,
          path: files[ranges.indexOf(r)],
          seekSec: relStart,
          durationSec: scene.durationSec,
          startSec: scene.startSec,
        });
      }
      return { kind: 'ts-window', segments, transferBytes: 0, omittedScenes: omitted, cleanup };
    }
  }

  // 3./4. Bounded MEGA acquisition: one download URL, one moov pass.
  const { url, size: resolvedSize } = await resolveDownloadUrl(video, deps);
  const totalSize = resolvedSize || size;
  if (isTs) {
    const windows = scenes.map((s) => ({
      scene: s,
      window: byteWindowFor(s.startSec, duration, totalSize, perWindowMax, 752, coverageSeconds, 1.6),
    }));
    const ranges = mergeByteWindows(
      windows.map((w) => ({ byteStart: w.window.byteStart, byteLen: w.window.byteLen })),
      perWindowMax,
      1024 * 1024,
    ).slice(0, maxRanges);
    if (ranges.length === 0) throw new SourceUnavailableError('empty TS window');
    let transfer = 0;
    const files: string[] = [];
    for (let i = 0; i < ranges.length; i++) {
      const f = path.join(workDir, `mega-${i}.ts`);
      await decryptRangeToFile(deps, url, ranges[i].byteStart, ranges[i].byteStart + ranges[i].byteLen - 1, fileKey, f);
      transfer += ranges[i].byteLen;
      files.push(f);
      tmpFiles.push(f);
    }
    const segments: MontageSceneSource[] = [];
    const omitted: number[] = [];
    for (const { scene, window } of windows) {
      const rIndex = ranges.findIndex((r) => window.byteStart >= r.byteStart && window.byteStart < r.byteStart + r.byteLen);
      if (rIndex < 0) { omitted.push(scene.index); continue; }
      const r = ranges[rIndex];
      const relStart = Math.max(0, scene.startSec - byteOffsetToSeconds(r.byteStart, totalSize, duration));
      segments.push({
        index: scene.index,
        path: files[rIndex],
        seekSec: relStart,
        durationSec: scene.durationSec,
        startSec: scene.startSec,
      });
    }
    return { kind: 'ts-window', segments, transferBytes: transfer, omittedScenes: omitted, cleanup };
  }

  // MP4: head/tail + one sparse file, media windows merged before fetch.
  const moovMax = previewMoovMaxBytes();
  const headLen = Math.min(moovMax, totalSize);
  const head = path.join(workDir, 'head.bin');
  await decryptRangeToFile(deps, url, 0, headLen - 1, fileKey, head);
  tmpFiles.push(head);
  let transfer = headLen;
  const headBuf = await fs.promises.readFile(head);
  let moov = findMoovInChunk(headBuf, 0, totalSize);
  let moovEnd = moov?.complete ? moov.end : null;
  let regionStart = 0;
  let regionLen = 0;
  const sparse = path.join(workDir, 'source.mp4');
  const openSparse = async (): Promise<fs.promises.FileHandle> => fs.promises.open(sparse, 'r+');

  if (!moovEnd) {
    const tailLen = Math.min(moovMax, totalSize);
    const tailStart = Math.max(0, alignDown(totalSize - tailLen, 16));
    const tail = path.join(workDir, 'tail.bin');
    await decryptRangeToFile(deps, url, tailStart, totalSize - 1, fileKey, tail);
    transfer += totalSize - tailStart;
    tmpFiles.push(tail);
    const tailBuf = await fs.promises.readFile(tail);
    moov = findMoovInChunk(tailBuf, tailStart, totalSize);
    if (!moov) throw new SourceUnavailableError('moov not found in head or tail');
    if (!moov.complete) throw new SourceUnavailableError('moov incomplete in tail chunk');
    moovEnd = moov.end;
    const fh = await fs.promises.open(sparse, 'w');
    try {
      await fh.truncate(totalSize);
      await fh.write(headBuf, 0, headBuf.length, 0);
      await fh.write(tailBuf, 0, tailBuf.length, tailStart);
    } finally {
      await fh.close();
    }
    tmpFiles.push(sparse);
    regionStart = 0;
    regionLen = Math.max(0, moov.start);
  } else {
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

  if (regionLen <= 0) throw new SourceUnavailableError('empty MP4 media region');
  const windows = scenes.map((s) => ({
    scene: s,
    window: byteWindowFor(s.startSec, duration, regionLen, perWindowMax, 16, coverageSeconds, 1.6),
  }));
  const ranges = mergeByteWindows(
    windows.map((w) => ({ byteStart: w.window.byteStart + regionStart, byteLen: w.window.byteLen })),
    perWindowMax,
    1024 * 1024,
  ).slice(0, maxRanges);
  if (ranges.length === 0) throw new SourceUnavailableError('empty MP4 window');
  const fh = await openSparse();
  try {
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i];
      const f = path.join(workDir, `media-${i}.bin`);
      await decryptRangeToFile(deps, url, r.byteStart, r.byteStart + r.byteLen - 1, fileKey, f);
      transfer += r.byteLen;
      tmpFiles.push(f);
      const buf = await fs.promises.readFile(f);
      await fh.write(buf, 0, buf.length, r.byteStart);
    }
  } finally {
    await fh.close();
  }

  const segments: MontageSceneSource[] = [];
  const omitted: number[] = [];
  for (const { scene, window } of windows) {
    const absStart = window.byteStart + regionStart;
    const r = ranges.find((r) => absStart >= r.byteStart && absStart < r.byteStart + r.byteLen);
    if (!r) { omitted.push(scene.index); continue; }
    segments.push({
      index: scene.index,
      path: sparse,
      seekSec: scene.startSec,
      durationSec: scene.durationSec,
      startSec: scene.startSec,
    });
  }
  return { kind: 'sparse-mp4', segments, transferBytes: transfer, omittedScenes: omitted, cleanup };
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
