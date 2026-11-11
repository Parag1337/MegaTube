# Neon → Render PostgreSQL Migration Plan (Phase 0 inventory)

Status: **plan** — written before any production configuration is modified.
Committed work preserved: everything from `c4ea6e8` (perf investigation fixes) stays intact.

---

## 1. Original database architecture

| Aspect | Current state |
|---|---|
| Local dev | Fedora 44, local PostgreSQL 18.6 on `:5433` (`megatube` / `megatube-dev-only`), config via `.env` (which currently points at Neon) |
| Production | Neon PostgreSQL, pooled endpoint at runtime; direct (non-pooler) endpoint for migrations |
| ORM | Prisma 7 (`prisma-client` generator, output `../generated`) with the `pg` driver adapter (`@prisma/adapter-pg`), shared client in `lib/db.ts` |
| Media | MEGA stores original files — unchanged by this migration |
| Auth | Custom session table (`Session`, cookie `session_token`), Clerk user linkage via `User.clerkUserId`, password hashes peppered with `AUTH_PEPPER`, MEGA session material AES-256-GCM encrypted (`MegaAccount.encryptedSession`, `Video.fileKeyEncrypted`) |
| Render | **No Render configuration exists in the repo yet** (no `render.yaml`, no Render docs). Deployment is presumably manual/dashboard-based. |

## 2. Production Neon facts (read-only probes, 2026-11-11)

- **PostgreSQL 18.6** (server), extensions: `pg_trgm 1.6`, `plpgsql 1.0` — nothing else. No Neon-specific features used by the schema (all plain SQL; the search migration was explicitly written Neon-compatible).
- **Database size: 13 MB.** Top tables: `VideoSearch` 3 MB, `Video` 1 MB.
- **Row counts:** Creator 264, MegaAccount 5, SavedFolder 0, SavedVideo 0, Session 1, User 30, Video 920, VideoSearch 920, WatchHistory 144, WatchlistItem 5, `_prisma_migrations` 2.
- **Sequences (with gaps — must be restored via `setval`, not left at defaults):** Creator=264, MegaAccount=5, SavedFolder=NULL, SavedVideo=1, Video=1340, WatchHistory=295, WatchlistItem=34.
- Local `pg_dump`/`pg_restore`/`psql` are **18.6** — exactly matching the server; dump/restore fully supported.
- Known perf profile (from `c4ea6e8` investigation): warm query ~390–520 ms (network RTT ~400 ms), new connection 4–5 s, compute wake 4–10 s.

## 3. Data model (prisma/schema.prisma)

9 application models + Prisma internals:

- **User** (id: cuid String) — unique `email`, unique nullable `clerkUserId`, `passwordHash`
- **Session** — unique `token`, FK→User (cascade), indexed `userId`
- **MegaAccount** — FK→User (cascade); unique `(userId, megaEmail)`; `encryptedSession` (AES-256-GCM envelope "v1.<base64url(iv|ct|tag)>"); status lifecycle fields; denormalized `videoCount`; `lastSyncMeta` JSON string
- **Video** — FK→MegaAccount (cascade), FK→Creator; unique `slug`, unique `(megaAccountId, megaNodeId)`; `fileKeyEncrypted` (per-video encrypted MEGA file key); indexes `(creatorId, createdAt)`, `sortOrder`, `title`, `(megaAccountId, createdAt)`
- **Creator** — FK→User (cascade); unique `(userId, slug)`
- **WatchlistItem** — FK→User/Video (cascade); unique `(userId, videoId)`
- **SavedVideo** — FK→User/Video (cascade), FK→SavedFolder (SetNull); unique `(userId, videoId)`
- **SavedFolder** — FK→User (cascade); unique `(userId, name)`
- **WatchHistory** — FK→User/Video (cascade); unique `(userId, videoId)`; indexed `lastWatchedAt`
- **VideoSearch** (created by migration, not a Prisma model) — plain table keyed by `Video.id` with a **generated tsvector column** (`GENERATED ALWAYS AS ... STORED`) and **SQL triggers** keeping `title/filename/creator/alltext` in sync with `Video`/`Creator`; accelerated by `pg_trgm` GIN indexes.

No Playlists/UserSettings tables exist (checked: not in schema, not in production). Session/auth persistence is entirely DB-backed (`lib/auth.ts` reads/writes `Session`).

## 4. Migration history

1. `20260914140755_init_postgres` — all tables, FKs, indexes (plain SQL)
2. `20260914150000_postgres_search` — `CREATE EXTENSION pg_trgm`, `VideoSearch` table + generated tsvector + triggers

`provider = "postgresql"` in `migration_lock.toml`. Target = `prisma migrate deploy` against the Render database (never `db push`).

## 5. Every Neon-specific reference (repo-wide grep, excluding node_modules/.next-perf build artifacts)

**Documentation only (safe; update in Phase 9):**
- `README.md` — lines ~131, 395, 410, 429 (setup/deploy docs mention Neon as production host)
- `env.example` — lines 3–14 (describes Neon pooled/direct URL usage)
- `docs/LOCALHOST-PERFORMANCE-INVESTIGATION.md`, `docs/` perf docs — historical measurements
- `lib/db.ts`, `lib/videos.ts`, `lib/homeFeed.ts`, thumbs route, video page, `components/useSession.tsx` — code comments mentioning Neon
- `scripts/latency-proxy.mjs`, `scripts/measure-compare.mjs` — comments describing benchmark methodology
- `tests/unit/perf-fixes.test.ts:171` — a Neon-host *test string* used as a fixture for `isRemoteDatabaseUrl` (host-pattern-based remote detection, not a real dependency)

**Functional (no actual Neon SDK dependency):**
- `.env` `DATABASE_URL` — the only place Neon credentials exist. There is **no `@neondatabase/*` npm dependency**; the app uses generic `pg` + Prisma adapter. No feature depends on Neon-specific behavior (checked: no Neon branches/headers/endpoints in code).

**Conclusion:** Neon is referenced through config/docs only. Removing it is a config + documentation change, not a code change.

## 6. Compatibility with Render Managed PostgreSQL

| Concern | Verdict |
|---|---|
| PostgreSQL version | Target Render PG **17 or 18** (18 preferred to match source exactly). Schema is PG 12+ compatible (generated columns), `pg_trgm` available on Render. |
| Extensions | `pg_trgm` ships in Render's PostgreSQL image. |
| Connection limits | Neon pooler had its own limits; Render internal DB exposes the real Postgres. App default `PG_POOL_MAX=25` is safe on any paid/hobby plan instance ≥ 25 connections. Verify chosen plan's connection limit before cutover. |
| `sslmode` | Render Internal Database URL (`dpg-...-a` internal hostname) typically does **not** require TLS inside the network but supports it. `lib/db.ts` remote-URL detection may classify the internal URL as remote — must verify at Phase 5 (this only affects keepalive/idle-timeout knobs, which are harmless on an internal network). |
| Prisma 7 + `pg` adapter | Works with any vanilla PostgreSQL; adapter has no Neon coupling. |
| Migrations | `prisma migrate deploy` with the Internal Database URL; Render has no pooled-endpoint issue (advisory locks work directly). |

## 7. Execution plan

- **Phase 2 — Local dev config:** create `.env.local` with the local DB (developer's existing `:5433` cluster, already migrated, left untouched); verify `.gitignore` covers `.env*` (it does); document fresh-local-DB init; keep the dev remote-DB warning from `c4ea6e8` (`lib/db.ts` warns when `DATABASE_URL` is remote during dev).
- **Phase 3 — Backup:** `pg_dump` the Neon **direct** (non-pooler) endpoint, custom format, into a gitignored location (`/data/backups/` — add ignore entry). Verify: `pg_restore --list`, restore into a scratch local DB, compare row counts to §2. Do not print any secret values; dump file itself contains secrets — keep it out of Git.
- **Phase 1 — Render database (user manual step):** create Render Managed PostgreSQL in the same region as the Web Service (region must match to get sub-ms internal RTT); take the **Internal Database URL**; wait for the user to supply it.
- **Phase 4 — Migration:** `prisma migrate deploy` on Render → `pg_restore --data-only` (or generated COPY) → verify all row counts/sequences/relationships against §2 → probe app read/write. Note: `VideoSearch` rows repopulate via triggers when `Video` data loads (COPY fires row triggers); verify count 920 after restore, with re-sync fallback (`DELETE FROM "VideoSearch"` + insert-select) if needed.
- **Cutover consideration:** the app has *at most* 30 users and 1 live session; background MEGA syncs can write at any time. Proposed safe cutover: set `MEGA_SYNC_DISABLED=1` (verify exact env name) + brief write freeze → final delta dump (counts diff) → flip `DATABASE_URL` → deploy → unfreeze. Full detail in the Phase 8 checklist.
- **Phase 5 — Integration:** point app at Internal URL; review `lib/db.ts` keepalive against internal network (Render internal RTT ≈ sub-ms — warm-keepalive likely unnecessary, but do not blindly remove; the remote-URL detection may still classify it as remote and apply the idle-hold, which is harmless internally); re-verify all DB-backed endpoints.
- **Phase 6 — Benchmarks:** Neon baseline numbers already exist from `c4ea6e8`; measure the same set against the Render deployment with the same dataset/methodology.
- **Phase 7 — Regression:** full unit+integration suite; E2E anonymous-homepage drift stays classified separately.
- **Phase 8 — Cutover checklist + rollback:** Neon untouched and remains rollback source (rollback = point `DATABASE_URL` back at Neon pooled URL and redeploy; any writes made on Render in the meantime would need re-copying).
- **Phase 9 — Neon removal:** docs/env.example/comment updates only, after verified cutover + explicit user approval.

## 8. Risks & mitigations

1. **Sequence gaps** — restore must `setval` each sequence to the dumped value (custom-format data-only dumps include this; verify after restore).
2. **Encrypted values** — `MegaAccount.encryptedSession`, `Video.fileKeyEncrypted`, `User.passwordHash`, `Session.token` must transfer byte-for-byte (raw COPY does this; never regenerate).
3. **`MEGA_SESSION_ENCRYPTION_KEY` / `AUTH_PEPPER`** — must be set to the *same values* in Render env vars, or all MEGA sessions/decrypts fail. They exist in `.env` today; the user must copy them into the Render dashboard (we will not print them).
4. **Trigger/generated-column table** — `VideoSearch` must be verified post-restore (row count + a representative ILIKE search).
5. **Secrets hygiene** — the dump contains hashes/sessions; store gitignored, restrict read permissions, delete after user confirms migration success (their call).
6. **Region mismatch** — if the Render DB is not in the same region as the Web Service, we reintroduce a Neon-like RTT problem; must confirm same region before benchmarking claims.

---

## Progress log

### Phase 0 — DONE (2026-11-11)
Repo inspected; all §5 references identified; no Render config exists in the repo; no Neon SDK dependency; production facts in §2. This plan written before any production config change.

### Phase 2 — Local dev configuration — DONE, then superseded by the final architecture decision (2026-11-11)
Initial implementation used `.env.local` (documented below). The user's final
architecture decision consolidated this: **`.env` is the single local environment
file** (`DATABASE_URL` = local PostgreSQL), `.env.local` and the migration-only
`.env.render` were removed, and `prisma.config.ts` reverted to plain
`import 'dotenv/config'` (which reads `.env`). The Render target URL is kept as a
`RENDER_DATABASE_URL` variable in `.env` (git-ignored) purely for local
verification scripts; the production app itself reads `DATABASE_URL` from the
Render dashboard only. The steps below are kept as the historical record:
- Created `.env.local` (git-ignored, covered by `.env*` in `.gitignore`) pointing at the developer's existing local cluster `localhost:5433/megatube`. Next.js precedence: shell > `.env.local` > `.env`. Shell exports still allow a one-off override.
- `prisma.config.ts` now loads `.env.local` before `.env` (dotenv `override: false`), so Prisma CLI commands (`migrate deploy/reset/status`) act on the same DB the dev server uses.
- `.gitignore`: added `/data/backups/*` for the production dump.
- README: documented `.env.local` usage, fresh-local-DB init (`createdb` + `migrate deploy`), and the remote-URL dev warning.
- Local DB maintenance: the local `megatube` DB had the correct schema but no `_prisma_migrations` bookkeeping (it was created without Prisma's migration history). Both migrations were baselined with `prisma migrate resolve --applied` (bookkeeping rows only — no schema or data changed). `prisma migrate status` now reports "Database schema is up to date!" against the local DB. **Note for the user: after the dev server restarts, it will use the local DB from `.env.local` instead of Neon; its MEGA accounts/videos live only in the Neon DB.**

### Phase 3 — Verified Neon backup — DONE (2026-11-11)
- Method: `pg_dump` (read-only) against the Neon **direct** (non-pooler) endpoint, custom format, `--no-owner --no-privileges`. The connection string was computed from `.env` at runtime and never printed.
- Location: `data/backups/neon-production-20261111.dump` (305 KB; mode 600, directory 700, git-ignored).
- SHA-256: `f1d78826401923367abfa143c540a1fd180e78da58047cab4a145005bf9b97e4` (recorded in `data/backups/neon-production-20261111.dump.sha256`).
- Verification: restored into a scratch database (`megatube_backup_verify`, since dropped) on the local cluster → **all 10 tables with exact row counts** (§2 numbers matched), **sequences identical including gaps** (Video=1340, WatchHistory=295, WatchlistItem=34, SavedVideo=1, Creator=264, MegaAccount=5), `pg_trgm` present, `VideoSearch` generated tsvector populated for all 920 rows, search triggers present, encrypted payloads (`encryptedSession` ×4 non-empty, `fileKeyEncrypted` ×920) transferred intact (lengths only — contents never printed). **VERIFY_OK.**
- Neon source was never modified: only `SELECT`/`pg_dump` traffic ever touched it.

### Phase 1 — Render PostgreSQL — PARTIALLY DONE (user created the database)
User created the Render Managed PostgreSQL and provided connection details:
- Service ID `dpg-dbq4dfijnfac73f30r50-a`, database `megatube_prod`, user `megatube_prod_user`
- **PostgreSQL 18.6** — exact version match with Neon
- Region: **Singapore (Southeast Asia)** — user must confirm the MegaTube Web Service is in the same region (required for the sub-ms internal RTT assumption)
- `max_connections=100`; `pg_trgm` available (installed by the search migration)
- Credentials stored in `.env.render` (git-ignored via `.env*`, mode 600); internal URL documented there for the app; external URL used for local tooling
- Pending from user: confirmation that the Web Service region is Singapore

### Phase 4 — Migration execution — DONE (2026-11-11)
1. **Schema**: `prisma migrate deploy` applied both migrations (`init_postgres`, `postgres_search`) to `megatube_prod` — schema created from migration history, never `db push`.
2. **Data copy**: `pg_restore --data-only` from the verified backup (`neon-production-20261111.dump`), with `_prisma_migrations` and `VideoSearch` data blocks excluded (VideoSearch repopulates from its triggers) and blocks ordered FK-safe (User → Session → Creator → MegaAccount → Video → children), executed in a single psql transaction.
   - Two restore pitfalls hit and solved (documented for reproducibility): (a) pg_restore/pg_dump plain output force an empty `search_path`, which broke the unqualified references inside the `videosearch_sync_video` trigger — fixed by `SET search_path = public, pg_catalog;` after removing the dump's `set_config('search_path','',false)` line; (b) FK-ordering required a custom block order.
3. **Integrity verification (all passed)**:
   - Row counts exact: User 30, Session 1, Creator 264, MegaAccount 5, Video 920, VideoSearch 920 (trigger-populated), WatchHistory 144, WatchlistItem 5, SavedFolder 0, SavedVideo 0
   - Sequences exact incl. gaps: Video=1340, WatchHistory=295, WatchlistItem=34, SavedVideo=1, Creator=264, MegaAccount=5
   - Encrypted/sensitive payloads intact: 4/5 `MegaAccount.encryptedSession` `v1.` envelopes (5th empty in source), 920/920 `Video.fileKeyEncrypted` `v1.` envelopes, 30/30 `passwordHash`, 1/1 session token
   - Relationships join cleanly (5 MEGA accounts ↔ users, 920 videos owned, 144 history joins, 264 creator joins); `VideoSearch` trigger sync: 0 mismatches; ILIKE probe 903 (identical to Neon baseline); tsvector probe 76
   - Live Neon re-checked after restore: **no drift** since the backup
4. **Application-stack verification**: Prisma 7 + `@prisma/adapter-pg` connected to Render, `SELECT 1` OK (1.5 s over WAN incl. fresh TLS), transactional write test OK (insert → trigger populated `VideoSearch` → FKs/triggers/sequence all worked). The probe row (id 1341) was cleaned up and `Video_id_seq` reset to 1340 so the target state byte-matches Neon.
5. Neon source untouched throughout (only `pg_dump`/`SELECT` traffic).

Write-freeze / cutover procedure still required at cutover time (MEGA syncs can write concurrently) — see Phase 8 checklist.

### Phase 6 — Benchmarks (database-level) — PARTIAL (2026-11-11)
Method: `scripts/bench-db-migration.mjs` — same machine, same script, same dataset (Render is a verified copy of Neon), minutes apart, both over external WAN with TLS. p50/p95/p99/max in ms.

| Measurement | Neon (us-east-2) | Render PG (Singapore, external) | Delta |
|---|---|---|---|
| Fresh connection (p50) | 4428 | 1739 | **2.5× faster** |
| Fresh connection (max) | 5836 | 2457 | 2.4× |
| Warm SELECT 1 (p50) | 410 | 106 | **3.9× faster** |
| Warm SELECT 1 (p95) | 1098 | 300 | 3.7× |
| Warm SELECT 1 (max) | 3066 | 391 | 7.8× |
| Homepage query (p50) | 411 | 204 | 2.0× |
| Homepage query (p95) | 1844 | 295 | 6.3× |
| Video by slug (p50) | 410 | 205 | 2.0× |
| Search ILIKE (p50) | 413 | 205 | 2.0× |
| Session lookup (p50) | 410 | 204 | 2.0× |
| 50-concurrent burst (total) | 5179 | 4120 | 1.3× |

Honest attribution:
- Both measurements are **external WAN from the developer's machine** — the real production path (app on Render → Internal Database URL) will be strictly faster than the Render column here (internal RTT is sub-ms vs ~100–200 ms WAN RTT).
- Neon p95 spikes (1–3 s) are consistent with its serverless compute behavior (suspend/wake and connection churn); Render external shows no such spikes in this window.
- App-level (homepage/auth/library through the built app) benchmark vs the `c4ea6e8` Neon baseline is still pending and will be run against a local production build pointing at Render before cutover; a production-on-Render measurement after deploy completes the picture.
- Dataset was identical (verified copy); no benchmark writes touched Neon.

### Phase 5 — Application integration — REVIEWED (code side), pending on-Render verification
- All `c4ea6e8` fixes retained: shared Prisma client (`lib/db.ts`), auth TTL memo (`lib/user-memo.ts`), MEGA single-flight (`lib/sync/session-cache.ts`), PERF_TRACE (`lib/observe.ts`). No behavior changed.
- Keepalive review vs Render internal network: `lib/db.ts` classifies any non-localhost host as remote, so the Render Internal URL still gets the warm-keepalive (2 connections, 60 s ping) and the 65 s idle hold. On Render's internal network this is harmless (sub-ms pings, ~2 connections of overhead against `max_connections=100`) and still protects against cold bursts after deploy/restart. **Decision: keep as-is; re-check with PERF_TRACE after the production deploy before any tuning.**
- Pool sizing: `PG_POOL_MAX=25` default vs Render `max_connections=100` — safe.
- Region: user confirmed Web Service and PostgreSQL are both Singapore.

### Phase 7 — Regression testing — MOSTLY DONE (2026-11-11)
- **Unit: 599 pass / 0 fail** (`npm run test:unit`).
- **Integration: 5/5 skipped** — by design; requires the optional dedicated MEGA test account (`MEGA_TEST_EMAIL`/`MEGA_TEST_PASSWORD` unset). Same as baseline.
- **TypeScript (`tsc --noEmit`): one error, in `app/api/auth/[...nextauth]/route.ts`** — the user's unfinished NextAuth WIP (imports a `handlers` export that `lib/auth` has never had). Pre-existing, untouched per constraint.
- **ESLint: clean for all migration-touched files.** Added `.next-perf/**` and `generated/**` to the ESLint ignores (build artifacts; `.next/` was already ignored). Remaining: 1 error (the same WIP file) + ~119 pre-existing warnings in tests/scripts.
- **Production build (`npm run build`): fails ONLY because of the WIP file** (same `handlers` import). Verified otherwise green by temporarily setting `app/api/auth/[...nextauth]/` aside (checksum-verified byte-identical restore, nothing modified): **build exit 0**.
- **E2E (Playwright):** dev-server slot was occupied by the user's running :3000 server (Next dev refuses a second instance for the same dir — the user's server was NOT touched), so the suite ran against `next start` (production build) on :3213 with the local `.env` database.
  - The **full suite** (all 5 spec files incl. playback-hardening and preview stress tests) runs very slowly in this environment (~15+ min, test retries on failures); it was stopped by the agent at the user's request and re-scoped.
  - **Focused subset** (`auth-navigation.spec.mjs` + `mega-accounts.spec.mjs` — login/logout/session, MEGA account API auth, ownership isolation, library redirect): **3 passed / 20 failed / 1 skipped**.
  - **Failure classification (verified, not caused by this migration):** every failure is *pre-existing expectation drift* — the spec (last modified 2026-09-13) automates the legacy email/password auth UI (`/register` and `/login` forms with `input#email`/`input#password`, links `href="/register"`/`href="/login"`), but the auth UI was reworked to Clerk on 2026-09-14 (commit `bd72958`): `/login` and `/register` now only redirect to Clerk's `/sign-in`/`/sign-up`, and no component renders the legacy links or form fields. These tests cannot pass against the current app on ANY database; the agent's diff (comments/docs/fixture host) cannot influence them.
  - **The passes that matter for the migration:** unauthenticated `GET`/`POST /api/mega/accounts` return 401 (session/DB plumbing works through the server), the DB fixture helper connected and cleaned up successfully, and an auth-navigation smoke passed.
  - **Migration-critical auth coverage instead comes from:** the unit suite (599 pass — includes auth/session/ownership/envelope-encryption suites) and the post-cutover browser checks by the user (Clerk login → session → logout) in the Phase 8 checklist section C.
  - **Recommended follow-up (out of scope here):** update the auth E2E specs to drive the Clerk flow, like the already-classified homepage drift.
  - The hardening-suite **anonymous homepage expectation drift** classification is preserved separately (known pre-existing issue, unrelated to this migration).

### Phase 9 — Neon removal — DONE in live code/config (2026-11-11)
Repo-wide `neon` search after cleanup (excluding node_modules, build dirs, `.git`, historical records):
- **Removed from live files:** `env.example` (rewritten: local dev via `.env`, production via Render Internal Database URL), `lib/db.ts` (3 comments), `lib/videos.ts` (2), `lib/homeFeed.ts` (1), `app/video/[slug]/page.tsx` (2), `app/api/media/thumbs/[videoId]/route.ts` (1), `components/useSession.tsx` (1), `scripts/latency-proxy.mjs` + `scripts/measure-compare.mjs` (comments/labels), `tests/unit/perf-fixes.test.ts` (remote-host fixture changed from a Neon host to a Render-style host — test semantics unchanged), `README.md` (2 spots), `.env` header comment.
- **No Neon packages exist**: `package.json`/`package-lock.json` contain no `@neondatabase/*` or `neon` dependencies (the app always used generic `pg` + the Prisma pg adapter). Nothing to uninstall.
- **No Neon deployment config exists**: no `render.yaml` ever existed either; deployment is dashboard-driven.
- **No fallback path**: `DATABASE_URL` is the only database variable consumed by the app and Prisma (`lib/db.ts`, `prisma.config.ts`). Nothing falls back to any provider.
- **Deliberately preserved (historical records, with reasons):**
  - `prisma/migrations/20260914150000_postgres_search/migration.sql` — mentions Neon in a comment; applied migrations are checksum-validated by Prisma and must never be edited.
  - `docs/LOCALHOST-PERFORMANCE-INVESTIGATION.md`, `docs/PHASE-1-2-REPORT.md` — dated measurement records of the Neon era; rewriting history would falsify the record.
  - `scripts/bench-db-migration.mjs` — the A/B benchmark tool itself documents its two subjects (Neon source vs Render target).
  - `docs/NEON-TO-RENDER-MIGRATION-PLAN.md` — this migration record.
- **ARM "NEON" matches in `sdk/` and the color word "neon" in `.agents/skills/` are unrelated** (hardware intrinsics / design vocabulary).

---

## Phase 8 — Production cutover checklist and rollback

### A. Render dashboard configuration (manual, by the user)
On the **MegaTube Web Service → Environment** tab (Singapore service):

1. Set `DATABASE_URL` = the **Internal Database URL** of `megatube_prod`
   (host `dpg-dbq4dfijnfac73f30r50-a`, database `megatube_prod`). The external
   equivalent stored as `RENDER_DATABASE_URL` in the local `.env` carries the
   same credentials; the dashboard's "Internal Database URL" is the value to use.
2. Keep/confirm these variables with their **existing values** (never regenerate):
   `MEGA_SESSION_ENCRYPTION_KEY`, `AUTH_PEPPER`, `CLERK_SECRET_KEY`,
   `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `NEXT_PUBLIC_CLERK_SIGN_IN_URL`,
   `NEXT_PUBLIC_CLERK_SIGN_UP_URL`,
   `NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL`,
   `NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL`, `VIDEOS_PER_PAGE`, and any
   `MEGA_SYNC_*` / `MEDIA_CACHE_*` knobs already configured.
3. Remove any Neon `DATABASE_URL` override from the Web Service env.
4. Save — the env change triggers a new deploy of the current commit.

### B. Write accounting (no data loss)
- The migration copy was taken with **zero drift** vs Neon and re-verified after restore.
- Writers to Neon between the copy and the flip: (a) the old production app until the
  new deploy completes, (b) the developer's local dev server on :3000 — which uses the
  **local** database after its next restart (`.env` now points there), removing it
  from the picture. The dev server was never killed by the agent.
- **Post-flip delta sync** (agent, after the user confirms the deploy):
  1. Re-`pg_dump` Neon (read-only) and diff per-table row counts against the snapshot.
     All equal → no delta, done.
  2. If a delta exists: per-table upsert (COPY into staging + `INSERT ... ON CONFLICT
     DO UPDATE`) for inserts/updates; explicit, individually listed and verified
     deletes; sequences advanced to `max(neon_last_value, render_last_value)`.
     Re-run the full Phase 4 integrity checks afterwards.

### C. Post-cutover verification (agent via public URL + read-only probes; user via browser)
1. Unauthenticated homepage/login return 200 quickly; no connection errors in logs.
2. User performs: login → session persists across reload → logout → immediate 401;
   MEGA account panel loads (existing encrypted sessions must decrypt — same
   `MEGA_SESSION_ENCRYPTION_KEY`); library / history / saved / watchlist read back.
3. Agent verifies writes reach Render (`megatube_prod` row counts move after the
   user's test actions — read-only probes only).
4. Thumbnail + playback spot checks.

### D. Rollback procedure (valid until Neon is explicitly retired)
- Point the Web Service `DATABASE_URL` back at the Neon pooled URL in the Render
  dashboard and redeploy — the old production returns immediately.
- Writes that accumulated on Render after the flip would need re-copying to Neon
  (same upsert procedure, reversed) if they must not be lost.
- Neon is untouched and remains the rollback source. Verified backup:
  `data/backups/neon-production-20261111.dump`
  (SHA-256 `f1d78826401923367abfa143c540a1fd180e78da58047cab4a145005bf9b97e4`).

### E. Neon retirement (agent has no Neon management access — exact dashboard steps)
1. Log in at neon.tech → **Projects** → open the MegaTube project (the one whose
   endpoint host matches the pooled `DATABASE_URL` used until the cutover, `us-east-2`).
2. Confirm Render production is healthy (section C) and no Render env var references
   Neon anymore.
3. Optional but recommended: take one final `pg_dump` from Neon and store it next to
   the verified backup.
4. Project → **Settings** → scroll to **Delete project** → type the project name to
   confirm deletion.
5. The agent cannot perform this deletion (no Neon credentials); it verifies
   retirement from the application side (no code path/config references Neon).
6. Do **not** delete the Render PostgreSQL database (`megatube_prod`).

---

## Completion status summary (2026-11-11)

**Completed and verified:**
- Phase 0 inspection + this plan; Phase 2 local-dev configuration (`.env` → local PostgreSQL; `.env.local`/`.env.render` removed after the final architecture decision)
- Phase 3 verified Neon backup (+ sha256, restore-verified)
- Phase 4 full migration + integrity verification (target byte-equivalent to source; no live drift)
- Phase 5 code-side review (all `c4ea6e8` fixes retained; keepalive harmless on Render internal network)
- Phase 6 database-level A/B benchmarks (Render 2–4× faster over WAN; production-internal will be faster still)
- Phase 7 unit 599/0; integration skipped-by-design; TS/lint/build green except the user's pre-existing NextAuth WIP file; E2E failures classified as pre-existing Clerk-era drift
- Phase 9 Neon removal from all live code/config/docs; no Neon packages or fallback paths exist (there never were any `@neondatabase/*` dependencies)

**Awaiting manual configuration (user, Render dashboard):** Phase 8 section A (env vars + deploy), then section C browser verification.

**Awaiting user approval / action:** post-flip delta sync (section B, agent-run, likely a no-op), Neon retirement (section E).

**Unresolved (pre-existing, unrelated to this migration):**
- NextAuth WIP (`app/api/auth/[...nextauth]/`) breaks `tsc`, lint, and `npm run build` until finished or set aside — the Render deploy of the current commit needs the WIP file removed or completed first.
- E2E auth/homepage spec drift (Clerk-era product changes vs legacy-UI assertions).
- ffmpeg 8.1.3 intermittent size-0 first `moof` (tracked separately via `scripts/bench-playback.mts`).
