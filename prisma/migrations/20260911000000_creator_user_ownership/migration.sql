-- Creator/channel user-scoping (Phase 6 schema, applied manually during dev;
-- this migration makes the state reproducible on fresh databases).
-- Existing Creator rows are re-owned via the Video -> MegaAccount -> User
-- chain. Orphaned creators (no videos) are removed because there is no safe
-- way to assign them to a user without inventing ownership.
-- Video.creatorAssignment: 'none' (unassigned) | 'auto' (filename-derived) |
-- 'manual' (explicit user override; sync never overwrites it).

-- AlterTable
ALTER TABLE "Video" ADD COLUMN "creatorAssignment" TEXT DEFAULT 'none';

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Creator" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "avatar" TEXT,
    "description" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Creator_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- Derive userId for existing creators from the first video that references
-- them. Creators with no videos get an empty-string placeholder and are
-- removed in the DELETE below so the NOT NULL constraint is never violated.
INSERT INTO "new_Creator" ("id", "userId", "name", "slug", "avatar", "description", "createdAt", "updatedAt")
SELECT
    "c"."id",
    COALESCE(
        (SELECT "ma"."userId"
         FROM "MegaAccount" "ma"
         INNER JOIN "Video" "v" ON "v"."megaAccountId" = "ma"."id"
         WHERE "v"."creatorId" = "c"."id"
           AND "v"."megaAccountId" IS NOT NULL
         LIMIT 1),
        ''
    ) AS "userId",
    "c"."name",
    "c"."slug",
    "c"."avatar",
    "c"."description",
    "c"."createdAt",
    "c"."updatedAt"
FROM "Creator" "c";
DELETE FROM "new_Creator" WHERE "userId" = '';
DROP TABLE "Creator";
ALTER TABLE "new_Creator" RENAME TO "Creator";
CREATE INDEX "Creator_userId_idx" ON "Creator"("userId");
CREATE UNIQUE INDEX "Creator_userId_slug_key" ON "Creator"("userId", "slug");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
