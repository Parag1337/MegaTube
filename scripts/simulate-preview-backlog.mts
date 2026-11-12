/**
 * Controlled Phase 5.1 backlog simulation.
 *
 * Seeds N synthetic videos against an ISOLATED PostgreSQL database, points
 * every video at one local MP4 fixture (so no MEGA credentials or network are
 * involved), and drives the real durable queue + generation service with K
 * simulated workers. The shared PreviewQueue is the production single-slot
 * gate, so the run proves that a 400-video backlog never starts 400 ffmpeg
 * processes at once.
 *
 * It also polls the dashboard statistics while jobs finish, exercising the
 * TTL/single-flight cache under continuous invalidation.
 *
 * Run:
 *   DATABASE_URL=postgresql://.../megatube_simulation \
 *   PREVIEW_CACHE_DIR=/tmp/opencode/preview-sim \
 *   npx tsx scripts/simulate-preview-backlog.mts --videos 400 --workers 8
 *
 * The target database must already have all migrations applied. The script
 * seeds a dedicated user and leaves rows in place for inspection; drop the
 * simulation database when finished.
 */

import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { prisma } from '../lib/db';
import {
  assertPreviewJobOwnership,
  beginPreviewGenerationAttempt,
  claimNextPreviewJob,
  completePreviewJob,
  ensurePreviewJob,
  failPreviewJob,
  getPreviewLibraryStats,
  previewHoverArtifactValid,
  sourceFingerprintFor,
} from '../lib/preview/jobs';
import {
  previewStatsCacheMetrics,
  __resetPreviewStatsCacheForTests,
} from '../lib/preview/stats-cache';
import { PreviewQueue } from '../lib/preview/queue';
import { generateHoverForWorker } from '../lib/preview/service';
import { runFfmpeg } from '../lib/preview/ffmpeg';
import { sidecarPath } from '../lib/preview/cache';
import {
  previewGenerationVersion,
  previewJobLeaseMs,
  previewStatsMinRefreshMs,
} from '../lib/preview/config';

const args = process.argv.slice(2);
function flag(name: string, fallback: number): number {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const value = Number(args[i + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const videoCount = flag('--videos', 400);
const workerCount = flag('--workers', 8);
const fixtureSeconds = flag('--fixture-seconds', 2);
const runId = `sim-${Date.now().toString(36)}`;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required (use an isolated simulation database)');
}
const previewDir = process.env.PREVIEW_CACHE_DIR;
if (!previewDir) {
  throw new Error('PREVIEW_CACHE_DIR is required (use an isolated directory)');
}
fs.mkdirSync(previewDir, { recursive: true });

interface SimVideo {
  id: number;
  megaNodeId: string;
  fileKeyEncrypted: string;
  mimeType: string;
  fileSize: bigint;
  duration: number | null;
  megaAccount: {
    id: number;
    userId: string;
    status: string;
    encryptedSession: string;
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1)));
  return Math.round(sorted[index] * 10) / 10;
}

async function main(): Promise<void> {
  const started = Date.now();
  const user = await prisma.user.create({
    data: {
      email: `preview-sim-${runId}@example.com`,
      passwordHash: 'x',
      previewAutoGenerate: true,
      previewPaused: false,
    },
  });
  const account = await prisma.megaAccount.create({
    data: {
      userId: user.id,
      label: 'simulation',
      megaEmail: `mega-${runId}@example.com`,
      encryptedSession: 'v1.simulation',
      status: 'CONNECTED',
    },
  });

  const fixturePath = path.join(previewDir, 'fixture.mp4');
  const encoded = await runFfmpeg(
    [
      '-f', 'lavfi', '-i', `testsrc2=s=160x90:r=24:d=${fixtureSeconds}`,
      '-c:v', 'libopenh264',
      '-pix_fmt', 'yuv420p',
      '-b:v', '220k',
      '-rc_mode', 'bitrate',
      '-movflags', '+faststart',
      '-f', 'mp4',
      '-y', fixturePath,
    ],
    60_000,
  );
  if (encoded.code !== 0) throw new Error(`fixture encode failed: ${encoded.stderrTail}`);
  const fixtureSize = fs.statSync(fixturePath).size;

  const rows = Array.from({ length: videoCount }, (_, i) => ({
    megaAccountId: account.id,
    megaNodeId: `sim-node-${runId}-${i}`,
    megaFilename: `sim-${i}.mp4`,
    title: `Simulation video ${i}`,
    slug: `sim-${runId}-${i}`,
    fileSize: BigInt(fixtureSize),
    mimeType: 'video/mp4',
    // Exercise the metadata/byte-fraction duration fallback on a slice of
    // the library instead of assuming every row has a DB duration.
    duration: i % 5 === 0 ? null : fixtureSeconds,
  }));
  const created = await prisma.video.createManyAndReturn({
    data: rows,
    select: { id: true, megaNodeId: true, fileSize: true, duration: true },
  });
  const videos: SimVideo[] = created.map((v) => ({
    ...v,
    fileKeyEncrypted: 'v1.simulation',
    mimeType: 'video/mp4',
    megaAccount: {
      id: account.id,
      userId: user.id,
      status: 'CONNECTED',
      encryptedSession: 'v1.simulation',
    },
  }));
  const byId = new Map(videos.map((v) => [v.id, v]));

  for (const video of videos) {
    await ensurePreviewJob({
      videoId: video.id,
      sourceFingerprint: sourceFingerprintFor(video),
      priority: 0,
    });
  }

  const deps = {
    loadVideo: async () => null,
    decryptFileKey: () => Buffer.alloc(16),
    sourceDeps: {
      fetchCiphertext: async () => {
        throw new Error('simulation must not fetch MEGA ciphertext');
      },
      withSession: async () => {
        throw new Error('simulation must not open a MEGA session');
      },
      getDownloadUrl: async () => {
        throw new Error('simulation must not request a MEGA URL');
      },
      readWarmCache: async () => ({ path: fixturePath, size: fixtureSize }),
    },
    readWarmCache: async () => ({ path: fixturePath, size: fixtureSize }),
    queue: new PreviewQueue(1, 4),
    now: () => Date.now(),
  } as unknown as Parameters<typeof generateHoverForWorker>[1];

  // Production gate: one ffmpeg-heavy generation at a time. Simulated
  // workers may hold claims concurrently, but only the queue runner encodes.
  const queue = new PreviewQueue(1, Math.max(workerCount * 2, 8));
  const version = previewGenerationVersion();
  const leaseMs = previewJobLeaseMs();
  let maxQueueRunning = 0;
  let maxQueueDepth = 0;
  let completed = 0;
  let failed = 0;
  let lostClaims = 0;
  let stop = false;
  const jobDurations: number[] = [];
  const stageCounts = new Map<string, number>();

  const statsPollLatencies: number[] = [];
  let statsPolls = 0;
  let statsError: string | null = null;
  __resetPreviewStatsCacheForTests();
  const statsPolling = (async () => {
    while (!stop) {
      const t0 = Date.now();
      try {
        await getPreviewLibraryStats(user.id);
        statsPollLatencies.push(Date.now() - t0);
        statsPolls++;
      } catch (err) {
        statsError = err instanceof Error ? err.message : String(err);
        break;
      }
      await sleep(100);
    }
  })();

  const sampleQueue = setInterval(() => {
    const snapshot = queue.snapshot();
    maxQueueRunning = Math.max(maxQueueRunning, snapshot.running);
    maxQueueDepth = Math.max(maxQueueDepth, snapshot.queued);
  }, 10);
  if (typeof sampleQueue.unref === 'function') sampleQueue.unref();

  async function worker(workerId: string): Promise<void> {
    let idle = 0;
    while (!stop) {
      const job = await claimNextPreviewJob(workerId, leaseMs);
      if (!job) {
        if (++idle > 20) return;
        await sleep(50);
        continue;
      }
      idle = 0;
      const video = byId.get(job.videoId);
      if (!video) {
        await failPreviewJob(job.id, workerId, 'source_unavailable', 'simulation row missing', {
          claimCount: job.claimCount,
        });
        failed++;
        continue;
      }
      const jobStarted = Date.now();
      const attempts = await beginPreviewGenerationAttempt(job.id, workerId, job.claimCount, leaseMs);
      if (attempts === null) {
        lostClaims++;
        continue;
      }
      // PreviewQueue resolves with its own outcome string; the generation
      // result is produced by the runner, so capture it in the closure (the
      // production worker does the same).
      let outcome: Awaited<ReturnType<typeof generateHoverForWorker>> | null = null;
      const queueOutcome = await queue
        .enqueue(`hover:${job.videoId}`, async () => {
          outcome = await generateHoverForWorker(video, deps, {
            onStage: (stage) => stageCounts.set(stage, (stageCounts.get(stage) ?? 0) + 1),
            guardPublish: () =>
              assertPreviewJobOwnership(job.id, workerId, job.claimCount, leaseMs),
          });
          return outcome;
        })
        .catch((err: unknown) => {
          outcome = {
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
            errorCode: 'internal',
            retryable: true,
          };
          return 'failed' as const;
        });

      if (queueOutcome !== 'completed' || !outcome) {
        failed++;
        await failPreviewJob(job.id, workerId, 'internal', outcome?.detail ?? 'simulation runner failed', {
          retryable: true,
          claimCount: job.claimCount,
        });
        continue;
      }
      if (!outcome.ok) {
        failed++;
        await failPreviewJob(job.id, workerId, 'internal', outcome.detail, {
          retryable: true,
          claimCount: job.claimCount,
        });
        continue;
      }

      const artifact = await previewHoverArtifactValid(job.videoId, {
        megaNodeId: video.megaNodeId,
        sourceSize: Number(video.fileSize),
      });
      if (!artifact) {
        failed++;
        await failPreviewJob(job.id, workerId, 'artifact_missing', 'sidecar not valid after generation', {
          retryable: true,
          claimCount: job.claimCount,
        });
        continue;
      }
      const sidecar = JSON.parse(fs.readFileSync(sidecarPath(job.videoId), 'utf8')) as {
        hover?: { bytes?: number; scenes?: unknown[] };
        metrics?: {
          transferBytes?: number;
          acquisitionMs?: number;
          ffmpegMs?: number;
          totalMs?: number;
          sourceKind?: string;
        };
      };
      const metrics = sidecar.metrics ?? {};
      const done = await completePreviewJob(
        job.id,
        workerId,
        sidecar.hover?.bytes ?? 0,
        {
          transferBytes: metrics.transferBytes ?? 0,
          acquisitionMs: metrics.acquisitionMs ?? 0,
          ffmpegMs: metrics.ffmpegMs ?? 0,
          totalMs: metrics.totalMs ?? 0,
          outputBytes: sidecar.hover?.bytes ?? 0,
          scenes: (sidecar.hover?.scenes ?? []) as never,
          sourceKind: metrics.sourceKind ?? 'local',
          generationVersion: version,
        },
        job.claimCount,
      );
      if (done) {
        completed++;
        jobDurations.push(Date.now() - jobStarted);
      } else {
        lostClaims++;
      }
    }
  }

  await Promise.all(
    Array.from({ length: workerCount }, (_, i) => worker(`sim-worker-${runId}-${i}`)),
  );

  // Let the final invalidation clear the minimum-refresh throttle, then take
  // one authoritative snapshot (the dashboard serves bounded-stale data in
  // between, which is the point of the cache).
  await sleep(previewStatsMinRefreshMs() + 250);
  stop = true;
  await statsPolling;
  clearInterval(sampleQueue);
  const finalStats = await getPreviewLibraryStats(user.id);
  const cacheMetrics = previewStatsCacheMetrics();

  const jobs = await prisma.previewGenerationJob.findMany({
    where: { video: { megaAccountId: account.id } },
    select: { status: true, attempts: true, claimCount: true, recoveryCount: true },
  });
  const statusCounts: Record<string, number> = {};
  let attempts = 0;
  let claimTotal = 0;
  let recoveries = 0;
  for (const job of jobs) {
    statusCounts[job.status] = (statusCounts[job.status] ?? 0) + 1;
    attempts += job.attempts;
    claimTotal += job.claimCount;
    recoveries += job.recoveryCount;
  }

  const previewFiles = fs.readdirSync(previewDir).filter((name) => name.endsWith('.preview.mp4'));
  const previewBytes = previewFiles.reduce(
    (sum, name) => sum + fs.statSync(path.join(previewDir, name)).size,
    0,
  );

  const elapsedMs = Date.now() - started;
  const summary = {
    runId,
    videoCount,
    workerCount,
    fixtureSeconds,
    elapsedMs,
    jobs: {
      completed,
      failed,
      lostClaims,
      statusCounts,
      attempts,
      claimTotal,
      recoveries,
      averageAttemptsPerCompleted: completed === 0 ? 0 : Math.round((attempts / completed) * 100) / 100,
      averageClaimsPerCompleted: completed === 0 ? 0 : Math.round((claimTotal / completed) * 100) / 100,
    },
    throughput: {
      completedPerMinute: elapsedMs === 0 ? 0 : Math.round((completed / (elapsedMs / 60_000)) * 10) / 10,
      generationMs: {
        p50: percentile(jobDurations, 50),
        p95: percentile(jobDurations, 95),
        max: jobDurations.length ? Math.max(...jobDurations) : 0,
      },
    },
    concurrency: {
      maxRunningFfmpegJobs: maxQueueRunning,
      maxQueuedGenerations: maxQueueDepth,
      configuredMaxConcurrent: queue.snapshot().maxConcurrent,
    },
    storage: {
      previewFiles: previewFiles.length,
      previewBytes,
      averageBytes: previewFiles.length ? Math.round(previewBytes / previewFiles.length) : 0,
    },
    stats: {
      polls: statsPolls,
      error: statsError,
      cacheMetrics,
      finalCompleted: finalStats.completedPreviews,
      finalMissing: finalStats.missingPreviews,
      finalGenerating: finalStats.generating,
      latencyMs: {
        p50: percentile(statsPollLatencies, 50),
        p95: percentile(statsPollLatencies, 95),
        max: statsPollLatencies.length ? Math.max(...statsPollLatencies) : 0,
      },
    },
    stages: Object.fromEntries([...stageCounts.entries()].sort()),
    mcp: 'NOT TESTED (no MEGA credentials; simulation uses a local fixture)',
  };

  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
