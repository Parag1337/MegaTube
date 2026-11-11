# MegaTube — Phase 1 + Phase 2: Stability, Reliability & Playback Performance

Branch: `phase-1-2-stability-performance` · Commit: `23622f7` · Date: 2026-11-11

---

## 1. Baseline

### Architecture inspection

The full data flow was reviewed before any change: MEGA session resume
(`lib/sync/session-cache.ts`, 10-min TTL, close-without-sml) → short-lived `a=g`
download URL (5-min in-process cache + single-flight, `app/api/media/[videoId]/route.ts`)
→ ciphertext fetch with keep-alive + bounded transient retry (`lib/net-resilience.ts`)
→ AES-128-CTR decryption with 16-byte range alignment (`resumeRequestParams`,
`alignDown16`) → stream-copy ffmpeg remux (`-c copy`, never re-encode) →
fragmented MP4 live broadcast + faststart cache publish.

Most of the Phase 1/2 program was already implemented in the codebase under
audit: job-lifecycle states (`dying`/`cancelling`/`settled`), zero-subscriber
grace, bounded remux slots with fail-fast 503, temp-media budget admission
(P1-C), resumable source acquisition with atomic frontier manifests, atomic
sidecar writes, LRU cache eviction with active-stream refcounts, abort-safe
`nodeToWebSafe` conversion, P0 startup-latency fixes (no blocking probes,
background duration probe, init-first publication). These were verified, not
re-implemented.

### Baseline test run (before changes)

`npm test` (with a local PostgreSQL on :5433):

- 563 tests: **555 pass, 3 fail, 5 skipped**
- The 3 failures, all pre-existing:
  1. `tests/unit/auth.test.ts` + 2. `tests/unit/titles-metadata.test.ts` — failed at import: they
     transitively import `lib/db`, which throws without `DATABASE_URL`; `npm test`
     did not provide one.
  3. `tests/unit/phase5-search-network.test.ts` › "runtime boundary: client
     components never import the Node-only network module" — false positive:
     `app/api/download/[videoId]/route.ts` (a server API route pinned to
     `runtime='nodejs'`) legitimately imports `lib/net-resilience` for the
     keep-alive fetcher; the scan's exclusion list only covered `api/media`.
- 5 skipped: real-MEGA integration tests (credentials not configured — correct).

Without a running PostgreSQL, 21 DB-backed files fail (connection refused) —
a local test cluster (`pg_ctl` on :5433, matching `tests/unit/helpers/test-db.ts`)
was used for all runs below.

---

## 2. Root-cause findings (confirmed problems)

| # | File / function | Root cause | Evidence | Fix |
|---|---|---|---|---|
| 1 | `package.json` `test` scripts | DB-backed suites that import `lib/db` at module scope fail without an exported `DATABASE_URL`; nothing loads `.env` for tests (and loading it would point tests at the production Neon URL) | baseline run: auth.test.ts + titles-metadata.test.ts `Error: DATABASE_URL is not set` | Default `DATABASE_URL` in the test scripts to the same local URL `test-db.ts` already uses (`${DATABASE_URL:-...}`); the real `.env` is never read |
| 2 | `tests/unit/phase5-search-network.test.ts` › runtime-boundary scan | Scan treated *all* of `app/**` as client-reachable, but server API routes are never bundled for the browser | baseline failure naming the download route | Scan now covers only client-reachable files (`components/`, `app/` minus `app/api/**`); a NEW stronger assertion requires every `app/api/**/route.ts` importing `net-resilience` to pin `runtime = 'nodejs'` |
| 3 | `lib/clerkUser.ts` › `getCurrentMegaUser` | One catch-all around Clerk *and* Prisma legs converted database outages into "signed out" (requirement 2.5 violation) | code reading: `prisma.user.findUnique` inside the same `try` as `auth()` | Clerk identity/profile failures → `null` (legacy-cookie fallback preserved); Prisma/pg failures → rethrown for an honest 5xx; the DB mapping call now sits outside the Clerk catch |
| 4 | `lib/media/remux.ts` › live `ffOut.on('data')` | `Buffer.from(c)` copied every ffmpeg stdout chunk (Node allocates fresh, non-reused chunk buffers; the spool append serializes at write time; subscribers read from the spool file) — pure allocation churn in the hot path | code reading + Node stream semantics | Copy removed; behavior unchanged (all 47 remux tests pass) |
| 5 | observability gap | No way to inspect remux/cache state at runtime without shell access | no stats endpoint existed | New owner-only `GET /api/media/stats` + `mediaCacheStats()` + `describeLiveRemuxJob()` (numeric gauges only) |
| 6 | coverage gap | `parseRange` — the shared Range contract for direct/warm-cache/416 paths — was not exported and only indirectly tested | no direct unit tests existed | Exported (interface-only change) + 10 new unit tests |

**Potential risks investigated and deliberately left unchanged** (verified, not
assumed wrong): `MAX_CONCURRENT_REMUX=2` (see §4 measurement), the
zero-subscriber 10 s grace, single-flight URL caching, the 5-minute g-URL TTL,
`PG_POOL_MAX=25` (documented as measured in `lib/db.ts`), multi-range HTTP
requests (rejected as malformed → 416; browsers send single ranges), and the
untracked user WIP (`app/api/auth/[...nextauth]/`, `scripts/auth-prod.mjs`)
which was preserved untouched — note it currently has a TypeScript error
(`handlers` is not exported from `lib/auth`) that is *not* addressed here.

---

## 3. Changes implemented

Files modified (commit `23622f7`):

- `package.json` (+`package-lock.json`): default test `DATABASE_URL`; carries
  the pre-existing working-tree `@clerk/nextjs` 7.9.4 bump.
- `tests/unit/phase5-search-network.test.ts`: runtime-boundary scope fix + new
  server-route `runtime='nodejs'` assertion.
- `lib/clerkUser.ts`: auth-vs-DB failure separation.
- `lib/media/remux.ts`: removed per-chunk buffer copy; added
  `describeLiveRemuxJob()` (numeric-only job diagnostics).
- `lib/media/cache.ts`: added `mediaCacheStats()` — strictly read-only scan
  (entries/stale/temp accounting; verified immutable by test).
- `app/api/media/[videoId]/route.ts`: `parseRange` exported for tests.

Files added:

- `app/api/media/stats/route.ts`: `GET /api/media/stats` (owner-only, 401 when
  signed out). Reports: Node memory gauges (rss/heap/external/arrayBuffers),
  remux slots (active/max/queued), live jobs (state, age, broadcast/spool
  bytes, subscribers, joined count), temp-media footprint vs budget, cache
  entries/stale/temp bytes. **No credentials, session ids, keys, or temporary
  URLs are ever included.**
- `tests/unit/media-range.test.ts`: 10 tests (suffix ranges, open/closed
  ranges, clamping, malformed + unsatisfiable → 416, empty source,
  boundary/leading-zero forms).
- `tests/unit/media-cache-stats.test.ts`: 3 tests (classification of
  valid/stale/temp, missing-dir behavior, read-only immutability).
- `scripts/bench-media.mts`: credential-free reproducible pipeline benchmarks.

---

## 4. Performance measurements

`npx tsx scripts/bench-media.mts` (linux/x64, 16 CPUs, system ffmpeg, Node
v22.23.1). Synthetic fixture: h264+AAC in MPEG-TS, generated locally.

| Metric | 30 s fixture (2.7 MB) | 240 s fixture (~20 MB) |
|---|---|---|
| Live fMP4 first stdout byte (init) | 292 ms | 284 ms |
| First 1 MB of fMP4 output | 324 ms | 529 ms |
| Cold faststart remux (`-c copy`) | 321 ms | ~510–610 ms |
| Warm-cache full read | 6 ms | 45 ms |
| ffmpeg peak RSS per remux job | **79.6 MB** | **80 MB** |
| 2 concurrent jobs: Node heap delta | 0.3 MB | 0.3 MB |
| 2 concurrent jobs: Node external | 10.5 MB | 31 MB |

**Key finding:** stream-copy ffmpeg RSS is *flat* (~80 MB) regardless of
source size — remuxing is streaming, not buffering. Two concurrent remux jobs
≈ 160 MB ffmpeg + ~120–150 MB Node ≈ 300 MB peak, which fits the 512 MB
target with headroom. **`MAX_CONCURRENT_REMUX=2` is therefore confirmed as a
measured, safe default** (not blindly increased — the env var remains
available for larger hosts).

*Not measurable without the live server + real MEGA account (stated honestly,
not invented): MEGA `a=g` URL latency, upstream ciphertext header time,
MEGA download speed, and true browser time-to-first-frame. The in-code
instrumentation already logs the server-side milestones (request → URL →
upstream headers → init published → broadcast) per request.*

---

## 5. Tests executed and results

| Stage | Command | Result |
|---|---|---|
| Baseline (local PG up) | `npm test` | 563 tests: 555 pass, **3 fail**, 5 skipped |
| After changes | `npm test` | **596 tests: 591 pass, 0 fail, 5 skipped** |
| Targeted | `remux.test.ts` | 47/47 pass |
| Targeted | `media-route.test.ts` | 41/41 pass |
| Targeted | `media-cache.test.ts`, `clerk-mapping.test.ts`, `phase5-search-network.test.ts` | 39/39 pass |
| Type check | `npx tsc --noEmit` | clean (only the pre-existing untracked nextauth WIP error remains) |
| Lint | `npx eslint` on all changed/added files | clean |

The 5 skips are the real-MEGA integration tests requiring
`MEGA_TEST_EMAIL`/`MEGA_TEST_PASSWORD`. Playwright e2e was **not** run: the
suite reads/writes fixtures against `DATABASE_URL`, which currently points at
the production Neon database — running it would write to production data.
Running it requires a dedicated local `E2E_DATABASE_URL` environment first
(recommended next step).

---

## 6. Remaining issues and limitations

1. **Untracked user WIP**: `app/api/auth/[...nextauth]/route.ts` imports a
   non-existent `handlers` export and breaks `tsc --noEmit`; preserved
   untouched (not mine to finish). Also `test-results/` is untracked and not
   gitignored.
2. **Playwright e2e** unexecuted (production-DB safety, §5).
3. **Real-MEGA integration tests** skipped without a dedicated test account
   (per instructions, never personal credentials).
4. Live fMP4 seek-ahead-of-frontier remains bounded-wait by design (30 s
   `SPOOL_WAIT_TIMEOUT_MS` then honest 503) — unchanged; no unsupported seek
   behavior was invented.
5. The two-range MEGA layout probe for faststart detection remains
   intentionally deferred/backgrounded (P0 design decision verified correct).

## 7. Recommended next steps

1. Finish or remove the NextAuth WIP files (they currently fail typecheck).
2. Add `test-results/` to `.gitignore`.
3. Provision a local `E2E_DATABASE_URL` and run the Playwright suite in CI.
4. Provision a dedicated MEGA test account for the real-MEGA integration tests.
5. Consider wiring `/api/media/stats` into an admin UI panel (the endpoint is
   already safe to consume).
