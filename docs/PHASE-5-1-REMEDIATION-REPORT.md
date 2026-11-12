# Phase 5.1 Preview Generation — Remediation Report

**Date:** 2026-11-12
**Branch:** `phase-5-1-remediation`
**Worktree:** `/home/parag/Projects/Project_Mega_phase5_remediation`
**Base:** Phase 5.1 tip `30c7630` (`docs: phase 5.1 preview generation implementation report`)
**Environment:** Node.js 22.23.1, Next.js 16.3.4, PostgreSQL 18.6 on `localhost:5433`, FFmpeg 8.1.3, Chromium/Google Chrome (Playwright 1.63)

---

## 1. Executive summary

The independent audit of Phase 5.1 was correct on every material point that
could be reproduced locally. This remediation:

- separates **claims**, **generation attempts**, and **recoveries** into
  distinct durable counters and prevents claim-only crashes from consuming
  the generation budget;
- bounds expired-lease recovery with exponential backoff, a cap, jitter, and
  a terminal `worker_recovery_exhausted` state;
- enforces one **absolute per-job deadline** from acquisition through
  publication, with SIGTERM → SIGKILL process termination and claim fencing
  so a stale worker can never publish;
- caches dashboard statistics for 20 s with single-flight refresh, explicit
  invalidation, and a 15 s minimum refresh interval (800 invalidations during
  the 400-video simulation produced only 12 disk scans);
- makes sidecar `lastAccessedAt` writes memory-only and flushes them in
  bounded batches while preserving LRU/active-stream safety;
- replaces the unknown-duration `t * 64_000` heuristic with real MP4 `mvhd`
  duration parsing and explicitly estimated byte-fraction windows for TS;
- proves the FFmpeg montage `-ss`/`-t` placement is correct through a real
  synthetic red → green → blue reproduction (no production code change);
- fixes two additional defects found during validation: **local-time
  `now()` writes into UTC `TIMESTAMP` columns** and **Next 16 route modules
  exporting non-route symbols**, which broke `next build`.

A controlled **400-video / 8-worker** simulation completed **400/400 jobs
with zero failures**, at most **one FFmpeg job running at a time**, and one
attempt and one claim per completed preview. Browser validation passed with
genuine Clerk authentication for desktop hover playback, preview/meta APIs,
settings statistics, and a 390×844 responsive layout.

Real MEGA acquisition, production Render disk behavior, multi-process
PostgreSQL contention, and native touch-device hover behavior remain
**NOT TESTED** (see §11).

---

## 2. Verified starting point

| Item | Value |
| --- | --- |
| Original Phase 5 worktree | `/home/parag/Projects/Project_Mega_phase5` |
| Phase 5.1 branch | `phase-5-1-preview-generation` |
| Phase 5.1 tip used as base | `30c7630` |
| Main (unchanged) | `93fecfb` |
| Phase 3–4 tip used later | `e39714d` (functional tip `9967ea0` plus one harness/docs commit) |
| Common ancestor | `b98737e` |
| Baseline unit tests | 689 pass |
| Baseline integration tests | 13 pass, 5 skipped (real-MEGA credentials), 0 fail |

No changes were made to `main`, the original Phase 5.1 worktree, `.env`, or
`data/`. The remediation worktree uses symlinks for `node_modules` and a
read-only `.env`; all test runs supplied an explicit local `DATABASE_URL`.

---

## 3. Audit finding → remediation mapping

| Audit finding | Status | Implementation |
| --- | --- | --- |
| Claim count conflated with generation attempts | **Fixed** | `claimCount` and `recoveryCount` columns; `attempts` incremented only by `beginPreviewGenerationAttempt()` |
| No bounded recovery for abandoned leases | **Fixed** | Exponential backoff (1/2/4/8 min by default), configurable cap/jitter, `PREVIEW_JOB_MAX_RECOVERIES`, terminal `worker_recovery_exhausted` |
| Heartbeat can keep a stuck job alive forever | **Fixed** | Absolute `previewJobDeadlineMs()` timer aborts the entire run independently of lease renewal |
| Stale worker may publish after losing its claim | **Fixed** | `claimCount` fencing checked by heartbeat, stage, completion, failure, and `guardPublish()` immediately before rename |
| Per-video filesystem stats on every 5 s dashboard poll | **Fixed** | `lib/preview/stats-cache.ts` TTL + single-flight + invalidation + min-refresh throttle |
| Sidecar `lastAccessedAt` write per touch | **Fixed** | `touchPreview()` is memory-only; `flushPreviewAccessTimes()` during stats refresh/eviction |
| Unknown duration uses fixed 64 KB/s estimate | **Fixed** | MP4 `mvhd` v0/v1 parsing; TS byte-fraction windows marked estimated/degraded |
| Montage `-ss`/`-t` placement questioned | **Verified correct** | Real red → green → blue FFmpeg reproduction; no production change |
| No 400-video validation | **Fixed locally** | Isolated 400-video simulation; real MEGA still NOT TESTED |
| No live browser validation | **Fixed** | Genuine Clerk-auth desktop + responsive browser run |
| Build/type health | **Fixed (new finding)** | Next route modules split into `route.ts` + `handler.ts`; UTC session/timezone fix |

---

## 4. Accounting and recovery semantics

### 4.1 Counters

| Counter | Meaning | Incremented by |
| --- | --- | --- |
| `claimCount` | Successful worker claims; also the fencing token | `claimNextPreviewJob()` |
| `attempts` | Real generation runs started | `beginPreviewGenerationAttempt()` |
| `recoveryCount` | Expired-lease recoveries | `recoverExpiredPreviewLeases()` |

A worker that claims a job and dies consumes **one claim**, **zero
attempts**, and later **one recovery**. A job that exhausts
`PREVIEW_JOB_MAX_RECOVERIES` becomes terminally failed and is not silently
resurrected by ordinary hover/sync scans (`autoRetryBlockedError`). Recovery
backoff is:

```text
delay = min(2^recoveryCount, ceil(maxMs/baseMs)) * baseMs
        + random(0, jitterMs)
```

Defaults: base 60 s, cap 8 min, jitter 15 s, max recoveries 4. Tests set
base 1 s / cap 10 s / jitter 0 for deterministic assertions.

### 4.2 Fencing

`claimCount` is accepted by `heartbeatPreviewJob`, `setPreviewJobStage`,
`assertPreviewJobOwnership`, `completePreviewJob`, and `failPreviewJob`.
Calls with a stale claim are no-ops. `generateHoverForWorker()` also receives
`guardPublish`, which is checked immediately before the final artifact
rename. A stale worker cannot overwrite a newer artifact or mark a job
complete/failed.

---

## 5. Deadlines, cancellation, and process control

### 5.1 Absolute job deadline

The worker starts a single deadline timer before acquisition and clears it
only after publication. The timer is independent of lease heartbeats, so a
live-but-stuck job cannot extend it. Default `PREVIEW_JOB_DEADLINE_MS` is
10 minutes, bounded to 30 s–1 h. Timeout outcomes are classified as
`job_timeout`.

### 5.2 Abort propagation

`AbortSignal` is threaded through:

- `resolveMontageSources()` / source range acquisition;
- montage encoding, hover encoding, validation, probes, scene selection,
  sprites, timeline generation;
- every `runProcess()` child invocation.

`runProcess()` now returns `aborted: true`, sends **SIGTERM**, waits
`PREVIEW_PROCESS_KILL_GRACE_MS` (default 5 s), sends **SIGKILL**, and has a
2 s force-settle timer in case a killed child never emits `close`. This
prevents a deadline from hanging the worker indefinitely.

### 5.3 Heartbeat loss and shutdown

- A failed heartbeat renewal aborts the run with reason `lease_lost`.
- Worker signal handlers abort the active run, cancel queued work via the
  queue signal, and re-deliver the signal so the host/default action still
  controls process exit.
- Aborted runs do not write a failure sidecar that could clobber a newer
  worker's artifact.

---

## 6. Dashboard statistics cache

`lib/preview/stats-cache.ts` is dependency-free to avoid a `jobs ↔ cache`
cycle. It provides:

- TTL (default 20 s);
- single-flight refresh (concurrent polls await one scan);
- explicit invalidation on publish/remove/evict;
- minimum refresh interval (default 15 s) so a bulk completion storm cannot
  turn every invalidation into a filesystem pass;
- hit/miss/refresh/coalesced/invalidation metrics.

Artifact publication, removal, eviction, and job transitions invalidate the
cache. The Settings UI keeps polling, but the expensive per-video disk pass
runs at most once per refresh window. Staleness is bounded and never used
for generation decisions; jobs read sidecars/rows directly.

### 6.1 Sidecar touch throttling

`touchPreview()` no longer writes JSON on every hover. Accesses accumulate in
`pendingTouches`; LRU ordering uses the pending timestamp, so active streams
remain protected. `flushPreviewAccessTimes()` persists pending accesses at
bounded points (stats refresh and eviction). The write path still preserves
the latest sidecar fields.

---

## 7. Unknown-duration sources

### 7.1 MP4

`lib/preview/mp4-index.ts` now parses `moov → mvhd` v0 and v1 boxes, including
64-bit durations, and converts them with the movie timescale. The source
resolver reads a bounded head window first, then a bounded tail window when
the moov atom is at the end of a non-faststart file. A metadata duration is
used only when it is finite and positive.

### 7.2 MPEG-TS

When no reliable duration exists, scene positions use
`byteWindowAtFraction()`: a bounded file-relative window (3% of the file,
minimum 4 MB, capped by `PREVIEW_SOURCE_MAX_BYTES`, 752-byte aligned). Scenes
are marked `estimated: true` and `byteFraction` is persisted. The old
`t * 64_000` assumption is gone; `byteWindowFor()` explicitly delegates
unknown-duration callers to the fraction path.

Scene metadata now carries `estimated` and `byteFraction`, and the API/sidecar
never presents estimated positions as exact.

---

## 8. FFmpeg montage argument verification

The audit questioned whether per-input `-ss`/`-t` before `-i` really select
the intended source windows. A real FFmpeg test builds a three-colour
4 s/segment source (red → green → blue), extracts one second from the middle
of each segment through `encodeMontage()`, validates the output, and samples
the montage at 0.5 s, 1.5 s, and 2.5 s. The result is red → green → blue.

**Conclusion:** the argument construction is correct; no production change
was made. The reproduction is permanently pinned in
`tests/unit/preview-ffmpeg-montage.test.ts`.

---

## 9. Additional defects found and fixed

### 9.1 Local time written into UTC `TIMESTAMP` columns

Reproduced during integration validation on a PostgreSQL server whose
timezone is `Asia/Kolkata`. Raw SQL used `now()`, which returns a
`timestamptz` rendered in the session timezone; PostgreSQL stored that local
wall-clock value into `TIMESTAMP(3)`, while Prisma reads such columns as UTC.
The observed first recovery backoff was **19,801,002 ms (≈5 h 30 m + 1 s)**
instead of ~1 s.

Fixes:

- preview raw SQL uses `(now() AT TIME ZONE 'UTC')` for every deadline,
  retry, lease, and recovery timestamp;
- every pg pool session is pinned to UTC (`options: '-c timezone=UTC'`), so
  DB-side defaults (`CURRENT_TIMESTAMP`) are also correct;
- an integration test asserts `current_setting('TimeZone') = 'UTC'`;
- the recovery-backoff test now fails fast on any timezone skew.

### 9.2 Next 16 route export surface broke `next build`

The download and media route files exported test helpers
(`handleDownloadRequest`, `persistVideoDuration`, `parseRange`,
`handleMediaRequest`, dependency types). Next 16 type-checks every export of
`route.ts` and fails with `Property ... is incompatible with index signature`.
This reproduced on the untouched Phase 5.1 tip.

Fix: move implementations to `handler.ts`; `route.ts` now exports only
`runtime`, `dynamic`, and the HTTP handlers. Unit tests import
`handler.ts` directly. No test was weakened or removed.

---

## 10. Verification results

### 10.1 Automated tests

| Suite | Result |
| --- | --- |
| Unit (remediation) | **709 pass, 0 fail** (`npm run test:unit`) |
| Integration (remediation) | **17 pass, 5 skipped, 0 fail** (`npm run test:integration`) |
| Integration skips | 5 real-MEGA tests requiring credentials |
| `npx tsc --noEmit` | **Clean** (after `.next` type generation) |
| `npx next build --webpack` | **Success** |
| Targeted service generation test | **3/3 pass** (real FFmpeg, duration probe, fencing, abort) |
| Targeted montage reproduction | **pass** (real red/green/blue) |
| ESLint on changed files | 0 errors; one pre-existing unused-parameter warning in `lib/db.ts` |

`next build` was run with `--webpack` because this worktree's `node_modules`
is a symlink outside the project root and Turbopack rejects that layout. The
application code itself compiled and type-checked cleanly.

### 10.2 New test coverage

- `tests/unit/preview-stats-cache.test.ts` — TTL, single-flight, invalidation
  throttle.
- `tests/unit/preview-mp4-index.test.ts` — `mvhd` v0/v1, malformed boxes.
- `tests/unit/preview-segment.test.ts` — fraction windows, no 64 KB/s path.
- `tests/unit/preview-source-montage.test.ts` — TS fraction, known duration,
  warm-cache reuse, abort.
- `tests/unit/preview-ffmpeg-abort.test.ts` — SIGTERM → SIGKILL and
  force-settle.
- `tests/unit/preview-ffmpeg-montage.test.ts` — real montage order.
- `tests/unit/preview-service-generation.test.ts` — real generation,
  publication fencing, abort/no-sidecar.
- `tests/unit/preview-cache.test.ts` — touch throttling/flush/LRU.
- `tests/integration/preview-jobs.test.ts` — claim/attempt/recovery
  accounting, fencing, backoff, cache, UTC session.

### 10.3 Controlled 400-video simulation

Isolated database `megatube_simulation`, one synthetic 2 s / 160×90 MP4
fixture reused by all rows, real queue + generation service + FFmpeg, no
MEGA network. 400 rows, 20% with `duration = NULL` to exercise MP4 `mvhd`
probe. Eight in-process worker loops shared one production-shaped
`PreviewQueue(1, …)` gate.

Command:

```bash
DATABASE_URL=postgresql://megatube:megatube-dev-only@localhost:5433/megatube_simulation?schema=public \
PREVIEW_CACHE_DIR=/tmp/opencode/preview-sim \
PG_KEEPALIVE_MIN=0 \
npx tsx scripts/simulate-preview-backlog.mts --videos 400 --workers 8
```

| Metric | Value |
| --- | --- |
| Jobs completed / failed | **400 / 0** |
| Attempts / claims | **400 / 400** (1.0 each per preview) |
| Recoveries | 0 |
| Lost claims | 0 |
| Elapsed (includes 15.25 s final cache settle) | 171,419 ms |
| Effective generation throughput | ≈154 previews/min (140/min including settle) |
| Job duration p50 / p95 / max | 3,036 / 3,321 / 4,539 ms (includes queue wait) |
| Max FFmpeg jobs running | **1** |
| Max queued generations | 7 |
| Preview files / bytes | 400 / 23,786,800 B |
| Average preview size | 59,467 B |
| Duration probes (`probing-duration`) | 80 (the 20% null-duration slice) |
| Stats polls | 1,699 |
| Stats cache hits / misses / refreshes | 1,688 / 12 / 12 |
| Stats invalidations (throttled) | 800 |
| Stats p50 / p95 / max latency | 0 / 1 / 45 ms |
| Final stats completed / missing / generating | 400 / 0 / 0 |

Interpretation:

- The queue never starts 400 FFmpeg processes; the shared gate caps real
  encoding at one job, with at most seven workers waiting in the queue.
- Every completed preview consumed exactly one claim and one generation
  attempt; no retry churn or recovery occurred.
- 800 stats invalidations produced 12 disk scans, not 800. The cache is doing
  the intended work under a completion storm.
- The 80 null-duration rows were resolved from MP4 metadata; no fixed-bitrate
  assumption was used.

### 10.4 Browser validation

Local production server (`next start`) against the local PostgreSQL, seeded
with three private videos (one ready preview, two missing). Authentication
was genuine Clerk auth: a temporary Clerk **dev-instance** user was created
through the Backend API, a single-use sign-in ticket was consumed by the real
sign-in page, and the user was deleted afterward. The temporary user was
linked to the seeded local library by email.

Desktop 1280×800:

- Clerk sign-in ticket established a session and redirected out of `/sign-in`.
- Library rendered the seeded private videos.
- Hovering the ready card mounted `<video src="/api/preview/1">`; playback
  started (`paused=false`, `currentTime>0`, `readyState=4`).
- `GET /api/preview/1` returned `200 video/mp4`; `GET /api/preview/1/meta`
  returned `status=ready` with `hover.url`.
- `/account/settings` rendered live preview statistics: “1 of 3 previews
  ready”, Completed 1, Missing 2, Failed 0.
- No uncaught browser console errors.

Responsive 390×844 (touch emulation, same authenticated storage state):

- Library rendered with no horizontal overflow (0 px).

Screenshots captured locally:
`/tmp/opencode/phase51-library-desktop.png`,
`/tmp/opencode/phase51-settings-desktop.png`,
`/tmp/opencode/phase51-library-mobile.png`.

**Native touch-device hover behavior is NOT TESTED**; the mobile check covers
responsive rendering, not a physical touch-device preview matrix.

---

## 11. Remaining limitations / NOT TESTED

| Area | Status | Reason |
| --- | --- | --- |
| Real MEGA login/session/acquisition | **NOT TESTED** | No MEGA credentials in this environment; simulation uses a local fixture and MEGA deps throw if touched |
| Real MEGA preview sizes/bitrates/transfer times | **NOT TESTED** | Same |
| Production Render ephemeral filesystem (lost previews on deploy) | **NOT TESTED** | Local disk only; missing-artifact requeue logic is unit/integration tested |
| Multi-process / multi-host worker contention | **NOT TESTED** | 8 worker loops ran in one process; PostgreSQL `SKIP LOCKED` semantics are covered by integration tests |
| Native mobile touch preview | **NOT TESTED** | Responsive rendering only; no physical touch-device matrix |
| Turbopack production build | **NOT TESTED** | Worktree symlink layout is rejected by Turbopack; webpack build passed |
| Real unknown-duration MPEG-TS at scale | **NOT TESTED** | Unit tests cover the fraction/alignment path; simulation's null-duration rows were MP4 |

Operational note: the 400-video simulation proves bounded queue behavior,
not production sizing. Real MEGA latency and real bitrates will determine
actual throughput and cache pressure.

---

## 12. Commits

| Commit | Description |
| --- | --- |
| `c4de4ff` | `feat(previews): separate claims, attempts and recoveries; cache dashboard stats` |
| `31df72a` | `feat(previews): abortable jobs, absolute deadlines and reliable duration fallback` |
| `db20217` | `fix(build): keep API route modules to Next's route export surface` |
| `70023ad` | `test(previews): pin remediation contracts and add 400-video simulation` |
| branch tip | Documentation commit containing this report |

The integration branch and its merge commit are documented separately in
`docs/PHASE-5-1-INTEGRATION-REPORT.md`.

---

## 13. Reproduction commands

```bash
# Local isolated PostgreSQL (fresh cluster, repo data untouched)
initdb -D /tmp/opencode/pgdata -U postgres --auth=trust
pg_ctl -D /tmp/opencode/pgdata -l /tmp/opencode/pg.log \
  -o "-p 5433 -k /tmp/opencode" start
psql -h /tmp/opencode -p 5433 -U postgres \
  -c "CREATE ROLE megatube LOGIN PASSWORD 'megatube-dev-only' CREATEDB;" \
  -c "CREATE DATABASE megatube OWNER megatube;"

# Tests
DATABASE_URL='postgresql://megatube:megatube-dev-only@localhost:5433/megatube?schema=public' \
  npm run test:unit
DATABASE_URL='postgresql://megatube:megatube-dev-only@localhost:5433/megatube?schema=public' \
  npm run test:integration

# Type-check + production build (webpack avoids the worktree symlink limit)
npx tsc --noEmit
DATABASE_URL='postgresql://megatube:megatube-dev-only@localhost:5433/megatube?schema=public' \
  npx next build --webpack
```

---

## 14. Conclusion

The audited Phase 5.1 reliability gaps are remediated and covered by tests.
The 400-video simulation demonstrates bounded concurrency, clean accounting,
and effective stats caching under a completion storm. The remaining risk is
concentrated where local validation cannot reach: real MEGA behavior,
production ephemeral storage, multi-process contention, and touch-device
preview UX. Those are explicitly marked NOT TESTED rather than inferred from
unit tests.
