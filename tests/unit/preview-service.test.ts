/**
 * Preview service core tests (lib/preview/service.ts).
 *
 * Auth matrix (401/400/404/410/409), meta statuses, durable-job status
 * mapping, artifact-missing requeue, timeline warm-cache gate, asset serving
 * (Range/ETag/304/416/404) and the VTT document. All dependencies are fakes —
 * no prisma, no MEGA, no ffmpeg.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'megatube-preview-svc-'));
process.env.PREVIEW_CACHE_DIR = dir;
process.env.PREVIEW_TOUCH_INTERVAL_MS = '0';
process.env.DATABASE_URL ||= 'postgresql://megatube:megatube-dev-only@localhost:5433/megatube?schema=public';
delete process.env.PREVIEW_DISABLED;

let svc: typeof import('@/lib/preview/service');
let generationVersion: string;

type PreviewSidecar = import('@/lib/preview/types').PreviewSidecar;
type JobStatus = import('@/lib/preview/jobs').PreviewJobStatus;

before(async () => {
  svc = await import('@/lib/preview/service');
  const config = await import('@/lib/preview/config');
  generationVersion = config.previewGenerationVersion();
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function clean() {
  for (const n of fs.readdirSync(dir)) fs.rmSync(path.join(dir, n), { force: true, recursive: true });
}

const USER = 'user-1';

function videoRow(overrides: Partial<svc.PreviewVideoRow> = {}): svc.PreviewVideoRow {
  return {
    id: 7,
    megaNodeId: 'node-7',
    fileKeyEncrypted: 'enc-7',
    mimeType: 'video/mp4',
    fileSize: 1000n,
    duration: 100,
    mp4Faststart: true,
    megaAccount: { id: 1, userId: USER, status: 'CONNECTED', encryptedSession: 'sess' },
    ...overrides,
  };
}

interface QueueStub {
  has: (key: string) => boolean;
  enqueueNow: (
    key: string,
    runner: () => Promise<unknown>,
    signal?: AbortSignal | null,
  ) => 'started' | 'queued' | 'rejected';
  calls: Array<{ key: string; signal: AbortSignal | null }>;
}

function stubQueue(opts?: { full?: boolean; inFlight?: boolean }): QueueStub {
  const calls: Array<{ key: string; signal: AbortSignal | null }> = [];
  return {
    calls,
    has: () => opts?.inFlight ?? false,
    enqueueNow: (key, _runner, signal) => {
      calls.push({ key, signal: signal ?? null });
      return opts?.full ? 'rejected' : 'started';
    },
  };
}

interface EnsureCall {
  videoId: number;
  fingerprint: string;
  priority: number;
}

/** Durable-backlog stub: records ensures and returns a fixed job state. */
function stubEnsure(status: JobStatus | 'completed', jobId: number | null = 1) {
  const calls: EnsureCall[] = [];
  const ensure = async (
    videoId: number,
    fingerprint: string,
    priority: number,
  ): Promise<import('@/lib/preview/jobs').PreviewJobEnsureResult> => {
    calls.push({ videoId, fingerprint, priority });
    return { key: `${videoId}:hover:${fingerprint}`, jobId, status, enqueued: status === 'pending' };
  };
  return { calls, ensure };
}

interface DepsOptions {
  video?: svc.PreviewVideoRow | null;
  queue?: QueueStub;
  warmCache?: boolean;
  job?: JobStatus | 'completed';
  jobId?: number | null;
  ensure?: ReturnType<typeof stubEnsure>;
}

function makeDeps(overrides?: DepsOptions): svc.PreviewServiceDeps & {
  ensureCalls: EnsureCall[];
  requeued: number[];
  state: { woken: number };
} {
  const ensureStub = overrides?.ensure ?? stubEnsure(overrides?.job ?? 'pending', overrides?.jobId ?? 1);
  const requeued: number[] = [];
  const state = { woken: 0 };
  const deps = {
    loadVideo: async () => (overrides && 'video' in overrides ? overrides.video ?? null : videoRow()),
    decryptFileKey: () => Buffer.alloc(16, 1),
    sourceDeps: {
      fetchCiphertext: async () => {
        throw new Error('no MEGA in tests');
      },
      withSession: async () => {
        throw new Error('no MEGA in tests');
      },
      getDownloadUrl: async () => {
        throw new Error('no MEGA in tests');
      },
      readWarmCache: async () => null,
    },
    readWarmCache: async () => (overrides?.warmCache ? { path: path.join(dir, 'warm.mp4'), size: 1000 } : null),
    queue: (overrides?.queue ?? stubQueue()) as unknown as svc.PreviewServiceDeps['queue'],
    now: () => Date.now(),
    ensureJob: ensureStub.ensure,
    requeueMissingArtifact: async (jobId: number) => {
      requeued.push(jobId);
      return true;
    },
    wakeWorker: () => {
      state.woken++;
    },
  };
  return Object.assign(deps, { ensureCalls: ensureStub.calls, requeued, state });
}

function readySidecar(videoId = 7, opts?: { sourceSize?: number; timeline?: boolean; version?: string }): void {
  const sidecar: PreviewSidecar = {
    version: 2,
    videoId,
    megaNodeId: 'node-7',
    sourceSize: opts?.sourceSize ?? 1000,
    durationSeconds: 100,
    status: 'ready',
    hover: {
      startSec: 25,
      durationSec: 8,
      width: 640,
      height: 360,
      bytes: 100,
      estimated: false,
      generationVersion: generationVersion,
      scenes: [
        { startSec: 25, durationSec: 8, sourceSeekSec: 24 },
        { startSec: 60, durationSec: 8, sourceSeekSec: 59 },
      ],
      faststart: true,
    },
    timeline: opts?.timeline
      ? { tileW: 160, tileH: 90, cols: 10, rows: 1, intervalSec: 4, count: 7 }
      : null,
    attempts: 0,
    lastError: null,
    failedAt: null,
    lastAccessedAt: new Date().toISOString(),
    metrics: null,
    generationVersion: opts?.version ?? generationVersion,
  };
  fs.writeFileSync(path.join(dir, `${videoId}.json`), JSON.stringify(sidecar));
}

// ---------------------------------------------------------------------------
// Auth matrix
// ---------------------------------------------------------------------------

test('meta: unauthenticated → 401', async () => {
  const res = await svc.handlePreviewMeta(null, '7', {}, makeDeps());
  assert.equal(res.status, 401);
});

test('meta: invalid id → 400', async () => {
  for (const bad of ['abc', '0', '-1', '1.5']) {
    const res = await svc.handlePreviewMeta(USER, bad, {}, makeDeps());
    assert.equal(res.status, 400, `id ${bad}`);
  }
});

test('meta: missing video / other user → 404', async () => {
  const res = await svc.handlePreviewMeta(USER, '7', {}, makeDeps({ video: null }));
  assert.equal(res.status, 404);
  const res2 = await svc.handlePreviewMeta(USER, '7', {}, makeDeps({ video: videoRow({ megaAccount: { id: 1, userId: 'other', status: 'CONNECTED', encryptedSession: 's' } }) }));
  assert.equal(res2.status, 404);
});

test('meta: disconnected account → 410; unplayable → 409', async () => {
  const res = await svc.handlePreviewMeta(USER, '7', {}, makeDeps({ video: videoRow({ megaAccount: { id: 1, userId: USER, status: 'DISCONNECTED', encryptedSession: 's' } }) }));
  assert.equal(res.status, 410);
  const res2 = await svc.handlePreviewMeta(USER, '7', {}, makeDeps({ video: videoRow({ megaNodeId: null, fileKeyEncrypted: null }) }));
  assert.equal(res2.status, 409);
});

// ---------------------------------------------------------------------------
// Meta statuses (durable PostgreSQL backlog)
// ---------------------------------------------------------------------------

test('meta: ready sidecar + files on disk → ready with URLs, no-store', async () => {
  clean();
  readySidecar();
  fs.writeFileSync(path.join(dir, '7.preview.mp4'), Buffer.alloc(100, 1));
  const res = await svc.handlePreviewMeta(USER, '7', {}, makeDeps());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = (await res.json()) as {
    status: string;
    hover: { url: string; durationSec: number; scenes: unknown[] } | null;
    timeline: { status: string; reason: string | null } | null;
  };
  assert.equal(body.status, 'ready');
  assert.equal(body.hover?.url, '/api/preview/7');
  assert.equal(body.hover?.durationSec, 8);
  assert.equal(body.hover?.scenes.length, 2);
  // No warm cache → timeline honestly reports source-not-local.
  assert.equal(body.timeline?.status, 'unavailable');
  assert.equal(body.timeline?.reason, 'source-not-local');
});

test('meta: missing clip bytes with a ready sidecar → durable job ensured + worker woken', async () => {
  clean();
  readySidecar(); // no .preview.mp4 written
  const deps = makeDeps();
  const res = await svc.handlePreviewMeta(USER, '7', {}, deps);
  const body = (await res.json()) as { status: string };
  assert.equal(body.status, 'pending');
  assert.equal(deps.ensureCalls.length, 1);
  assert.equal(deps.ensureCalls[0].videoId, 7);
  assert.equal(deps.ensureCalls[0].fingerprint, 'node-7:1000');
  assert.ok(deps.ensureCalls[0].priority > 0, 'hover work outranks bulk work');
  assert.equal(deps.state.woken, 1, 'enqueue wakes the bounded worker');
});

test('meta: durable job states map to card-visible states', async () => {
  const cases: Array<{ job: JobStatus; expected: string }> = [
    { job: 'pending', expected: 'pending' },
    { job: 'queued', expected: 'queued' },
    { job: 'generating', expected: 'generating' },
    { job: 'failed', expected: 'failed' },
    { job: 'unsupported', expected: 'unsupported' },
  ];
  for (const c of cases) {
    clean();
    const res = await svc.handlePreviewMeta(USER, '7', {}, makeDeps({ job: c.job }));
    const body = (await res.json()) as { status: string; reason: string | null };
    assert.equal(body.status, c.expected, `job ${c.job}`);
    assert.ok(body.reason, `job ${c.job} carries a human-readable reason`);
  }
});

test('meta: completed job without an artifact is requeued, not reported ready', async () => {
  clean();
  const deps = makeDeps({ job: 'completed', jobId: 42 });
  const res = await svc.handlePreviewMeta(USER, '7', {}, deps);
  const body = (await res.json()) as { status: string; errorCode: string | null };
  assert.equal(body.status, 'pending');
  assert.equal(body.errorCode, 'artifact_missing');
  assert.deepEqual(deps.requeued, [42]);
});

test('meta: answers immediately; generation runs independently of the request', async () => {
  clean();
  const deps = makeDeps();
  const started = Date.now();
  const res = await svc.handlePreviewMeta(USER, '7', {}, deps);
  assert.ok(Date.now() - started < 500, 'meta must never wait for ffmpeg/MEGA');
  assert.equal(((await res.json()) as { status: string }).status, 'pending');
});

test('meta: stale-generation sidecar is never served (old encoding rules)', async () => {
  clean();
  readySidecar(7, { version: 'p51-old-version' });
  fs.writeFileSync(path.join(dir, '7.preview.mp4'), Buffer.alloc(100, 1));
  const deps = makeDeps();
  const res = await svc.handlePreviewMeta(USER, '7', {}, deps);
  assert.equal(((await res.json()) as { status: string }).status, 'pending');
  assert.ok(!fs.existsSync(path.join(dir, '7.preview.mp4')), 'stale artifact removed');
  assert.equal(deps.ensureCalls.length, 1);
});

test('meta: identity mismatch (re-synced source) invalidates assets + regenerates', async () => {
  clean();
  readySidecar(7, { sourceSize: 999 }); // stale size
  fs.writeFileSync(path.join(dir, '7.preview.mp4'), Buffer.alloc(10, 1));
  fs.writeFileSync(path.join(dir, '7.sprite.jpg'), Buffer.alloc(10, 1));
  const res = await svc.handlePreviewMeta(USER, '7', {}, makeDeps());
  assert.equal(((await res.json()) as { status: string }).status, 'pending');
  assert.ok(!fs.existsSync(path.join(dir, '7.preview.mp4')), 'stale assets removed');
  assert.ok(!fs.existsSync(path.join(dir, '7.sprite.jpg')));
});

test('meta: timeline gate — warm cache present enqueues; absent reports source-not-local', async () => {
  clean();
  const queue = stubQueue();
  const res = await svc.handlePreviewMeta(USER, '7', { want: 'timeline' }, makeDeps({ queue, warmCache: true }));
  const body = (await res.json()) as { status: string; timeline: { status: string } };
  assert.equal(body.timeline.status, 'generating');
  assert.equal(queue.calls.length, 1);
  assert.equal(queue.calls[0].key, 'timeline:7');
  assert.equal(body.status, 'unavailable', 'hover untouched by a timeline-only request');

  clean();
  const queue2 = stubQueue();
  const res2 = await svc.handlePreviewMeta(USER, '7', { want: 'timeline' }, makeDeps({ queue: queue2, warmCache: false }));
  const body2 = (await res2.json()) as { timeline: { status: string; reason: string | null } };
  assert.equal(body2.timeline.status, 'unavailable');
  assert.equal(body2.timeline.reason, 'source-not-local');
  assert.equal(queue2.calls.length, 0, 'no MEGA spritesheet downloads, ever');
});

test('meta: timeline queue full reports unavailable without starting work', async () => {
  clean();
  const queue = stubQueue({ full: true });
  const res = await svc.handlePreviewMeta(USER, '7', { want: 'timeline' }, makeDeps({ queue, warmCache: true }));
  const body = (await res.json()) as { timeline: { status: string; reason: string | null } };
  assert.equal(body.timeline.status, 'unavailable');
  assert.equal(body.timeline.reason, 'busy');
});

test('meta: kill switch answers without any work', async () => {
  process.env.PREVIEW_DISABLED = '1';
  try {
    const deps = makeDeps();
    const res = await svc.handlePreviewMeta(USER, '7', {}, deps);
    const body = (await res.json()) as { status: string; timeline: { reason: string | null } | null };
    assert.equal(body.status, 'unavailable');
    assert.equal(body.timeline?.reason, 'disabled');
    assert.equal(deps.ensureCalls.length, 0);
  } finally {
    delete process.env.PREVIEW_DISABLED;
  }
});

// ---------------------------------------------------------------------------
// Asset serving
// ---------------------------------------------------------------------------

test('asset: full response with ETag + private caching + refcount release', async () => {
  clean();
  readySidecar();
  fs.writeFileSync(path.join(dir, '7.preview.mp4'), Buffer.alloc(100, 5));
  const res = await svc.handlePreviewAsset(USER, '7', 'clip', {}, makeDeps());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal(res.headers.get('content-length'), '100');
  assert.match(res.headers.get('cache-control') ?? '', /private/);
  assert.match(res.headers.get('etag') ?? '', /^"pv-7-1000-clip-100"$/);
  await res.arrayBuffer(); // drain → refcount released
  const cacheMod = await import('@/lib/preview/cache');
  assert.equal(cacheMod.activePreviewReaders(7), 0);
});

test('asset: Range request → 206 slice with Content-Range', async () => {
  clean();
  readySidecar();
  fs.writeFileSync(path.join(dir, '7.preview.mp4'), Buffer.alloc(100, 5));
  const res = await svc.handlePreviewAsset(USER, '7', 'clip', { rangeHeader: 'bytes=10-19' }, makeDeps());
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 10-19/100');
  assert.equal(res.headers.get('content-length'), '10');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.length, 10);
});

test('asset: invalid Range → 416 with bytes */size; suffix range resolves', async () => {
  clean();
  readySidecar();
  fs.writeFileSync(path.join(dir, '7.preview.mp4'), Buffer.alloc(100, 5));
  const bad = await svc.handlePreviewAsset(USER, '7', 'clip', { rangeHeader: 'bytes=500-600' }, makeDeps());
  assert.equal(bad.status, 416);
  assert.equal(bad.headers.get('content-range'), 'bytes */100');
  const suffix = await svc.handlePreviewAsset(USER, '7', 'clip', { rangeHeader: 'bytes=-10' }, makeDeps());
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers.get('content-range'), 'bytes 90-99/100');
});

test('asset: If-None-Match → 304', async () => {
  clean();
  readySidecar(7, { timeline: true });
  fs.writeFileSync(path.join(dir, '7.sprite.jpg'), Buffer.alloc(50, 2));
  const etag = '"pv-7-1000-sprite-50"';
  const res = await svc.handlePreviewAsset(USER, '7', 'sprite', { ifNoneMatch: etag }, makeDeps());
  assert.equal(res.status, 304);
});

test('asset: wrong owner / not ready → 404 JSON (never HTML)', async () => {
  clean();
  const res = await svc.handlePreviewAsset('other-user', '7', 'clip', {}, makeDeps());
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error?: string };
  assert.ok(body.error, 'auth errors are JSON with an error message');

  const res2 = await svc.handlePreviewAsset(USER, '7', 'clip', {}, makeDeps({ video: videoRow({ megaAccount: { id: 1, userId: USER, status: 'DISCONNECTED', encryptedSession: 's' } }) }));
  assert.equal(res2.status, 410);

  // Authenticated owner, but no preview assets at all → 404 with status.
  const res3 = await svc.handlePreviewAsset(USER, '7', 'clip', {}, makeDeps());
  assert.equal(res3.status, 404);
  const body3 = (await res3.json()) as { status: string };
  assert.equal(body3.status, 'unavailable');
});

test('asset: stale-generation clip is not served even if bytes exist', async () => {
  clean();
  readySidecar(7, { version: 'p51-old-version' });
  fs.writeFileSync(path.join(dir, '7.preview.mp4'), Buffer.alloc(100, 5));
  const res = await svc.handlePreviewAsset(USER, '7', 'clip', {}, makeDeps());
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// VTT
// ---------------------------------------------------------------------------

test('vtt: ready timeline → text/vtt with the documented cell count', async () => {
  clean();
  readySidecar(7, { timeline: true });
  const res = await svc.handlePreviewVtt(USER, '7', {}, makeDeps());
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/vtt/);
  const text = await res.text();
  assert.match(text, /^WEBVTT/);
  assert.match(text, /#xywh=0,0,160,90/);
  assert.equal((text.match(/-->/g) ?? []).length, 7);
});

test('vtt: no timeline → 404 JSON', async () => {
  clean();
  const res = await svc.handlePreviewVtt(USER, '7', {}, makeDeps());
  assert.equal(res.status, 404);
  const body = (await res.json()) as { status: string };
  assert.equal(body.status, 'unavailable');
});
