import Database from 'better-sqlite3';

const db = new Database('data/database/app.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = OFF');

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS "new_Creator" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "userId" TEXT NOT NULL,
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

    CREATE UNIQUE INDEX IF NOT EXISTS "Creator_slug_key" ON "Creator"("slug");
    CREATE UNIQUE INDEX IF NOT EXISTS "Creator_userId_name_key" ON "Creator"("userId", "name");
    CREATE INDEX IF NOT EXISTS "Creator_userId_idx" ON "Creator"("userId");

    ALTER TABLE "Video" ADD COLUMN "creatorAssignment" TEXT NOT NULL DEFAULT 'auto';
    CREATE INDEX IF NOT EXISTS "Video_creatorAssignment_idx" ON "Video"("creatorAssignment");
    UPDATE "Video" SET "creatorAssignment" = 'manual' WHERE "creatorId" IS NOT NULL AND "creatorAssignment" = 'auto';
  `);
  console.log('Phase 6 migration applied.');
} finally {
  db.close();
}
