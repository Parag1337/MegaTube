-- P1.3: native SQLite FTS5 search index for videos.
--
-- Replaces full-table LIKE '%q%' scans (one SCAN per search plus a second
-- SCAN for the COUNT) with an FTS5 trigram index. Trigram preserves the
-- current substring semantics (including mid-word and case-insensitive
-- matching); queries with sub-3-character tokens keep the old LIKE path in
-- application code (FTS5 trigrams cannot index those).
--
-- Design notes:
-- - Plain (non-external-content) FTS table keyed by Video.id (rowid), kept
--   in sync by SQLite triggers. Triggers cover EVERY write path (sync
--   engine, manual creator assignment, creator rename/delete, account
--   removal) with no application-code changes, so the index can never drift.
-- - Ownership isolation is NOT stored in the FTS table (user ids must never
--   go through the stemmer/tokenizer); the search query JOINs Video and
--   applies the exact same ownership predicate as the LIKE path.
-- - The table is intentionally not a Prisma model: it is queried with bound
--   $queryRaw parameters only. Prisma ignores unknown tables for drift.

CREATE VIRTUAL TABLE "VideoSearch" USING fts5("title", "filename", "creator", tokenize='trigram remove_diacritics 2');

-- Backfill existing rows (creator name denormalized, '' when unassigned).
INSERT INTO "VideoSearch"(rowid, "title", "filename", "creator")
  SELECT "v"."id", "v"."title", "v"."megaFilename", COALESCE("c"."name", '')
  FROM "Video" "v" LEFT JOIN "Creator" "c" ON "c"."id" = "v"."creatorId";

-- Keep the index in sync with Video writes.
CREATE TRIGGER "VideoSearch_ai" AFTER INSERT ON "Video" BEGIN
  INSERT INTO "VideoSearch"(rowid, "title", "filename", "creator")
    VALUES (
      NEW."id",
      NEW."title",
      NEW."megaFilename",
      COALESCE((SELECT "name" FROM "Creator" WHERE "id" = NEW."creatorId"), '')
    );
END;

CREATE TRIGGER "VideoSearch_ad" AFTER DELETE ON "Video" BEGIN
  DELETE FROM "VideoSearch" WHERE rowid = OLD."id";
END;

CREATE TRIGGER "VideoSearch_au" AFTER UPDATE OF "title", "megaFilename", "creatorId" ON "Video" BEGIN
  DELETE FROM "VideoSearch" WHERE rowid = OLD."id";
  INSERT INTO "VideoSearch"(rowid, "title", "filename", "creator")
    VALUES (
      NEW."id",
      NEW."title",
      NEW."megaFilename",
      COALESCE((SELECT "name" FROM "Creator" WHERE "id" = NEW."creatorId"), '')
    );
END;

-- Creator renames propagate to the denormalized creator column.
CREATE TRIGGER "VideoSearch_creator_au" AFTER UPDATE OF "name" ON "Creator" BEGIN
  UPDATE "VideoSearch" SET "creator" = NEW."name"
    WHERE rowid IN (SELECT "id" FROM "Video" WHERE "creatorId" = NEW."id");
END;

-- Defensive: the app unassigns videos before deleting a creator, but a
-- creator row must never leave stale names behind if that order changes.
CREATE TRIGGER "VideoSearch_creator_ad" AFTER DELETE ON "Creator" BEGIN
  UPDATE "VideoSearch" SET "creator" = ''
    WHERE rowid IN (SELECT "id" FROM "Video" WHERE "creatorId" = OLD."id");
END;
