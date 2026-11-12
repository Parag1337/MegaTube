# MegaTube — Phase 5: Efficient Video Hover Previews and Timeline Previews — Design

Branch: `phase-5-video-previews` (worktree), based on `b98737e`.

## 1. Architecture inspection summary (integration surface)

The existing pipeline (Phase 3–4) is deliberately NOT rewritten. The preview
feature reuses it read-only:

| Existing piece | Reuse |
|---|---|
| MEGA session resume (`lib/sync/session-cache.ts` `withMegaSession`) | resolve a short-lived download URL for the source node |
| `a=g` URL acquisition (`lib/mega/account.ts` `getTemporaryDownloadUrl`) | same, cached 5 min per node |
| AES-CTR decryption (`megajs` `decrypt(key, { start, disableVerification })`) | decrypt bounded ranges at 16-byte-aligned offsets |
| Range fetching (`lib/net-resilience.ts` `keepAliveFetch` + `withTransientRetry`) | fetch ciphertext windows |
| Warm media cache (`data/cache-media/<id>.mp4` + `<id>.json` sidecar, `readRemuxCache`) | primary local source for preview generation |
| Remux-cache faststart layout knowledge (`Video.mp4Faststart`, `probeMp4Layout`) | decides whether moov can be read from the head or the tail |
| ffmpeg frame-extraction patterns (`lib/thumbs/repair.ts`) | brightness probe (`scale=32:32 rgb24`) reused for segment quality |
| Auth/ownership conventions (`app/api/media/thumbs/[videoId]/route.ts`) | identical 401/400/404/410 matrix, `Server-Timing`, cache headers |
| `createCachedFileResponse` + `trackCacheStream` (Range + refcount) | serving preview bytes with Range support and eviction protection |
| Client card hover plumbing (`components/VideoCard.tsx`, `lib/preview-manager.ts`, `lib/config.ts` `previewDelayMs`) | reused; the iframe preview becomes a fallback, the new local preview takes priority |

New, self-contained code (no Phase 3–4 file modified except one-line additive
wiring listed in §11):

```
lib/preview/types.ts        sidecar/status types
lib/preview/config.ts       env-tunable bounds
lib/preview/segment.ts      pure segment/window math (unit-tested)
lib/preview/mp4-index.ts    minimal MP4 moov parser (faststart + tail moov)
lib/preview/source.ts       acquisition: warm cache -> local TS prefix -> bounded MEGA window
lib/preview/ffmpeg.ts       encode hover clip + spritesheet + brightness probe
lib/preview/cache.ts        data/previews store: sidecars, LRU eviction, refcount
lib/preview/queue.ts        bounded generation queue (dedupe, cancel, retry, status)
lib/preview/service.ts      meta endpoint core (injectable, unit-tested)
app/api/preview/[videoId]/route.ts            hover clip bytes (Range)
app/api/preview/[videoId]/meta/route.ts       metadata + enqueue
app/api/preview/[videoId]/timeline/route.ts   spritesheet JPEG
app/api/preview/[videoId]/timeline/vtt/route.ts WebVTT for Vidstack thumbnails
components/PreviewVideo.tsx                   local hover preview element
components/VideoCard.tsx                      wiring (additive)
components/PrivatePlayer.tsx                  timeline thumbnails (additive)
tests/unit/preview-*.test.ts
```

## 2. Source acquisition strategy (bounded, cheapest first)

Generation resolves a **source plan**, tried in cost order:

1. **Warm media cache** (`data/cache-media/<id>.mp4` with a valid sidecar) —
   0 MEGA bytes. Any timestamp is decodable. Preferred unconditionally.
2. **Local acquisition prefix** (`data/cache-media/<id>.ts.part`, frontier ≥
   window end) — 0 MEGA bytes (only for MPEG-TS sources).
3. **Bounded MEGA ciphertext window** — the only MEGA-consuming path:

   - MPEG-TS source: windows are self-synchronizing. Start at
     `align752(size × t/duration)` (752 = 188 × 4 keeps the TS packet grid AND
     MEGA's 16-byte CTR alignment simultaneously — same trick as
     `pcrTailStart`). ffmpeg resyncs at the next keyframe inside the window.
     Window size ≈ 18 s of content × 1.8 safety, clamped to
     `PREVIEW_SOURCE_MAX_BYTES` (default 24 MB).
   - MP4 source: moov is fetched separately (head for faststart, tail for
     moov-at-end, ≤ 4 MB) and the media window is placed at its absolute
     offset in a **sparse file**; ffmpeg `-ss <t>` seeks through moov's own
     index directly into the present bytes. The head chunk is also written at
     offset 0 even for moov-at-end sources: the demuxer needs a valid
     top-level box chain (`ftyp` + `mdat` header) to walk to the sparse moov.
     A tail chunk normally starts inside `mdat`, so moov is located there by
     a signature scan validated against the mandatory `mvhd` first child (a
     plain box walk cannot reach it). Validated live: a 6 s 360p preview was
     produced from moov + a ~12 % window of a 2.9 MB test file, and an 8 s
     preview from a 31 MB non-faststart MP4 (head + tail + 2 MB window,
     10.0 MB total) with zero full-file reads.
   - MEGA bytes per job are therefore **≤ 24 MB (TS) / ≤ 28 MB (MP4, moov
     included) and only ever paid ONCE per video** (results are cached
     forever until the source identity changes).

4. **Spritesheets**: require the whole duration, so they are generated ONLY
   from the warm cache (path 1). Downloading ~100 keyframe windows from MEGA
   would cost hundreds of MB per video and is explicitly rejected. Cold
   videos report `timeline: unavailable (source-not-local)` until the first
   full playback warms the cache (playback already warms MPEG-TS and large
   non-faststart MP4 sources by design), after which the next page open
   generates the spritesheet.

## 3. Segment selection strategy (representative, not the first 10 s)

Pure math in `lib/preview/segment.ts`:

- Candidate positions: **25 %, 50 %, 75 %** of the known duration (never
  inside the first 10 % — the classic intro/black-lead-in zone), plus a
  fallback ladder (10 s, 30 s, 60 s) when duration is unknown.
- For each candidate the generator decodes up to 8 s of preview; three probe
  frames (start/mid/end of the decoded segment) are measured with the shared
  `scale=32:32 rgb24` mean-brightness probe (`THUMB_BRIGHTNESS_MIN`).
- The first candidate that yields ≥ 2/3 usable (non-black) probe frames wins.
  If no candidate clears the floor, the brightest candidate is used as a
  best-effort fallback (mirrors `pickFrame`).
- Attempt budget: `PREVIEW_MAX_ATTEMPTS` candidates per run (default 2,
  tunable 1–5), each attempt one bounded window fetch. Attempts accumulate in
  the sidecar across runs; a run that exhausts the budget records
  `failedAt`, and the video is parked for the cooldown. An expired cooldown
  resets the budget to zero. Total MEGA bytes in the degenerate all-fail
  case stay bounded by `PREVIEW_MAX_ATTEMPTS × PREVIEW_SOURCE_MAX_BYTES`; the
  common case is one window.
- Without a known duration, candidates are the fixed ladder and the
  resulting preview is labelled `estimated: true` in the sidecar.

## 4. Expected MEGA bytes transferred

| Path | First preview ever | Every later hover |
|---|---|---|
| Warm cache | 0 B | 0 B (browser HTTP cache after first serve) |
| TS bounded window | ~6–24 MB once | 0 B |
| MP4 sparse (moov + window) | ~6–28 MB once | 0 B |
| Spritesheet | 0 B extra (needs warm cache) | 0 B |

Repeated hovers NEVER re-trigger generation: the meta endpoint answers from
the disk sidecar and the clip itself is served with
`Cache-Control: private, max-age=3600` + `ETag`, so even the clip bytes come
from the browser cache on repeat hovers within the session.

## 5. FFmpeg resource requirements

- Encoding: **libopenh264** (the only h264 encoder in this ffmpeg build; no
  libx264), `scale=-2:360`, `-b:v 700k -rc_mode bitrate` (libopenh264 has no
  CRF mode), `-t 8`, `+faststart` — plus AAC 96 kbps. Measured on a 405 s
  360p source: 0.49 s wall / 0.95 s CPU, 94.5 MB peak RSS, 796 KB output.
- Timeline sprite (`-discard nokey`, demuxer-level): measured **0.84 s**,
  90.8 MB peak RSS, 97 KB JPEG for 80 cells from the same source. The
  originally planned `-skip_frame nokey` measured 12.1 s: libopenh264 does
  not skip decoding, the flag only drops output frames, so cost stayed
  proportional to the full video length.
- Never re-encodes the ORIGINAL source; the preview is a new derived asset
  (stream copy cannot cut at an arbitrary mid-GOP offset cleanly and would
  carry full source bitrate — 8 s of 1080p at 5 Mbps ≈ 5 MB vs ~0.3 MB).
- Concurrency: `PREVIEW_MAX_CONCURRENT` (default 1) ffmpeg process at a time,
  bounded per-process timeout (`PREVIEW_FFMPEG_TIMEOUT_MS`, default 90 s,
  SIGKILL). Decode+encode of 8 s at 360p measured ~0.5–1.2 s wall.
- Peak RAM: one ffmpeg child ~60–120 MB; the Node side streams (no video
  buffering, bounded temp files ≤ PREVIEW_SOURCE_MAX_BYTES).
- The remux pool (`MAX_CONCURRENT_REMUX`) is never touched — preview jobs
  cannot starve or delay normal playback slots.

## 6. Preview format decision

- **Hover clip: fragmented-free faststart MP4** (`ftyp+moov` first, h264
  Baseline/Main + AAC-LC). Fast startup (moov-first), universally
  compatible with `<video>`, small (~0.3–1 MB per 8 s at 360p), one ffmpeg
  pass, cacheable. WebM/VP9 was rejected: slower encode (libvpx), no gain
  for an 8 s muted clip, and AV1 (svt) is far slower still.
- **Timeline: JPEG spritesheet + WebVTT** (sprite.jpg + .vtt with `#xywh=`
  cell fragments), consumed natively by Vidstack's `DefaultVideoLayout
  thumbnails` — zero custom timeline UI, existing player controls preserved.
  Tiles 160×90, ≤ 100 cells (cols 10), interval = `max(4s, duration/100)`
  (env-tunable), one JPEG ~0.2–0.4 MB.
- Keyframes are NOT re-cut on the server: the clip starts at the first
  decodable keyframe inside the window (the `-ss` probe avoids re-cutting).

## 7. Cache structure (`data/previews/`)

```
data/previews/<id>.preview.mp4    hover clip (transcoded, ≤ PREVIEW_MAX_FILE_BYTES = 3 MB)
data/previews/<id>.sprite.jpg     timeline spritesheet
data/previews/<id>.json           sidecar (single writer, atomic tmp+rename)
```

Sidecar (validated on every read; identity mismatch ⇒ stale ⇒ regenerate):

```json
{
  "version": 1,
  "videoId": 365,
  "megaNodeId": "abc",
  "sourceSize": 12345678,
  "durationSeconds": 1100,
  "status": "ready",
  "hover":   { "startSec": 275, "durationSec": 8, "width": 640, "height": 360,
               "bytes": 321456, "estimated": false },
  "timeline": { "tileW": 160, "tileH": 90, "cols": 10, "rows": 6,
                "intervalSec": 12, "count": 55 },
  "attempts": 1,
  "lastError": null,
  "failedAt": null,
  "lastAccessedAt": "2026-11-11T18:00:00.000Z"
}
```

- Statuses: `ready` | `generating` (in-memory only, never persisted as
  such) | `failed` (with `attempts`/`lastError`/`failedAt`). `attempts` counts
  candidate attempts, not runs: a run that spends its whole budget records
  `failedAt` immediately; a run with a smaller budget records the failure
  without `failedAt`, so the next hover may retry. Missing warm cache for a
  timeline is a state, not a failure: it never increments `attempts` and
  never parks the video.
- Failed jobs are retried at most until `PREVIEW_MAX_ATTEMPTS` candidate
  attempts have accumulated, then parked for
  `PREVIEW_FAILURE_COOLDOWN_MS` (default 30 min) — the meta endpoint answers
  `unavailable` during cooldown without any work, and the first request after
  the cooldown resets the budget.
- Bounded store: `PREVIEW_CACHE_MAX_BYTES` (default 512 MB) LRU eviction by
  `lastAccessedAt` (throttled touch), runs on the same background interval
  pattern as the media cache; files being streamed are refcount-protected
  (`trackPreviewStream`, mirroring `trackCacheStream`); jobs' in-progress
  temp files (`*.tmp.mp4`, `*.tmp.jpg`, window files `*.win`) are never
  eviction victims and are cleaned by the owning job's `finally`.
- Stale previews: identity is `megaNodeId + sourceSize (+duration)`, so a
  re-synced/changed video invalidates automatically.

## 8. API design

All routes: `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`, the exact
thumbs-route auth matrix (`getCurrentUser` → 401; bad id → 400; not owner /
missing / disconnected-mismatch → 404; `DISCONNECTED` → 410). No MEGA URLs,
no session material, no filesystem paths are ever exposed.

| Endpoint | Response |
|---|---|
| `GET /api/preview/[videoId]/meta?want=hover,timeline` | JSON `{ status, hover?, timeline? }`; enqueues missing generations (bounded queue; queue-full ⇒ `status: "rejected"`); returns `generating` in milliseconds and never waits for MEGA/ffmpeg; `Cache-Control: no-store` |
| `GET /api/preview/[videoId]` | hover clip bytes (`video/mp4`, Range via `createCachedFileResponse`, refcount protection, `private, max-age=3600`, `ETag`); 404 JSON when not ready |
| `GET /api/preview/[videoId]/timeline` | spritesheet JPEG (`image/jpeg`, `private, max-age=3600`, `ETag`) |
| `GET /api/preview/[videoId]/timeline/vtt` | WebVTT (relative sprite URL, `private, max-age=3600`) |

Failure handling: missing preview ⇒ JSON 404 `{ error, status }` (never HTML);
generation failures are recorded in the sidecar with bounded retries and a
cooldown; a crashed job cleans its temps in `finally`; a restart loses only
in-flight work (disk sidecars are the source of truth).

## 9. Background generation model (on-demand + bounded queue)

Chosen: **on-demand via the meta endpoint** with a bounded in-process queue.
Not eager per-library generation (would burn MEGA bytes for videos nobody
hovers) and not piggybacked on playback acquisition (would require touching
the Phase 3–4 live pipeline).

- `PREVIEW_MAX_CONCURRENT = 1` running job (ffmpeg + at most one MEGA window
  download), `PREVIEW_MAX_QUEUE = 8` waiting jobs, FIFO.
- Duplicate protection: in-flight map keyed by videoId; concurrent meta
  calls join the same job (single-flight).
- Non-blocking admission: meta uses `enqueueNow`, which returns
  `started`/`queued`/`rejected` immediately after bounded admission. It never
  awaits the job-completion promise; the response is `generating` in
  milliseconds even when the MEGA window or ffmpeg run takes many seconds.
- Cancellation: queued-but-not-started jobs are cancelled when their
  requester aborts; a RUNNING job completes (bounded ≤ 90 s) because its
  result is cached and reused by the next hover — this is the cheaper
  outcome, never a wasted job.
- Retry: bounded attempts (2) with sidecar-recorded failure + cooldown.
- Memory admission: `process.memoryUsage().heapUsed` above
  `PREVIEW_MAX_HEAP_RATIO × os.totalmem()` (default 0.85) ⇒ enqueue is
  refused (`rejected`) rather than degrading active playback.
- Playback priority: preview jobs never enter the remux pool, never touch
  `data/cache-media` writes, and their single MEGA window download is
  bounded; normal playback therefore always retains priority.

## 10. Frontend behavior

- `VideoCard`: thumbnail shows immediately; after `previewDelayMs` (400 ms,
  existing knob) the card fetches `meta` (ready results cached client-side per
  video for the page lifetime). `ready` ⇒ mount one `<video muted
  playsInline loop preload="auto">` over the thumbnail (no iframe, no full
  player); play on `canplay`; leave ⇒ pause + unmount + restore thumbnail.
  `generating` ⇒ keep the thumbnail and poll the cheap meta endpoint every
  ~2 s, for at most 30 s, while the pointer remains on the card. Polling stops
  immediately on leave/card switch or any terminal state; if it expires, fall
  back to the existing MEGA-iframe preview for videos that have a mega embed
  URL (public videos), otherwise no preview. Cards that have a MEGA embed also
  show that iframe after a short 2.5 s grace while cold generation continues;
  the local clip replaces it as soon as it is ready. The first hover therefore
  shows the clip as soon as a cold background generation finishes, instead of
  requiring a second hover. Client meta cache means rapid movement across
  cards issues at most one meta request per KNOWN-READY video.
- Clicking a card navigates to `/video/<slug>` in the **current tab** via
  Next.js client routing (`router.push`), never `window.open`. The same
  behavior applies to every listing that renders `VideoCard` (home, search,
  creator, library, watchlist) as well as the History/Saved/related links,
  which are ordinary internal `<a>`/`<Link>` elements. External links are
  untouched.
- One preview at a time is enforced by the existing `preview-manager`.
- Touch devices: the existing long-press interaction triggers the same
  preview; a `touchmove` cancels (unchanged).
- `PrivatePlayer`: on mount fetches `meta?want=timeline`; when the
  spritesheet is ready it passes the VTT URL to `DefaultVideoLayout
  thumbnails` (native Vidstack timeline preview). Controls and layout are
  untouched; cold videos simply render the plain timeline.

## 11. Integration dependencies (documented, additive)

- `components/VideoCard.tsx` — extended (hover preview + fallback). No
  Phase 3–4 behavior removed: the iframe path is retained as fallback.
- `components/PrivatePlayer.tsx` — additive `thumbnails` prop wiring.
- No changes to `app/api/media/[videoId]/route.ts`, `lib/media/remux.ts`
  internals, or the sync worker. Preview code reads the media cache and DB
  only.

## 12. Open limitations (documented honestly)

1. Timeline sprites require a warm local source (§2 path 1); cold videos
   show the plain timeline until their first full playback.
2. Hover previews for MP4 sources without a warm cache use linear byte
   estimation + `-ss` (ffmpeg resolves the exact keyframe via moov); the
   clip may start up to one GOP late. TS windows self-synchronize equally.
3. libopenh264 (no libx264 in this ffmpeg build) caps the preview encode at
   Baseline-profile-class quality; visually fine at 360p.
4. Videos with unknown duration use the fixed candidate ladder and are
   marked `estimated: true`.
