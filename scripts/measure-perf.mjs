/**
 * Measure endpoint latency against the running local server
 * (docs/LOCALHOST-PERFORMANCE-INVESTIGATION.md). Legacy-cookie auth.
 *
 * Usage: node scripts/measure-perf.mjs [--base http://localhost:3000] [--runs 5]
 * Output: JSON lines with per-request timings + aggregate stats.
 */

function argVal(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const BASE = argVal('--base', 'http://localhost:3000');
const RUNS = Number(argVal('--runs', '5')) || 5;

let COOKIE = null;

async function request(path, { method = 'GET', range = null, absolute = false } = {}) {
  const headers = {};
  if (COOKIE) headers.cookie = COOKIE;
  if (range) headers.range = range;
  const t0 = performance.now();
  const res = await fetch(absolute ? path : `${BASE}${path}`, { method, headers, redirect: 'manual' });
  const ttfb = performance.now() - t0;
  const body = await res.text();
  const total = performance.now() - t0;
  return {
    path: absolute ? path : path,
    status: res.status,
    ttfbMs: Math.round(ttfb * 10) / 10,
    totalMs: Math.round(total * 10) / 10,
    bytes: body.length,
    serverTiming: res.headers.get('server-timing'),
  };
}

async function login() {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'perf-investigation@example.com',
      password: 'perf-investigation-password',
    }),
  });
  const setCookie = res.headers.get('set-cookie') ?? '';
  const m = setCookie.match(/session_token=([^;]+)/);
  COOKIE = m ? `session_token=${m[1]}` : null;
  console.log(JSON.stringify({ t: 'login', status: res.status, ms: Math.round(performance.now() - t0), hasCookie: !!COOKIE }));
}

function stats(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const sum = times.reduce((a, b) => a + b, 0);
  return {
    n: times.length,
    min: Math.round(sorted[0] * 10) / 10,
    p50: Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10,
    max: Math.round(sorted[sorted.length - 1] * 10) / 10,
    mean: Math.round((sum / times.length) * 10) / 10,
  };
}

async function scenario(name, fn, runs = RUNS) {
  const results = [];
  for (let i = 0; i < runs; i++) {
    results.push(await fn());
  }
  const total = stats(results.map((r) => r.totalMs));
  console.log(JSON.stringify({ t: 'scenario', name, totalMs: total, runs: results.map((r) => ({ status: r.status, totalMs: r.totalMs, st: r.serverTiming ?? undefined })) }));
}

async function main() {
  await login();
  if (!COOKIE) {
    console.error('login failed');
    process.exit(1);
  }

  await scenario('home-cold', () => request('/'), 3);
  await scenario('home-warm', () => request('/'));
  await scenario('home-p2', () => request('/?page=2'));
  await scenario('search', () => request('/search?q=harbor'));
  await scenario('library', () => request('/library'));
  await scenario('watchlist', () => request('/watchlist'));
  await scenario('video-page', () => request('/video/golden-harbor-1'));
  await scenario('api-history', () => request('/api/history'));
  await scenario('api-saved', () => request('/api/saved'));
  await scenario('api-watchlist', () => request('/api/watchlist'));
  await scenario('api-mega-accounts', () => request('/api/mega/accounts'));
  await scenario('thumb-seq', () => request('/api/media/thumbs/1'));
  await scenario('media-range-nocookie', () => request('/api/media/1', { range: 'bytes=0-' }), 2);

  // Burst: 24 concurrent thumbs (what a homepage grid triggers).
  {
    const t0 = performance.now();
    const ids = [];
    for (let i = 1; i <= 24; i++) ids.push(i);
    const results = await Promise.all(ids.map((id) => request(`/api/media/thumbs/${id}`)));
    const wall = Math.round((performance.now() - t0) * 10) / 10;
    const st = results.map((r) => r.serverTiming);
    console.log(JSON.stringify({ t: 'scenario', name: 'thumb-burst-24', wallMs: wall, statuses: stats(results.map((r) => r.status === 200 ? r.totalMs : -1)), serverTimingSample: st.slice(0, 4) }));
  }

  // Homepage immediately after thumb burst (pool contention evidence).
  await scenario('home-after-thumb-burst', () => request('/'), 3);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
