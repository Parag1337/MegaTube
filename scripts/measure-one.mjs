/**
 * Full authenticated endpoint measurement against one server.
 * Usage: node scripts/measure-one.mjs --base http://localhost:3200 [--runs 5]
 */

function argVal(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const BASE = argVal('--base', 'http://localhost:3200');
const RUNS = Number(argVal('--runs', '5')) || 5;
let cookie = null;

async function req(path, { range = null } = {}) {
  const headers = { cookie };
  if (range) headers.range = range;
  const t0 = performance.now();
  const res = await fetch(`${BASE}${path}`, { headers, redirect: 'manual' });
  const ttfb = performance.now() - t0;
  await res.text();
  return { status: res.status, ttfb: Math.round(ttfb * 10) / 10, total: Math.round((performance.now() - t0) * 10) / 10, st: res.headers.get('server-timing') };
}
function stats(runs, field = 'total') {
  const xs = runs.map((r) => r[field]).sort((a, b) => a - b);
  const sum = runs.reduce((a, r) => a + r[field], 0);
  return { n: runs.length, min: xs[0], p50: xs[Math.floor(xs.length / 2)], max: xs[xs.length - 1], mean: Math.round((sum / xs.length) * 10) / 10 };
}
function report(name, runs) {
  console.log(JSON.stringify({ name, total: stats(runs) }));
}

async function main() {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'perf-investigation@example.com', password: 'perf-investigation-password' }),
  });
  cookie = ((res.headers.get('set-cookie') ?? '').match(/session_token=([^;]+)/) ?? [])[0] ?? null;
  console.log(JSON.stringify({ t: 'login', status: res.status, ms: Math.round(performance.now() - t0), ok: !!cookie }));
  if (!cookie) process.exit(1);

  for (const p of ['/', '/?page=2', '/search?q=harbor', '/library', '/watchlist', '/account', '/video/golden-harbor-1']) {
    const runs = [];
    for (let i = 0; i < RUNS; i++) runs.push(await req(p));
    report(`GET ${p}`, runs);
  }
  for (const p of ['/api/history', '/api/saved', '/api/watchlist', '/api/mega/accounts']) {
    const runs = [];
    for (let i = 0; i < RUNS; i++) runs.push(await req(p));
    report(`GET ${p}`, runs);
  }
  {
    const runs = [];
    for (let i = 0; i < RUNS; i++) runs.push(await req('/api/media/thumbs/481'));
    report('GET /api/media/thumbs/481', runs);
  }
  {
    const t = performance.now();
    const ids = Array.from({ length: 24 }, (_, i) => i + 481);
    const burst = await Promise.all(ids.map((id) => req(`/api/media/thumbs/${id}`)));
    console.log(JSON.stringify({ name: 'thumb-burst-24', wallMs: Math.round(performance.now() - t), statuses: burst.map((b) => b.status).join('') }));
  }
  // Cold-pool scenario: after an idle gap, how long is the first request?
  await new Promise((r) => setTimeout(r, 3000));
  {
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await req('/'));
    report('GET / (after 3s idle)', runs);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
