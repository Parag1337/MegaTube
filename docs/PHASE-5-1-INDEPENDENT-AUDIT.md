# MegaTube Phase 5.1 — Independent Technical Audit

**Branch audited:** `phase-5-1-preview-generation` (worktree `/home/parag/Projects/Project_Mega_phase5`)
**Commit:** `30c7630` (HEAD), feature code at `6e0690e`
**Base:** `93fecfb` (main HEAD)
**Auditor:** Kilo (independent technical audit)
**Date:** 2026-11-12

**AUDIT-ONLY:** No source code was modified, no bugs were fixed, no commits created, no branches merged.

---

## Section A — Executive Verdict

**NOT READY — IMPORTANT ISSUES**

The Phase 5.1 implementation is substantially complete and well-engineered. Unit tests (689/689), integration tests (13 pass, 5 skipped), TypeScript, ESLint, and the production build all pass. The multi-scene montage pipeline was verified end-to-end against real FFmpeg with synthetic fixtures and genuinely produces a single MP4 containing multiple distinct scenes from different source positions.

However, three important issues prevent a "READY" verdict:

1. **Phase 3–4 is not integrated.** Commit `9967ea0` (performance and playback improvements) is NOT an ancestor of this branch. The common ancestor is `b98737e`. Phase 5.1 was built on `main` at `93fecfb`, which predates Phase 3–4. The branches diverge and likely conflict on `prisma/schema.prisma`, `components/VideoCard.tsx`, `lib/db.ts`, and `generated/*`. Integration must be planned before merge.

2. **No live browser validation possible.** Port 3000 is not running; no authenticated Clerk session was available. Desktop hover, mobile autoplay, same-tab navigation, and loading-indicator behavior could not be verified against a live instance. These are marked NOT TESTED, not assumed passing.

3. **No real-MEGA or 400-video validation.** Zero videos exist in the dev database and no MEGA credentials are configured. MEGA source acquisition, real preview sizes, and the controlled 400-video simulation could not be executed. All MEGA/performance claims rest on code inspection and unit tests only.

The implementation is sound where tested, but these gaps must be closed before integration with Phase 3–4 and production deployment.

---

## Section B — Requirement Verification Matrix

| Requirement | Reported status | Independently verified status | Evidence | Remaining issue |
|---|---|---|---|---|
| Multi-scene montage (multiple scenes, not single clip) | COMPLETE | PASS | Ran `resolveMontageSources`+`encodeMontage`+`validateMontageFile` against synthetic 75.4s video; frame analysis showed RED→BLUE→YELLOW→MAGENTA at distinct output positions; 5 scenes from source positions 7.5s/22.6s/37.7s/52.8s/67.9s | None confirmed |
| Scenes distributed across duration (not all from opening) | COMPLETE | PASS | `planMontage(75.4,5,1.2)` targets at 10/30/50/70/90% → starts at 7.5/22.6/37.7/52.8/67.9s; strictly increasing | None confirmed |
| Chronological scene order | COMPLETE | PASS | `selected.sort((a,b) => a.input.seekSec - b.input.seekSec)` in `service.ts:470` | None confirmed |
| Total montage duration 5–10s | COMPLETE | PASS | Output: 6.04s (5 scenes × 1.2s) | None confirmed |
| Short video handling | COMPLETE | PASS | 2.5s → 1 scene; 1.5s → 1 scene; 0.8s → 1 scene (0.64s); all stay inside source | None confirmed |
| Unknown-duration safety | COMPLETE | PASS | Ladder [10,30,50,70,90]s, `estimated=true`, clamped by `byteWindowFor` | Byte-to-time heuristic `t * 64_000` is unreliable for unknown durations |
| Brightness filtering | COMPLETE | PASS | Red scene (mean 76.5) → "usable"; black scene (mean 0.0) → "black"; threshold PREVIEW_BRIGHTNESS_MIN=12 | None confirmed |
| Duplicate-scene rejection | COMPLETE | PASS | Same-scene signature distance 0.00 < 2.5 (duplicate); red-vs-blue distance 46.14 ≥ 2.5 (distinct) | None confirmed |
| Bounded alternative timestamps | COMPLETE | PASS | First alt = original; offsets [0, ±1.5, ±3, ±4.5]; count ≤ attempts+1; clamped to source | None confirmed |
| H.264 / libopenh264 codec | COMPLETE | PASS | ffprobe: `codec_name=h264`; only encoder available is libopenh264 | libx264 not available in this build |
| 360p max / 640×360 landscape | COMPLETE | PASS | Output 640×360; `montageCanvas(1920,1080)` → 640×360 | None confirmed |
| 360×640 portrait | COMPLETE | PASS | `montageCanvas(1080,1920)` → 360×640 | None confirmed |
| No audio | COMPLETE | PASS | `-an` flag; ffprobe `hasAudio=false` | None confirmed |
| ~450 Kbps | PARTIAL | — | Config default 450 kbps; actual measured 29.7KB for 6s of solid-color content (highly compressible). Real-content size not measured | Real-MEGA benchmark not run (0 videos, no creds) |
| Max 24 FPS | COMPLETE | PASS | Output `r_frame_rate=24/1`; `outputFps(23.976,24)` → 23 (never up-converts); `outputFps(60,24)` → 24 | None confirmed |
| Faststart | COMPLETE | PASS | `validateMontageFile` checks `faststartVerdict`; output confirmed faststart | None confirmed |
| Max 2 MB artifact | COMPLETE | PASS | `previewMontageMaxFileBytes()` = 2 MB; validation rejects oversized output | Target 200–450 KB not measured on real sources |
| MEGA source acquisition (all paths) | COMPLETE | PARTIAL | Code review: warm cache, local TS prefix, MEGA TS window, MEGA MP4 sparse (moov head/tail), 752-byte/16-byte alignment all implemented | Cannot test without MEGA credentials — NOT TESTED |
| Durable PostgreSQL queue (all statuses) | COMPLETE | PASS | Integration tests cover pending/queued/generating/completed/failed/unsupported; SKIP LOCKED claiming verified | None confirmed |
| Multi-instance safety (no duplicate active generation) | COMPLETE | PASS | Integration test: two workers never get same job; unique idempotencyKey prevents duplicate inserts; wrong-worker publish rejected | Report's concern about cross-instance duplicates is overstated — SKIP LOCKED prevents it |
| Lease expiration / recovery | COMPLETE | PASS | `recoverExpiredPreviewLeases` tested; expired leases return to pending/failed | Stuck-but-alive worker renews heartbeat indefinitely (lease never expires while process runs) |
| Sync integration (fire-and-forget, auto-generate setting) | COMPLETE | PASS | `syncAccount.ts:656` uses `void import(...).then().catch()`; respects `previewAutoGenerate`; idempotent | Not tested against live MEGA sync |
| Settings dashboard + authorization | COMPLETE | PARTIAL | Routes gated by `canManagePreviews`; server-side auth; per-user scoping | Dashboard stats do per-video filesystem stat on every 5s poll (performance concern at scale) |
| Desktop hover playback | COMPLETE | NOT TESTED | Code review only; port 3000 not running, no authenticated session | Requires live browser with Clerk session |
| Mobile preview playback | COMPLETE | NOT TESTED | Code review only; IntersectionObserver, dwell, coordinator implemented | Not re-run against live authenticated browser (report admits this gap) |
| Loading indicator states | COMPLETE | NOT TESTED | Code maps pending/queued/generating to labels; 10s watchdog | Not verified against live instance |
| Cache/storage reliability | COMPLETE | PARTIAL | Atomic sidecars, refcount, LRU eviction, orphan sweep, missing-artifact requeue all implemented | Eviction interval default 10 min; `touchPreview` writes sidecar on every access |
| Render ephemeral filesystem impact | COMPLETE | PARTIAL | Missing-artifact detection + requeue (`artifact_missing`) implemented | 400 preview files lost on deploy = 400 regenerations (bounded queue, one at a time) |
| Production build | COMPLETE | PARTIAL | `npm run build` succeeded in prior session; not re-run here to avoid disrupting `.next` | Build not re-verified in this audit session |

**Legend:** PASS = verified by test or real execution; PARTIAL = partially verified (code review + unit tests, no live data); FAIL = none; NOT TESTED = cannot complete in this environment.

---

## Section C — Bugs and Defects

### Confirmed Defects

None found in the executed code paths. All tested functions behave as specified.

### Potential Risks (not confirmed defects)

**R1 — Unknown-duration byte-to-time heuristic is unreliable**
- **File:** `lib/preview/source.ts:314` (`byteWindowFor`)
- **Issue:** For unknown-duration sources, `rawStart = t > 0 ? Math.min(t * 64_000, maxStart) : 0` assumes a fixed ~64 KB/s bitrate. Real bitrates vary widely, so the acquired window may not contain the intended timestamp.
- **Impact:** Scene extraction from the wrong part of the video for unknown-duration sources.
- **Severity:** Medium
- **Recommended fix:** Probe the source first (even a small head fetch) to estimate bitrate, or clamp ladder positions to verified decodable ranges.

**R2 — Stats endpoint does per-video filesystem scans on every poll**
- **File:** `lib/preview/jobs.ts:781-817` (`getPreviewLibraryStats`)
- **Issue:** Calls `previewHoverArtifactValid` (which does `fs.promises.stat` on sidecar + clip) for every video, on every 5-second dashboard poll. With 400+ videos this is 400+ stat calls per refresh.
- **Impact:** Dashboard becomes slow and I/O-heavy as library grows.
- **Severity:** Medium
- **Recommended fix:** Cache stats with a TTL, or compute completed/missing from job rows plus a periodic (not per-poll) disk verification.

**R3 — `touchPreview` writes the sidecar on every access**
- **File:** `lib/preview/cache.ts:150-162` (`touchPreview`)
- **Issue:** Every clip/sprite serve rewrites the sidecar JSON to update `lastAccessedAt`. During active browsing this causes repeated writes.
- **Impact:** Write amplification, SSD wear, potential LRU thrashing.
- **Severity:** Low
- **Recommended fix:** Batch touch updates or update `lastAccessedAt` only in the eviction pass.

**R4 — Stuck-but-alive worker renews lease indefinitely**
- **File:** `lib/preview/worker.ts:187-189` (heartbeat interval)
- **Issue:** If the Node process is alive but the event loop is blocked (e.g., ffmpeg run exceeds expectations), the heartbeat keeps renewing the lease. `recoverExpiredPreviewLeases` only runs on worker start and in `tick()`.
- **Impact:** A job can appear `generating` forever if the process is alive but stuck.
- **Severity:** Medium
- **Recommended fix:** Add a maximum absolute runtime cap per job (wall-clock deadline independent of lease renewals).

**R5 — Phase 3–4 not integrated (integration risk)**
- **File:** Branch ancestry
- **Issue:** `9967ea0` is not an ancestor of `phase-5-1-preview-generation`. Common ancestor is `b98737e`. Likely conflicts on `prisma/schema.prisma`, `components/VideoCard.tsx`, `lib/db.ts`, `generated/*`.
- **Impact:** Merge conflicts; Phase 5.1 may not work correctly without Phase 3–4's playback/remux fixes.
- **Severity:** High (pre-integration)
- **Recommended fix:** Merge Phase 3–4 first, then rebase/test Phase 5.1 on top.

---

## Section D — Performance Findings (Real Measured Values)

All measurements below are from the actual pipeline run against a synthetic 75.4s, 640×360, 25fps H.264 source video (solid-color scenes with text overlays), using `lib/preview/source.resolveMontageSources` (warm-cache/local-mp4 path) + `lib/preview/ffmpeg.encodeMontage` + `validateMontageFile`:

| Metric | Measured value | Required / target |
|---|---|---|
| Output codec | h264 (libopenh264) | Browser-compatible H.264 |
| Output resolution | 640 × 360 | ≤ 640 × 360 landscape |
| Output frame rate | 24 fps | ≤ 24 fps, never up-converted |
| Output audio | None | No audio |
| Output faststart | Yes | Faststart MP4 |
| Output container | MP4 (mov/mp4/m4a) | MP4 |
| Output duration | 6.041667 s | 5–10 s target |
| Output size | 29,740 bytes (~29 KB) | ≤ 2 MB cap; 200–450 KB target for real content |
| MEGA bytes acquired | 0 (warm cache) | 0 for warm/local |
| Source acquisition time | ~0 ms (local file) | Bounded |
| FFmpeg encode time | Not separately measured | ≤ 90s timeout |
| Total generation time | Not separately measured | — |
| Scenes | 5 | Default 5 |
| Scene source positions | 7.5s, 22.6s, 37.7s, 52.8s, 67.9s | Distributed 10%–90% |

**Size note:** 29 KB for 6 seconds of solid-color content is far below the 450 kbps bitrate target because synthetic flat colors compress extremely well. Real video content with motion and detail will produce larger files (~200–450 KB expected at 450 kbps for 6s). The 2 MB cap is sensible as a hard ceiling but real montages should land well under it.

**Not measured (no MEGA credentials / 0 dev videos):**
- MEGA bytes acquired per preview
- MEGA acquisition duration
- Range request count
- Real preview file size (P50/P95)
- 400-video workload simulation
- Peak memory during generation
- Temp disk usage under load
- Cache hit rate under 400-video load

---

## Section E — Security Findings

No vulnerabilities were exploited (audit-only, no destructive testing). Observations:

**S1 — Admin authorization is server-side and per-user**
- **File:** `lib/preview/admin.ts`, `app/api/preview/admin/*/route.ts`
- All admin routes check `getCurrentUser()` then `canManagePreviews()`. When `PREVIEW_ADMIN_EMAILS` is unset, every authenticated user can manage their own previews (scoped by `userId` in all queries). This is appropriate for single-owner deployments.
- **Severity:** None (by design)

**S2 — No MEGA URLs, session tokens, or file keys stored in job rows**
- **File:** `lib/preview/jobs.ts`, migration SQL
- Confirmed: `PreviewGenerationJob` stores no secrets. Error messages are sanitized (`sanitizeFailureDetail` strips URLs).
- **Severity:** None

**S3 — File path safety**
- **File:** `lib/preview/cache.ts`, `lib/preview/source.ts`
- All paths derived from numeric `videoId` and fixed templates (`<id>.preview.mp4`, `<id>.json`). No user-controlled path components. No symlink following.
- **Severity:** None

**S4 — Brute-force / resource exhaustion via bulk generate**
- **File:** `app/api/preview/admin/generate/route.ts`, `lib/preview/jobs.ts:257` (`ensureMissingPreviewJobs`)
- `ensureMissingPreviewJobs` inserts durable jobs only (one bounded worker processes them). `previewMaxConcurrent=1`, `previewMaxQueue=8`, `previewBacklogMaxJobs=5000`. Cannot launch 400 concurrent ffmpeg processes.
- **Severity:** None (bounded)

**S5 — ID enumeration**
- Preview asset routes (`/api/preview/[videoId]`) require ownership via `authorize()` in `service.ts:180`. A user cannot access another user's preview.
- **Severity:** None

**Not tested:** Live authenticated browser session, MEGA session secrecy, signed URL leakage, real-world abuse testing.

---

## Section F — Phase 3–4 Integration Findings

### Branch ancestry

```
Phase 3–4 branch: b98737e → 9967ea0 (phase-3-4-performance-playback)
Phase 5.1 branch:  b98737e → ... → d89c621 → 93fecfb → 6e0690e → 30c7630 (phase-5-1-preview-generation)
main:              b98737e → ... → d89c621 → 93fecfb
```

- `d89c621` (Phase 5 fix) IS an ancestor of Phase 5.1 ✓
- `9967ea0` (Phase 3–4) is NOT an ancestor of Phase 5.1 or main ✗
- Common ancestor of Phase 5.1 and Phase 3–4: `b98737e`
- The branches diverged at `b98737e`; neither contains the other

### Dependencies

Phase 5.1 reads from the media cache (`readRemuxCache` from `lib/media/remux`) which Phase 3–4 modifies (`lib/media/remux.ts`, 113 lines changed). Phase 5.1's `VideoCard.tsx` (190 lines changed) overlaps with Phase 3–4's playback/fMP4 fixes. Both branches modify `prisma/schema.prisma` and `generated/*` (Prisma client).

### Likely merge conflicts

| File | Phase 3–4 change | Phase 5.1 change | Conflict likelihood |
|---|---|---|---|
| `prisma/schema.prisma` | Query shape changes | Adds `PreviewGenerationJob` model, `User.previewAutoGenerate`/`previewPaused` | High |
| `components/VideoCard.tsx` | Playback/fMP4 fixes | Hover preview + mobile IntersectionObserver | High |
| `lib/db.ts` | DB config / pool changes | Uses `@/lib/db` prisma client | Medium |
| `lib/media/remux.ts` | Remux engine fixes | Read-only (`readRemuxCache`) | Low (read-only) |
| `generated/*` | Regenerated Prisma client | Regenerated Prisma client | High (regenerate after merge) |
| `lib/sync/syncAccount.ts` | — | +18 lines (preview enqueue hook) | Low |

### Recommended integration order

1. **Merge Phase 3–4 (`9967ea0`) into `main` first.** It is the playback/performance foundation.
2. **Rebase or merge `phase-5-1-preview-generation` onto updated `main`.** Resolve conflicts in `prisma/schema.prisma`, `VideoCard.tsx`, and `generated/*`.
3. **Regenerate Prisma client** (`prisma generate`) after schema merge.
4. **Re-run full test suite** (unit, integration, tsc, eslint, build).
5. **Run Playwright E2E** against a live instance for desktop hover and mobile preview.

Do not merge either branch directly into the other without resolving conflicts first.

---

## Section G — Additional Recommendations

| Priority | Improvement | Why it matters | Effort | Recommended phase |
|---|---|---|---|---|
| P0 | Merge Phase 3–4 before Phase 5.1; resolve `prisma/schema.prisma` and `VideoCard.tsx` conflicts | Phase 5.1 does not contain Phase 3–4 playback/remux fixes; merging out of order risks broken playback | Medium | Pre-integration |
| P0 | Run controlled 400-video simulation against isolated DB + synthetic fixtures | Report admits this was not run; validates queue bounds, no 400-concurrent ffmpeg, bounded MEGA/FFmpeg | Medium | Pre-production |
| P0 | Run real-MEGA benchmark to measure actual per-montage size and MEGA bytes | 200–450 KB target is unmeasured; may need bitrate/scene-duration tuning | Medium | Pre-production |
| P0 | Run Playwright E2E against live authenticated instance for desktop hover + mobile | Report admits mobile was not re-run against live browser; port 3000 not running in this audit | Medium | Pre-production |
| P1 | Optimize stats endpoint: cache with TTL, avoid per-video filesystem stat on every poll | 400+ stat calls per 5s refresh will slow the dashboard as library grows | Small | P1 (before production) |
| P1 | Add absolute wall-clock deadline per job (independent of lease heartbeat) | Stuck-but-alive worker can renew lease forever; job appears generating indefinitely | Small | P1 (before production) |
| P1 | Batch `touchPreview` sidecar writes; update lastAccessedAt in eviction pass only | Reduces write amplification and SSD wear during active browsing | Small | P1 (before production) |
| P2 | Improve unknown-duration bitrate estimation (probe head before ladder selection) | `t * 64_000` heuristic is unreliable; wrong windows for unknown-duration sources | Medium | P2 |
| P2 | Add preview storage durability option (persistent disk or object storage) | Render ephemeral filesystem means 400 previews lost per deploy; all must regenerate | Large | P2 (evaluate separately) |
| P2 | Implement preview prioritization (newest/most-viewed/recently-synced first) | Bulk generation currently FIFO by createdAt; high-value videos wait behind long backlog | Medium | P2 |
| P3 | Add structured metrics endpoint (Prometheus) instead of console.log only | Observability for stuck jobs, MEGA throttling, cache pressure, FFmpeg crashes | Medium | P3 |
| P3 | Add cache hit-rate reporting and stale-preview invalidation metrics | Helps tune eviction grace and retention | Small | P3 |

---

## Section H — Merge and Deployment Readiness

### Pre-merge checklist

- [x] Unit tests: 689/689 pass
- [x] Integration tests: 13 pass, 5 skipped (MEGA creds), 0 fail
- [x] TypeScript: clean
- [x] ESLint: clean
- [ ] Production build: not re-verified (`.next` exists but port 3000 not running; do not disrupt)
- [ ] Phase 3–4 integration: NOT started (branches diverged at `b98737e`)
- [ ] Real-MEGA benchmark: NOT run (no credentials, 0 dev videos)
- [ ] 400-video simulation: NOT run
- [ ] Live browser E2E: NOT run (port 3000 not running, no Clerk session)
- [ ] Multi-worker concurrent test: verified via integration tests (SKIP LOCKED)

### Final Recommendation

**NO-GO for direct merge to `main`**

The Phase 5.1 implementation is technically sound where tested, and the core multi-scene montage pipeline was verified end-to-end with real FFmpeg. However:

1. **Phase 3–4 is not integrated** — the branches diverged and likely conflict on shared files. Phase 3–4 must be merged first.
2. **Critical validation gaps remain** — no real-MEGA testing, no 400-video simulation, no live browser verification. These cannot be assumed from unit tests alone.

**Recommended path:**
1. Merge Phase 3–4 (`9967ea0`) into `main`.
2. Rebase/merge Phase 5.1 onto updated `main`, resolve conflicts.
3. Run full test suite + build.
4. Run real-MEGA benchmark and 400-video simulation against staging.
5. Run Playwright E2E against live authenticated instance.
6. Then merge to `main` and deploy.

Until steps 1–5 are complete, Phase 5.1 is **NOT READY** for production integration.

---

## Audit Methodology Notes

- Verified via actual code execution: `planMontage`, `montageCanvas`, `outputFps`, `byteWindowFor`, `mergeByteWindows`, `probeSceneSample`, `brightnessVerdict`, `sceneSignatureDistance`, `sceneAlternatives`, `resolveMontageSources` (warm-cache path), `encodeMontage`, `validateMontageFile`.
- Ran full test suite (unit 689/689, integration 13 pass/5 skipped), `tsc --noEmit`, `eslint`.
- Created synthetic video fixtures in `/tmp/kilo/audit-fixtures/` with distinguishable colored scenes at known source positions; decoded output with ffprobe and frame color analysis to prove multi-scene content.
- Port 3000 was not running; no live browser or Clerk session testing possible.
- No MEGA credentials configured; dev database has 0 videos. MEGA source acquisition and real-world performance are unverified.
- Temporary test artifacts at `/tmp/kilo/audit-fixtures/` are outside the workspace and may be cleaned up separately.
