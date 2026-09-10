-- CreateTable
CREATE TABLE "Creator" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "avatar" TEXT,
    "description" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Video" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "megaUrl" TEXT NOT NULL,
    "megaFileId" TEXT NOT NULL,
    "megaFileKey" TEXT NOT NULL,
    "megaFilename" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "creatorId" INTEGER,
    "fileSize" BIGINT,
    "mimeType" TEXT,
    "duration" INTEGER,
    "thumbnail" TEXT,
    "thumbnailAvailable" BOOLEAN NOT NULL DEFAULT false,
    "embedUrl" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "tags" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Video_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Creator_name_key" ON "Creator"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Creator_slug_key" ON "Creator"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Video_megaUrl_key" ON "Video"("megaUrl");

-- CreateIndex
CREATE UNIQUE INDEX "Video_megaFileId_key" ON "Video"("megaFileId");

-- CreateIndex
CREATE UNIQUE INDEX "Video_slug_key" ON "Video"("slug");

-- CreateIndex
CREATE INDEX "Video_creatorId_idx" ON "Video"("creatorId");

-- CreateIndex
CREATE INDEX "Video_sortOrder_idx" ON "Video"("sortOrder");

-- CreateIndex
CREATE INDEX "Video_title_idx" ON "Video"("title");
