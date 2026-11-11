#!/usr/bin/env node
/**
 * Database-level A/B benchmark: Neon (source) vs Render PostgreSQL (target).
 *
 * Used during the Neon → Render migration (docs/NEON-TO-RENDER-MIGRATION-PLAN.md)
 * to compare the two providers with the SAME machine, dataset, and method.
 * The dataset is identical because the target is a verified copy of the source.
 *
 * Measures per endpoint:
 *   - fresh-connection cost:  new Pool -> connect -> SELECT 1 -> close (N runs)
 *   - warm SELECT 1:          single pooled connection, N iterations
 *   - representative queries: homepage list, video-by-slug, search ILIKE (warm)
 *   - pool saturation probe:  50 concurrent SELECT 1 (burst behavior)
 *
 * Reports p50/p95/p99/max. Never prints connection strings or credentials.
 *
 * Usage:
 *   node scripts/bench-db-migration.mjs <path-to-env-file-with-DATABASE_URL> [label]
 * Two separate invocations (one per provider) are combined manually in the report.
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';

const envPath = process.argv[2];
const label = process.argv[3] || envPath;
if (!envPath) {
  console.error('usage: bench-db-migration.mjs <env-file> [label]');
  process.exit(1);
}
const env = readFileSync(envPath, 'utf8');
const url = env.match(/^DATABASE_URL="([^"]+)"/m)?.[1];
if (!url) {
  console.error('no DATABASE_URL found in', envPath);
  process.exit(1);
}

const N_CONNECT = 10;
const N_WARM = 200;
const N_QUERY = 100;

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const p = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { n: s.length, p50: p(0.5), p95: p(0.95), p99: p(0.99), max: s[s.length - 1] };
};
const fmt = (r) => `${r.p50}/${r.p95}/${r.p99}/${r.max}ms (n=${r.n})`;

async function freshConnectRun() {
  const t0 = performance.now();
  const p = new pg.Pool({ connectionString: url, max: 1 });
  await p.query('SELECT 1');
  const ms = performance.now() - t0;
  await p.end();
  return ms;
}

const pool = new pg.Pool({ connectionString: url, max: 25 });
await pool.query('SELECT 1'); // establish warm connection

const warmSelect = [];
for (let i = 0; i < N_WARM; i++) {
  const t = performance.now();
  await pool.query('SELECT 1');
  warmSelect.push(performance.now() - t);
}

// Representative queries (mirror app query shapes; parameterized, read-only)
const homepage = [];
for (let i = 0; i < N_QUERY; i++) {
  const t = performance.now();
  await pool.query(
    'SELECT v."id", v."title", v."slug", v."thumbnailAvailable" FROM "Video" v ' +
      'ORDER BY v."createdAt" DESC LIMIT 24',
  );
  homepage.push(performance.now() - t);
}
const bySlug = [];
for (let i = 0; i < N_QUERY; i++) {
  const t = performance.now();
  await pool.query('SELECT * FROM "Video" WHERE "slug" = $1', ['echo-in-latex-with-my-big-black-strapon']);
  bySlug.push(performance.now() - t);
}
const searchProbe = [];
for (let i = 0; i < N_QUERY; i++) {
  const t = performance.now();
  await pool.query(`SELECT s.id FROM "VideoSearch" s WHERE s.alltext ILIKE $1 LIMIT 24`, ['%sissy%']);
  searchProbe.push(performance.now() - t);
}
// Session-lookup shape (auth path)
const sessionProbe = [];
for (let i = 0; i < N_QUERY; i++) {
  const t = performance.now();
  await pool.query('SELECT * FROM "Session" WHERE "token" = $1 LIMIT 1', ['nonexistent-token-probe']);
  sessionProbe.push(performance.now() - t);
}

// Burst: 50 concurrent simple queries against the pool
const burst = [];
{
  const t0 = performance.now();
  await Promise.all(Array.from({ length: 50 }, () => pool.query('SELECT 1')));
  burst.push(performance.now() - t0);
}

console.log(`\n=== ${label} ===`);
console.log('pg version     :', (await pool.query('SELECT version()')).rows[0].version.split(' ').slice(0, 2).join(' '));
const fresh = [];
for (let i = 0; i < N_CONNECT; i++) fresh.push(await freshConnectRun());
console.log('fresh connect  :', fmt(stats(fresh)));
console.log('warm SELECT 1  :', fmt(stats(warmSelect)));
console.log('homepage query :', fmt(stats(homepage)));
console.log('video by slug  :', fmt(stats(bySlug)));
console.log('search ILIKE   :', fmt(stats(searchProbe)));
console.log('session lookup :', fmt(stats(sessionProbe)));
console.log('50-concurrent burst total:', Math.round(burst[0]) + 'ms');
await pool.end();
