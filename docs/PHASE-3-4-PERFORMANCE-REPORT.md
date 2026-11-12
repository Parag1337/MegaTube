# MegaTube — Phase 3 + Phase 4: Performance & Playback Report

Branch: `phase-3-4-performance-playback` (base commit `b98737e`)
Date: 2026-11-11

This report covers:

- **Phase 3 — application performance**: database query shape (N+1s,
  sequential round trips, missing indexes), homepage/nav responsiveness,
  search, the thumbnail pipeline, and caching-architecture correctness.
- **Phase 4 — playback/media engine**: MEGA acquisition, AES decryption,
  FFmpeg remux (including the fragmented-MP4 `moof size=0` bug), time to
  first frame staging, seeking/Range, stream lifecycle/concurrency, and
  memory/CPU bounds.
- **Part C — evidence**: before/after benchmarks, regression tests, and the
  list of remaining bottlenecks.

All measurements were taken on this machine against the local PostgreSQL
dev database (`:5433`), with a simulated remote database (`:5434`, 200 ms
added per client→server chunk ≈ 400 ms round trip — the same simulation
used in `docs/LOCALHOST-PERFORMANCE-INVESTIGATION.md`). No production data
or external service was used.

---

## 1. Executive summary

| Area | Before | After | Mechanism |
|---|---|---|---|
| Home page build (cold, 1st page) | 35 SQL queries | **18** | `relationJoins` (nested creator/megaAccount in the same query), creator id pass-through |
| Home page 2 (page-1 feed cached) | 39 | **20** | same |
| Video page recommendation pools | 16 | **7** | same |
| Library/watchlist/history/saved lists | 4–5 | **2** | same |
| Search page (FTS) | 5 | **2** | `COUNT(*) OVER()` folded into the page query |
| `/video/[slug]` at ~400 ms RTT | 425 ms | **218 ms** | 2 sequential DB round trips → 1 |
| `/api/history` at ~400 ms RTT | 611 ms | **250 ms** | 3 round trips → 1–2 |
| `/api/saved` at ~400 ms RTT | 613 ms | **209 ms** | 3 → 1 |
| `/api/watchlist` at ~400 ms RTT | 612 ms | **249 ms** | 3 → 1–2 |
| Thumbnail (warm file) at ~400 ms RTT | 411 ms | **208 ms** | `relationJoins` folds the nested `megaAccount` select into the video lookup (2 round trips → 1) |
| 24-thumbnail concurrent burst | 707 ms | **492 ms** | `relationJoins` (burst is 2 RTT waves before, 1 after) |
| Live playback start (`init` published) | **never** (infinite retry, no video played) | **153.8 ms** | `moof` size-patch fix + init-end hardening |
| First media byte after init | — | **5.3 ms** | staged init + bounded fragments |
| Seek first byte (5 positions) | — | **1.1–4.1 ms** | fragmented MP4 + Range path |
| Warm-cache full read (4.8 MB) | — | **3.2 ms** | file cache path |
| Concurrent playback of two different videos | — | both first-byte < 150 ms, 2/2 slots | shared-job lifecycle |
| Process RSS peak (playback bench) | — (hung) | **151.2 MB** (ffmpeg children 127.7 MB) | bounded 8 MiB stdin queue |

The single most consequential fix is Phase 4's fragmented-MP4 bug: sources
with a long/single GOP produced a first `moof` larger than FFmpeg's 32 KB
AVIO patch-back buffer, the muxer left the box size as `0`, the init-segment
scan never succeeded, and the job retried forever — **those videos never
played at all**. With `-frag_duration 2000000` the output is valid, seeking
works, and cold start is ~150 ms server-side.

---

## 2. Methodology and fixtures

- Branch cut from `b98737e` (the Phase 1+2 work is already merged into it).
- Perf database `postgresql://megatube:megatube-dev-only@localhost:5433/megatube`
  was seeded with `scripts/seed-perf.mts`: 240 videos (ids **978–1217**), a
  cyclic creator assignment for every video (so N+1 exposure is realistic),
  history/saved/watchlist fixtures for `perf-investigation@example.com`, and
  thumbnail files on disk for the whole perf catalog (267 files with ids ≥
  978).
- **Query counting**: Prisma engine `$on('query')` events proved unreliable
  for concurrent waves (they under-count), so `lib/db.ts` wraps the pg
  `pool.query` hook (`withDbQueryCounter`) and `scripts/bench-db.mts`
  measures counts and wall time through the same hot paths the app uses.
- **HTTP measurement**: `scripts/measure-one.mjs` (login + pages + APIs +
  single thumb + 24-thumb burst + post-idle scenario) against a production
  build, with `DATABASE_URL` pointed at the latency proxy (`:5434`).
  Protected pages (`/library`, `/search`, `/watchlist`, `/account`) return
  a Clerk 307 for the legacy session cookie used by the harness; their
  ~3 ms numbers are redirect latency and are shown only for completeness,
  not as page performance. `/`, `/video/[slug]`, the JSON APIs and the
  thumbnail API are fully exercised.
- **Playback measurement**: `scripts/bench-playback.mts` drives the real
  `lib/media/remux.ts` machinery against a locally served, genuinely
  megajs-encrypted MPEG-TS fixture. Only the MEGA transport is replaced.
  Time-to-first-frame *in a browser* and MEGA session-resume latency are
  explicitly out of scope (no MEGA test account exists in this environment;
  see §8).

---

## 3. Phase 3 — what was wrong and what changed

### 3.1 N+1 relation loads on every list/page (biggest win)

**Root cause.** Every serialized video includes `creator { id, slug, name }`
and `megaAccount { id, userId, label, status }`. With Prisma's default
`query` strategy this is **one extra query per relation per query** — a
home feed build fans out into dozens of small SELECTs.

**Fix.** Enabled Prisma's `relationJoins` preview feature
(`prisma/schema.prisma` generator). Nested relation selects now compile to
a single SQL statement with `LEFT JOIN LATERAL` + JSON aggregation. The
generated client was regenerated; the returned rows were verified identical
against the old strategy for every affected query (same values, same order).

Effect: home 35→18 and 39→20; video-page pools 16→7; list endpoints 4–5→2.

### 3.2 Redundant creator lookup per related-video seed

`getSameCreatorVideos(userId, seedId, 12)` re-read the video row just to
learn its `creatorId` before querying that creator's videos. The home feed
already holds the full seed rows, so `creatorId` was added to the shared
`videoSelect`/`serializeVideo` shapes and passed through as
`knownCreatorId` (home feed related pool, up-next selection). The lookup
only decided "no creator → []", so output is unchanged.

### 3.3 `getHistoryRelatedVideos` ran up to 5×(1+3) round trips sequentially

**Root cause.** Creator matches (≤5 queries) and title matches (≤5 refs ×
≤3 search pages) were awaited one ref at a time. Over a remote database
that is up to twenty sequential round trips for the related pool alone
(5 creator + 5 refs × up to 3 pages) — the home feed cold build pays it.

**Fix.** Both phases now issue their per-ref queries concurrently (one wave
per phase, two waves total) and merge in ref order at the end. Per-ref
`take` is now the full limit rather than `limit − found`; this is
merge-order-equivalent **and** sufficient: the j-th item the old sequential
call could return is, by construction, within the first `take` items of the
same ordered search result after the same fixed exclusions (the 3-page walk
bound is identical). Merge-time de-duplication reproduces the old
query-time exclusion exactly, preserving output order.

Trade-off: the pool can run one more query than the early-stopping
sequential loop (6 vs 5 for a cold pool), but it collapses 5 sequential
RTT waves to 2 — the wall-time win that matters remotely.

### 3.4 Search did two round trips per page

`searchVideosFts` ran the id page query and a separate `COUNT(*)` query in
parallel (two DB round trips; over a remote DB the count is a second full
scan/RTT). Folded into one statement with `COUNT(*) OVER()`; the window
total counts all matching rows, so `total`/`totalPages` semantics are
unchanged. Empty result pages fall back to a separate count (cold, rare
path) so the hot path stays at two queries — the count no longer costs its
own round trip.

### 3.5 Thumbnail pipeline

- **Single-flight heal.** Two concurrent requests for the same missing
  thumbnail could both fetch from MEGA, decrypt and write the same file.
  `healInflight` now shares one heal promise per video; a failed heal is
  not memoized (next request retries). This path is only hit for
  missing-but-available thumbnails; the benchmark's warm-file burst does
  not trigger it.
- **Thumbnail hot path.** The route's video lookup selects the nested
  `megaAccount` relation; `relationJoins` serves it in the same query, so a
  warm thumbnail request costs **one** DB round trip instead of two (411 →
  208 ms at simulated latency).
- **Redundant second cache probe in the media route.** `/api/media/[videoId]`
  called `readRemuxCache` a second time after the first miss. It is now
  skipped when the requested size equals the cache entry size (the same key
  was already checked), removing a wasted fs stat/read on every cold miss.
- **Verified caching architecture**: thumbnails are served from
  `data/thumbs` with `Cache-Control: private`; remuxed media is keyed by
  video id + byte size and validated against the durable file; the
  `size`-mismatch path still regenerates. No cache was added that changes
  invalidation semantics, and no Redis/external cache was introduced.

### 3.6 Indexes / query plans

`EXPLAIN (ANALYZE, BUFFERS)` on the hot ordering query (`userLibraryScope`
+ `ORDER BY createdAt DESC, id DESC LIMIT n`) uses a nested loop with a
memoized sort key + top-N heapsort, **0.29 ms** — healthy, no new index was
needed. The ordering already had the compound index from the existing
schema; adding more would have been cargo-culting.

---

## 4. Phase 4 — playback engine

### 4.1 The fragmented-MP4 `moof size=0` bug (videos that never played)

**Reproduction and root cause (verified empirically).** FFmpeg 8.1.3's mov
muxer writing to a non-seekable pipe (`pipe:1`) patches box sizes by
seeking *inside its 32 KB AVIOContext buffer*. With `-movflags
frag_keyframe` and a source that has **one keyframe for the whole file**
(verified with a 60 s / 3000 k fixture: 1 keyframe per 1800 packets), the
first fragment is a single ~35 KB `moof` — larger than the buffer. The
patch-back seek finds the box already flushed, so `moof` (and its `traf` /
`trun`) keep their placeholder `size=0`. Per the ISO-BMFF spec `size=0`
means "extends to end of file", so the stream is unparseable by MSE/`<video>`;
`findFragmentedMp4InitEnd` bailed with `size < 8` and the job hit the 4 MB
init-segment guard and retried forever. Result: those videos never played,
and the job burned a download slot on every retry.

**Fixes.**
1. `-frag_duration 2000000` on the live FFmpeg spawn. Fragments are now
   bounded to ~2 s (moof of a few KB, ~10× margin under the patch buffer),
   which also improves first-fragment latency. `-c copy` is preserved — no
   re-encode, no quality change; container overhead is sub-percent.
2. `findFragmentedMp4InitEnd` checks the box **type** before the size
   validity. A size-0 box at the init boundary no longer blocks publishing
   an already-complete `ftyp`+`moov`; everything after it is fragment
   payload streamed byte-exactly, so parsing is the only thing affected,
   never content. A regression test reproduces the exact size-0
   `moof/traf/trun` buffer.

### 4.2 Backpressure and memory bounds

- `pumpPrefixInto` replaced a manual `data` handler that ignored `write()`'s
  return value (buffering the whole prefix in Node memory when ffmpeg's
  stdin stalls) with `rs.pipe(dest, { end: false })`.
- The live tail tee into `ffIn` now has a **bounded 8 MiB queue**: on
  overflow the source (and the durable file tee) pause until ffmpeg drains.
  The durable file tee stays unthrottled otherwise. If ffmpeg dies with
  bytes still queued, the queue is dropped and the source resumed so the
  cache download still completes (the job then fails with the real FFmpeg
  error). Ending stdin is deferred until the queue is fully drained —
  ending early would silently truncate the muxed stream.
- Peak RSS in the 60 s / 3000 k playback bench: **151.2 MB** process,
  **127.7 MB** across ffmpeg children, 20.4 MB temp disk — versus an
  unbounded buffering path before.

### 4.3 Lifecycle / concurrency (verified, unchanged semantics)

- One shared live job per video: +2 viewers join in **3.4 ms** with 0 extra
  upstream download (3 upstream requests total for the whole scenario).
- Zero-subscriber cancellation tears down promptly and singletons release
  the download slot; the interrupted-upstream scenario recovers
  automatically (first byte **134.4 ms** after resume, 4 upstream requests,
  full 4.8 MB cache published).
- Two different videos play concurrently with 2/2 slots, no queueing
  (first bytes 140.1 ms / 141.3 ms — the second pays its own upstream
  handshake, not a queue).
- Seeks (5 positions across the file) serve in **1.1–4.1 ms** from the
  spool/cache with correct Range responses.
- Slow upstream (0.5 MB/s cap): init published at 1053.5 ms (bounded by the
  available bytes), viewer first byte 1.9 ms after init — playback starts
  as soon as the init segment exists instead of waiting for the whole file.

---

## 5. Before/after measurements

### 5.1 SQL query counts (per operation, pool-level counting)

| Operation | Before (p50) | After (p50) | Local ms before→after |
|---|---|---|---|
| Home page 1 (cold) | 35 | **18** | 54 → 11 |
| Home page 2 (page-1 taken cached) | 39 | **20** | 46 → 9 |
| Search `q=harbor` p1 | 5 | **2** | 13 → 4 |
| Library p1 | 4 | **2** | 5 → 2 |
| New videos p1 | 4 | **2** | 7 → 2 |
| Watchlist p1 | 5 | **2** | 9 → 1 |
| History p1 | 5 | **2** | 13 → 1 |
| Saved videos p1 | 5 | **2** | 6 → 1 |
| Saved folders | 1 | **1** | 3 → 1 |
| History-related pool | 5 | **6** | 9 → 3 |
| Video page pools | 16 | **7** | 15 → 5 |
| Creator listing p1 | 5 | **3** | 8 → 2 |

### 5.2 HTTP at simulated ~400 ms database RTT (production build, p50 of 5)

| Endpoint | Before | After | Δ |
|---|---|---|---|
| `GET /` | 217.1 ms | 217.9 ms | ~0 (1 wave already; tail mean 630→470 ms) |
| `GET /?page=2` | 216.8 ms | 215.9 ms | ~0 (tail mean 501→380 ms) |
| `GET /video/golden-harbor-1` | 425.0 ms | **218.3 ms** | −49% |
| `GET /api/history` | 611.3 ms | **250.1 ms** | −59% |
| `GET /api/saved` | 613.3 ms | **208.7 ms** | −66% |
| `GET /api/watchlist` | 612.1 ms | **249.0 ms** | −59% |
| `GET /api/mega/accounts` | 207.5 ms | 208.3 ms | ~0 (already 1 query) |
| `GET /api/media/thumbs/978` (warm file) | 411.0 ms | **208.3 ms** | −49% |
| 24-thumb concurrent burst (warm files, all 200) | 707 ms | **492 ms** | −30% |
| `GET /` after 3 s idle | 215.1 ms | 218.4 ms | ~0 (keepalive holds) |

Protected pages in the harness are Clerk redirects (≈3 ms both sides) and
are not part of this table. The home page was already a single concurrent
wave after Phase 1+2; its remaining gain is fewer queries per wave (less
DB CPU, smaller tail) rather than another RTT.

### 5.3 Playback engine (60 s / 3000 k encrypted TS fixture)

| Metric | Before | After (final code) |
|---|---|---|
| Init segment published | **never** (4 MB guard, infinite retry) | **153.8 ms** |
| Time to first media byte | — (no stream) | **5.3 ms** |
| +2 concurrent viewers join | — | 3.4 ms, 0 extra upstream |
| Seek first byte (5 positions) | — | 1.1–4.1 ms |
| Cache publication | — | 4.8 MB in 317.6 ms total, 16.9 MB/s downstream |
| Warm cache full read (4.8 MB) | — | 3.2 ms |
| Two different videos concurrently | — | 2/2 slots, first bytes 140.1/141.3 ms |
| Slow upstream (0.5 MB/s) | never played | init 1053.5 ms, viewer first byte 1.9 ms |
| Interrupted upstream | — | recovered, first byte 134.4 ms, cache complete |
| Peak process RSS / ffmpeg children / temp disk | unbounded buffering | **151.2 MB / 127.7 MB / 20.4 MB** |

A second fixture size (30 s / 2000 k) was validated during the
investigation with the same fix set before the final backpressure polish:
init **161.4 ms**, first byte **3.5 ms**, 2.4 MB cache published — same
lifecycle and seek behavior.

---

## 6. Tests and validation

### 6.1 Automated suites

| Check | Result |
|---|---|
| `npm run test:unit` (final code) | **600 passed, 0 failed** (70 s) |
| `npm run test:integration` | 5 skipped — all gated on `MEGA_TEST_EMAIL`/`MEGA_TEST_PASSWORD`; no test account exists in this environment |
| `npx tsc --noEmit` | clean |
| `npx eslint` on every touched file | 0 errors, 1 warning (pre-existing `label` parameter in the `lib/db.ts` keepalive; `schema.prisma` is not covered by the ESLint config) |
| Repo-wide `npm run lint` | 1 pre-existing error (`components/ThemeProvider.tsx`: setState-in-effect) + 119 pre-existing warnings; nothing introduced by this work |
| `next build` (production, final code) | success |
| New regression test | `tests/unit/remux.test.ts` — size-0 `moof/traf/trun` init-boundary case (part of the 600) |

### 6.2 Playwright (hardening + preview)

`tests/e2e/hardening.spec.mjs` + `tests/e2e/preview.spec.mjs` against a
dedicated production server (`:3200`): **14 failed, 0 passed**.

Classification: **pre-existing suite drift, not caused by this work.** All
14 failures are `element(s) not found` / timeouts waiting for
`[role="link"][aria-label]` cards on the **anonymous** homepage. The app
renders `Landing` (zero cards) for anonymous visitors — `app/page.tsx`, and
the whole `components/` tree, are untouched by this work (no diff). The
same failure signature is documented in
`docs/LOCALHOST-PERFORMANCE-INVESTIGATION.md` §9 (8 hardening failures on
the pre-Phase-3 baseline). These specs need an authenticated fixture or a
product decision on the anonymous catalog; per instructions they were not
weakened or deleted. Authenticated-page behavior was exercised through the
HTTP harness (§5.2) instead.

`tests/e2e/auth-navigation.spec.mjs`, `auth.spec.mjs` and
`mega-accounts.spec.mjs` were not run in this phase: they drive Clerk
registration/login (external dev instance) and MEGA credentials, neither of
which is part of the performance work; `mega-accounts` would skip without
credentials anyway. Playwright is not part of the standard `npm test`
chain in this repo.

---

## 7. Files modified

| File | Change |
|---|---|
| `prisma/schema.prisma` | `relationJoins` preview feature |
| `generated/**` (12 files regenerated; 17 tracked) | regenerated Prisma client |
| `lib/videos.ts` | `creatorId` in select/serialize; `COUNT(*) OVER()` search |
| `lib/personal.ts`, `lib/recommendations.ts` | `creatorId` in shared shapes; parallel history-related merge |
| `lib/homeFeed.ts` | pass `knownCreatorId` into the related pool |
| `lib/db.ts` | pool-level query counter (`withDbQueryCounter`, env-gated) |
| `lib/media/remux.ts` | `-frag_duration`, init-end hardening, pipe backpressure, bounded ffIn queue |
| `app/api/media/thumbs/[videoId]/route.ts` | single-flight heal |
| `app/api/media/[videoId]/route.ts` | skip duplicate cache probe on size-equal key |
| `tests/unit/remux.test.ts` | size-0 `moof` regression test |
| `scripts/bench-db.mts` | new query-count/wall-time harness |
| `scripts/measure-one.mjs` | `--thumb-base` flag (fixture ids) |
| `scripts/seed-perf.mts` | cyclic creator assignment (realistic N+1 exposure) |
| `scripts/bench-playback.mts` | local playback-engine benchmark harness (added unchanged apart from an unused-import cleanup; used for the Phase 4 numbers) |
| `scripts/auth-prod.mjs` | local Playwright auth smoke script (dev server `:3101`) |
| `.gitignore` | ignore benchmark build outputs and Playwright artifacts |
| `docs/PHASE-3-4-PERFORMANCE-REPORT.md` | this report |

Not modified: UI components, Phase 5 files, tests (other than the added
regression test), MEGA transport code, database schema beyond the preview
feature flag.

---

## 8. Remaining bottlenecks and limitations

1. **MEGA integration not exercised end-to-end.** No dedicated test account
   exists in this environment; integration tests that need
   `MEGA_TEST_EMAIL`/`MEGA_TEST_PASSWORD` are skipped (5 skips). The
   playback bench replaces only the MEGA transport with a local encrypted
   fixture, so session-resume latency and real throughput remain
   unmeasured. This is the main honest gap in Phase 4 evidence.
2. **Title walk can still page up to 3 times per ref.** Bounded, but on a
   remote DB the title phase remains the slowest part of the home feed's
   related pool. A precomputed similarity table or a single combined FTS
   query would remove the walk.
3. **Thumbnails still cost one ownership lookup per uncached request.**
   The burst improves via concurrency and single-flight, but a browser
   cold page load can still trigger 24 metadata round trips. A batched
   thumbnail endpoint (or embedding ownership in the signed URL) is the
   structural fix — out of scope here.
4. **`lib/media/fmp4-index.ts` is dormant.** A proper fragment index would
   allow instant seeking without scanning; wiring it in is a larger change
   and was deliberately not done.
5. **`VideoActions` mount probes** remain (client-side); not touched to
   avoid UI changes.
6. **Single-keyframe sources now fragment mid-GOP.** With `-frag_duration`
   the muxer cuts fragments at 2 s boundaries even without a keyframe;
   decoding starts from the preceding keyframe, so playback is correct but
   a mid-fragment seek is still bounded by keyframe distance (source
   property, not a regression).
7. **Home page still needs one DB round trip.** It is now 18 queries in
   one wave; further gains require fewer queries per wave (e.g., caching
   the composed feed), which risks staleness and was out of scope.
8. **Lint:** the repo-wide baseline is 1 pre-existing error
   (`components/ThemeProvider.tsx`, setState-in-effect) + 119 pre-existing
   warnings; all files touched in this work lint clean (0 errors, 1
   pre-existing warning: the `label` parameter in the Phase 1+2 keepalive).

### Environment/WIP notes

- An untracked user WIP route `app/api/auth/[...nextauth]/route.ts`
  (imports a non-existent `handlers` export and breaks `next build`) was
  parked at `/tmp/opencode/user-wip-backup/[...nextauth]` so the repo could
  build. It was **not** deleted and is not part of this commit.
- `scripts/auth-prod.mjs` and `scripts/bench-playback.mts` are local
  harnesses committed as-is; they require a running dev server / local
  MEGA-free fixture respectively and are not part of the app runtime.
- `test-results/`, `.next-perf/` and `.tmp-bench/` are local
  build/test/benchmark artifacts (gitignored in this commit).

---

## 9. Reproducing

```bash
# 1. database (local dev instance)
DATABASE_URL='postgresql://megatube:megatube-dev-only@localhost:5433/megatube?schema=public' \
  npx prisma migrate deploy
npx tsx scripts/seed-perf.mts

# 2. query counts + local wall time (before/after on any revision)
DATABASE_URL='postgresql://megatube:megatube-dev-only@localhost:5433/megatube?schema=public' \
  npx tsx scripts/bench-db.mts --runs 5

# 3. playback engine bench (fixture is generated locally, no MEGA account)
npx tsx scripts/bench-playback.mts --seconds 60 --bitrate-k 3000

# 4. HTTP comparison at simulated ~400 ms DB RTT
node scripts/latency-proxy.mjs --port 5434 --delay 200
DATABASE_URL='postgresql://megatube:megatube-dev-only@localhost:5433/megatube?schema=public' \
  npx next build
DATABASE_URL='postgresql://megatube:megatube-dev-only@127.0.0.1:5434/megatube?schema=public' \
  npx next start -p 3300
node scripts/measure-one.mjs --base http://localhost:3300 --runs 5 --thumb-base 978

# 5. tests
npm run test:unit
npm run test:integration   # 5 env-gated skips without MEGA credentials
npx tsc --noEmit
npm run lint
```
