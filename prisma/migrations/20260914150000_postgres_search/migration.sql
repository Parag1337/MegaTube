-- PostgreSQL search: replaces the archived SQLite FTS5 trigram index
-- (prisma/migrations-sqlite-archive/20260912010000_p1_search_fts) with a
-- design that keeps the same user-visible behavior:
--
--   * substring matching (mid-word), case-insensitive: the "alltext" column
--     concatenates title + filename + creator name and pg_trgm GIN indexes
--     accelerate ILIKE '%term%' probes against it
--   * field weighting title > filename > creator: the generated "search"
--     tsvector stores setweight(to_tsvector('simple', ...), 'A'/'B'/'C')
--     and ts_rank is called with weights {0,1,1,2} (D,C,B,A)
--   * creator synchronization: triggers refresh the search row when a video
--     is inserted/updated/deleted, renamed/reassigned, or when the creator's
--     name changes / a creator is deleted (videos then lose the creator
--     part of their search text, exactly like the SQLite triggers)
--   * Neon-compatible: plain SQL triggers + stored columns only; every
--     extension used here (pg_trgm) is available on Neon.
--
-- The application query layer (lib/search.ts, lib/videos.ts) compiles the
-- boolean AST into plain SQL over these structures; no SQLite MATCH/bm25
-- is used anywhere.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Search representation: one row per Video, kept in sync by triggers.
--   alltext - lower-case-insensitive substring source:
--             title \n megaFilename \n creator-name (maintained by triggers)
--   search  - generated weighted tsvector (title=A, filename=B, creator=C);
--             GENERATED ALWAYS AS makes staleness impossible for the
--             columns stored on this table (title/filename/creator are
--             materialized here by triggers, so renames propagate).
CREATE TABLE "VideoSearch" (
    "id" INTEGER PRIMARY KEY,
    "title" TEXT NOT NULL DEFAULT '',
    "filename" TEXT NOT NULL DEFAULT '',
    "creator" TEXT NOT NULL DEFAULT '',
    "alltext" TEXT NOT NULL DEFAULT '',
    "search" tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce("title", '')), 'A') ||
        setweight(to_tsvector('simple', coalesce("filename", '')), 'B') ||
        setweight(to_tsvector('simple', coalesce("creator", '')), 'C')
    ) STORED
);

-- Trigger bookkeeping -------------------------------------------------------

-- Keep the denormalized title/filename/creator/alltext in VideoSearch in
-- step with Video. alltext concatenates the creator NAME (from the Creator
-- table) so creator renames must recompute the affected rows.
CREATE OR REPLACE FUNCTION "videosearch_sync_video"() RETURNS trigger AS $$
BEGIN
    IF (TG_OP = 'DELETE') THEN
        DELETE FROM "VideoSearch" WHERE "id" = OLD."id";
        RETURN OLD;
    END IF;

    INSERT INTO "VideoSearch" ("id", "title", "filename", "creator", "alltext")
    VALUES (
        NEW."id",
        coalesce(NEW."title", ''),
        coalesce(NEW."megaFilename", ''),
        coalesce((SELECT "c"."name" FROM "Creator" "c" WHERE "c"."id" = NEW."creatorId"), ''),
        coalesce(NEW."title", '') || E'\n' ||
        coalesce(NEW."megaFilename", '') || E'\n' ||
        coalesce((SELECT "c"."name" FROM "Creator" "c" WHERE "c"."id" = NEW."creatorId"), '')
    )
    ON CONFLICT ("id") DO UPDATE SET
        "title" = EXCLUDED."title",
        "filename" = EXCLUDED."filename",
        "creator" = EXCLUDED."creator",
        "alltext" = EXCLUDED."alltext";

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- A creator rename must propagate into the alltext/creator of every video
-- assigned to that creator; deleting a creator empties that part (videos
-- keep their creatorId until ON DELETE SET NULL lands, matching the SQLite
-- behavior where the search text lost the creator term but rows remained).
CREATE OR REPLACE FUNCTION "videosearch_sync_creator"() RETURNS trigger AS $$
BEGIN
    IF (TG_OP = 'DELETE') THEN
        UPDATE "VideoSearch" "vs"
        SET "creator" = '',
            "alltext" = "vs"."title" || E'\n' || "vs"."filename" || E'\n' || ''
        WHERE "vs"."id" IN (SELECT "v"."id" FROM "Video" "v" WHERE "v"."creatorId" = OLD."id");
        RETURN OLD;
    END IF;

    UPDATE "VideoSearch" "vs"
    SET "creator" = NEW."name",
        "alltext" = "vs"."title" || E'\n' || "vs"."filename" || E'\n' || NEW."name"
    WHERE "vs"."id" IN (SELECT "v"."id" FROM "Video" "v" WHERE "v"."creatorId" = NEW."id");
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "VideoSearch_video_ai" AFTER INSERT ON "Video"
    FOR EACH ROW EXECUTE FUNCTION "videosearch_sync_video"();

CREATE TRIGGER "VideoSearch_video_au" AFTER UPDATE ON "Video"
    FOR EACH ROW EXECUTE FUNCTION "videosearch_sync_video"();

CREATE TRIGGER "VideoSearch_video_ad" AFTER DELETE ON "Video"
    FOR EACH ROW EXECUTE FUNCTION "videosearch_sync_video"();

-- Only the name change can affect search text.
CREATE TRIGGER "VideoSearch_creator_au" AFTER UPDATE OF "name" ON "Creator"
    FOR EACH ROW EXECUTE FUNCTION "videosearch_sync_creator"();

CREATE TRIGGER "VideoSearch_creator_ad" AFTER DELETE ON "Creator"
    FOR EACH ROW EXECUTE FUNCTION "videosearch_sync_creator"();

-- Indexes -------------------------------------------------------------------

-- Substring (trigram) acceleration for the ILIKE probes over alltext and
-- the per-field similarity ranking. GIN trgm indexes serve both.
CREATE INDEX "VideoSearch_alltext_trgm_idx" ON "VideoSearch" USING gin ("alltext" gin_trgm_ops);
CREATE INDEX "VideoSearch_title_trgm_idx" ON "VideoSearch" USING gin ("title" gin_trgm_ops);
CREATE INDEX "VideoSearch_filename_trgm_idx" ON "VideoSearch" USING gin ("filename" gin_trgm_ops);
CREATE INDEX "VideoSearch_creator_trgm_idx" ON "VideoSearch" USING gin ("creator" gin_trgm_ops);

-- Full-text ranking (weighted tsvector).
CREATE INDEX "VideoSearch_search_idx" ON "VideoSearch" USING gin ("search");

-- Backfill: existing Video rows (idempotent; triggers keep it current from
-- here on).
INSERT INTO "VideoSearch" ("id", "title", "filename", "creator", "alltext")
SELECT
    "v"."id",
    coalesce("v"."title", ''),
    coalesce("v"."megaFilename", ''),
    coalesce("c"."name", ''),
    coalesce("v"."title", '') || E'\n' ||
    coalesce("v"."megaFilename", '') || E'\n' ||
    coalesce("c"."name", '')
FROM "Video" "v"
LEFT JOIN "Creator" "c" ON "c"."id" = "v"."creatorId"
ON CONFLICT ("id") DO NOTHING;
