# Localhost Performance Investigation

Investigation of the extreme localhost latencies reported during Phase 3–4 testing:
homepage 19–31s, search 6–8s, library 4–7s, thumbnails 3–22s, video Range requests
1.9–26.8s, authentication ~5s spikes, and repeated `The destination stream closed
early` / `ResponseAborted` errors.

Method: no "attached logs" existed in the repository, so the investigation is
measurement-driven end to end — direct database probes, a controlled production
build against a local Postgres, a simulated-WAN replica of the deployed database,
and PERF_TRACE instrumentation. No data was written to the production (Neon)
database at any point; it was only probed with read-only `SELECT 1`/`COUNT(*)`.

---

## 0. TL;DR

| Finding | Evidence | Status |
|---|---|---|
| **RC1 (dominant).** The dev server runs against the **remote Neon database**: every query pays a ~400ms WAN round trip, every new connection 4–5s, and a suspended Neon compute adds 5–10s. A page load fans out dozens of queries. | `/proc/<pid>/environ` of the running `next dev`; direct Neon probes (§4.1); query fan-out via PERF_TRACE (§5) | Fixed where fixable without replacing Postgres/Prisma (connection warming, auth memoization, single-flight); residual RTT is inherent |
| **RC2.** Dev-mode overhead stacks on top (`next dev` / Turbopack). | Same requests: dev 94–723ms vs prod 14–30ms (§3) | Documented + DX warning added; recommendation: `next build && next start` for local perf testing |
| **RC3.** Clerk **dev instance** (`sk_test`/`pk_test`) adds Backend-API network legs per authenticated request. | `.env` key prefixes (type only, values never printed) | Documented; use a production Clerk instance for realistic numbers |
| **RC4.** MEGA session resume had **no single-flight**: a burst of cold thumbnail/media requests each resumed a full MEGA session. | Code inspection `withMegaSession` (§6.3) | **Fixed** (in-flight sharing) |
| **RC5.** The production (Turbopack) build instantiates `lib/db` **per chunk** → multiple pg pools, multiple MEGA-session caches, split auth memos. | PERF_TRACE showed two samplers; one pool idle at 0 connections while the other served every query (§5.3) | **Fixed** (globalThis client dedup in all runtimes) |
| **RC6.** `The destination stream closed early` = **React SSR client-disconnect** message; `ResponseAborted` = client-cancelled fetch. Both are **symptoms of the slow requests**, not independent bugs. | String traced into `react-dom-server` bundle (`createCancelHandler`) (§8) | Nothing to fix beyond RC1–RC3 |
| PostgreSQL **pool size was not the bottleneck**. | `pgPool.waitingCount = 0` in every PERF sample across all runs | Verified, not assumed |

Measured improvement of the fixes under a simulated ~400ms-RTT remote database
(§7): homepage **620ms → 217ms p50 (−65%)**, history/saved/watchlist **~1015ms →
~610ms**, thumbnail burst of 24 **1074ms → 695ms**, post-idle spike **2652ms →
614–822ms**. Local-Postgres correctness and all 604 unit tests remain green.

---

## 1. Environment forensics (what "localhost" actually is)

The server bound to `:3000` at investigation start (PID 43203, started 13:31,
**44 minutes before this session**) is the developer's own `next dev` (Turbopack,
Next 16.3.4). Its `/proc/43203/environ` and the Turbopack worker's environ show:

- `DATABASE_URL = postgresql://...@ep-silent-base-...-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require`
  (the **remote Neon pooled endpoint**; credentials redacted, never printed)
- Clerk keys of type `pk_test` / `sk_test` (a **dev instance**; key values never
  printed)

So "running on localhost" means: dev-mode compilation + **every database query
over the WAN to Neon** + Clerk dev-instance verification. The local Postgres on
`:5433` was empty (no tables) — it was not in use by the dev server.

This single fact reframes the whole investigation: the observed latencies are
exactly what the app produces when its query fan-out is multiplied by WAN
latency. Everything below quantifies that and fixes what can be fixed in the
application layer.

---

## 2. Reproduction strategy (and why Neon was only probed read-only)

Three controlled servers were used:

| Server | Build | Database | Purpose |
|---|---|---|---|
| A `:3000` | developer's `next dev` (untouched) | Neon (its own env) | ground truth of the reported environment; only unauthenticated, strictly read-only GETs were sent to it (no media requests, no POSTs, no Clerk sign-in) |
| B `:3100` | `next build && next start` | local Postgres `:5433` | proves the **application logic is fast** and provides PERF_TRACE instrumentation |
| C `:3200` | `next build && next start` | local Postgres **through a latency-injecting TCP proxy** (`scripts/latency-proxy.mjs`, +200ms per query leg ≈ 400ms RTT) | replicates the Neon round-trip cost **without touching Neon**, to measure fixes before/after |

Neon itself was only probed directly with `SELECT 1` / `COUNT(*)` (read-only).
No fixtures, no app traffic, no writes.

Seed for B/C: `scripts/seed-perf.mts` (1 user + legacy session, 1 linked MEGA
account with deliberately-invalid encrypted session material, 240 videos,
24 thumbnail files, history/watchlist/saved rows).

---

## 3. Application logic is verified healthy (server B: prod + local DB)

All numbers below are end-to-end HTTP timings, authenticated via the legacy
session cookie, measured with `scripts/measure-compare.mjs`:

| Request | p50 | Notes |
|---|---|---|
| `GET /` (authenticated, feed) | 14–30ms | warm feed cache |
| `GET /search?q=…` | 3.3ms | |
| `GET /library` / `/watchlist` / `/account` | 3–4ms | |
| `GET /video/<slug>` | 16–25ms | |
| `GET /api/history` / `saved` / `watchlist` | fast | |
| `GET /api/mega/accounts` | fast | |
| `GET /api/media/thumbs/481` | 7.3ms | `Server-Timing: auth;dur=8, videodb;dur=8, fs;dur=1` |
| **24 concurrent thumbs (burst)** | **125ms wall** | all 200 |
| per-query (`dbq` traces) | 5–8ms | |

Conclusion: routing, SSR, Prisma usage, the thumbnail pipeline's cached-file
path, and the media route's control flow are **not** the cause. The same
requests are 3–20× slower in dev mode on identical data (A vs B on
unauthenticated paths: `/` 94–723ms vs 14–30ms), which is RC2.

---

## 4. The database leg measured directly (section D)

### 4.1 Neon probes (read-only)

`SELECT 1` / `COUNT(*) FROM "Video"` against the exact `DATABASE_URL` the dev
server uses (920 videos on Neon):

| Probe | Result |
|---|---|
| Warm pooled `SELECT 1` (established connection) | **376–1097ms** (median ~400ms) |
| First query after idle (compute suspended) | **5.2s** |
| New connection (3 fresh pools) | **4.1–5.1s each** |
| 10× back-to-back warm `SELECT 1` | 387–518ms (first = 4232ms = connect) |
| 10× back-to-back `COUNT(*)` on 920 rows | **396–675ms** |
| Occasional multi-second query after brief idle | one `COUNT(*)` = **4.06s** (compute wake) |

`COUNT(*)` costs the same as `SELECT 1` → the ~400ms is **pure network round
trip**, not compute or query cost. Connection establishment is 4–5s, and a
suspended Neon compute adds seconds more.

### 4.2 Pool saturation — explicitly checked, explicitly not the problem

PERF_TRACE sampled `pgPool.totalCount/idleCount/waitingCount` on every run:
`waitingCount = 0` in **every sample of every run** (e.g. `total:6 idle:6
waiting:0`), and per-query `dbq` latencies equal the network RTT, not a queueing
wait. The pool was never the bottleneck; it was raised to 25 in Phase 2 and that
was appropriate. No pool-size change was made.

### 4.3 Query fan-out per page (why RTT × count = the observed numbers)

PERF_TRACE per-query traces (single unified client, §5.3) show one
authenticated homepage load issues roughly:

- auth (`Session.findUnique` / Clerk link lookup) — **was** issued once per
  request including every thumbnail request (§6.1)
- feed build: ~11 queries (`Video.count` ×2, `Video.findMany` ×6,
  `WatchHistory.findMany`, `MegaAccount.findMany`, …) in ~4–5 sequential waves
- a full page load with the 24-card grid historically issued **~50 auth+video
  lookups** (24 thumbnails × 2 + page queries)

At the measured 400ms/query this predicts: homepage 6–15s + connect costs
(4–5s × the connections a burst opens) + Neon compute wake (5–10s) + Clerk-dev
legs + dev overhead → **the reported 19–31s**. Thumbnails: 24 requests × 2
lookups with cold-pool connection establishment during the burst (pre-fix
traces show the pool opening up to 12 connections during one burst) → **the
reported 3–22s**. Auth ~5s ≈ one cold connection establishment + Clerk-dev.
History/saved/watchlist/mega-accounts (2–3 queries each) → several seconds.
Search 6–8s, library 4–7s (Clerk-authenticated; note these pages are
proxy-redirected to `/sign-in` for legacy-cookie sessions, so their cost is
Clerk session + page queries on Neon).

---

## 5. Resource measurements (section E)

`lib/observe.ts` (new) samples, when `PERF_TRACE=1`:

- **Event-loop delay** (mean/p50/p99/max via `monitorEventLoopDelay`):
  ~10ms mean, p99 ~10–15ms across **all** runs — the event loop is never the
  bottleneck; the process is overwhelmingly idle awaiting network I/O.
- **Memory**: RSS 163–227MB, heapUsed 52–61MB, external ~5MB, ArrayBuffers ~0 —
  stable, no growth across bursts; no memory pressure.
- **ffmpeg children**: 0 in all measured flows (no remux jobs active during
  page navigation; playback lifecycle was not exercisable without a real MEGA
  account — see §Limitations).
- **Active pg pool connections**: never saturated (`waiting: 0` always; pre-fix
  bursts opened up to 12 connections during thumbnail bursts — each paying the
  4–5s Neon connect cost).
- **Per-query durations** (`dbq`): local 5–8ms; simulated-remote 200–613ms —
  confirming the latency lives in the network leg, not Prisma/pg.

Bottleneck classification: **network I/O wait (database WAN + Clerk-dev API +
MEGA), not CPU, not memory, not event-loop, not pool, not app logic.**

---

## 6. Fixes implemented

### 6.1 Auth result memoization — kills the ~50 auth round trips per page

- **New** `lib/user-memo.ts`: `TtlMemo` — TTL result cache **with in-flight
  promise sharing** (24 concurrent thumbnail requests miss the TTL cache
  simultaneously and must share ONE lookup, not issue 24). `AUTH_MEMO_TTL_MS`
  default 10s; `0` disables.
- `lib/auth.ts` `getCurrentUser`: legacy session lookup memoized per token
  (`legacy:<token>`); `logout()` invalidates immediately (verified: request
  right after logout returns 401). `clearSessionMemoForTests()` exported.
- `lib/clerkUser.ts` `getCurrentMegaUser`: link lookup memoized per Clerk user
  id (`clerk:<userId>`); DB failures still propagate (memo never masks a 5xx as
  "signed out"). `clearClerkUserMemoForTests()` exported.
- Security contract (documented): values are the immutable `UserRecord`
  projection; a session deleted **without** going through `logout()` (e.g.
  direct DB write) stays accepted for at most the TTL (10s default). This
  mirrors the existing cookie-tolerance semantics and is covered by tests.

### 6.2 Connection warm-keepalive — kills the 4–5s connect and compute wake

`lib/db.ts`:
- `startPoolKeepalive`: at startup and every `PG_KEEPALIVE_INTERVAL_MS`
  (default 60s) establishes up to `PG_KEEPALIVE_MIN` (default 2, `0`=off)
  connections and pings `SELECT 1`. This (a) warms the pool so the first burst
  never pays 4–5s connects, (b) keeps a suspending remote compute awake, (c)
  re-establishes after network drops. Never crashes the app; `unref`'d timer.
- For **remote** `DATABASE_URL`s the pool's `idleTimeoutMillis` is raised to
  just above the keepalive interval (pg's default is 10s, which would evict the
  warmed connections between pings and defeat the purpose; connect = 4–5s
  there). Local DBs keep pg's default. Verified in isolation that connections
  persist for 65s+ with the override.
- Dev-mode DX guard: if `DATABASE_URL` is remote, one console warning explains
  the per-query WAN cost and points at `.env.local` with a local Postgres.

### 6.3 MEGA session resume single-flight

`lib/sync/session-cache.ts` `withMegaSession`: concurrent cold callers now
share **one** resume (in-flight promise map). A failed resume is never memoized
— the next caller retries; evictions clear the in-flight entry too. Warm-cache
hits unchanged (10-min TTL). Test seam `__setMegaSessionLegsForTests` (same
pattern as `MediaDeps`/`SyncDeps`).

### 6.4 One shared Prisma client in all runtimes (structural)

`lib/db.ts` previously assigned `globalForPrisma.prisma` only in
non-production. The production Turbopack build instantiates `lib/db` **per
chunk** — measured: two pools, one idle at 0 connections while the other served
every query; also two MEGA-session caches and two auth memos (splitting the
effect of §6.1/§6.3). The global assignment is now unconditional: one pool, one
session cache, one memo everywhere. Dev semantics unchanged (dev already
deduped this way).

### 6.5 PERF_TRACE instrumentation (kept, opt-in)

- `lib/observe.ts`: event-loop histogram, memory gauges, ffmpeg child count
  (via `/proc`), pool gauges. One JSON line per interval. `unref`'d.
- `lib/db.ts`: per-query `dbq` logs (model, operation, ms — never argument
  values) via a Prisma `$extends` query component. Threshold
  `PERF_TRACE_MIN_QUERY_MS`. Zero cost when `PERF_TRACE` is unset.

### 6.6 What was deliberately NOT done

- No pool-size change (waitingCount was always 0).
- No arbitrary caching beyond the auth memo (invalidation understood:
  logout/link-flows; TTL bounded).
- No batching endpoint for thumbnails (would cut 24 ownership RTTs to 1 but
  changes the API/UI contract — listed under Remaining bottlenecks).
- No changes to MEGA, PostgreSQL, Prisma, Clerk, Redis, or the UI.
- No E2E/test traffic against production Neon.

---

## 7. Before/after measurements (server C: prod build + simulated ~400ms-RTT DB)

Same server, same seed, same client script (`scripts/measure-one.mjs --runs 5`),
before = pre-fix build, after = post-fix build:

| Request | Before | After | Δ |
|---|---|---|---|
| `GET /` (auth, p50) | 620ms | **217ms** | **−65%** |
| `GET /` max (feed cache miss) | 2709ms | 2280–2366ms | spikes bounded by feed build; post-idle max below |
| `GET /` after 3s idle, max | 2652ms | **614–822ms** | −70–77% |
| `GET /?page=2` (p50) | 620ms | 216ms | −65% |
| `GET /api/history` (p50) | 1016ms | **612ms** | −40% |
| `GET /api/saved` (p50) | 1016ms | 610ms | −40% |
| `GET /api/watchlist` (p50) | 1014ms | 610ms | −40% |
| `GET /api/mega/accounts` (p50) | 609ms | 206ms | −66% |
| `GET /api/media/thumbs/481` (p50) | 410ms | 410ms | unchanged — now 1 video RTT (auth memoized), which is the floor for a single uncached thumb |
| **24-thumb burst (wall)** | 1074ms | **695ms** | −35% |
| `GET /video/<slug>` (p50) | 425ms | 420ms | unchanged — 2 inherent RTTs |
| login (POST) | 805ms | 788–864ms | unchanged — PBKDF2 + 2 writes, not a hot path |

Interpretation: each remaining ~200ms/RTT quantum is an irreducible round trip
for that request's inherent queries. The memoization removed the *duplicate*
round trips (auth per request), keepalive removed connect/wake spikes, and the
remaining latencies are exactly (inherent queries × RTT). On real Neon (~400ms
measured) the same requests scale proportionally; the user's original numbers
additionally included cold-connection and compute-wake legs that keepalive now
prevents.

---

## 8. Stream errors (section F)

- `The destination stream closed early.` — traced into the bundled
  `react-dom-server` (`createCancelHandler(request, "The destination stream
  closed early.")`). Emitted when the **browser disconnects while SSR is still
  streaming** — i.e. the client aborted a slow page load. Not a bug in our
  streaming code.
- `ResponseAborted` — the fetch pipeline's abort signal for a **client-cancelled
  response**; already classified as non-transient and logged at debug level in
  `lib/net-resilience.ts:155` and handled honestly in `app/api/media/[videoId]/route.ts:1380`
  and `app/api/download/[videoId]/route.ts:329`.

Both are **consequences of RC1–RC3** (slow requests → user navigates/aborts →
cancellation errors in logs). Fixing the latency removes the trigger; there is
no independent stream bug to fix here, and none was suppressed.

---

## 9. E2E hardening suite — classification (not weakened, not hidden)

`tests/e2e/hardening.spec.mjs` reported 8 failures (`toBeVisible`) when run
against the fixed build. Classification performed before changing anything:

1. The suite runs **anonymous** (no `storageState`) and expects
   `[role="link"][aria-label]` cards and exactly 17 cards on the homepage.
2. The current app renders `Landing` for anonymous visitors with **zero video
   cards** (`app/page.tsx`: `if (!user) return <Landing />`; `Landing` is a
   marketing page). With 17 public catalog videos inserted, the homepage still
   renders 0 cards.
3. Reproduced **identically** on the canonical flow (`scripts/e2e.sh`-style dev
   server on :3213) — 2/2 spot-checked tests fail the same way.
4. The original 17-video public fixture database no longer exists in this
   environment (`data/database/app.db` SQLite rollback file is absent; local
   `:5433` was empty at investigation start).
5. The failing assertions touch only anonymous homepage rendering; the perf
   changes do not alter anonymous rendering (no DB queries occur on that path
   at all — verified by traces).

Verdict: **pre-existing suite drift** (spec assumes the old anonymous
public-catalog grid). Not caused by the performance work; left untouched per
the "do not weaken tests" instruction — it needs a deliberate product decision
(anonymous catalog vs Landing) or an authenticated fixture, which is out of
scope for a latency investigation.

---

## 10. Test results

- **Unit**: 604 tests, **599 pass, 0 fail, 5 skip** (baseline before this work:
  596/591/0/5; the +8 are `tests/unit/perf-fixes.test.ts`: TtlMemo TTL /
  in-flight sharing / invalidation / disabled mode / failure
  non-memoization; `withMegaSession` single-flight sharing, warm-cache reuse,
  failure non-memoization; `isRemoteDatabaseUrl` classification).
- **Correctness spot-checks** (HTTP, real server):
  - login → authorized thumb 200; **logout → immediate 401** (+0.3s and +1s)
    — memo invalidation works.
  - 24-thumb burst: all 200 with correct `Server-Timing` stages.
- **E2E hardening**: 8 failed — classified pre-existing (§9), unrelated to
  this work.
- **Type check**: `tsc --noEmit` clean (excluding the user's known WIP route).

---

## 11. Remaining bottlenecks and recommendations

1. **Thumbnails on a remote DB**: each uncached thumb still costs one ownership
   lookup RTT (24 per cold page load; browser `Cache-Control: private,
   max-age=3600` already suppresses repeats within the hour). A batched
   ownership+status endpoint would collapse this to 1 RTT — requires an API/UI
   contract change, deliberately deferred.
2. **Homepage feed cold build**: ~11 queries in ~4–5 sequential waves → ~2–3s
   worst case at 400ms RTT when the 30s feed cache is cold. Consolidation is
   possible but touches the feed composer's correctness-sensitive logic.
3. **Development mode**: for meaningful local numbers use
   `next build && next start`; `next dev` adds compile-on-demand and 3–20×
   per-request overhead (measured).
4. **Remote DB in dev**: create `.env.local` with a local Postgres for day-to-day
   development; the app now warns when `DATABASE_URL` is remote in dev. For
   production-style local runs against Neon, the keepalive + memo fixes above
   are what make it tolerable.
5. **Clerk dev instance**: production Clerk instances verify JWTs locally;
   dev instances add Backend-API legs. For realistic auth latency, test with a
   production instance.
6. **Keepalive cost**: `PG_KEEPALIVE_MIN=2` keeps the remote compute awake
   (a few ms of compute per minute). Set `PG_KEEPALIVE_MIN=0` in CI or when
   running against a local DB where it's unnecessary.
7. **Video playback (Range) legs**: authentication + MEGA session resume
   (now single-flight) + `a=g` + container probe + upstream spool remain
   network-bound to MEGA and were not directly measurable without real MEGA
   credentials (none available in this environment); their per-stage timings
   are logged by the media route's existing `console.warn` instrumentation for
   a future authenticated session.
8. **Known separate correctness issue (from Phase 3, not claimed fixed here)**:
   ffmpeg 8.1.3 intermittently writes the first `moof` with `size=0` at the
   init boundary, which defeats `findFragmentedMp4InitEnd` (`size < 8 → -1`
   before type check) in `lib/media/remux.ts` and fails live remux jobs.
   Reproducible at 30/60/90s × 2000k/3000k; fix direction identified (check box
   type before size); tracked with `scripts/bench-playback.mts`.

---

## 12. Honest limitations

- The developer's authenticated numbers (19–31s etc.) could not be captured
  directly (no credentials for their Clerk session); they are predicted from
  (measured per-query RTT) × (measured per-endpoint query counts) + (measured
  connect/wake costs) + (measured Clerk-dev/dev-mode overhead), and every
  predicted magnitude matches the reported ranges.
- Neon was touched only with read-only probes; all fix measurements used the
  simulated-RTT replica of that RTT.
- MEGA upstream legs were not measured (no real MEGA account available);
  attribution there comes from code paths and the route's existing stage logs.
- The simulated RTT (~400ms) matches Neon's warm steady state but not its
  compute-wake transients, which are prevented (not reproduced) by the
  keepalive.

## 13. Reproducing this investigation

```bash
# seed the local DB (migrations must be applied first)
DATABASE_URL='postgresql://megatube:megatube-dev-only@localhost:5433/megatube?schema=public' \
  npx tsx scripts/seed-perf.mts --videos 240

# simulated ~400ms-RTT remote DB
node scripts/latency-proxy.mjs --port 5434 --delay 200

# prod server against the simulated remote DB
DATABASE_URL='postgresql://megatube:megatube-dev-only@localhost:5434/megatube?schema=public' \
  npx next build && npx next start -p 3200

# measure (login + all endpoints + 24-thumb burst + post-idle scenario)
node scripts/measure-one.mjs --base http://localhost:3200 --runs 5

# with instrumentation
PERF_TRACE=1 ...   # adds 'perf' resource samples and 'dbq' per-query logs
```

Env knobs: `PERF_TRACE`, `PERF_TRACE_INTERVAL_MS`, `PERF_TRACE_MIN_QUERY_MS`,
`PG_KEEPALIVE_MIN`, `PG_KEEPALIVE_INTERVAL_MS`, `PG_POOL_MAX`,
`AUTH_MEMO_TTL_MS`.
