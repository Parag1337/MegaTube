-- Add lastSyncMeta to MegaAccount: durable sync result metadata
-- (duration, created/updated/removed counts, outcome) used by the UI to show
-- the final sync result and to recover after server restarts.
ALTER TABLE "MegaAccount" ADD COLUMN "lastSyncMeta" TEXT;
