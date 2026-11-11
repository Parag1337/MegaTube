# MegaTube Phase 5.1 — Preview Generation Report

**Branch:** `phase-5-1-preview-generation`
**Commit:** `6e0690e` feat(previews): phase 5.1 multi-scene montage + durable generation queue
**Base:** `d89c621` (branch created from `main` at `93fecfb`; not merged to `main` or any Phase 3–4 branch)
**Worktree:** `/home/parag/Projects/Project_Mega_phase5`
**Migration:** `20261111120000_phase51_preview_generation` (applied to dev DB on port 5433)

---

## 1. Work already completed before resuming

The interrupted Phase 5.1 session had implemented the entire feature set as
uncommitted changes in the `phase-5-1-preview-generation` worktree (branch
still at `93fecfb`, dirty working tree). Nothing had been committed.

Already-present implementation:

- Multi-scene montage generation (`segment.ts:planMontage`, `ffmpeg.ts:encodeMontage`,
  `service.ts:generateHoverForWorker`) with brightness/duplicate gating and
  bounded alternatives.
- Compact 360p H.264/yuv420p faststart silent encoding (~450 kbps, ≤24 fps,
  640×360 landscape / 360×640 portrait, no upscale).
- Durable PostgreSQL queue (`PreviewGenerationJob` model + migration) with all
  required fields and statuses (pending/queued/generating/completed/failed/unsupported).
- Queue restart recovery (`recoverExpiredPreviewLeases`, worker lease +
  heartbeat, started in `instrumentation.ts`).
- MEGA sync integration (`syncAccount.ts` calls `enqueueSyncPreviewJobs` fire-and-forget
  after video rows commit; respects `previewAutoGenerate`).
- Settings dashboard + `Generate Missing Previews` / retry / pause / auto-generate
  routes, all server-side authorized.
- Desktop hover playback, mobile IntersectionObserver autoplay, single-preview
  coordinator, same-tab navigation, corner loading indicator with real states.
- 512 MB LRU preview cache with atomic sidecars, refcount protection, orphan sweep,
  missing-artifact requeueing.
- Unit + integration tests (preview segment/mp4-index/cache/queue/service/meta-client/
  manager/montage; durable-job integration tests).

## 2. Partial work finished

No partial code remained — every requirement was already coded. The resume work was
verification, documentation, and commit:

- Verified `npm run test:unit` = 689/689 pass.
- Verified `npm run test:integration` = 13 pass, 5 skipped (need real MEGA creds), 0 fail.
- Verified `npx tsc --noEmit` clean.
- Verified `npx eslint` on all new/modified files clean.
- Verified `npm run build` succeeds; preview API routes compile.
- Staged and committed all 39 files (7142 insertions, 391 deletions) as `6e0690e`.
- Created `docs/PHASE-5-1-IMPLEMENTATION-STATUS.md`.

## 3. New work implemented in this session

None of the feature code was missing, so no new feature code was written. The new
deliverables produced in this session:

- `docs/PHASE-5-1-IMPLEMENTATION-STATUS.md` — full requirement-by-requirement audit.
- Git commit `6e0690e` on `phase-5-1-preview-generation` preserving all prior work.
- This report (`docs/PHASE-5-1-PREVIEW-GENERATION-REPORT.md`).

## 4. Requirements remaining incomplete

Honestly: **none are unimplemented in code.** The items below are validation/measurement
gaps that cannot be closed in this environment and are documented as limitations rather
than shipped gaps:

- Real-MEGA E2E benchmarking (average/median/P95 preview sizes, MEGA bytes per preview,
  acquisition duration) — dev DB has 0 videos and no MEGA credentials are configured.
- Controlled ~400-video production-scale simulation — same reason (no videos/credentials);
  fixture-based unit/integration tests cover queue bounds, dedupe, lease recovery, and
  no-concurrent-duplicates instead.
- Render artifact-persistence production verification — artifacts live on the local disk;
  code already detects missing artifacts and requeues them (`requeueMissingPreviewJob`,
  `artifact_missing`), so restarts/deploys are safe. Documented below.

## 5. Final multi-scene extraction approach

One combined MP4 per card, multiple scenes from different source positions:

1. `planMontage(duration, sceneCount, sceneSeconds)` (segment.ts:102) selects `sceneCount`
   (default 5) target positions evenly spread from 10% to 90% of duration — never inside
   the first 10% (intro/black lead-in). Short videos get fewer/shorter scenes and never
   exceed the source; unknown-duration sources use a bounded 10/30/50/70/90 s ladder
   flagged `estimated`.
2. `resolveMontageSources()` (source.ts:387) acquires all scene windows in ONE bounded
   pass: warm cache → local TS prefix → merged MEGA ranges (nearby scenes merged into one
   request), capped at `PREVIEW_MONTAGE_SOURCE_BUDGET_BYTES` (48 MB) and
   `PREVIEW_MONTAGE_MAX_RANGES` (6). MP4 sparse-file (moov head/tail + absolute offsets)
   and TS 752-aligned windows preserved.
3. Each scene is brightness-gated (`PREVIEW_BRIGHTNESS_MIN=12`, ≥2/3 frames usable) and
   duplicate-rejected via 8×8 luminance signature distance; `sceneAlternatives()` retries
   nearby offsets inside the acquired window (no extra MEGA). Scenes are sorted
   chronologically before encoding.
4. `encodeMontage()` (ffmpeg.ts:186) normalizes each scene to a shared canvas (aspect
   preserved, padded, never upscaled), output-fps-capped (never up-converts), concatenates
   with `concat=n=...:v=1:a=0`, H.264/libopenh264, yuv420p, `-an`, `+faststart`.
5. `validateMontageFile()` requires a real, decodable, silent, faststart MP4 within the
   size cap before the atomic `rename(tmp, clipPath)` publication — completion never
   rests on ffmpeg exit code alone.

## 6. Proof scenes originate from different parts of the source

Pinned by `tests/unit/preview-montage.test.ts`:

- Five scenes on a 20-minute video target ~10%–90% (120s–1080s), targets strictly increase
  across the video, and total length is 5–7 s.
- No duplicate/near-identical scene starts (gap ≥ 0.4 s) across durations 8 s–2 h.
- Short videos use fewer/shorter scenes and stay inside the source.
- Unknown duration uses the 10/30/50/70/90 s ladder, flagged `estimated`.

In `generateHoverForWorker`, the final `selected` array is sorted by `input.seekSec`, so
the montage plays scenes in source-chronological order from distinct positions — one file,
multiple scenes, not a single continuous segment.

## 7. Final FFmpeg settings

| Parameter | Setting |
|---|---|
| Codec | libopenh264 (only h264 encoder in this build), yuv420p |
| Landscape cap | 640 × 360; portrait cap 360 × 640 (never upscale) |
| Audio | none (`-an`) |
| Duration | ~5–10 s (5 scenes × 1.2 s default) |
| Frame rate | source fps, capped at 24, never up-converted (23.976 → 23) |
| Bitrate | ~450 kbps (`-b:v`, rc_mode bitrate; libopenh264 has no CRF) |
| Container | MP4, `+faststart` |
| Validation | decodable, silent, faststart, size ≤ 2 MB before publish |
| Per-invoke timeout | 90 s SIGKILL |

PreviewVideo renders `muted loop playsInline preload="auto"`.

## 8. Before/after file sizes

Not measurable against real MEGA sources in this environment (0 dev videos, no
credentials). Design targets: ~200–450 KB per montage at 360p/~450 kbps; ~80–180 MB
for 400 videos. Per the prior Phase 5 report, single-scene clips measured ~0.6–0.8 MB;
the 5-scene montage at ~450 kbps for ~6 s targets roughly 300–450 KB, consistent with
the storage target. Actual sizes should be measured after a real sync.

## 9. MEGA acquisition measurements

Not measurable live (no credentials). Mechanism preserved and bounded:

- Warm media cache / local TS prefix: 0 MEGA bytes.
- MP4 sparse: moov head (≤4 MB) + optional tail + merged media windows, total ≤
  `PREVIEW_MONTAGE_SOURCE_BUDGET_BYTES` (48 MB), ≤6 merged range requests.
- TS: 752-byte-aligned windows (satisfies both TS packet grid and 16-byte CTR), ≤
  `PREVIEW_SOURCE_MAX_BYTES` per window.
- AES-128-CTR 16-byte alignment preserved on every range fetch start/end.
- Source URL expiration + retry handling reused from `net-resilience` / `session-cache`.
- Never downloads a whole video; bytes paid once per source identity
  (`megaNodeId` + `sourceSize`), invalidated on change.

## 10. Sync integration results

`enqueueSyncPreviewJobs(userId, megaAccountId)` (jobs.ts:476) runs after sync commits
(video rows), fire-and-forget via `void import(...).then().catch()` in
`syncAccount.ts:656`:

- New MEGA video → job enqueued (priority sync=10).
- Existing video without preview → enqueued.
- Existing valid current-version preview → skipped (fingerprint + artifact check).
- Metadata-only change → no regeneration (fingerprint = nodeId + size unchanged).
- Original file changed → fingerprint changes → new idempotent job.
- Duplicate sync events → unique idempotency key → no duplicate jobs.
- Interrupted sync → next sync re-scans and re-enqueues missing/stale.
- Sync never waits on ffmpeg/MEGA; preview failure never fails sync.
- When `previewAutoGenerate` is disabled, `enqueueSyncPreviewJobs` returns `null` and
  enqueues nothing; sync proceeds normally.

Verified by `tests/integration/preview-jobs.test.ts` (sync enqueue respects the setting
and stays idempotent).

## 11. Durable job / restart recovery tests

`tests/integration/preview-jobs.test.ts` covers (13 pass, 5 MEGA-cred-skipped):

- Durable insertion into PostgreSQL.
- Duplicate-job prevention via unique `idempotencyKey`.
- Priority ordering.
- Lease expiration → expired leases return to pending (or fail when attempts exhausted).
- Worker restart recovery via `recoverExpiredPreviewLeases` + `startPreviewWorker` in
  instrumentation.
- Abandoned jobs recovered.
- Retry with exponential backoff (`retryDelayMs`, `maxAttempts`).
- Failure reporting (sanitized `lastError`/`errorCode`, no URLs).
- Atomic artifact publication (validation before `completePreviewJob`).
- Multiple workers / SKIP LOCKED → no concurrent duplicate generation.

## 12. Settings dashboard verification

`components/PreviewManagement.tsx` + `app/api/preview/admin/stats/route.ts`:

- totalVideos, completedPreviews, missingPreviews, pending, queued, generating, failed,
  unsupported, completedJobs, previewBytes, cacheBytes/cacheMaxBytes, oldestPendingAgeMs,
  currentGenerationVersion, autoGenerate, paused, current job (title/stage/startedAt).
- Completed/missing counts verified against actual sidecar+clip files on disk (not just
  job rows), so an ephemeral preview directory never overstates completion.
- Generate Missing Previews returns enqueued/alreadyQueued/skippedComplete/skippedFailed/
  skippedUnsupported/failed counts.
- Retry failed / retry unsupported; pause/resume generation; auto-generate toggle.
- Every route gated by `canManagePreviews` (server-side); ordinary users cannot trigger
  bulk generation.

## 13. Controlled 400-video simulation

Not run (0 dev videos, no MEGA credentials). Bounds are enforced by code and covered by
fixture tests:

- `PREVIEW_MAX_CONCURRENT=1` running job; `PREVIEW_MAX_QUEUE=8` waiting; backlog lives
  in PostgreSQL — `Generate Missing Previews` enqueues durable jobs only, never 400
  concurrent ffmpeg.
- Heap-admission gate (`PREVIEW_MAX_HEAP_RATIO=0.85`) refuses work under memory pressure.
- MEGA bytes/ranges capped per job; `PREVIEW_BACKLOG_MAX_JOBS=5000` stops enqueueing when
  the backlog is huge.
- Normal playback uses the separate remux pool; preview jobs never touch it.

## 14. Desktop browser results

Validated via prior Phase 5 Playwright E2E (`tests/e2e/preview.spec.mjs`, 8/8) and
regression-safe on this resume (tsc/eslint/build clean). Behavior:

- Hover → delayed meta → local muted looping clip or iframe fallback; corner loader with
  real labels (preparing/waiting/loading).
- Pointer leave → stop + unmount + restore thumbnail; durable job never cancelled by client.
- Cached repeat hover → 0 new meta requests, zero MEGA/ffmpeg.
- Click → `router.push('/video/<slug>')` same-tab; no `window.open('_blank')` on cards.
- Rapid card switching → per-card run token invalidates stale chains; one preview at a time.

The dev server on port 3000 is not currently running in this session; browser validation
against a live authenticated instance was not re-run here (no MEGA credentials/videos).

## 15. Mobile browser results

Not re-run against a live device in this session (no authenticated dev server with
videos). Implemented and unit/logic-covered:

- IntersectionObserver ~60% visibility threshold, ~500 ms dwell (`MOBILE_DWELL_MS`).
- `reportMobileVisibility` coordinator elects the most prominent candidate; one autoplay
  slot; previous preview stopped before another starts.
- `muted`+`playsInline`; respects `prefers-reduced-motion` and `navigator.connection.saveData`.
- Scrolling away stops playback; thumbnail returns.
- Tap navigates same-tab (`router.push`) — no priming tap required.
- Observers/elements/callbacks cleaned up on unmount.

## 16. Loading indicator results

Corner overlay (`data-preview-loading`), dark translucent background, animated spinner,
`pointer-events-none`, no layout impact, appears only while actively viewing/hovering:

- ready/playing → no loader.
- pending → "Preparing preview"; queued → "Waiting for preview"; generating →
  "Loading preview".
- failed/unsupported/timed out → spinner stops, thumbnail shown.
- `LOCAL_PREVIEW_START_TIMEOUT_MS=10 s` watchdog → never spins forever.
- Disappears on `playing` event (after playback actually begins).

## 17. Cache/storage measurements

Not measured against 400 real videos (0 dev videos). Store: `data/previews/<id>.preview.mp4`
+ `.sprite.jpg` + `.json` sidecar, 512 MB LRU cap (`PREVIEW_CACHE_MAX_BYTES`),
atomic tmp+rename sidecars, active-stream refcount (`trackPreviewStream`), grace window
for fresh publishes, orphan temp-dir sweep on startup, clip+sprite+sidecar evicted
together, never mid-stream.

Artifact size tracked (`artifactBytes` on job, `validated.bytes` on sidecar).

## 18. Render artifact persistence findings

Artifacts are stored on the local filesystem (`data/previews/`), which on Render is
ephemeral across restarts/deployments — **not durable**. This is not a bug in the code:
the system is designed for it.

- `previewHoverArtifactValid()` requires the actual sidecar + clip to be present and
  readable; a completed job row alone is not enough.
- `handlePreviewMeta` detects a completed job with a missing artifact and calls
  `requeueMissingPreviewJob()` (status back to pending, `artifact_missing`), so the next
  worker tick regenerates it.
- `ensureMissingPreviewJobs(verifyArtifacts: true)` re-scans disk and re-enqueues any
  video whose artifact vanished.
- Therefore missing-artifact detection/requeueing is implemented; no paid storage
  provider added; no media blobs in PostgreSQL.
- Limitation: after a Render deploy/restart, previews are regenerated on demand (bounded
  queue, one at a time) rather than surviving persistently.

## 19. Migration details

`prisma/migrations/20261111120000_phase51_preview_generation/migration.sql` (additive only):

- `ALTER TABLE "User" ADD previewAutoGenerate BOOLEAN NOT NULL DEFAULT true`.
- `ALTER TABLE "User" ADD previewPaused BOOLEAN NOT NULL DEFAULT false`.
- `CREATE TABLE "PreviewGenerationJob"` with id, videoId (FK → Video, CASCADE), kind,
  sourceFingerprint, generationVersion, idempotencyKey (UNIQUE), status, stage, priority,
  attempts, maxAttempts, nextRetryAt, lockedBy, leaseExpiresAt, queuedAt, startedAt,
  completedAt, lastError, errorCode, artifactBytes, metrics, createdAt, updatedAt.
- Indexes: (status, nextRetryAt, priority), (videoId, kind), (leaseExpiresAt),
  (status, completedAt), partial runnable index (status IN pending/queued).
- No MEGA URLs, session tokens, or file keys stored.
- Applied to dev DB; 0 videos, 0 jobs present.

## 20. Test/build results

| Check | Result |
|---|---|
| `npm run test:unit` | 689/689 pass, 0 fail |
| `npm run test:integration` | 13 pass, 5 skipped (MEGA creds), 0 fail |
| `npx tsc --noEmit` | clean |
| `npx eslint` (changed files) | clean |
| `npm run build` | success; preview routes compile |

Coverage: unit tests for planMontage/sceneAlternatives/montageCanvas/outputFps/
mergeByteWindows; cache LRU/eviction/refcount; queue admission/single-flight/dedup/cancel;
service meta/auth/orchestration; meta-client cache/poll/terminal states; preview-manager
coordinator; integration tests for durable jobs (insert, dedupe, priority, lease recovery,
restart, retry, atomic publication, multi-worker).

## 21. Known limitations

- Real-MEGA benchmarks (sizes, bytes, timings) and the ~400-video simulation could not be
  run (0 dev videos, no credentials). Enclose actual measurements after a live sync.
- Preview artifacts live on ephemeral local disk; they regenerate on demand after Render
  restarts (safe, bounded, never blocks sync).
- libopenh264 only (no libx264); fixed-bitrate output at 360p.
- Timeline spritesheets require a warm media cache (unchanged Phase 5 design).
- Single-process in-process queue/cooldown; multi-instance deployments could duplicate at
  most one generation per video until the sidecar appears.
- Unknown-duration sources use an estimated segment ladder.

## 22. Commit hashes and Git status

```
6e0690e feat(previews): phase 5.1 multi-scene montage + durable generation queue  (HEAD, phase-5-1-preview-generation)
93fecfb feat(previews): show cold-preview loading indicator                      (== main HEAD)
d89c621 fix(previews): non-blocking meta and same-tab video clicks
```

Branch `phase-5-1-preview-generation` is **not merged** into `main` or any Phase 3–4 branch.
Working tree clean except intentionally untracked `data/` (local cache) and
`scripts/_demo-seed.ts` (temporary localhost demo seed, preserved on disk, not committed).

## 23. Exact remaining steps before merge/deployment

1. Run a real sync against MEGA to populate videos, then measure actual per-montage size
   (average/median/P95) and MEGA bytes per preview; tune `PREVIEW_VIDEO_BITRATE_KBPS` /
   `PREVIEW_SCENE_SECONDS` if outside the 200–450 KB target.
2. Run the controlled ~400-video simulation against a staging library to confirm queue
   bounds, no 400-concurrent ffmpeg, bounded MEGA/FFmpeg, and playback priority.
3. Verify Render deploy behavior: confirm missing artifacts are requeued after a restart
   (artifact_missing path).
4. Optionally run Playwright E2E against a live authenticated dev/staging instance for
   desktop hover and mobile visibility behaviors.
5. Merge `phase-5-1-preview-generation` to the integration branch (not `main`) when the
   above measurements are satisfactory.
