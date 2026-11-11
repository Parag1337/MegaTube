/**
 * Comparative endpoint measurement for the localhost performance
 * investigation. Measures BOTH servers with identical requests where the
 * auth state allows it.
 *
 * Server A (:3000) = the developer's running `next dev` (Neon DB, Clerk dev
 * keys). Only UNAUTHENTICATED, strictly read-only requests are sent there -
 * no fixtures, no writes, no media/thumbnail requests (those can persist
 * metadata or touch MEGA), no Clerk sign-in.
 *
 * Server B (:3100) = production build + local Postgres + PERF_TRACE, fully
 * authenticated via legacy session cookie.
 */

import { execSync } from 'node:child_process';

const A = 'http://localhost:3000';
const B = 'http://localhost:3100';

let cookieB = null;

async function req(base, path, { cookie = null, range = null } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (range) headers.range = range;
  const t0 = performance.now();
  const res = await fetch(`${base}${path}`, { headers, redirect: 'manual' });
  const ttfb = performance.now() - t0;
  const body = await res.text();
  return { status: res.status, ttfb: Math.round(ttfb * 10) / 10, total: Math.round((performance.now() - t0) * 10) / 10, bytes: body.length, st: res.headers.get('server-timing') };
}

function stats(runs, field = 'total') {
  const xs = runs.map((r) => r[field]).sort((a, b) => a - b);
  const sum = runs.reduce((a, r) => a + r[field], 0);
  return { n: runs.length, min: xs[0], p50: xs[Math.floor(xs.length / 2)], max: xs[xs.length - 1], mean: Math.round((sum / xs.length) * 10) / 10 };
}

function report(name, runs) {
  console.log(JSON.stringify({ name, total: stats(runs), ttfb: stats(runs, 'ttfb') }));
  return runs;
}

async function main() {
  // --- Server A: dev + Neon (unauth, read-only) ---
  for (const p of ['/', '/login', '/register']) {
    const runs = [];
    for (let i = 0; i < 5; i++) runs.push(await req(A, p));
    report(`A(dev+neon) GET ${p}`, runs);
  }
  for (const p of ['/api/history', '/api/saved', '/api/watchlist', '/api/mega/accounts']) {
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await req(A, p));
    report(`A(dev+neon) GET ${p} (401 path)`, runs);
  }

  // --- Server B: prod + local (auth via legacy cookie) ---
  const res = await fetch(`${B}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'perf-investigation@example.com', password: 'perf-investigation-password' }),
  });
  const m = (res.headers.get('set-cookie') ?? '').match(/session_token=([^;]+)/);
  cookieB = m ? `session_token=${m[1]}` : null;
  console.log(JSON.stringify({ t: 'login-B', status: res.status, cookie: !!cookieB }));
  if (!cookieB) return;

  const samePaths = ['/', '/login', '/register'];
  for (const p of samePaths) {
    const runs = [];
    for (let i = 0; i < 5; i++) runs.push(await req(B, p));
    report(`B(prod+local) GET ${p}`, runs);
  }

  for (const p of ['/?page=2', '/search?q=harbor', '/library', '/watchlist', '/account', '/video/golden-harbor-1']) {
    const runs = [];
    for (let i = 0; i < 5; i++) runs.push(await req(B, p, { cookie: cookieB }));
    report(`B(prod+local) GET ${p} (auth)`, runs);
  }
  for (const p of ['/api/history', '/api/saved', '/api/watchlist', '/api/mega/accounts']) {
    const runs = [];
    for (let i = 0; i < 5; i++) runs.push(await req(B, p, { cookie: cookieB }));
    report(`B(prod+local) GET ${p} (auth)`, runs);
  }
  // Thumbs: sequential + burst.
  {
    const runs = [];
    for (let i = 0; i < 5; i++) runs.push(await req(B, '/api/media/thumbs/481', { cookie: cookieB }));
    report('B GET /api/media/thumbs/481 (auth, cached file)', runs);
    const t0 = performance.now();
    const ids = Array.from({ length: 24 }, (_, i) => i + 481);
    const burst = await Promise.all(ids.map((id) => req(B, `/api/media/thumbs/${id}`, { cookie: cookieB })));
    console.log(JSON.stringify({ name: 'B thumb-burst-24 wall', wallMs: Math.round(performance.now() - t0), statuses: burst.map((r) => r.status), stSample: burst[0].st }));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
