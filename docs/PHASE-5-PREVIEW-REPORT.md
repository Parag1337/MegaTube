# Phase 5 — Hover Video Previews + Timeline Thumbnails: Implementation Report

**Branch:** `phase-5-video-previews` (worktree `/home/parag/Projects/Project_Mega_phase5`)
**Base commit:** `b98737e` — not merged to `main`.
**Design:** [`docs/PHASE-5-PREVIEW-DESIGN.md`](./PHASE-5-PREVIEW-DESIGN.md)
**Status:** implemented, unit-tested, and verified end-to-end against MEGA and a real browser. Remaining limitations are listed in §8.

---

## 1. What was built

### Hover preview (card mouse-over)

- A card hover asks `GET /api/preview/<id>/meta?want=hover`.
- If a preview exists, the card mounts a muted, looping local `<video src="/api/preview/<id>">` — 5–10 s of representative content, 360p, ~0.3–0.8 MB.
- If no preview exists yet (or generation is refused), the existing MEGA iframe behavior is untouched.
- Generation is **on-demand and background**: the meta request only enqueues; it never blocks on MEGA/ffmpeg. The client re-polls once after 2.5 s and otherwise keeps the iframe until the next hover.
- The segment is selected away from the intro: 25/50/75 % of a known duration; for unknown durations a fixed ladder starting at 10 s. It must pass the shared mean-brightness gate (≥ 2/3 usable probe frames), with a brightest-best-effort fallback.
- Repeat hovers NEVER regenerate and never contact MEGA: the sidecar answers `ready`, and clip bytes are served with `Cache-Control: private, max-age=3600` + strong `ETag` (304 on revalidation).

### Timeline preview (player scrub thumbnails)

- `GET /api/preview/<id>/meta?want=timeline` reports readiness; when available the player passes `/api/preview/<id>/timeline/vtt` to Vidstack's `DefaultVideoLayout thumbnails` (existing controls and playback pipeline untouched).
- Spritesheet: JPEG grid, 160×90 cells, 10 columns, ≤ 100 cells, interval `max(4 s, duration/100)`; WebVTT cues use `#xywh=` fragments.
- Sprites are generated **only from the warm media cache** (`data/cache-media/<id>.mp4`, 0 extra MEGA bytes). Cold videos answer `timeline: unavailable (source-not-local)` until normal playback warms the cache — by design; downloading ~100 keyframe windows would cost hundreds of MB per video.

### Source acquisition (cheapest first, every path bounded)

1. Warm media cache → 0 MEGA.
2. Local TS acquisition prefix (`<id>.ts.part`, frontier check) → 0 MEGA.
3. MEGA TS window: 752-byte-aligned (188 TS packet × 4 = 16-byte CTR alignment), ≤ `PREVIEW_SOURCE_MAX_BYTES` (24 MB), ffmpeg resyncs at the next keyframe.
4. MEGA MP4 sparse file: moov from the head (faststart) or tail (moov-at-end), ≤ 4 MB per chunk;
   the media window is written at its absolute byte offset alongside the head chunk, so ffmpeg's
   own moov index seeks straight into the present bytes. Moovs in a tail chunk (which starts inside
   `mdat`) are found by a signature scan that validates the mandatory `mvhd` first child.

MEGA bytes are paid **once per video identity** (`megaNodeId` + `sourceSize`); identity changes invalidate the cached assets.

### Bounds and safety

- One queue, **one running job**, up to 8 queued; single-flight per `kind:videoId`; queued jobs cancel when the requester disconnects, running jobs finish.
- A separate queue from the remux pool; preview work cannot occupy playback slots.
- Heap-admission gate (`PREVIEW_MAX_HEAP_RATIO=0.85`) refuses work under memory pressure (`rejected`).
- Per-ffmpeg timeout (90 s, SIGKILL); attempt budget (`PREVIEW_MAX_ATTEMPTS=2` candidate attempts) then a 30 min cooldown recorded in the sidecar.
- Temp work dirs `<id>.tmp-<rand>` with atomic publish (tmp + rename), startup orphan sweep, and LRU eviction (`PREVIEW_CACHE_MAX_BYTES=512 MB`, grace period, refcount-protected stream serving).
- All new routes replicate the thumbnail route's auth matrix: 401/400/404/410/409, JSON errors only.

---

## 2. Changed files

New:

```
app/api/preview/[videoId]/route.ts              clip bytes (Range/ETag/304/416)
app/api/preview/[videoId]/meta/route.ts         meta + enqueue
app/api/preview/[videoId]/timeline/route.ts     sprite JPEG
app/api/preview/[videoId]/timeline/vtt/route.ts WebVTT
components/PreviewVideo.tsx                     hover <video>
lib/preview-meta-client.ts                      page-lifetime meta cache + bounded re-poll
lib/preview/config.ts                           env-tunable bounds
lib/preview/types.ts                            sidecar/meta/source types
lib/preview/segment.ts                          candidate ladder, alignment, sprite/VTT math
lib/preview/mp4-index.ts                        MP4 box walker + validated moov signature scan
lib/preview/cache.ts                            sidecar IO, LRU eviction, refcount, maintenance
lib/preview/source.ts                           warm cache / TS window / sparse MP4 acquisition
lib/preview/ffmpeg.ts                           encode/probe/brightness (libopenh264, discard nokey)
lib/preview/queue.ts                            bounded single-flight queue
lib/preview/service.ts                          meta/auth/orchestration + asset/VTT serving
docs/PHASE-5-PREVIEW-DESIGN.md
docs/PHASE-5-PREVIEW-REPORT.md                  (this file)
tests/unit/preview-segment.test.ts              (9 tests)
tests/unit/preview-mp4-index.test.ts            (11 tests)
tests/unit/preview-cache.test.ts                (9 tests)
tests/unit/preview-queue.test.ts                (7 tests)
tests/unit/preview-service.test.ts             (20 tests)
```

Modified (additive only):

```
components/VideoCard.tsx       local preview with iframe fallback (existing hover path preserved)
components/PrivatePlayer.tsx   thumbnails meta fetch + Vidstack prop (playback untouched)
instrumentation.ts             startPreviewMaintenance() + sweepOrphanWorkDirs()
.gitignore                     /data/previews/*
```

`package-lock.json`, `proxy.ts`, and all Phase 3/4 playback/remux code are unchanged in the committed tree.

---

## 3. API contract

| Endpoint | Behavior |
|---|---|
| `GET /api/preview/[videoId]/meta?want=hover,timeline` | JSON status; enqueues missing generations; `no-store`. Per-asset `generating` / `unavailable (source-not-local)` / `rejected` / cooldown info |
| `GET /api/preview/[videoId]` | clip bytes, `video/mp4`, `Range` (206/416), `ETag` (304), `private, max-age=3600` |
| `GET /api/preview/[videoId]/timeline` | sprite JPEG, same caching semantics |
| `GET /api/preview/[videoId]/timeline/vtt` | WebVTT with one `#xywh=` cue per cell |

Meta response example:

```json
{
  "videoId": 1373,
  "status": "ready",
  "hover": { "url": "/api/preview/1373", "startSec": 10, "durationSec": 7.872,
             "width": 202, "height": 360, "estimated": true },
  "timeline": { "status": "ready", "vtt": "/api/preview/1373/timeline/vtt",
                "sprite": "/api/preview/1373/timeline", "intervalSec": 5, "count": 80 }
}
```

---

## 4. Measurements (live E2E)

Environment: dev server (`next dev`) on localhost, this MEGA connection (~1–1.6 MB/s), FFmpeg 8.1.3 with libopenh264 only.

### Hover generation

| Video | Layout | MEGA bytes | ffmpeg | Clip | Cold trigger→ready |
|---|---|---|---|---|---|
| 1373 — 28.9 MB MP4, DB duration null | faststart sparse (4 MB head + 2 MB window) | **6.0 MB** | 600 ms | 611,431 B, 7.87 s, 202×360 | not cleanly timed (dev compile) |
| 1302 — 31.2 MB MP4, DB duration null | moov-at-end sparse (4 MB head + 4 MB tail + 2 MB window) | **10.0 MB** | 862 ms | 799,621 B, 8.00 s, 204×360 | **11.0 s** |

- Both clips are h264 + AAC, `+faststart`, and start at 10 s (unknown-duration ladder; the brightness gate accepted them). No full-file reads.
- Repeat hover: meta answers `ready` in ~10–20 ms, zero MEGA, zero ffmpeg; clip ETag revalidation returns 304.
- The 11.0 s cold time is dominated by MEGA transfer (10 MB at ~1 MB/s); ffmpeg is < 1 s.

### Timeline generation (video 1373, warm cache)

The warm cache entry for this E2E run was produced by downloading the full plaintext once through the existing media route (`/api/media/1373`), which is the same file the normal playback warm path would produce; no preview code wrote it and no extra MEGA bytes are attributed to preview generation.

| Metric | Result |
|---|---|
| Extra MEGA bytes | **0** |
| ffmpeg wall time | **904 ms** (job), 0.71 s standalone |
| Sprite | 98,991 B, 1600×720 (10 × 8 cells), 80 cells @ 5 s |
| Duration probe | 404.88 s from the warm file (DB duration was null) |
| VTT | 80 cues, correct `#xywh=0,0,160,90` … grid; served `text/vtt` |
| Cold video | `timeline: unavailable (source-not-local)` — no work enqueued |

### FFmpeg resource use (isolated, `/usr/bin/time -v`, 405 s 360p source)

| Operation | Wall | CPU (user+sys) | Peak RSS | Output |
|---|---|---|---|---|
| Hover encode (8 s, 360p, 700 kbps) | 0.49 s | 0.95 s | 94.5 MB | 796,492 B |
| Brightness probe (3 frames, 32×32) | 0.16 s | — | 81.1 MB | — |
| Spritesheet (`-discard nokey`, 80 cells) | 0.71 s | — | 90.8 MB | 99,123 B |

TS window decode was re-validated on a real 60 s MPEG-TS sample: a ~3 MB mid-file window produced an 8 s 640×360 h264+aac clip (298,552 B) in **0.28 s**, resyncing at the next keyframe; the expected libopenh264 mid-stream warnings appear at window start but the output is valid.

### Browser E2E (Playwright/Chromium, real dev server)

- Hover on a search-result card mounts `/api/preview/1373`, muted + loop, playback advances (`currentTime > 0`, `readyState 4`), 203×360.
- Leaving the card unmounts the video (count 0); re-hovering reuses the cached meta — **0 new meta requests** and zero MEGA/ffmpeg.
- Player page fetches `/api/preview/1373/timeline/vtt` → 200 while normal playback streams `/api/media/1373`.
- **Zero console errors**; screenshots captured during the run (not committed).

### Tests and static checks

- `npm run test:unit`: **655/655 pass**, including 56 new preview tests.
- `npx tsc --noEmit`: clean.
- ESLint on every new/modified file: clean.
- HTTP checks: clip 200 / Range 206 / 416 invalid range / ETag 304 / sprite + VTT 200 with correct MIME types.

### Storage footprint

Per generated video: ~0.6–0.8 MB clip + ~97 KB sprite + <1 KB sidecar. At the default 512 MB budget that is roughly 500–700 videos; LRU eviction removes clip + sprite + sidecar together, never while a response is streaming.

---

## 5. Implementation notes / decisions that changed during verification

1. **`-discard nokey`, not `-skip_frame nokey`.** The originally planned flag measured **12.1 s** for an 80-cell sprite of a 405 s video: libopenh264 does not implement decode skipping, so all frames were still decoded. Demuxer-level `-discard nokey` measured **0.84 s** (14× faster) with the same 97 KB output.
2. **Non-faststart sparse files need the head too.** The first implementation wrote only tail + window; ffmpeg reported `moov atom not found` because offset 0 was a hole with no `ftyp`/`mdat` box chain. The head chunk (already fetched) is now written at offset 0; no extra MEGA.
3. **Tail moov detection needs a signature scan.** A tail chunk starts inside `mdat`, so a sequential top-level walker cannot reach the moov. `findMoovInChunk` scans for `moov` and validates the declared size, file bounds, and the mandatory `mvhd` first child; decoy `moov` bytes inside media payloads are rejected. This is what unblocked video 1302.
4. **MEGA CTR alignment.** Both tail-fetch starts and the faststart media-window start are rounded to 16-byte boundaries (tail start down, window start up); misalignment surfaced as `megaDecrypt must be a multiple of 16`.
5. **Stream pipeline import fix.** `pipeline` must come from `node:stream/promises`; importing it from `node:stream` turned the write stream into a callback and failed generation.
6. **Metric fix.** The non-faststart path's `transferBytes` did not count the moov/head fetch; sidecar metrics now report the true bytes.

---

## 6. Failure handling verified live

While hardening, two real failures exercised the retry/cooldown path: the video was attempted twice (`attempts: 2`), `failedAt` was recorded, meta answered `unavailable` without any further MEGA/ffmpeg work, and the sidecar parked the video for the 30 min cooldown (with budget reset afterwards). Missing warm cache for timelines is a state (`source-not-local`), not a failure: it never increments attempts and never parks a video.

---

## 7. Configuration

| Env var | Default | Meaning |
|---|---|---|
| `PREVIEW_DISABLED` | unset | `1` = kill switch; meta answers without work |
| `PREVIEW_MAX_CONCURRENT` | 1 | running generation jobs |
| `PREVIEW_MAX_QUEUE` | 8 | queued jobs; beyond → `rejected` |
| `PREVIEW_SOURCE_MAX_BYTES` | 24 MB | MEGA ciphertext per window |
| `PREVIEW_MOOV_MAX_BYTES` | 4 MB | head/tail moov fetch cap |
| `PREVIEW_CLIP_SECONDS` | 8 | hover preview length (3–15) |
| `PREVIEW_CLIP_HEIGHT` | 360 | output height (width follows aspect) |
| `PREVIEW_CLIP_MAX_FILE_BYTES` | 3 MB | finished clip cap |
| `PREVIEW_MAX_ATTEMPTS` | 2 | candidate attempts before cooldown |
| `PREVIEW_FAILURE_COOLDOWN_MS` | 30 min | parked failure duration |
| `PREVIEW_FFMPEG_TIMEOUT_MS` | 90 s | per-invocation SIGKILL |
| `PREVIEW_MAX_HEAP_RATIO` | 0.85 | admission gate |
| `PREVIEW_CACHE_MAX_BYTES` | 512 MB | store budget, LRU eviction |
| `PREVIEW_SPRITE_*` | 160px / 10 cols / 100 tiles / 4 s | spritesheet grid |

---

## 8. Remaining issues / limitations

1. **MPEG-TS path is not E2E-tested through MEGA.** All 240 `video/mp2t` rows in the test database are fixtures without `megaNodeId` (they correctly answer 409). The TS decode and 752-byte window alignment were validated on a real TS sample and pinned by unit tests, but no live MEGA TS row exists to exercise end to end.
2. **`libopenh264` only.** This FFmpeg build has no libx264; output is fixed-bitrate (~700 kbps at 360p), so quality is slightly below a CRF-encoded x264 preview. The code path will use better encoders if the deployment FFmpeg provides them, but this was not benchmarked here.
3. **Timeline requires a warm media cache.** Cold/short MP4s and TS files that never trigger the existing warm-cache policy will show no scrub thumbnails until a full playback warms them. This is deliberate (avoid hundreds of MB per video), but it means coverage grows with playback, not browsing.
4. **Moov outside the 4 MB head/tail caps is unsupported.** Such files (or fragmented MP4s without a top-level moov) fail after the bounded attempts and enter cooldown. Large non-faststart files whose moov sits at a non-standard offset are likewise unsupported. `PREVIEW_MOOV_MAX_BYTES` can be raised if this shows up in practice.
5. **Eviction and maintenance are unit-tested, not load-tested.** LRU eviction, refcount protection, grace period, and orphan sweep have coverage, but the 512 MB pressure scenario was not exercised end-to-end.
6. **Unknown-duration sources use an estimated segment.** DB duration is null for the two E2E videos; the ladder starts at 10 s and marks the hover `estimated: true`. The brightness gate prevents black/intro content, but a warm-cache duration probe (used for timelines) gives better segment selection when available.
7. **Single-process assumption.** Single-flight, queue, and cooldown are in-process; like the existing media cache, this assumes one Node instance (or per-instance work). Multi-instance deployments would duplicate at most one generation per video until the sidecar appears.
8. **Sprite cadence follows keyframes.** `fps` holds the last keyframe, so sources with long GOPs can show duplicate adjacent cells; visually acceptable for scrub thumbnails.
9. **Browser E2E used a temporary Clerk middleware bypass.** Pages are Clerk-protected and the legacy session cookie only authenticates API routes. The bypass (`P5_E2E_LOCAL_BYPASS`) was reverted before commit; `proxy.ts` is unchanged.
10. **Dev-mode latency.** The 11.0 s cold figure includes dev-server overhead (one poll was delayed by Turbopack recompilation during the first measurement); expect lower wall time in a production build, network being the dominant cost.

---

## 9. Verification commands

```bash
# from /home/parag/Projects/Project_Mega_phase5
npm run test:unit                 # 655 pass (56 preview)
npx tsc --noEmit                  # clean
npx eslint lib/preview app/api/preview components/PreviewVideo.tsx \
  components/VideoCard.tsx components/PrivatePlayer.tsx \
  lib/preview-meta-client.ts tests/unit/preview-*.test.ts instrumentation.ts
```

Manual E2E (API, authenticated cookie or Clerk session):

```bash
curl -H "Cookie: session_token=..." localhost:3000/api/preview/1373/meta
curl -H "Cookie: session_token=..." -H "Range: bytes=0-1023" \
     -D - -o /dev/null localhost:3000/api/preview/1373
curl -H "Cookie: session_token=..." localhost:3000/api/preview/1373/timeline/vtt
```

Run the app normally; hover generation is on-demand. `PREVIEW_DISABLED=1` disables all generation and asset work.
