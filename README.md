<div align="center">

# 🎬 MegaTube

**Your private video library, powered by MEGA.**

MegaTube is a private, self-hosted video library that turns videos stored in MEGA
into a modern streaming-library experience. It connects to your MEGA accounts,
indexes your video files into a local searchable database, and streams them back
through a polished web player — no uploading, no third-party hosting, and your
originals stay exactly where they are.

**Status:** early stage · v0.1.0 · actively developed

</div>

---

## Contents

- [✨ Features](#features)
- [🖥️ What It Looks Like](#what-it-looks-like)
- [🧠 How It Works](#how-it-works)
- [🏗️ Tech Stack](#tech-stack)
- [🔐 Privacy & Security](#privacy--security)
- [☁️ MEGA Integration](#mega-integration)
- [▶️ Playback](#playback)
- [🖼️ Thumbnails](#thumbnails)
- [🔎 Search](#search)
- [📚 Library & Discovery](#library--discovery)
- [🚀 Getting Started](#getting-started)
- [🧪 Testing](#testing)
- [📁 Project Layout](#project-layout)
- [🙏 Acknowledgements](#acknowledgements)

---

## ✨ Features

- 🎬 **MEGA-backed library** — link one or more MEGA accounts; every video file is discovered, indexed, and tracked by its MEGA node id.
- ▶️ **Streaming playback** — a private media endpoint decrypts MEGA files server-side and streams them to the browser with HTTP range support; browser-hostile containers (MPEG-TS) are remuxed on demand.
- 🔎 **Fast search** — PostgreSQL full-text + **pg_trgm** search across titles, original MEGA filenames, and creator names, with a small boolean query language.
- 🏠 **Personalized home feed** — one interleaved, quota-composed feed mixing newest adds, related picks, history-based suggestions, and randomized discovery — no isolated silos.
- 🎲 **Shuffle / random discovery** — type `#random` in search (or hit **Reshuffle**) for a deterministic, pageable random order.
- 👤 **Creator organization** — creators are parsed from `Creator - Title` filenames, grouped under a per-user *Unknown Creator* bucket, and manually assignable.
- ❤️ **Watchlist** — add/remove, **Play All**, **Download All** (bounded queue), and **Clear All**.
- 🔖 **Saved videos** — bookmark any video and organize saves into personal folders.
- 🕘 **Watch history** — recorded automatically, newest first, remove-and-clear per user.
- 🆕 **New videos** — a dedicated library view ordered by newest-synced.
- 🎯 **Related / recommended videos** — deterministic, user-scoped recommendations (same creator → title match → random) on the video page and inside the home feed.
- 🖼️ **Thumbnail repair** — missing, black, or broken thumbnails can be replaced with a real frame extracted from the actual video; valid ones are preserved.
- 👥 **Multiple MEGA accounts** — several MEGA accounts per user, each with independent status, sync, and session management.
- 🔐 **User-scoped, private data** — every query and route is scoped to the signed-in user; private videos are invisible to everyone but their owner.
- 📱 **Responsive UI** — Tailwind-powered app shell with a dark theme, mobile-friendly navigation, hover previews, and a Vidstack-based player.

## 🖥️ What It Looks Like

The repository doesn't ship UI screenshots yet, so here's a quick map of the app instead:

| Page | What you get |
| --- | --- |
| Landing (`/`) | Signed-out visitors see the *screening room* landing page: a pointer-responsive media wall, feature strip, and sign-up/sign-in CTAs. |
| Home | For signed-in users: page one groups feed picks into **Recently added**, **Recommended**, and **Browse your library**; later pages form one continuous grid. |
| Library | **All / New / Creators** views with per-MEGA-account filtering and pagination. |
| Search | Full-text results across titles, filenames, and creators; `#random` flips it into shuffle mode. |
| Video page | Player with poster, gestures, and settings; **Up Next**, **From this Creator**, and **Discover** sections; watchlist / save / download / creator controls. |
| Watchlist · Saved · History | Personal collections with bulk actions and (for Saved) user-created folders. |
| Account & Settings | Profile, linked MEGA accounts with live sync progress and statuses, Maintenance (thumbnail repair), and appearance/settings. |

## 🧠 How It Works

At a high level, MegaTube is a layered application with a clean split between the
**web experience** and the **MEGA boundary**:

```text
Browser (React · Tailwind · Vidstack player)
        │
        ▼
Next.js App Router (server components + API routes)
        │
        ▼
User / auth layer (Clerk sign-in, legacy password sessions)
        │
        ▼
PostgreSQL + Prisma → library metadata, sync state, watchlist/saved/history
        │
        ▼
MEGA account/session layer (megajs · encrypted session material)
        │
        ▼
MEGA cloud storage — your files are always the source of truth
```

### Playback flow

```text
Browser player
        │
        ▼
/api/media/[videoId]      (owner-only route, Node runtime)
        │
        ▼
MEGA session resume → short-lived download URL → ciphertext fetch
        │
        ▼
megajs AES-128-CTR decryption (MAC-verified)
        │
        ▼
direct stream (MP4)  ── or ──  ffmpeg remux (MPEG-TS → MP4 / live fMP4)
        │
        ▼
HTTP range streaming → <video>
```

Two things matter here conceptually:

1. **MEGA is storage, not the app.** MegaTube keeps a lightweight local database
   of *metadata* (titles, creators, durations, node ids, thumbnails) and streams
   the actual *bytes* from MEGA at playback time. Nothing is re-uploaded anywhere.
2. **The browser never talks to MEGA.** All MEGA traffic happens server-side
   through MegaTube's own endpoints, so download URLs, session ids, and file keys
   never reach the client.

## 🏗️ Tech Stack

| Layer | Technology | Notes |
| --- | --- | --- |
| Framework | **Next.js 16** | App Router, server components, API routes |
| UI | **React 19** + **Tailwind CSS 4** | dark theme, responsive app shell |
| Player | **@vidstack/react** | `<MediaPlayer>` UI over native `<video>` |
| Data | **Prisma 7** + **PostgreSQL** | via the `pg` driver adapter (`@prisma/adapter-pg`) — Neon-compatible |
| MEGA client | **megajs 1.3** | login, node tree, file attributes, decryption |
| Auth | **Clerk** (`@clerk/nextjs`) | hosted sign-in/up; legacy PBKDF2 password sessions kept as fallback |
| Media processing | **ffmpeg** (system binary) | stream-copy remux (no re-encode) + thumbnail frame extraction |
| Language / tooling | **TypeScript 5** · ESLint · `tsx` | |
| Tests | `node:test` via `tsx` · **Playwright** | unit/integration/E2E |

> **`ffmpeg` is an external requirement.** It must be installed on the host
> (`FFMPEG_BIN` overrides the binary path). MegaTube never re-encodes video — it
> only remuxes containers (stream-copy) when the browser can't play the original.

## 🔐 Privacy & Security

The model is simple and honest: MegaTube's server is a trusted component that
holds everything needed to reach *your* files.

- **MEGA passwords are never stored.** The password is used exactly once when a
  MEGA account is linked or reconnected, then discarded immediately. It is never
  written to the database, logs, or responses.
- **Session material is encrypted at rest.** The reusable MEGA session (session
  id, master key, RSA private key) and per-video file keys are AES-256-GCM
  encrypted with the `MEGA_SESSION_ENCRYPTION_KEY` envelope key (64 hex chars,
  generated with `npm run keygen`). Rotating the envelope key invalidates all
  stored sessions — users simply reconnect.
- **Everything is user-scoped.** All queries and API routes are keyed to the
  signed-in user's identity. A user's private videos are invisible (and
  unreachable) to everyone else — media, download, and thumbnail routes re-check
  ownership per request, and private video pages render 404 for non-owners.
- **The browser only sees MegaTube.** Media bytes are decrypted server-side and
  streamed through MegaTube endpoints; short-lived MEGA download URLs, session
  ids, and file keys never touch the client.
- **Secrets come from the environment.** Configuration is read from `.env`
  (git-ignored); `env.example` documents every variable.

> ⚠️ **What this is not:** MegaTube does not claim zero-knowledge or end-to-end
> encrypted playback. The server can decrypt your media — that is a necessary,
> deliberate property of the architecture. Protect the envelope key and the host
> you deploy on the same way you would protect your MEGA login.
>
> Also be careful with sessions: stored MEGA sessions are reusable the way MEGA
> itself defines them. Reconnecting (or revoking the session on mega.nz)
> invalidates them.

## ☁️ MEGA Integration

There is a hard separation between **MEGA storage** and **MegaTube's local copy**:

| | MEGA storage | MegaTube's local data |
| --- | --- | --- |
| What lives there | Files, folders, encryption — the actual video bytes | PostgreSQL metadata (titles, creators, durations, node ids) + cached artifacts (thumbnails, remuxed MP4s) |
| Who owns it | The MEGA account | The MegaTube user who linked that account |
| Is it required to play? | Yes — bytes are streamed from MEGA at playback time | No — it's a fast, searchable index over what MEGA holds |

**Linking.** From the Account page you add a MEGA account (email + password, plus
an MFA code when the account requires one). MegaTube logs in once, captures the
reusable session material, encrypts it at rest, and never asks for the password
again. Session expiry or revocation flips the account to *re-auth required*, with
an explicit reconnect flow.

**Indexing & sync.** A background sync engine keeps the local library aligned with
MEGA:

1. resumes the stored session (no password) and fetches the node tree;
2. keeps video files only and reconciles against local rows by **MEGA node id** —
   added, updated, and removed videos are detected; unchanged rows are left alone;
3. fetches thumbnails and durations for *new* videos;
4. records a durable per-run summary (discovered / created / updated / removed /
   unchanged) shown in the UI.

Synchronization runs on a scheduler (default every 6 h), on demand via **Sync now**,
and immediately after linking. It is per-account gated (one job per account at a
time), survives crashes (stuck `SYNCING` accounts are retried on startup), and
back-off retries transient failures. Multiple MEGA accounts can be linked to one
user, each synced independently.

## ▶️ Playback

Playback is MegaTube's most important feature, so it gets its own section.

- **One media endpoint, owner-only.** `/api/media/[videoId]` handles everything:
  it resolves the video, verifies the requesting user owns it, resumes the MEGA
  session, obtains a short-lived download URL, decrypts the ciphertext stream
  (megajs AES-128-CTR, MAC-verified), and streams it to the browser.
- **Range-based playback.** Warm content supports full HTTP range requests —
  seeking, buffering-friendly delivery, and standard `<video>` behavior. MEGA URLs
  are cached briefly in-process (single-flight) so concurrent player requests
  don't hammer the API.
- **Container detection.** MEGA nodes carry no MIME type, so MegaTube verifies the
  actual bytes with a cheap prefix probe instead of trusting filename extensions.
  Plain MP4 streams directly; **MPEG-TS** (commonly produced by HLS-style export
  tools) is served through a remux pipeline.
- **Remux without re-encoding.** MPEG-TS is converted to MP4 with `ffmpeg -c copy`
  (stream copy — no quality loss, pure container surgery). Two serving modes:
  - **Cold cache:** the video starts as a *live fragmented-MP4* stream so playback
    begins within seconds while the same bytes are written to a spool file
    (`data/cache-media`). A bounded fragment index supports future-timeline seeking
    into the spool.
  - **Warm cache:** once the full file is downloaded and remuxed to a faststart
    MP4, subsequent plays (and seeks) get full range support from the cache.
- **Bounded, resilient.** Remux jobs are concurrency-limited (a queue with timeouts,
  retryable `503 + Retry-After` when busy), temp/disk budgets are checked before
  cold jobs start, a cold job's MEGA download can resume from the last good byte
  if interrupted, and the player auto-retries warming failures with backoff
  (bounded — permanent failures show an error panel instead of looping).
- **A managed cache.** `data/cache-media` is capped by default at 5 GiB
  (`MEDIA_CACHE_MAX_BYTES`). Background LRU eviction removes cold entries while
  never touching live remux jobs, in-progress spill-over files, files actively
  being streamed, or freshly published caches. Stale/corrupt entries are reclaimed
  first.
- **Original-file downloads.** `/api/download/[videoId]` streams the pristine MEGA
  bytes (no remux, no disk copies) with sanitized filenames and proper MIME types,
  used by the per-video Download button and bulk **Download All** flows.

> **Reality check:** playback quality depends on the source. MegaTube targets the
> h264/AAC content that dominates MEGA video libraries — any codec or container
> combination may simply not play in a given browser, and MegaTube will say so
> rather than pretend otherwise.

## 🖼️ Thumbnails

Thumbnails come from two sources, both stored server-side under `data/thumbs`:

- **From MEGA metadata.** MEGA stores thumbnails as encrypted *file attributes*
  (type-0 blobs). The sync engine fetches and decrypts them with the node's
  derived key and saves them locally — no public-link tricks, authenticated API
  calls only.
- **Repaired, from real frames.** MEGA thumbnails are sometimes missing or come
  out as black/broken images. The **Repair Thumbnails** action (Account →
  Maintenance) scans your library and, for any thumbnail that fails a simple
  brightness check, extracts a real 640-px-wide frame from the actual video with
  ffmpeg and stores it. Existing good thumbnails are **never touched or
  re-generated**, and the repair is batch-bounded, safely re-runnable, and streams
  live per-video progress to the UI. A similar background pass runs quietly after
  each sync for newly added videos.

The design is deliberately simple: a brightness floor on a downscaled image decides
"problematic" — no face detection, no ML, no computer vision.

## 🔎 Search

Search is backed by PostgreSQL structures (`VideoSearch`) kept in
sync with the `Video` table by database triggers, so the index can never drift from
the data. It covers:

- **titles**, **original MEGA filenames**, and **creator names**;
- **case-insensitive substring matching** (pg_trgm-accelerated ILIKE);
- **weighted relevance** ranking (ts_rank over a generated weighted tsvector +
  trigram similarity) with title weighted above filename/creator.

Queries support a small boolean language:

| Syntax | Meaning |
| --- | --- |
| `space between terms` | implicit OR |
| `a && b` | AND |
| `a \|\| b` | OR |
| `!term` | NOT |
| `( ... )` | grouping |
| `"multi word"` | one exact phrase |

Precedence: `!` > `&&` > `||`. User input is always compiled to bound parameters —
it can never become SQL or full-text operators. Terms too short for trigrams fall
back to an ILIKE path, and databases created before the search migration fall back
to plain case-insensitive contains-matching too.

> 🎲 **Shuffle mode:** searching the exact command `#random` (or clicking the
> shuffle button on the search page) replaces search with a deterministic random
> ordering seeded per visit — stable across pages, reshuffled on demand.

## 📚 Library & Discovery

### Home

One **interleaved feed** composed from five explicitly quota'd sources — not
isolated sections:

| Source | Share | What it is |
| --- | --- | --- |
| Recent | 15% | newest-synced videos |
| History | 10% | related to your recent watches |
| Related | 15% | same-creator / title matches around the newest picks |
| Random | 30% | a deterministic daily-seeded shuffle |
| Variety | 30% | a back-to-front pass through the library so nothing gets buried |

The composition is deterministic for the same user/day/page, de-duplicated, and
previous pages are excluded so adjacent pages never repeat. Page one groups its
picks into **Recently added**, **Recommended**, and **Browse your library**; deeper
pages are one continuous grid. No AI, no scoring, no profiling.

### Library

**All / New / Creators** views with a per-MEGA-account filter and pagination.
**New** orders by newest-synced; **Creators** surfaces the people behind your
library with video counts and avatars.

### Creators

Creators are derived automatically from `Creator - Title` filenames at sync time
(download-tool wrappers like `_-_VOE...` suffixes and `Watch_` prefixes are
stripped first). Videos without a recognizable pattern group under a per-user
**Unknown Creator**. Assignments are editable — manual assignments are never
overwritten by a re-sync. Each creator has a page with their videos, and creators
can be created and assigned by hand.

### Watchlist

A "watch later" list with add/remove from any video's menu, plus bulk actions:
**Play All** (opens the current page's items in new tabs), **Download All** (a
bounded, resumable queue with per-item status), and **Clear All** (confirm-first).

### Saved

Bookmark anything with a folder: saved videos live under **All Saved**, and you can
create personal folders (application-level only — never MEGA folders) to organize
them. Deleting a folder never deletes videos; they return to All Saved.

### History

Every play is recorded automatically (one row per video, re-watches refresh the
timestamp). The history page lists newest first and supports per-item removal and
clear-all.

### Shuffle

Deterministic seeded randomization (`#random` in search + **Reshuffle** button) —
the same seed always yields the same order, pagination stays stable, and a fresh
seed reshuffles.

### Recommendations

Deliberately simple and deterministic — no ML, no embeddings: **same creator →
title match → random discovery**, always user-scoped and excluding the current
video. They appear as **Up Next**, **From this Creator**, and **Discover** on the
video page and feed the home page's related/history pools.

## 🚀 Getting Started

### Prerequisites

- **Node.js 20.9+** (developed against Node 22)
- **ffmpeg** on `PATH` (or set `FFMPEG_BIN`)
- A **Clerk application** with its keys for the hosted sign-up/sign-in pages; the
  legacy built-in email/password flow (`/login`, `/register`) is still present for
  existing accounts and tests.

### 1. Clone & install

```bash
git clone https://github.com/Parag1337/MegaTube.git
cd MegaTube
npm install
```

### 2. Configure environment

```bash
cp env.example .env
npm run keygen    # prints "MEGA_SESSION_ENCRYPTION_KEY=..." — paste it into .env
```

Add the Clerk keys to `.env` and adjust the optional knobs (see the table below).

### 3. Prepare the database

Create a local PostgreSQL database (PostgreSQL 14+; Neon is used in production)
and point `DATABASE_URL` at it:

```bash
# Example: local cluster on port 5433
createuser megatube --createdb   # or: CREATE ROLE megatube LOGIN CREATEDB;
createdb megatube -O megatube    # or: CREATE DATABASE megatube OWNER megatube;
psql -c "ALTER ROLE megatube PASSWORD '...'"

npx prisma migrate deploy
```

This applies the included migrations (schema, indexes, pg_trgm search
structures, product tables). `CREATE EXTENSION pg_trgm` inside the search
migration requires the PostgreSQL contrib package on self-hosted servers
(`postgresql-contrib` on Fedora/Debian); managed providers like Neon ship it.

### 4. Run it

```bash
npm run dev
# → http://localhost:3000
```

For a production-style server run `npm run build && npm start`.

**First run:** sign up (or log in), open **Account → MEGA accounts → Add MEGA
account**, enter your MEGA credentials, and the first sync starts automatically.
Your private library appears on Home / Library as soon as videos finish indexing.

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | PostgreSQL connection string (local dev: `postgresql://...localhost:5433/megatube`; production: Neon **pooled** URL) |
| `MEGA_SESSION_ENCRYPTION_KEY` | ✅ for MEGA linking | 64-hex AES-256-GCM envelope key — `npm run keygen` |
| `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | for Clerk sign-in/up | Clerk API + publishable keys |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL`, `NEXT_PUBLIC_CLERK_SIGN_UP_URL`, `NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL`, `NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL` | with Clerk | Clerk route/redirect configuration |
| `AUTH_PEPPER` | — | optional pepper for legacy password hashing |
| `VIDEOS_PER_PAGE` | — | default 24 |
| `MEGA_SYNC_INTERVAL_MS` | — | auto-resync interval (default 6 h) |
| `MEGA_SYNC_CONCURRENCY` | — | max simultaneous sync jobs (default 1) |
| `MEDIA_CACHE_MAX_BYTES` | — | remux cache cap (default 5 GiB, accepts `KB/MB/GB/TB`) |
| `MEDIA_CACHE_EVICTION_INTERVAL_MS` / `MEDIA_CACHE_TOUCH_INTERVAL_MS` / `MEDIA_CACHE_EVICTION_GRACE_MS` / `MEDIA_CACHE_EVICTION_DISABLED` | — | cache-eviction tuning |
| `FFMPEG_BIN` | — | override the ffmpeg binary path |
| `MEGA_TEST_EMAIL` / `MEGA_TEST_PASSWORD` (+ `_B` variants) | test-only | a **dedicated** MEGA test account for integration tests; tests skip when unset |

> 🔒 **Never commit `.env`.** Use real values only on machines you control, and
> point integration tests at a throwaway MEGA test account — never a personal one.

## 🧪 Testing

MegaTube ships three test layers:

| Layer | Command | What it covers |
| --- | --- | --- |
| Unit | `npm run test:unit` | media route, remux, cache, source acquisition, search (FTS + boolean), shuffle stability, sync (worker/queue/scheduler/reconcile), home feed, thumbnails/repair, auth, envelope encryption, and more |
| Integration | `npm run test:integration` | real MEGA linking + sync against a **dedicated** MEGA test account — skipped automatically when `MEGA_TEST_EMAIL` / `MEGA_TEST_PASSWORD` are unset |
| E2E | `npx playwright test` (or `scripts/e2e.sh`) | browser journeys: auth + navigation, MEGA-account flows, playback hardening, previews |

```bash
npm test                 # everything (unit + integration)
npm run test:unit        # unit only
npm run test:integration # real-MEGA integration (requires MEGA_TEST_* env)
npm run lint             # ESLint (Next.js core-web-vitals + TypeScript)

# handy local checks
scripts/smoke-test.sh    # boots the dev server and status-checks every route
scripts/check-pages.sh   # page-level content probes
scripts/check-search.sh  # search-result probes
scripts/e2e.sh           # boot + run Playwright suite
```

Unit and integration tests run on `node:test` via `tsx` — no extra test runner
needed. Playwright uses the repo's `playwright.config.mjs` (local Chrome channel).

## 📁 Project Layout

```text
app/
  page.tsx                 → landing (signed-out) / home feed (signed-in)
  api/                     → media · download · thumbs/repair · mega accounts/sync
  │                          · watchlist · saved · history · creators · auth
  library/ search/ watchlist/ account/ creator/[slug]/ video/[slug]/ …
components/                → AppShell, VideoCard/Grid, players, MegaAccountsPanel, …
lib/
  media/                   → remux, cache, container probing, source acquisition
  mega/                    → megajs session, nodes, attributes, envelope, thumbnails
  sync/                    → scheduler, worker, reconcile, queue, progress
  *.ts                     → auth, search, home feed, recommendations, personal, …
prisma/
  schema.prisma            → PostgreSQL schema
  migrations/              → migration history (incl. FTS5 search index)
scripts/                   → keygen, smoke/check probes, e2e runner, backfills
tests/
  unit/                    → node:test suites (tsx)
  integration/             → real-MEGA sync/linking tests
  e2e/                     → Playwright browser suites
data/                      → runtime state: database/, thumbs/, cache-media/
                            (remux cache is git-ignored and regenerable)
proxy.ts                   → Clerk middleware + route protection
instrumentation.ts         → server startup hooks (cache maintenance, temp sweep)
```

The `sdk/` directory is a git submodule with the upstream MEGA C++ SDK sources —
vendored for reference; the Node.js runtime talks to MEGA through **megajs**, not
the C++ SDK.

## 🙏 Acknowledgements

Built on the shoulders of great open-source software: **Next.js**, **React**,
**TypeScript**, **Prisma** + **PostgreSQL**, **Tailwind CSS**, **Clerk**, 
**@vidstack/react**, **megajs**, and of course **ffmpeg** — plus the **MEGA**
service itself for being a reliable home for private files.
