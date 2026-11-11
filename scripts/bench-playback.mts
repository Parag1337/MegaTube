/**
 * End-to-end playback pipeline benchmark (server-side).
 *
 * Drives the REAL live-remux machinery (lib/media/remux.ts:
 * getOrCreateLiveRemuxJob / createLiveResponse / createCachedFileResponse /
 * readRemuxCache) against a genuine megajs-encrypted MPEG-TS fixture served
 * by a LOCAL controllable HTTP server. Only the MEGA transport is replaced —
 * session resume (a=g) latency and browser time-to-first-frame are
 * explicitly NOT measured (no MEGA account, no browser here; those legs are
 * documented in docs/PHASE-3-REPORT.md as out of scope for this script).
 *
 * Scenarios:
 *   1  single-viewer cold live playback (time-to-init, first fragment,
 *      sustained throughput, cache publication)
 *   2  two concurrent viewers of the same video (shared job, one download)
 *   3  two viewers of DIFFERENT videos (two remux slots)
 *   4  repeated cold seeks against the live spool
 *   5  warm-cache playback after publication (cold vs warm)
 *   6  SLOW upstream (throttled) — time-to-init must stay fast
 *   7  INTERRUPTED upstream (mid-body abort once) — recovery via frontier
 *      resume + fresh URL, then cache publication
 *   8  memory profile during a full run (Node RSS/heap/external, ffmpeg
 *      child RSS peak, temp disk usage)
 *
 * Usage: npx tsx scripts/bench-playback.mts [--seconds 60] [--bitrate-k 3000]
 * Output: JSON on stdout. No credentials involved anywhere.
 */

process.env.MEDIA_CACHE_DIR = process.env.MEDIA_CACHE_DIR_OVERRIDE_FOR_BENCH
  ?? ''; // replaced below per-run
process.env.MEDIA_CACHE_EVICTION_DISABLED = '1';
process.env.MEDIA_ZERO_SUBSCRIBER_GRACE_MS = process.env.MEDIA_ZERO_SUBSCRIBER_GRACE_MS
  ?? '600000'; // keep jobs alive for the whole benchmark run
process.env.MEDIA_RESUME_BACKOFF_MS = process.env.MEDIA_RESUME_BACKOFF_MS ?? '100';
process.env.MEDIA_SOURCE_MAX_ATTEMPTS = process.env.MEDIA_SOURCE_MAX_ATTEMPTS ?? '6';

import http from 'node:http';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encrypt } from 'megajs';
import {
  cancelLiveRemuxJob,
  createLiveResponse,
  getOrCreateLiveRemuxJob,
  getRemuxSlotStats,
  mediaTempUsage,
  readRemuxCache,
} from '@/lib/media/remux';
import type { LiveRemuxJob } from '@/lib/media/remux';

const remux = { cancelLiveRemuxJob, createLiveResponse, getOrCreateLiveRemuxJob, getRemuxSlotStats, mediaTempUsage, readRemuxCache };

const args = process.argv.slice(2);
function argValue(name: string, fallback: number): number {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1]) return Number(args[i + 1]) || fallback;
  return fallback;
}
const SECONDS = argValue('--seconds', 60);
const BITRATE_K = argValue('--bitrate-k', 3000); // target fixture bitrate kbps
const SLOW_RATE_BYTES = argValue('--slow-rate', 512 * 1024); // scenario 6 cap

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'megatube-bench-play-'));
process.env.MEDIA_CACHE_DIR = path.join(TMP, 'cache-media');
fs.mkdirSync(process.env.MEDIA_CACHE_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Fixture: genuine megajs CTR ciphertext of a synthetic MPEG-TS file
// ---------------------------------------------------------------------------

async function generateEncryptedFixture(): Promise<{ ct: Buffer; fileKey: Buffer }> {
  // Generate a plain MPEG-TS fixture with the system ffmpeg, then encrypt it
  // with megajs exactly like tests do (stream API; key from the stream).
  const plainPath = path.join(TMP, 'fixture.ts');
  await new Promise<void>((resolve, reject) => {
    execFile('ffmpeg', [
      '-v', 'error',
      '-f', 'lavfi', '-i', `testsrc=size=1280x720:rate=30:duration=${SECONDS}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${SECONDS}`,
      '-c:v', 'h264', '-pix_fmt', 'yuv420p',
      '-b:v', `${BITRATE_K}k`,
      '-c:a', 'aac', '-b:a', '128k',
      '-f', 'mpegts', plainPath,
    ], { timeout: 300_000 }, (err) => (err ? reject(err) : resolve()));
  });
  const plain = fs.readFileSync(plainPath);
  fs.rmSync(plainPath, { force: true });
  const encStream = encrypt();
  const chunks: Buffer[] = [];
  encStream.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => encStream.on('end', resolve));
  encStream.end(plain);
  await done;
  return { ct: Buffer.concat(chunks), fileKey: Buffer.from(encStream.key) };
}

// ---------------------------------------------------------------------------
// Controllable local ciphertext server (stands in for MEGA storage only)
// ---------------------------------------------------------------------------

interface ServerBehavior {
  /** Abort the response mid-body after this fraction of bytes (once per id). */
  abortAfterFraction?: number;
  /** Throttle body delivery to this many bytes/sec. */
  rateBytesPerSec?: number;
  /** Chunk size for body delivery (default 64 KiB). */
  chunkBytes?: number;
}

interface FixtureServer {
  base: string;
  fetchCiphertext: (url: string, signal?: AbortSignal) => Promise<Response>;
  setBehavior: (id: number, b: ServerBehavior) => void;
  requestsServed: () => number;
  close: () => Promise<void>;
}

function startFixtureServer(ct: Buffer): Promise<FixtureServer> {
  const behaviors = new Map<number, ServerBehavior>();
  const abortedOnce = new Set<number>();
  let served = 0;
  const server = http.createServer((req, res) => {
    const m = req.url?.match(/^\/(\d+)-(\d+)(?:\?.*)?$/);
    if (!m) {
      res.writeHead(400);
      res.end();
      return;
    }
    const start = Math.max(0, Math.min(Number(m[1]), ct.length - 1));
    const end = Math.max(start, Math.min(Number(m[2]), ct.length - 1));
    const q = req.url?.match(/[?&]v=(\d+)/);
    const id = q ? Number(q[1]) : 0;
    const b = behaviors.get(id) ?? {};
    served++;
    // "Abort after fraction" is a ONCE-per-id simulation of a mid-body
    // network failure; later requests for the same id behave normally so
    // the job's resume path can actually recover.
    const willAbort = b.abortAfterFraction != null && !abortedOnce.has(id);
    const abortAt = willAbort ? Math.max(1, Math.floor((end - start + 1) * b.abortAfterFraction!)) : Infinity;
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    const total = end - start + 1;
    const chunk = b.chunkBytes ?? 64 * 1024;
    let sent = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pace = () => {
      if (sent >= abortAt) {
        // Simulate a mid-body network failure: destroy the socket.
        abortedOnce.add(id);        res.socket?.destroy();
        return;
      }
      const n = Math.min(chunk, total - sent, abortAt === Infinity ? total : abortAt - sent);
      if (n <= 0) {
        res.end();
        return;
      }
      res.write(ct.subarray(start + sent, start + sent + n));
      sent += n;
      if (b.rateBytesPerSec) {
        timer = setTimeout(pace, Math.max(1, (chunk / b.rateBytesPerSec) * 1000));
      } else if (sent < total) {
        setImmediate(pace);
      } else {
        res.end();
      }
    };
    req.on('close', () => {
      if (timer) clearTimeout(timer);
    });
    pace();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      const base = `http://127.0.0.1:${addr.port}`;
      resolve({
        base,
        requestsServed: () => served,
        setBehavior: (id, b) => behaviors.set(id, b),
        fetchCiphertext: (url, signal) =>
          fetch(url, { signal }) as unknown as Promise<Response>,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------

interface MemorySample { rssMB: number; heapMB: number; extMB: number; ffmpegMB: number | null; tempMB: number }

function ffmpegChildrenRssMB(): number | null {
  try {
    const self = process.pid.toString();
    let total = 0;
    let found = false;
    for (const pid of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(pid) || pid === self) continue;
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const name = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
        // After the comm field: state(0) ppid(1) ... vsize(20) rss(21).
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const ppid = fields[1];
        if (ppid === self && name === 'ffmpeg') {
          const rssPages = Number(fields[21]);
          total += (rssPages * 4096) / 1048576;
          found = true;
        }
      } catch {
        // process exited - ignore
      }
    }
    return found ? Math.round(total * 10) / 10 : null;
  } catch {
    return null;
  }
}

function sampleMemory(): MemorySample {
  const m = process.memoryUsage();
  const usage = remux.mediaTempUsage();
  return {
    rssMB: Math.round((m.rss / 1048576) * 10) / 10,
    heapMB: Math.round((m.heapUsed / 1048576) * 10) / 10,
    extMB: Math.round((m.external / 1048576) * 10) / 10,
    ffmpegMB: ffmpegChildrenRssMB(),
    tempMB: Math.round((usage.bytes / 1048576) * 10) / 10,
  };
}

/** Drain a live Response body; record first-byte latency + total bytes. */
async function consumeLive(
  job: LiveRemuxJob,
  startOffset: number,
  opts: { untilBytes?: number } = {},
): Promise<{ firstByteMs: number; bytes: number; ms: number }> {
  const ac = new AbortController();
  const t0 = performance.now();
  let firstByteMs = 0;
  let bytes = 0;
  const res = remux.createLiveResponse(job, null, ac.signal, startOffset);
  const reader = res.body!.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstByteMs === 0) firstByteMs = performance.now() - t0;
      bytes += value.byteLength;
      if (opts.untilBytes && bytes >= opts.untilBytes) {
        ac.abort();
        break;
      }
    }
  } catch {
    // aborted - expected when bounded
  }
  return { firstByteMs, bytes, ms: performance.now() - t0 };
}

async function main(): Promise<void> {
  const out: Record<string, unknown> = {
    fixture: { seconds: SECONDS, bitrateK: BITRATE_K },
    env: { node: process.version, platform: `${os.platform()}/${os.arch()}`, cpus: os.cpus().length },
    scenarios: {},
  };
  const memProfile: MemorySample[] = [];
  const sampler = setInterval(() => {
    if (memProfile.length < 2000) memProfile.push(sampleMemory());
  }, 250);
  if (typeof sampler.unref === 'function') sampler.unref();

  const { ct, fileKey } = await generateEncryptedFixture();
  out.fixture.sizeMB = Math.round((ct.length / 1048576) * 10) / 10;

  // Scenario 1+2+4: one video, shared job.
  {
    const server = await startFixtureServer(ct);
    const t0 = performance.now();
    const job = remux.getOrCreateLiveRemuxJob({
      videoId: 1,
      megaNodeId: 'bench-node-1',
      size: ct.length,
      fileKey,
      upstreamUrl: server.base,
      durationSeconds: null,
      fetchCiphertext: (url, signal) => server.fetchCiphertext(`${url}?v=1`, signal),
      refreshUpstreamUrl: async () => server.base,
    });
    const tReady = performance.now();
    await job.ready;
    const readyMs = performance.now() - tReady;
    await job.spoolInitWritten;
    const initMs = performance.now() - t0;

    // Scenario 1: one bounded viewer (reads 2 MB of the live stream).
    const v1 = await consumeLive(job, 0, { untilBytes: 2 * 1024 * 1024 });

    // Scenario 2: two concurrent bounded viewers joining the running job.
    const tJoin = performance.now();
    const [v2, v3] = await Promise.all([
      consumeLive(job, 0, { untilBytes: 1024 * 1024 }),
      consumeLive(job, 0, { untilBytes: 1024 * 1024 }),
    ]);
    const joinMs = performance.now() - tJoin;

    // Scenario 4: repeated cold seeks against the spool.
    const seeks: Array<{ at: number; firstByteMs: number }> = [];
    const frontier = job.spoolBytes;
    for (let i = 1; i <= 5; i++) {
      const at = Math.floor((frontier * i) / 6);
      if (at <= 0) continue;
      const r = await consumeLive(job, at, { untilBytes: 256 * 1024 });
      seeks.push({ at, firstByteMs: Math.round(r.firstByteMs * 10) / 10 });
    }

    // Wait for completion (cache publication).
    const cache = await job.cache;
    const totalMs = performance.now() - t0;
    out.scenarios.sharedJob = {
      upstreamHeadersMs: Math.round(readyMs * 10) / 10,
      initPublishedMs: Math.round(initMs * 10) / 10,
      singleViewerFirstByteMs: Math.round(v1.firstByteMs * 10) / 10,
      singleViewerBytesMB: Math.round((v1.bytes / 1048576) * 10) / 10,
      twoJoiningViewersMs: Math.round(joinMs * 10) / 10,
      twoJoiningViewersFirstByteMs: [v2.firstByteMs, v3.firstByteMs].map((x) => Math.round(x * 10) / 10),
      seeks,
      cachePublished: cache !== null,
      cacheSizeMB: cache ? Math.round((cache.size / 1048576) * 10) / 10 : null,
      totalMs: Math.round(totalMs * 10) / 10,
      downloadMBps: Math.round((ct.length / 1048576) / (totalMs / 1000) * 10) / 10,
      upstreamRequests: server.requestsServed(),
    };

    // Scenario 5: warm-cache playback (full-file read of the published cache).
    if (cache) {
      const warm = await remux.readRemuxCache(1, 'bench-node-1', ct.length);
      if (warm) {
        const tWarm = performance.now();
        let bytes = 0;
        await new Promise<void>((resolve) => {
          const rs = fs.createReadStream(warm.path, { highWaterMark: 256 * 1024 });
          rs.on('data', (c: Buffer) => { bytes += c.length; });
          rs.on('end', () => resolve());
          rs.on('error', () => resolve());
        });
        out.scenarios.warmCache = {
          fullReadMs: Math.round((performance.now() - tWarm) * 10) / 10,
          bytesMB: Math.round((bytes / 1048576) * 10) / 10,
        };
      }
    }
    remux.cancelLiveRemuxJob(job, 'benchmark done');
    await server.close();
  }

  // Scenario 3: two DIFFERENT videos concurrently (two slots).
  {
    process.env.MAX_CONCURRENT_REMUX = process.env.MAX_CONCURRENT_REMUX ?? '2';
    const s1 = await startFixtureServer(ct);
    const s2 = await startFixtureServer(ct);
    const t0 = performance.now();
    const j1 = remux.getOrCreateLiveRemuxJob({
      videoId: 3, megaNodeId: 'bench-node-3', size: ct.length, fileKey,
      upstreamUrl: s1.base, durationSeconds: null,
      fetchCiphertext: (url, signal) => s1.fetchCiphertext(`${url}?v=3`, signal),
      refreshUpstreamUrl: async () => s1.base,
    });
    const j2 = remux.getOrCreateLiveRemuxJob({
      videoId: 4, megaNodeId: 'bench-node-4', size: ct.length, fileKey,
      upstreamUrl: s2.base, durationSeconds: null,
      fetchCiphertext: (url, signal) => s2.fetchCiphertext(`${url}?v=4`, signal),
      refreshUpstreamUrl: async () => s2.base,
    });
    const c1 = consumeLive(j1, 0, { untilBytes: 1024 * 1024 });
    const c2 = consumeLive(j2, 0, { untilBytes: 1024 * 1024 });
    const [r1, r2] = await Promise.all([c1, c2]);
    out.scenarios.twoDifferentVideos = {
      bothFirstByteMs: [r1.firstByteMs, r2.firstByteMs].map((x) => Math.round(x * 10) / 10),
      wallMs: Math.round((performance.now() - t0) * 10) / 10,
      slots: remux.getRemuxSlotStats(),
    };
    remux.cancelLiveRemuxJob(j1, 'benchmark done');
    remux.cancelLiveRemuxJob(j2, 'benchmark done');
    await Promise.all([s1.close(), s2.close()]);
  }

  // Scenario 6: SLOW upstream (~512 KB/s cap) — time-to-init stays fast.
  {
    const server = await startFixtureServer(ct);
    server.setBehavior(6, { rateBytesPerSec: SLOW_RATE_BYTES });
    const t0 = performance.now();
    const job = remux.getOrCreateLiveRemuxJob({
      videoId: 6, megaNodeId: 'bench-node-6', size: ct.length, fileKey,
      upstreamUrl: server.base, durationSeconds: null,
      fetchCiphertext: (url, signal) => server.fetchCiphertext(`${url}?v=6`, signal),
      refreshUpstreamUrl: async () => server.base,
    });
    await job.ready;
    await job.spoolInitWritten;
    const initMs = performance.now() - t0;
    const v = await consumeLive(job, 0, { untilBytes: 1024 * 1024 });
    out.scenarios.slowUpstream = {
      rateCapMBps: Math.round((SLOW_RATE_BYTES / 1048576) * 10) / 10,
      initPublishedMs: Math.round(initMs * 10) / 10,
      viewerFirstByteMs: Math.round(v.firstByteMs * 10) / 10,
    };
    remux.cancelLiveRemuxJob(job, 'benchmark done');
    await server.close();
  }

  // Scenario 7: INTERRUPTED upstream (mid-body socket destroy at ~40%).
  {
    const server = await startFixtureServer(ct);
    server.setBehavior(7, { abortAfterFraction: 0.4 });
    const t0 = performance.now();
    const job = remux.getOrCreateLiveRemuxJob({
      videoId: 7, megaNodeId: 'bench-node-7', size: ct.length, fileKey,
      upstreamUrl: server.base, durationSeconds: null,
      fetchCiphertext: (url, signal) => server.fetchCiphertext(`${url}?v=7`, signal),
      refreshUpstreamUrl: async () => server.base,
    });
    const v = await consumeLive(job, 0, { untilBytes: 1024 * 1024 });
    const cache = await job.cache;
    const totalMs = performance.now() - t0;
    out.scenarios.interruptedUpstream = {
      viewerFirstByteMs: Math.round(v.firstByteMs * 10) / 10,
      recovered: cache !== null,
      cacheSizeMB: cache ? Math.round((cache.size / 1048576) * 10) / 10 : null,
      totalMs: Math.round(totalMs * 10) / 10,
      upstreamRequests: server.requestsServed(),
    };
    await server.close();
  }

  // Memory profile across the whole run.
  {
    const ffmpegPeak = Math.max(...memProfile.map((s) => s.ffmpegMB ?? 0));
    const rssPeak = Math.max(...memProfile.map((s) => s.rssMB));
    const extPeak = Math.max(...memProfile.map((s) => s.extMB));
    const tempPeak = Math.max(...memProfile.map((s) => s.tempMB));
    out.memory = { samples: memProfile.length, rssPeakMB: rssPeak, extPeakMB: extPeak, ffmpegChildrenPeakMB: ffmpegPeak, tempDiskPeakMB: tempPeak };
  }

  clearInterval(sampler);
  console.log(JSON.stringify(out, null, 2));
}

try {
  await main();
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
