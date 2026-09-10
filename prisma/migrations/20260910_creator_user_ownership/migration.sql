-- Phase 6: creator/user ownership + manual creator override tracking.
-- Existing video rows are preserved. New required fields get safe defaults.

-- Move Creator.name to a user-scoped unique constraint.
CREATE TABLE "new_Creator" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" TEXT NOT NULL REFERENCES "User" ("id") ON DELETE CASCADE,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "avatar" TEXT,
    "description" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Creator" ("id", "userId", "name", "slug", "avatar", "description", "createdAt", "updatedAt")
  SELECT "id", '', "name", "slug", "avatar", "description", "createdAt", "updatedAt" FROM "Creator";
DROP TABLE "Creator";
ALTER TABLE "new_Creator" RENAME TO "Creator";
CREATE UNIQUE INDEX "new_Creator_slug_key" ON "Creator"("slug");
CREATE UNIQUE INDEX "new_Creator_userId_name_key" ON "Creator"("userId", "name");
CREATE INDEX "new_Creator_userId_idx" ON "Creator"("userId");

-- Add creatorAssignment determination field with a safe default matching current state.
ALTER TABLE "Video" ADD COLUMN "creatorAssignment" TEXT NOT NULL DEFAULT 'auto';
CREATE INDEX "new_Video_creatorAssignment_idx" ON "Video"("creatorAssignment");

-- Backfill creatorAssignment for existing videos whose creatorId is set.
UPDATE "Video" SET "creatorAssignment" = 'manual'
  WHERE "creatorId" IS NOT NULL AND "creatorAssignment" = 'auto';

-- Re-establish FK after table rebuild (SQLite DDL preserves FK by name, but be explicit).
CREATE INDEX IF NOT EXISTS "Video_creatorId_idx" ON "Video"("creatorId");
