/**
 * Reproducible performance benchmarks for the MegaTube media pipeline core.
 *
 * Measures, with a locally generated synthetic MPEG-TS fixture (no MEGA
 * account, no credentials, no network):
 *
 *   1. cold faststart remux        (ffmpeg -c copy file -> faststart MP4,
 *                                   the cache-publish step of a live job)
 *   2. live fMP4 first-fragment    (pipe mode, time until the first
 *                                   stdout bytes = init segment latency)
 *   3. warm-cache read             (full read of the cached MP4)
 *   4. two concurrent remux jobs   (peak RSS per ffmpeg child + Node heap)
 *
 * Output: single JSON object on stdout. Never logs credentials (it has
 * none). Exit code 0 on success.
 *
 * Usage: npx tsx scripts/bench-media.mts [--seconds 30] [--concurrency 2]
 *
 * NOT measurable here (documented honestly in the phase report): MEGA
 * upstream latency (a=g, ciphertext headers, download speed) and true
 * browser time-to-first-frame — those require the live server + real MEGA
 * account and are intentionally out of scope for a credential-free script.
 */

import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
function argValue(name: string, fallback: number): number {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1]) return Number(args[i + 1]) || fallback;
  return fallback;
}
const SECONDS = argValue('--seconds', 30);
const CONCURRENCY = Math.max(1, Math.min(4, argValue('--concurrency', 2)));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'megatube-bench-'));
const fixtureTs = path.join(TMP, 'fixture.ts');

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 300_000 }, (err) => (err ? reject(err) : resolve()));
  });
}

/** Peak RSS of a pid in bytes (VmHWM from /proc). Null after exit. */
function peakRssBytes(pid: number): number | null {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = status.match(/VmHWM:\s+(\d+)\s+kB/);
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}

async function generateFixture(): Promise<void> {
  // 1280x720 h264 + AAC in MPEG-TS — the exact container shape MegaTube
  // remuxes (browser-incompatible TS carrying browser-compatible codecs).
  await run('ffmpeg', [
    '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc=size=1280x720:rate=30:duration=${SECONDS}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${SECONDS}`,
    '-c:v', 'h264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-f', 'mpegts', fixtureTs,
  ]);
}

/** Cold stream-copy remux to a faststart MP4 (the cache-publish step). */
async function benchColdRemux(): Promise<{ ms: number; outBytes: number }> {
  const out = path.join(TMP, 'cold.mp4');
  const t0 = performance.now();
  await run('ffmpeg', [
    '-v', 'error', '-y',
    '-i', fixtureTs,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c', 'copy', '-bsf:a', 'aac_adtstoasc',
    '-movflags', '+faststart',
    out,
  ]);
  return { ms: performance.now() - t0, outBytes: fs.statSync(out).size };
}

/** Live fMP4 pipe mode: time to first stdout byte (init segment) + first MB. */
async function benchLiveFirstFragment(): Promise<{ initMs: number; first1MBMs: number; totalMs: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-v', 'error',
      '-i', 'pipe:0',
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c', 'copy', '-bsf:a', 'aac_adtstoasc',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'ignore'] });
    const t0 = performance.now();
    let initMs = 0;
    let first1MBMs = 0;
    let got = 0;
    child.stdout.on('data', (c: Buffer) => {
      if (initMs === 0) initMs = performance.now() - t0;
      got += c.length;
      if (first1MBMs === 0 && got >= 1024 * 1024) first1MBMs = performance.now() - t0;
    });
    child.stdin.on('error', () => { /* EPIPE when ffmpeg exits early */ });
    fs.createReadStream(fixtureTs)
      .on('data', (c: Buffer) => { try { child.stdin.write(c); } catch { /* exit race */ } })
      .on('end', () => { try { child.stdin.end(); } catch { /* exit race */ } })
      .on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve({ initMs, first1MBMs, totalMs: performance.now() - t0 }) : reject(new Error(`ffmpeg exited ${code}`))));
    child.on('error', reject);
  });
}

async function benchWarmRead(): Promise<{ ms: number; bytes: number }> {
  const file = path.join(TMP, 'cold.mp4');
  const t0 = performance.now();
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const rs = fs.createReadStream(file, { highWaterMark: 256 * 1024 });
    rs.on('data', (c: Buffer) => { bytes += c.length; });
    rs.on('end', resolve);
    rs.on('error', reject);
  });
  return { ms: performance.now() - t0, bytes };
}

/** N concurrent cold remuxes: peak child RSS + per-job wall time. */
async function benchConcurrentRemux(): Promise<{ jobs: Array<{ ms: number; peakRssMB: number | null }>; nodeHeapMB: number; nodeExternalMB: number }> {
  const jobs: Array<{ ms: number; peakRssMB: number | null }> = [];
  const heapBefore = process.memoryUsage();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async (_, i) => {
      const out = path.join(TMP, `conc-${i}.mp4`);
      const t0 = performance.now();
      await new Promise<void>((resolve, reject) => {
        const child = execFile('ffmpeg', [
          '-v', 'error', '-y',
          '-i', fixtureTs,
          '-map', '0:v:0', '-map', '0:a:0?',
          '-c', 'copy', '-bsf:a', 'aac_adtstoasc',
          '-movflags', '+faststart',
          out,
        ], { timeout: 300_000 }, (err) => (err ? reject(err) : resolve()));
        const sampler = setInterval(() => {
          if (child.pid) {
            const rss = peakRssBytes(child.pid);
            if (rss !== null) jobs[i] = { ms: performance.now() - t0, peakRssMB: Math.round((rss / 1048576) * 10) / 10 };
          }
        }, 100);
        child.on('exit', () => clearInterval(sampler));
      });
      if (!jobs[i]) jobs[i] = { ms: performance.now() - t0, peakRssMB: null };
    }),
  );
  const after = process.memoryUsage();
  return {
    jobs,
    nodeHeapMB: Math.round(((after.heapUsed - heapBefore.heapUsed) / 1048576) * 10) / 10,
    nodeExternalMB: Math.round((after.external / 1048576) * 10) / 10,
  };
}

const result = {
  fixture: { path: fixtureTs, sizeMB: 0, seconds: SECONDS },
  coldRemux: null as unknown as { ms: number; outBytes: number },
  liveFirstFragment: null as unknown as { initMs: number; first1MBMs: number; totalMs: number },
  warmRead: null as unknown as { ms: number; bytes: number },
  concurrent: null as unknown,
  env: { ffmpeg: 'system', node: process.version, platform: `${os.platform()}/${os.arch()}`, cpus: os.cpus().length },
};
try {
  await generateFixture();
  result.fixture.sizeMB = Math.round((fs.statSync(fixtureTs).size / 1048576) * 10) / 10;

  result.liveFirstFragment = await benchLiveFirstFragment();
  result.coldRemux = await benchColdRemux();
  result.warmRead = await benchWarmRead();
  result.concurrent = await benchConcurrentRemux();

  console.log(JSON.stringify(result, null, 2));
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
