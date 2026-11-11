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
  previewDisabled,
  previewFfmpegTimeoutMs,
  previewMaxHeapRatio,
  previewFailureCooldownMs,
  previewGenerationConfig,
  previewGenerationVersion,
  previewMontageMaxFileBytes,
  previewPriorityHover,
  previewSceneAlternatives,
  previewSpriteCols,
  previewSpriteMaxTiles,
  previewSpriteMinIntervalSec,
  previewSpriteTileW,
} from './config';
import {
  brightnessVerdict,
  encodeMontage,
  encodeSprite,
  probeMedia,
  probeSceneSample,
  sceneSignatureDistance,
  validateMontageFile,
  type MontageInput,
} from './ffmpeg';
import { PreviewQueue, previewQueueSingleton } from './queue';
import {
  buildSpriteVtt,
  montageCanvas,
  outputFps,
  planMontage,
  sceneAlternatives,
  spritePlan,
  type MontagePlan,
} from './segment';
import {
  createWorkDir,
  defaultPreviewSourceDeps,
  removeWorkDir,
  resolveMontageSources,
  type MontageSceneRequest,
  type PreviewSourceDeps,
} from './source';
import {
  ensurePreviewJob,
  requeueMissingPreviewJob,
  sourceFingerprintFor,
  type PreviewJobEnsureResult,
  type PreviewJobMetrics,
} from './jobs';
import type {
  AssetReportStatus,
  MetaResponse,
  OwnedVideo,
  PreviewMetrics,
  PreviewSidecar,
} from './types';

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
  /** Durable backlog integration (production default; tests inject a stub). */
  ensureJob?: (
    videoId: number,
    sourceFingerprint: string,
    priority: number,
    opts?: { retryEligible?: boolean; artifactValid?: boolean },
  ) => Promise<PreviewJobEnsureResult>;
  requeueMissingArtifact?: (jobId: number) => Promise<boolean>;
  wakeWorker?: () => void;
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
    ensureJob: (videoId, sourceFingerprint, priority, opts) =>
      ensurePreviewJob({
        videoId,
        sourceFingerprint,
        priority,
        retryEligible: opts?.retryEligible,
        artifactValid: opts?.artifactValid,
      }),
    requeueMissingArtifact: (jobId) => requeueMissingPreviewJob(jobId),
    wakeWorker: () => {
      // Dynamic import keeps worker -> service -> worker from being a
      // synchronous cycle and keeps build-time evaluation free of timers.
      void import('./worker').then((m) => m.wakePreviewWorker(), () => {});
    },
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

export interface HoverGenerationOutcome {
  ok: boolean;
  detail: string;
  errorCode?: string;
  retryable?: boolean;
  unsupported?: boolean;
  /** Full job metrics, or the sidecar metrics when a ready artifact exists. */
  metrics?: PreviewJobMetrics | PreviewMetrics;
}

type HoverOutcome = HoverGenerationOutcome;

/** Sanitized one-line failure detail (never a URL or credential). */
function sanitizeFailureDetail(input: unknown): string {
  const text = input instanceof Error ? input.message : String(input);
  return text.replace(/https?:\/\/\S+/g, '[url]').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function classifyGenerationError(input: unknown): {
  code: string;
  retryable: boolean;
  unsupported: boolean;
} {
  const text = (input instanceof Error ? input.message : String(input)).toLowerCase();
  if (text.includes('source size unknown')) return { code: 'source_size_unknown', retryable: false, unsupported: false };
  if (text.includes('unsupported') || text.includes('unknown decoder') || text.includes('invalid data')) {
    return { code: 'unsupported_codec', retryable: false, unsupported: true };
  }
  if (text.includes('moov not found') || text.includes('moov incomplete')) {
    return { code: 'moov_missing', retryable: true, unsupported: false };
  }
  if (text.includes('timeout') || text.includes('timed out')) {
    return { code: 'ffmpeg_timeout', retryable: true, unsupported: false };
  }
  if (text.includes('ciphertext fetch failed') || text.includes('source unavailable')) {
    return { code: 'download_failed', retryable: true, unsupported: false };
  }
  if (text.includes('output too large')) return { code: 'output_too_large', retryable: true, unsupported: false };
  if (text.includes('output') || text.includes('probe failed')) {
    return { code: 'output_invalid', retryable: true, unsupported: false };
  }
  if (text.includes('encode failed') || text.includes('ffmpeg')) {
    return { code: 'encode_failed', retryable: true, unsupported: false };
  }
  return { code: 'internal', retryable: true, unsupported: false };
}

async function writeFailedSidecar(
  video: PreviewVideoRow,
  previous: PreviewSidecar | null,
  detail: string,
  deps: PreviewServiceDeps,
): Promise<void> {
  const nowIso = new Date(deps.now()).toISOString();
  const next: PreviewSidecar = {
    version: 2,
    videoId: video.id,
    megaNodeId: video.megaNodeId as string,
    sourceSize: video.fileSize !== null ? Number(video.fileSize) : previous?.sourceSize ?? 1,
    durationSeconds: video.duration ?? previous?.durationSeconds ?? null,
    status: 'failed',
    hover: null,
    timeline: previous?.timeline ?? null,
    attempts: (previous?.attempts ?? 0) + 1,
    lastError: sanitizeFailureDetail(detail),
    failedAt: nowIso,
    lastAccessedAt: previous?.lastAccessedAt ?? nowIso,
    metrics: previous?.metrics ?? null,
    generationVersion: previewGenerationVersion(),
  };
  await writeSidecarAtomic(next).catch(() => {});
}

/**
 * Generate one compact multi-scene hover montage for a video.
 *
 * The flow is bounded end-to-end:
 *   1. plan representative scenes (short videos get fewer/shorter scenes),
 *   2. acquire all scene windows in ONE cheap source pass (warm cache →
 *      local TS prefix → merged MEGA ranges; never the whole video),
 *   3. brightness/duplicate-gate every scene, retrying small offsets within
 *      the already-acquired window,
 *   4. encode the scenes into one silent faststart MP4, validate the bytes,
 *   5. publish atomically and write the versioned sidecar.
 *
 * Exported for the durable worker; the old on-demand single-scene path is
 * intentionally gone (the montage replaces it for every card preview).
 */
export async function generateHoverForWorker(
  video: PreviewVideoRow,
  deps: PreviewServiceDeps,
  opts?: { onStage?: (stage: string) => void },
): Promise<HoverGenerationOutcome> {
  const videoId = video.id;
  const timeoutMs = previewFfmpegTimeoutMs();
  const version = previewGenerationVersion();
  const startedAt = deps.now();
  let transferBytes = 0;
  let ffmpegMs = 0;
  let acquisitionMs = 0;
  const workDir = await createWorkDir(videoId);
  let sidecar: PreviewSidecar | null = null;
  try {
    sidecar = await readSidecar(videoId);
    if (sidecar) {
      if (sidecar.generationVersion !== version || !sidecarMatchesRow(sidecar, video)) {
        // Old-format or changed-source artifact: never serve it as current.
        await removePreviewAssets(videoId).catch(() => {});
        sidecar = null;
      } else if (sidecar.status === 'ready' && sidecar.hover) {
        const clip = await fileReadable(clipPath(videoId));
        if (clip.ok) {
          return { ok: true, detail: 'already ready', metrics: sidecar.metrics ?? undefined };
        }
        sidecar = null; // asset vanished (eviction/restart): regenerate
      }
    }

    const owned = ownedVideoOf(video);
    if (!owned.megaNodeId || !video.fileKeyEncrypted) {
      return { ok: false, detail: 'source is not playable', errorCode: 'source_unavailable', retryable: false };
    }
    const fileKey = deps.decryptFileKey(video.fileKeyEncrypted);
    const cfg = previewGenerationConfig();
    const plan = planMontage(video.duration, cfg.sceneCount, cfg.sceneSeconds);
    if (plan.scenes.length === 0) {
      return { ok: false, detail: 'no usable scenes', errorCode: 'output_invalid', retryable: false };
    }

    opts?.onStage?.('acquiring');
    const acquireStarted = deps.now();
    let source: Awaited<ReturnType<typeof resolveMontageSources>>;
    try {
      source = await resolveMontageSources(
        owned,
        plan.scenes.map((scene): MontageSceneRequest => ({
          index: scene.index,
          startSec: scene.startSec,
          durationSec: scene.durationSec,
        })),
        workDir,
        fileKey,
        deps.sourceDeps,
      );
    } catch (err) {
      const cls = classifyGenerationError(err);
      return {
        ok: false,
        detail: sanitizeFailureDetail(err),
        errorCode: cls.code,
        retryable: cls.retryable,
        unsupported: cls.unsupported,
      };
    }
    acquisitionMs = deps.now() - acquireStarted;
    transferBytes = source.transferBytes;
    if (source.segments.length === 0) {
      return {
        ok: false,
        detail: 'no source segment could be acquired',
        errorCode: 'source_unavailable',
        retryable: true,
      };
    }

    // Source geometry/fps: one probe of the first acquired segment is enough
    // (all scenes come from the same original). The canvas is never larger
    // than the source, so low-resolution videos are never upscaled.
    const probeStarted = deps.now();
    const sourceProbe = await probeMedia(source.segments[0].path, timeoutMs);
    ffmpegMs += deps.now() - probeStarted;
    if (!sourceProbe) {
      return {
        ok: false,
        detail: 'source probe failed',
        errorCode: 'output_invalid',
        retryable: false,
      };
    }
    const canvas = montageCanvas(sourceProbe.width, sourceProbe.height, cfg);
    const fps = outputFps(sourceProbe.fps, cfg.fpsCap);

    opts?.onStage?.('scene-selection');
    const selected: Array<{
      scene: MontagePlan['scenes'][number];
      input: MontageInput;
      sample: NonNullable<Awaited<ReturnType<typeof probeSceneSample>>>;
    }> = [];
    const signatures: number[][] = [];
    for (const scene of plan.scenes) {
      const segment = source.segments.find((s) => s.index === scene.index);
      if (!segment) continue;
      type SceneSample = NonNullable<Awaited<ReturnType<typeof probeSceneSample>>>;
      let usable: { input: MontageInput; sample: SceneSample } | null = null;
      let best: { input: MontageInput; sample: SceneSample } | null = null;
      for (const alt of sceneAlternatives(scene, video.duration, previewSceneAlternatives())) {
        const seek = Math.max(0, segment.seekSec + (alt - scene.startSec));
        const t0 = deps.now();
        const sample = await probeSceneSample(segment.path, {
          seekSec: seek,
          durationSec: scene.durationSec,
          timeoutMs,
        });
        ffmpegMs += deps.now() - t0;
        if (!sample) continue;
        const input: MontageInput = { path: segment.path, seekSec: seek, durationSec: scene.durationSec };
        if (!best) best = { input, sample };
        const verdict = brightnessVerdict(sample.means);
        const duplicate = signatures.some((sig) => sceneSignatureDistance(sig, sample.signature) < 2.5);
        if (verdict === 'usable' && !duplicate) {
          usable = { input, sample };
          break;
        }
      }
      const chosen = usable ?? best;
      if (!chosen) continue;
      selected.push({ scene, input: chosen.input, sample: chosen.sample });
      signatures.push(chosen.sample.signature);
    }
    if (selected.length === 0) {
      return {
        ok: false,
        detail: 'all candidate scenes were unusable',
        errorCode: 'output_invalid',
        retryable: true,
      };
    }
    // Chronological order, independent of the percentage ladder index.
    selected.sort((a, b) => a.input.seekSec - b.input.seekSec);

    opts?.onStage?.('encoding');
    const tmpOut = path.join(workDir, 'montage.tmp.mp4');
    const encodeStarted = deps.now();
    const encoded = await encodeMontage({
      inputs: selected.map((s) => s.input),
      width: canvas.width,
      height: canvas.height,
      fps,
      bitrateKbps: cfg.bitrateKbps,
      outPath: tmpOut,
      timeoutMs,
    });
    ffmpegMs += deps.now() - encodeStarted;
    if (!encoded.ok) {
      const cls = classifyGenerationError(encoded.detail);
      return {
        ok: false,
        detail: `encode failed (${sanitizeFailureDetail(encoded.detail)})`,
        errorCode: cls.code,
        retryable: cls.retryable,
        unsupported: cls.unsupported,
      };
    }

    const validateStarted = deps.now();
    const selectedDuration = selected.reduce((sum, s) => sum + s.input.durationSec, 0);
    const validated = await validateMontageFile(tmpOut, {
      minDurationSec: Math.max(0.5, selectedDuration * 0.5),
      maxBytes: previewMontageMaxFileBytes(),
      timeoutMs,
    });
    ffmpegMs += deps.now() - validateStarted;
    if (!validated.ok) {
      const cls = classifyGenerationError(validated.reason);
      return {
        ok: false,
        detail: `output invalid (${sanitizeFailureDetail(validated.reason)})`,
        errorCode: cls.code,
        retryable: cls.retryable,
        unsupported: cls.unsupported,
      };
    }

    opts?.onStage?.('publishing');
    await fs.promises.rename(tmpOut, clipPath(videoId));
    const nowIso = new Date(deps.now()).toISOString();
    const scenes = selected.map((s) => ({
      startSec: s.scene.startSec,
      durationSec: s.input.durationSec,
      sourceSeekSec: s.input.seekSec,
    }));
    const metrics: PreviewJobMetrics = {
      transferBytes,
      acquisitionMs: Math.round(acquisitionMs),
      ffmpegMs: Math.round(ffmpegMs),
      totalMs: Math.round(deps.now() - startedAt),
      outputBytes: validated.bytes,
      scenes,
      sourceKind: source.kind,
      generationVersion: version,
    };
    const next: PreviewSidecar = {
      version: 2,
      videoId,
      megaNodeId: owned.megaNodeId,
      sourceSize: owned.fileSize ?? sidecar?.sourceSize ?? 1,
      durationSeconds: video.duration ?? sidecar?.durationSeconds ?? null,
      status: 'ready',
      hover: {
        startSec: scenes[0]?.startSec ?? 0,
        durationSec: validated.durationSec ?? selectedDuration,
        width: validated.width,
        height: validated.height,
        bytes: validated.bytes,
        estimated: plan.estimated,
        generationVersion: version,
        scenes,
        faststart: validated.faststart,
      },
      timeline: sidecar?.timeline ?? null,
      attempts: 0,
      lastError: null,
      failedAt: null,
      lastAccessedAt: nowIso,
      metrics: {
        transferBytes,
        acquisitionMs: Math.round(acquisitionMs),
        ffmpegMs: Math.round(ffmpegMs),
        totalMs: Math.round(deps.now() - startedAt),
        sourceKind: source.kind,
        generatedAt: nowIso,
      },
      generationVersion: version,
    };
    await writeSidecarAtomic(next);
    console.log(
      `${GENERATION_LOG_PREFIX} montage ready video ${videoId} scenes=${scenes.length} ` +
        `source=${source.kind} ${(validated.bytes / 1024).toFixed(0)}KB ` +
        `mega=${(transferBytes / 1048576).toFixed(1)}MB ffmpeg=${Math.round(ffmpegMs)}ms`,
    );
    return { ok: true, detail: 'generated', metrics };
  } catch (err) {
    const cls = classifyGenerationError(err);
    await writeFailedSidecar(video, sidecar, sanitizeFailureDetail(err), deps);
    return {
      ok: false,
      detail: sanitizeFailureDetail(err),
      errorCode: cls.code,
      retryable: cls.retryable,
      unsupported: cls.unsupported,
    };
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
      version: 2,
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
      generationVersion: previewGenerationVersion(),
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
  signal: AbortSignal | undefined,
  deps: PreviewServiceDeps,
): 'started' | 'queued' | 'rejected' {
  const key = `timeline:${video.id}`;
  if (deps.queue.has(key)) return 'started';
  if (heapAdmissionRefused()) return 'rejected';
  // IMPORTANT: admit only. The meta endpoint must answer in milliseconds
  // with `generating`; waiting for the job outcome made meta block for the
  // entire MEGA download + ffmpeg run (and the browser fetch timed out).
  return deps.queue.enqueueNow(key, () => generateTimeline(video, deps), signal ?? null);
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
  const version = previewGenerationVersion();
  const base: MetaResponse = { videoId, status: 'unavailable', hover: null, errorCode: null, reason: null, timeline: null };

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

  // Sidecar: read + validate identity and generation version. A changed
  // source or old-format hover artifact invalidates itself; a legacy v1
  // sidecar was already migrated (timeline preserved) by readSidecar.
  let sidecar = await readSidecar(videoId);
  if (sidecar && (sidecar.generationVersion !== version || !sidecarMatchesRow(sidecar, video))) {
    sidecar = null;
    await removePreviewAssets(videoId).catch(() => {});
  }
  const timelineInFlight = deps.queue.has(`timeline:${videoId}`);

  // ---- hover (durable PostgreSQL backlog) ----
  let hoverStatus: AssetReportStatus = 'unavailable';
  if (want.hover) {
    const hoverReady = sidecar?.status === 'ready' && sidecar.hover && sidecar.generationVersion === version;
    const clip = hoverReady ? await fileReadable(clipPath(videoId)) : { ok: false, size: 0 };
    if (clip.ok && sidecar?.hover) {
      hoverStatus = 'ready';
      base.hover = {
        url: `/api/preview/${videoId}`,
        startSec: sidecar.hover.startSec,
        durationSec: sidecar.hover.durationSec,
        width: sidecar.hover.width,
        height: sidecar.hover.height,
        estimated: sidecar.hover.estimated,
        scenes: sidecar.hover.scenes ?? [],
      };
      void touchPreview(videoId);
    } else {
      const fingerprint = sourceFingerprintFor({
        megaNodeId: video.megaNodeId,
        fileSize: video.fileSize,
      });
      const ensure = deps.ensureJob ?? ((id, fp, priority, opts) => ensurePreviewJob({
        videoId: id,
        sourceFingerprint: fp,
        priority,
        retryEligible: opts?.retryEligible,
        artifactValid: opts?.artifactValid,
      }));
      const job = await ensure(videoId, fingerprint, previewPriorityHover(), {
        retryEligible: true,
        artifactValid: false,
      });
      deps.wakeWorker?.();
      if (job.status === 'completed') {
        // A completed row without a readable current artifact means the
        // local preview directory was ephemeral/cleared: requeue safely.
        const requeue = deps.requeueMissingArtifact ?? requeueMissingPreviewJob;
        if (job.jobId) await requeue(job.jobId).catch(() => {});
        hoverStatus = 'pending';
        base.errorCode = 'artifact_missing';
        base.reason = 'Preview artifact missing; requeued.';
      } else if (job.status === 'generating') {
        hoverStatus = 'generating';
        base.reason = 'Preview is being generated.';
      } else if (job.status === 'queued') {
        hoverStatus = 'queued';
        base.reason = 'Waiting for a preview worker slot.';
      } else if (job.status === 'pending') {
        hoverStatus = 'pending';
        base.reason = 'Preparing preview.';
      } else if (job.status === 'unsupported') {
        hoverStatus = 'unsupported';
        base.errorCode = 'unsupported_codec';
        base.reason = 'This source cannot be previewed safely.';
      } else {
        hoverStatus = 'failed';
        base.errorCode = 'generation_failed';
        base.reason = 'Preview generation failed.';
      }
    }
    base.status = hoverStatus;
  } else {
    base.status = 'unavailable';
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
    } else {
      const outcome = enqueueGeneration(video, request.signal, deps);
      if (outcome === 'rejected') {
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
  if (kind === 'clip') {
    // Only current-generation montages may be served. This is the hard
    // guarantee that an old/stale artifact is never exposed as ready.
    if (!sidecar.hover || sidecar.generationVersion !== previewGenerationVersion()) {
      return jsonError(404, 'Preview not available.', { status: 'unavailable' });
    }
  }
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
