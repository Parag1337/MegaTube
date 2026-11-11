-- Phase 5.1: durable, resumable preview generation backlog.
--
-- Additive only: existing Video/MegaAccount/User rows are untouched. Job
-- rows store no MEGA URLs, session material or file keys.

-- Per-user preferences (Settings -> Video Preview Management).
ALTER TABLE "User" ADD COLUMN "previewAutoGenerate" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN "previewPaused" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "PreviewGenerationJob" (
    "id" SERIAL NOT NULL,
    "videoId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'hover',
    "sourceFingerprint" TEXT NOT NULL,
    "generationVersion" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "stage" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "nextRetryAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "lockedBy" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "errorCode" TEXT,
    "artifactBytes" INTEGER,
    "metrics" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PreviewGenerationJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PreviewGenerationJob_idempotencyKey_key"
    ON "PreviewGenerationJob"("idempotencyKey");
CREATE INDEX "PreviewGenerationJob_status_nextRetryAt_priority_idx"
    ON "PreviewGenerationJob"("status", "nextRetryAt", "priority");
CREATE INDEX "PreviewGenerationJob_videoId_kind_idx"
    ON "PreviewGenerationJob"("videoId", "kind");
CREATE INDEX "PreviewGenerationJob_leaseExpiresAt_idx"
    ON "PreviewGenerationJob"("leaseExpiresAt");
CREATE INDEX "PreviewGenerationJob_status_completedAt_idx"
    ON "PreviewGenerationJob"("status", "completedAt");

-- Claim scans only runnable work. The partial index keeps the worker poll
-- cheap as the historical completed/failed backlog grows with the library.
CREATE INDEX "PreviewGenerationJob_runnable_idx"
    ON "PreviewGenerationJob"("priority" DESC, "createdAt" ASC)
    WHERE "status" IN ('pending', 'queued');

ALTER TABLE "PreviewGenerationJob"
    ADD CONSTRAINT "PreviewGenerationJob_videoId_fkey"
    FOREIGN KEY ("videoId") REFERENCES "Video"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
