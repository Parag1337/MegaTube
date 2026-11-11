/**
 * Phase 5 preview system: service core (meta endpoint logic + generation).
 *
 * Split out of the routes (same pattern as `handleMediaRequest`) so unit
 * tests can drive it with injected deps and no next/headers request scope.
 *
 * Responsibilities:
 *  - the exact thumbs-route auth matrix (401 / 400 / 404 / 410 / 409);
 *  - meta answers from the disk sidecar whenever possible, and enqueue only
 *    bounded background work when something is missing;
 *  - generation orchestration: candidate ladder → bounded source plan →
 *    encode → brightness verdict → atomic publish → sidecar update;
 *  - serving clip/sprite bytes with Range, ETag and stream refcounts.
 *
 * Hard rules: never modify Phase 3–4 code paths (the media cache is read
 * only), never re-encode originals, never buffer media in Node memory.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { MEGA_ACCOUNT_STATUSES } from '@/lib/megaAccounts';
import { decryptSecret } from '@/lib/mega/envelope';
import {
  clipPath,
  readSidecar,
  removePreviewAssets,
  spritePath,
  touchPreview,
  trackPreviewStream,
  writeSidecarAtomic,
} from './cache';
import {
  previewClipHeight,
  previewClipMaxFileBytes,
  previewClipMinSeconds,
  previewClipSeconds,
  previewDisabled,
  previewFfmpegTimeoutMs,
  previewMaxAttempts,
  previewMaxHeapRatio,
  previewFailureCooldownMs,
  previewSpriteCols,
  previewSpriteMaxTiles,
  previewSpriteMinIntervalSec,
  previewSpriteTileW,
} from './config';
import {
  brightnessVerdict,
  encodeHoverClip,
  encodeSprite,
  probeBrightnessFrames,
  probeMedia,
} from './ffmpeg';
import { PreviewQueue, QueueFullError, previewQueueSingleton } from './queue';
import { buildSpriteVtt, candidatePositions, spritePlan } from './segment';
import {
  createWorkDir,
  defaultPreviewSourceDeps,
  removeWorkDir,
  resolvePreviewSource,
  SourceUnavailableError,
  type PreviewSourceDeps,
} from './source';
import type { AssetReportStatus, MetaResponse, OwnedVideo, PreviewSidecar } from './types';

// ---------------------------------------------------------------------------
// Injectable deps (unit tests swap prisma / MEGA boundaries out)
// ---------------------------------------------------------------------------

export interface PreviewVideoRow {
  id: number;
  megaNodeId: string | null;
  fileKeyEncrypted: string | null;
  mimeType: string | null;
  fileSize: bigint | null;
  duration: number | null;
  mp4Faststart: boolean | null;
  megaAccount: { id: number; userId: string; status: string; encryptedSession: string } | null;
}

export interface PreviewServiceDeps {
  loadVideo: (userId: string, videoId: number) => Promise<PreviewVideoRow | null>;
  decryptFileKey: (enc: string) => Buffer;
  sourceDeps: PreviewSourceDeps;
  readWarmCache: (
    videoId: number,
    megaNodeId: string,
    sourceSize: number,
  ) => Promise<{ path: string; size: number } | null>;
  queue: PreviewQueue;
  now: () => number;
}

function defaultDeps(): PreviewServiceDeps {
  return {
    loadVideo: async (userId, videoId) =>
      prisma.video.findFirst({
        where: { id: videoId, megaAccountId: { not: null } },
        select: {
          id: true,
          megaNodeId: true,
          fileKeyEncrypted: true,
          mimeType: true,
          fileSize: true,
          duration: true,
          mp4Faststart: true,
          megaAccount: { select: { id: true, userId: true, status: true, encryptedSession: true } },
        },
      }),
    decryptFileKey: decryptSecret,
    sourceDeps: defaultPreviewSourceDeps,
    readWarmCache: defaultPreviewSourceDeps.readWarmCache,
    queue: previewQueueSingleton(),
    now: () => Date.now(),
  };
}

export const defaultPreviewServiceDeps: PreviewServiceDeps = defaultDeps();

// ---------------------------------------------------------------------------
// Auth + shared helpers
// ---------------------------------------------------------------------------

function jsonError(status: number, error: string, extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ error, ...extra }, { status });
}

/** The thumbs-route ownership matrix, shared by every preview route. */
async function authorize(
  rawUserId: string | null,
  videoId: number,
  deps: PreviewServiceDeps,
): Promise<{ video: PreviewVideoRow } | { response: NextResponse }> {
  if (!rawUserId) return { response: jsonError(401, 'Not authenticated.') };
  if (!Number.isInteger(videoId) || videoId <= 0) return { response: jsonError(400, 'Invalid video id.') };
  const video = await deps.loadVideo(rawUserId, videoId);
  if (!video || !video.megaAccount || video.megaAccount.userId !== rawUserId) {
    return { response: jsonError(404, 'Video not found.') };
  }
  if (video.megaAccount.status === MEGA_ACCOUNT_STATUSES.DISCONNECTED) {
    return { response: jsonError(410, 'The MEGA account for this video is disconnected.') };
  }
  if (!video.megaNodeId || !video.fileKeyEncrypted) {
    return { response: jsonError(409, 'This video is not playable yet.') };
  }
  return { video };
}

/** Identity with the documented wildcard: unknown source size ⇒ node-only. */
function sidecarMatchesRow(sidecar: PreviewSidecar, video: PreviewVideoRow): boolean {
  if (sidecar.megaNodeId !== video.megaNodeId) return false;
  if (video.fileSize === null) return true;
  return sidecar.sourceSize === Number(video.fileSize);
}

function ownedVideoOf(video: PreviewVideoRow): OwnedVideo {
  return {
    id: video.id,
    megaNodeId: video.megaNodeId as string,
    mimeType: video.mimeType,
    fileSize: video.fileSize !== null ? Number(video.fileSize) : null,
    duration: video.duration,
    mp4Faststart: video.mp4Faststart,
    megaAccountId: video.megaAccount?.id ?? 0,
    encryptedSession: video.megaAccount?.encryptedSession ?? '',
  };
}

async function fileReadable(absPath: string): Promise<{ ok: boolean; size: number }> {
  try {
    const st = await fs.promises.stat(absPath);
    return st.isFile() && st.size > 0 ? { ok: true, size: st.size } : { ok: false, size: 0 };
  } catch {
    return { ok: false, size: 0 };
  }
}

function toTileH(tileW: number): number {
  return Math.round(tileW * 9 / 16);
}

/** In-memory cooldown for timeline failures (cheap, restart clears it). */
const timelineCooldown = new Map<number, number>();

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

const GENERATION_LOG_PREFIX = '[preview]';

interface HoverOutcome {
  ok: boolean;
  detail: string;
}

/**
 * Generate the hover clip. Tries up to PREVIEW_MAX_ATTEMPTS candidates per
 * run; on total failure records attempts/failedAt in the sidecar so meta
 * stops paying for this video until the cooldown expires.
 */
async function generateHover(video: PreviewVideoRow, deps: PreviewServiceDeps): Promise<HoverOutcome> {
  const videoId = video.id;
  const timeoutMs = previewFfmpegTimeoutMs();
  let lastDetail = 'no candidate produced a usable segment';
  let transferBytes = 0;
  let ffmpegMs = 0;
  const workDir = await createWorkDir(videoId);
  try {
    let sidecar = await readSidecar(videoId);
    if (sidecar && sidecar.status === 'ready' && sidecar.hover) {
      const clip = await fileReadable(clipPath(videoId));
      if (clip.ok) return { ok: true, detail: 'already ready' };
      sidecar = null; // assets vanished (raced eviction): regenerate
    }

    // Attempt budget (design §7): retried at most PREVIEW_MAX_ATTEMPTS times,
    // then parked for the cooldown. Expired cooldown resets the budget.
    let attempts = sidecar?.attempts ?? 0;
    if (sidecar?.status === 'failed' && sidecar.failedAt) {
      const age = deps.now() - Date.parse(sidecar.failedAt);
      if (Number.isFinite(age) && age >= previewFailureCooldownMs()) attempts = 0;
    }
    if (attempts >= previewMaxAttempts()) {
      return { ok: false, detail: 'attempt budget exhausted (cooldown active)' };
    }

    const owned = ownedVideoOf(video);
    const fileKey = deps.decryptFileKey(video.fileKeyEncrypted as string);
    const candidates = candidatePositions(video.duration, previewClipSeconds()).slice(0, previewMaxAttempts());
    let bestFailure: HoverOutcome | null = null;

    for (const candidate of candidates) {
      attempts++;
      let plan: Awaited<ReturnType<typeof resolvePreviewSource>> | null = null;
      try {
        plan = await resolvePreviewSource(owned, candidate.t, workDir, fileKey, deps.sourceDeps);
        transferBytes += plan.transferBytes;

        const tmpOut = path.join(workDir, 'clip.tmp.mp4');
        let t0 = deps.now();
        const encoded = await encodeHoverClip({
          inputPath: plan.path,
          seekSec: plan.seekSec,
          clipSeconds: previewClipSeconds(),
          height: previewClipHeight(),
          outPath: tmpOut,
          timeoutMs,
        });
        ffmpegMs += deps.now() - t0;
        if (!encoded.ok) {
          lastDetail = `encode failed (${encoded.detail})`;
          await plan.cleanup();
          plan = null;
          continue;
        }

        t0 = deps.now();
        const probe = await probeMedia(tmpOut, timeoutMs);
        ffmpegMs += deps.now() - t0;
        if (!probe || probe.durationSec === null || probe.durationSec < previewClipMinSeconds()) {
          lastDetail = probe
            ? `clip too short (${probe.durationSec?.toFixed(1) ?? '?'}s < ${previewClipMinSeconds()}s)`
            : 'clip probe failed';
          await plan.cleanup();
          plan = null;
          continue;
        }

        t0 = deps.now();
        const means = await probeBrightnessFrames(tmpOut, { timeoutMs });
        ffmpegMs += deps.now() - t0;
        const verdict = brightnessVerdict(means);
        if (verdict !== 'usable') {
          // Black/unknown segment: keep as best-effort fallback, prefer a
          // brighter candidate (mirrors the thumbs pickFrame ladder).
          if (!bestFailure) {
            bestFailure = { ok: false, detail: `segment rejected (${verdict})` };
          }
          lastDetail = `segment rejected (${verdict})`;
          await plan.cleanup();
          plan = null;
          continue;
        }

        const st = await fs.promises.stat(tmpOut);
        if (st.size <= 0 || st.size > previewClipMaxFileBytes()) {
          lastDetail = `clip size out of bounds (${st.size} B)`;
          await plan.cleanup();
          plan = null;
          continue;
        }

        // Publish atomically within the same filesystem (workDir lives inside
        // the previews dir): rename over any previous clip, then the sidecar.
        const published = clipPath(videoId);
        await fs.promises.rename(tmpOut, published);
        const durationSec = Math.min(probe.durationSec, previewClipSeconds());
        const nowIso = new Date(deps.now()).toISOString();
        const next: PreviewSidecar = {
          version: 1,
          videoId,
          megaNodeId: owned.megaNodeId,
          sourceSize: owned.fileSize ?? sidecar?.sourceSize ?? 1,
          durationSeconds: video.duration ?? sidecar?.durationSeconds ?? null,
          status: 'ready',
          hover: {
            startSec: candidate.t,
            durationSec,
            width: probe.width,
            height: probe.height,
            bytes: st.size,
            estimated: candidate.estimated,
          },
          timeline: sidecar?.timeline ?? null,
          attempts,
          lastError: null,
          failedAt: null,
          lastAccessedAt: nowIso,
          metrics: { transferBytes, ffmpegMs: Math.round(ffmpegMs), generatedAt: nowIso },
        };
        await writeSidecarAtomic(next);
        console.log(
          `${GENERATION_LOG_PREFIX} hover ready video ${videoId} source=${plan.kind} ` +
            `t=${candidate.t.toFixed(0)}s ${(st.size / 1024).toFixed(0)}KB ` +
            `mega=${(transferBytes / 1048576).toFixed(1)}MB ffmpeg=${Math.round(ffmpegMs)}ms`,
        );
        return { ok: true, detail: 'generated' };
      } catch (err) {
        if (err instanceof SourceUnavailableError) {
          lastDetail = `source unavailable: ${err.message}`;
        } else {
          lastDetail = `generation error: ${err instanceof Error ? err.message.slice(0, 120) : typeof err}`;
          console.warn(`${GENERATION_LOG_PREFIX} hover candidate error video ${videoId}: ${lastDetail}`);
        }
      } finally {
        if (plan) await plan.cleanup().catch(() => {});
      }
    }

    // All candidates failed: record the failure (bounded retries + cooldown).
    const nowIso = new Date(deps.now()).toISOString();
    const parked = attempts >= previewMaxAttempts();
    const next: PreviewSidecar = {
      version: 1,
      videoId,
      megaNodeId: owned.megaNodeId,
      sourceSize: owned.fileSize ?? sidecar?.sourceSize ?? 1,
      durationSeconds: video.duration ?? sidecar?.durationSeconds ?? null,
      status: 'failed',
      hover: null,
      timeline: sidecar?.timeline ?? null,
      attempts,
      lastError: bestFailure ? `${bestFailure.detail}; ${lastDetail}` : lastDetail,
      failedAt: parked ? nowIso : null,
      lastAccessedAt: sidecar?.lastAccessedAt ?? nowIso,
      metrics: sidecar?.metrics ?? null,
    };
    await writeSidecarAtomic(next);
    return { ok: false, detail: next.lastError ?? lastDetail };
  } finally {
    await removeWorkDir(workDir);
  }
}

/**
 * Generate the timeline spritesheet — ONLY from the warm media cache
 * (design §2.4: per-keyframe windows from MEGA are rejected by design).
 * Missing warm cache is a STATE (no sidecar failure, no attempts); hard
 * failures cool down in-memory only.
 */
async function generateTimeline(video: PreviewVideoRow, deps: PreviewServiceDeps): Promise<HoverOutcome> {
  const videoId = video.id;
  const sourceSize = video.fileSize !== null ? Number(video.fileSize) : null;
  if (sourceSize === null) return { ok: false, detail: 'source-not-local' };

  const warm = await deps.readWarmCache(videoId, video.megaNodeId as string, sourceSize);
  if (!warm) return { ok: false, detail: 'source-not-local' };

  let sidecar = await readSidecar(videoId);
  if (sidecar && sidecar.status === 'ready' && sidecar.timeline) {
    const sprite = await fileReadable(spritePath(videoId));
    if (sprite.ok) return { ok: true, detail: 'already ready' };
    sidecar = null;
  }

  const cooldownUntil = timelineCooldown.get(videoId) ?? 0;
  if (deps.now() < cooldownUntil) return { ok: false, detail: 'timeline cooldown' };

  const timeoutMs = previewFfmpegTimeoutMs();
  const workDir = await createWorkDir(videoId);
  try {
    // Duration: DB first (trusted enough for a sprite grid), ffprobe of the
    // local file as the authority when the DB has none.
    let durationSec = video.duration !== null && video.duration > 0 ? video.duration : null;
    let ffmpegMs = 0;
    if (durationSec === null) {
      const t0 = deps.now();
      const probe = await probeMedia(warm.path, timeoutMs);
      ffmpegMs += deps.now() - t0;
      durationSec = probe?.durationSec ?? null;
    }
    if (durationSec === null) {
      timelineCooldown.set(videoId, deps.now() + previewFailureCooldownMs());
      return { ok: false, detail: 'unknown-duration' };
    }

    const tileW = previewSpriteTileW();
    const tileH = toTileH(tileW);
    const plan = spritePlan(durationSec, tileW, previewSpriteCols(), previewSpriteMaxTiles(), previewSpriteMinIntervalSec());
    const tmpOut = path.join(workDir, 'sprite.tmp.jpg');
    const t0 = deps.now();
    const encoded = await encodeSprite({
      inputPath: warm.path,
      intervalSec: plan.intervalSec,
      tileW,
      tileH,
      cols: plan.cols,
      rows: plan.rows,
      outPath: tmpOut,
      timeoutMs,
    });
    ffmpegMs += deps.now() - t0;
    if (!encoded.ok) {
      timelineCooldown.set(videoId, deps.now() + previewFailureCooldownMs());
      return { ok: false, detail: `sprite encode failed (${encoded.detail})` };
    }
    const st = await fs.promises.stat(tmpOut);
    if (st.size <= 0) {
      timelineCooldown.set(videoId, deps.now() + previewFailureCooldownMs());
      return { ok: false, detail: 'sprite empty' };
    }

    await fs.promises.rename(tmpOut, spritePath(videoId));
    const nowIso = new Date(deps.now()).toISOString();
    const base: PreviewSidecar = sidecar ?? {
      version: 1,
      videoId,
      megaNodeId: video.megaNodeId as string,
      sourceSize,
      durationSeconds: durationSec,
      status: 'ready',
      hover: null,
      timeline: null,
      attempts: 0,
      lastError: null,
      failedAt: null,
      lastAccessedAt: nowIso,
      metrics: null,
    };
    await writeSidecarAtomic({
      ...base,
      status: base.hover ? 'ready' : base.status === 'failed' ? 'failed' : 'ready',
      timeline: {
        tileW,
        tileH,
        cols: plan.cols,
        rows: plan.rows,
        intervalSec: plan.intervalSec,
        count: plan.count,
      },
      durationSeconds: base.durationSeconds ?? durationSec,
      lastAccessedAt: nowIso,
      metrics: base.metrics ?? { transferBytes: 0, ffmpegMs: Math.round(ffmpegMs), generatedAt: nowIso },
    });
    console.log(
      `${GENERATION_LOG_PREFIX} timeline ready video ${videoId} cells=${plan.count} ` +
        `interval=${plan.intervalSec}s ${(st.size / 1024).toFixed(0)}KB ffmpeg=${Math.round(ffmpegMs)}ms`,
    );
    return { ok: true, detail: 'generated' };
  } finally {
    await removeWorkDir(workDir);
  }
}

// ---------------------------------------------------------------------------
// Enqueue (bounded queue + heap admission gate)
// ---------------------------------------------------------------------------

/** Design §9 admission gate: refuse work when the heap is nearly exhausted. */
function heapAdmissionRefused(): boolean {
  try {
    const { heapUsed } = process.memoryUsage();
    return heapUsed > previewMaxHeapRatio() * os.totalmem();
  } catch {
    return false;
  }
}

function enqueueGeneration(
  video: PreviewVideoRow,
  kind: 'hover' | 'timeline',
  signal: AbortSignal | undefined,
  deps: PreviewServiceDeps,
): Promise<'started' | 'queued' | 'rejected' | 'busy'> {
  const key = `${kind}:${video.id}`;
  if (deps.queue.has(key)) return Promise.resolve('started');
  if (heapAdmissionRefused()) return Promise.resolve('rejected');
  return deps.queue
    .enqueue(
      key,
      () => (kind === 'hover' ? generateHover(video, deps) : generateTimeline(video, deps)),
      signal ?? null,
    )
    .then(
      () => 'started' as const,
      (err: unknown) => {
        if (err instanceof QueueFullError) return 'busy' as const;
        console.warn(`${GENERATION_LOG_PREFIX} queue error ${key}: ${err instanceof Error ? err.message : err}`);
        return 'busy' as const;
      },
    );
}

// ---------------------------------------------------------------------------
// Meta endpoint core
// ---------------------------------------------------------------------------

export interface MetaRequest {
  /** Raw `want` query parameter (`hover,timeline`; default both). */
  want?: string | null;
  signal?: AbortSignal;
}

function parseWant(raw: string | null | undefined): { hover: boolean; timeline: boolean } {
  if (!raw || raw.trim().length === 0) return { hover: true, timeline: true };
  const parts = raw.split(',').map((p) => p.trim().toLowerCase());
  return { hover: parts.includes('hover'), timeline: parts.includes('timeline') };
}

function cooldownActive(sidecar: PreviewSidecar, deps: PreviewServiceDeps): boolean {
  if (sidecar.status !== 'failed' || !sidecar.failedAt) return false;
  if (sidecar.attempts < previewMaxAttempts()) return false; // budget left: retry allowed
  const age = deps.now() - Date.parse(sidecar.failedAt);
  return Number.isFinite(age) && age < previewFailureCooldownMs();
}

export async function handlePreviewMeta(
  rawUserId: string | null,
  videoIdParam: string,
  request: MetaRequest,
  deps: PreviewServiceDeps = defaultPreviewServiceDeps,
): Promise<NextResponse> {
  const videoId = Number(videoIdParam);
  const auth = await authorize(rawUserId, videoId, deps);
  if ('response' in auth) return auth.response;
  const video = auth.video;

  const want = parseWant(request.want);
  const base: MetaResponse = { videoId, status: 'unavailable', hover: null, timeline: null };

  if (previewDisabled()) {
    return NextResponse.json(
      {
        ...base,
        timeline: want.timeline
          ? { status: 'unavailable' as AssetReportStatus, vtt: null, sprite: null, intervalSec: null, count: null, reason: 'disabled' }
          : null,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // Sidecar: read + validate identity (a changed source invalidates itself).
  let sidecar = await readSidecar(videoId);
  if (sidecar && !sidecarMatchesRow(sidecar, video)) {
    sidecar = null;
    await removePreviewAssets(videoId).catch(() => {});
  }
  const hoverInFlight = deps.queue.has(`hover:${videoId}`);
  const timelineInFlight = deps.queue.has(`timeline:${videoId}`);

  // ---- hover ----
  let hoverStatus: AssetReportStatus = 'unavailable';
  let hoverCooldown = false;
  if (want.hover) {
    const clip = sidecar?.status === 'ready' && sidecar.hover ? await fileReadable(clipPath(videoId)) : { ok: false, size: 0 };
    if (clip.ok && sidecar?.hover) {
      hoverStatus = 'ready';
      base.hover = {
        url: `/api/preview/${videoId}`,
        startSec: sidecar.hover.startSec,
        durationSec: sidecar.hover.durationSec,
        width: sidecar.hover.width,
        height: sidecar.hover.height,
        estimated: sidecar.hover.estimated,
      };
      void touchPreview(videoId);
    } else if (hoverInFlight) {
      hoverStatus = 'generating';
    } else if (sidecar && cooldownActive(sidecar, deps)) {
      hoverStatus = 'unavailable';
      hoverCooldown = true;
    } else {
      // Not ready (or a ready sidecar without bytes — stale): enqueue a run.
      const outcome = await enqueueGeneration(video, 'hover', request.signal, deps);
      hoverStatus = outcome === 'busy' || outcome === 'rejected' ? 'rejected' : 'generating';
    }
    base.status = hoverStatus;
  } else {
    base.status = hoverInFlight ? 'generating' : 'unavailable';
  }

  // ---- timeline ----
  if (want.timeline) {
    let timelineStatus: AssetReportStatus = 'unavailable';
    let reason: string | null = null;
    const sprite = sidecar?.status === 'ready' && sidecar.timeline ? await fileReadable(spritePath(videoId)) : { ok: false, size: 0 };
    if (sprite.ok && sidecar?.timeline) {
      timelineStatus = 'ready';
      base.timeline = {
        status: 'ready',
        vtt: `/api/preview/${videoId}/timeline/vtt`,
        sprite: `/api/preview/${videoId}/timeline`,
        intervalSec: sidecar.timeline.intervalSec,
        count: sidecar.timeline.count,
        reason: null,
      };
      void touchPreview(videoId);
    } else if (timelineInFlight) {
      timelineStatus = 'generating';
      reason = null;
    } else if (video.fileSize === null || !(await warmCacheAvailable(video, deps))) {
      // Warm-cache-only rule (design §2.4): report the state honestly and
      // enqueue nothing — the first full playback warms the cache.
      timelineStatus = 'unavailable';
      reason = 'source-not-local';
    } else if (hoverCooldown && sidecar && cooldownActive(sidecar, deps)) {
      timelineStatus = 'unavailable';
      reason = 'cooldown';
    } else {
      const outcome = await enqueueGeneration(video, 'timeline', request.signal, deps);
      if (outcome === 'busy' || outcome === 'rejected') {
        timelineStatus = 'unavailable';
        reason = 'busy';
      } else {
        timelineStatus = 'generating';
      }
    }
    base.timeline = { status: timelineStatus, vtt: base.timeline?.vtt ?? null, sprite: base.timeline?.sprite ?? null, intervalSec: base.timeline?.intervalSec ?? null, count: base.timeline?.count ?? null, reason };
  }

  return NextResponse.json(base, { headers: { 'Cache-Control': 'no-store' } });
}

/** Cheap warm-cache probe for the timeline gate (no MEGA work). */
function warmCacheAvailable(video: PreviewVideoRow, deps: PreviewServiceDeps): Promise<boolean> {
  const size = video.fileSize !== null ? Number(video.fileSize) : 0;
  if (!video.megaNodeId || size <= 0) return Promise.resolve(false);
  return deps.readWarmCache(video.id, video.megaNodeId, size).then((w) => w !== null);
}

// ---------------------------------------------------------------------------
// Asset serving (clip / sprite) + VTT
// ---------------------------------------------------------------------------

function parseRangeHeader(range: string | null, size: number): { start: number; end: number } | null | 'invalid' {
  if (!range) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start: number;
  let end: number;
  if (m[1] === '') {
    // suffix range: last N bytes
    const suffix = Number(m[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start >= size) return 'invalid';
  return { start, end };
}

export type PreviewAssetKind = 'clip' | 'sprite';

export interface AssetRequest {
  rangeHeader?: string | null;
  ifNoneMatch?: string | null;
  signal?: AbortSignal;
}

function assetEtag(videoId: number, sidecar: PreviewSidecar, kind: PreviewAssetKind, bytes: number): string {
  return `"pv-${videoId}-${sidecar.sourceSize}-${kind}-${bytes}"`;
}

/**
 * Serve one preview asset with the shared conventions: Range support,
 * refcount-protected against eviction while streaming, ETag/304, private
 * browser caching (repeat hovers never re-download bytes).
 */
export async function handlePreviewAsset(
  rawUserId: string | null,
  videoIdParam: string,
  kind: PreviewAssetKind,
  request: AssetRequest,
  deps: PreviewServiceDeps = defaultPreviewServiceDeps,
): Promise<Response> {
  const videoId = Number(videoIdParam);
  const auth = await authorize(rawUserId, videoId, deps);
  if ('response' in auth) return auth.response;

  const sidecar = await readSidecar(videoId);
  if (!sidecar || !sidecarMatchesRow(sidecar, auth.video) || sidecar.status !== 'ready') {
    return jsonError(404, 'Preview not available.', { status: 'unavailable' });
  }
  if (kind === 'clip' && !sidecar.hover) return jsonError(404, 'Preview not available.', { status: 'unavailable' });
  if (kind === 'sprite' && !sidecar.timeline) return jsonError(404, 'Preview not available.', { status: 'unavailable' });

  const absPath = kind === 'clip' ? clipPath(videoId) : spritePath(videoId);
  const file = await fileReadable(absPath);
  if (!file.ok) return jsonError(404, 'Preview not available.', { status: 'unavailable' });

  const etag = assetEtag(videoId, sidecar, kind, file.size);
  if (request.ifNoneMatch && request.ifNoneMatch.trim() === etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, 'Cache-Control': 'private, max-age=3600' },
    });
  }

  const range = parseRangeHeader(request.rangeHeader ?? null, file.size);
  if (range === 'invalid') {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${file.size}`, 'Cache-Control': 'private, max-age=3600' },
    });
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : file.size - 1;

  const release = trackPreviewStream(videoId);
  const nodeStream = fs.createReadStream(absPath, { start, end });
  if (request.signal) {
    request.signal.addEventListener('abort', () => nodeStream.destroy(), { once: true });
  }
  nodeStream.on('error', (err: Error) => {
    if (err.name !== 'AbortError') {
      console.warn(`[preview] asset stream error video ${videoId}: ${err.message.slice(0, 80)}`);
    }
  });
  nodeStream.once('close', release);

  const headers = new Headers({
    'Content-Type': kind === 'clip' ? 'video/mp4' : 'image/jpeg',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    ETag: etag,
    'Content-Length': String(end - start + 1),
  });
  const partial = !(start === 0 && end === file.size - 1);
  if (partial) headers.set('Content-Range', `bytes ${start}-${end}/${file.size}`);
  void touchPreview(videoId);
  return new Response(Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>, {
    status: partial ? 206 : 200,
    headers,
  });
}

/** WebVTT for Vidstack timeline thumbnails (sprite URL is route-relative). */
export async function handlePreviewVtt(
  rawUserId: string | null,
  videoIdParam: string,
  request: { ifNoneMatch?: string | null },
  deps: PreviewServiceDeps = defaultPreviewServiceDeps,
): Promise<Response> {
  const videoId = Number(videoIdParam);
  const auth = await authorize(rawUserId, videoId, deps);
  if ('response' in auth) return auth.response;

  const sidecar = await readSidecar(videoId);
  if (!sidecar || !sidecarMatchesRow(sidecar, auth.video) || sidecar.status !== 'ready' || !sidecar.timeline) {
    return jsonError(404, 'Preview not available.', { status: 'unavailable' });
  }
  const duration = sidecar.durationSeconds;
  if (duration === null) return jsonError(404, 'Preview not available.', { status: 'unavailable' });

  const info = sidecar.timeline;
  const vtt = buildSpriteVtt({
    spriteUrl: `/api/preview/${videoId}/timeline`,
    durationSec: duration,
    intervalSec: info.intervalSec,
    count: info.count,
    cols: info.cols,
    tileW: info.tileW,
    tileH: info.tileH,
  });
  const etag = `"pv-${videoId}-${sidecar.sourceSize}-vtt-${info.count}"`;
  if (request.ifNoneMatch && request.ifNoneMatch.trim() === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'private, max-age=3600' } });
  }
  void touchPreview(videoId);
  return new Response(vtt, {
    status: 200,
    headers: {
      'Content-Type': 'text/vtt; charset=utf-8',
      'Cache-Control': 'private, max-age=3600',
      ETag: etag,
    },
  });
}
