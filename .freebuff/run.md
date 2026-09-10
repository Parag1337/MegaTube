# Run doc — MegaTube (Phase 0)

Next.js 16 (Turbopack) + Prisma 7 (better-sqlite3) video catalog over MEGA public links.

## How to reproduce the artifacts

1. Install dependencies (already present in this checkout):
   ```bash
   npm ci
   ```
2. Environment: `.env` already exists in the repo root (contains `DATABASE_URL`).
   If starting from a fresh checkout, copy `.env` from the main checkout.
3. Database: SQLite at `data/database/app.db`. Schema is applied via
   `prisma/migrations`; verify with `npx prisma migrate status`.
4. Catalog data: import `link.txt` (16 MEGA public links) into the DB and
   download thumbnails into `public/thumbs/`:
   ```bash
   npm run import
   ```
   This is idempotent (upserts by `megaFileId`). The current checkout already
   has 16 videos + 16 cached thumbnails, so this step can be skipped.

## How to run the server

```bash
npm run dev -- --port 3000
```

- IMPORTANT: the desktop environment exports `PORT=0`, which makes Next.js
  bind a random port. Always pass an explicit port as shown above (or
  `PORT=3000 npm run dev`).
- URL: http://localhost:3000
- Video pages: `/video/<slug>` (e.g. `/video/freya-reign-quick-pegging-before-dinner`)

## Validation commands

```bash
npm test                 # node:test unit tests (MEGA URL parsing/embed)
npx tsc --noEmit         # typecheck
npm run lint             # eslint
npm run build            # production build
npx playwright test      # E2E (tests/e2e, Chrome, needs display or headless)
node scripts/probe-preview.mjs   # deep MEGA playback probe (see README in script)
```
