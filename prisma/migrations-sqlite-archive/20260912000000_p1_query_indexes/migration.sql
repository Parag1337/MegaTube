-- P1.1: query-driven index tuning (verified with EXPLAIN QUERY PLAN on SQLite).
--
-- 1. Video(creatorId, createdAt): serves the creator page
--    (WHERE creatorId = ? ORDER BY createdAt DESC, id DESC LIMIT n). The old
--    single-column Video_creatorId_idx forced a TEMP B-TREE sort after the
--    seek; the compound index returns rows in createdAt order directly and
--    its leftmost column still serves plain creatorId equality.
-- 2. Video(megaAccountId, createdAt): serves the per-user library queries
--    (per-account seeks, newest first). Same reasoning: replaces the
--    single-column Video_megaAccountId_idx with a strictly more useful
--    compound index (no extra index count).
-- 3. Drop Session_token_idx: redundant with the Session(token) UNIQUE index
--    (Session_token_key), which serves the same token lookups. One less
--    index to maintain on every session write.

DROP INDEX "Video_creatorId_idx";
CREATE INDEX "Video_creatorId_createdAt_idx" ON "Video"("creatorId", "createdAt");

DROP INDEX "Video_megaAccountId_idx";
CREATE INDEX "Video_megaAccountId_createdAt_idx" ON "Video"("megaAccountId", "createdAt");

DROP INDEX "Session_token_idx";
