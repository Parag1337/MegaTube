-- P2.1 corrections: simple user-created folders organizing Saved Videos.
--
-- Additive and non-destructive:
-- - new SavedFolder table (one row per user-created folder);
-- - nullable SavedVideo.folderId (existing rows stay NULL = uncategorized,
--   shown under "All Saved" - no data migration, no backfill needed);
-- - deleting a folder returns its videos to uncategorized (SetNull), never
--   deletes videos or unsaves them.
-- These are application-level folders only - MEGA folder structure is never
-- read, inferred, or exposed here.

-- CreateTable
CREATE TABLE "SavedFolder" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SavedFolder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- AlterTable
ALTER TABLE "SavedVideo" ADD COLUMN "folderId" INTEGER CONSTRAINT "SavedVideo_folderId_fkey" REFERENCES "SavedFolder" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX "SavedFolder_userId_name_key" ON "SavedFolder"("userId", "name");

-- CreateIndex
CREATE INDEX "SavedFolder_userId_createdAt_idx" ON "SavedFolder"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "SavedVideo_userId_folderId_idx" ON "SavedVideo"("userId", "folderId");
