-- CreateTable
CREATE TABLE "MegaAccount" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "megaEmail" TEXT NOT NULL,
    "megaUserId" TEXT,
    "encryptedSession" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CONNECTED',
    "lastAuthenticatedAt" DATETIME,
    "lastSyncStartedAt" DATETIME,
    "lastSyncCompletedAt" DATETIME,
    "lastSyncErrorAt" DATETIME,
    "lastSyncError" TEXT,
    "consecutiveSyncFailures" INTEGER NOT NULL DEFAULT 0,
    "videoCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MegaAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Video" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "megaAccountId" INTEGER,
    "megaUrl" TEXT,
    "megaFileId" TEXT,
    "megaFileKey" TEXT,
    "megaFilename" TEXT NOT NULL,
    "megaNodeId" TEXT,
    "parentNodeId" TEXT,
    "fileKeyEncrypted" TEXT,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "creatorId" INTEGER,
    "fileSize" BIGINT,
    "mimeType" TEXT,
    "duration" INTEGER,
    "thumbnail" TEXT,
    "thumbnailAvailable" BOOLEAN NOT NULL DEFAULT false,
    "embedUrl" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "tags" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Video_megaAccountId_fkey" FOREIGN KEY ("megaAccountId") REFERENCES "MegaAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Video_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Video" ("createdAt", "creatorId", "duration", "embedUrl", "fileSize", "id", "megaFileId", "megaFileKey", "megaFilename", "megaUrl", "mimeType", "slug", "sortOrder", "tags", "thumbnail", "thumbnailAvailable", "title", "updatedAt") SELECT "createdAt", "creatorId", "duration", "embedUrl", "fileSize", "id", "megaFileId", "megaFileKey", "megaFilename", "megaUrl", "mimeType", "slug", "sortOrder", "tags", "thumbnail", "thumbnailAvailable", "title", "updatedAt" FROM "Video";
DROP TABLE "Video";
ALTER TABLE "new_Video" RENAME TO "Video";
CREATE UNIQUE INDEX "Video_slug_key" ON "Video"("slug");
CREATE INDEX "Video_creatorId_idx" ON "Video"("creatorId");
CREATE INDEX "Video_sortOrder_idx" ON "Video"("sortOrder");
CREATE INDEX "Video_title_idx" ON "Video"("title");
CREATE INDEX "Video_megaAccountId_idx" ON "Video"("megaAccountId");
CREATE UNIQUE INDEX "Video_megaAccountId_megaNodeId_key" ON "Video"("megaAccountId", "megaNodeId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "MegaAccount_userId_idx" ON "MegaAccount"("userId");

-- CreateIndex
CREATE INDEX "MegaAccount_status_idx" ON "MegaAccount"("status");

-- CreateIndex
CREATE UNIQUE INDEX "MegaAccount_userId_megaEmail_key" ON "MegaAccount"("userId", "megaEmail");
