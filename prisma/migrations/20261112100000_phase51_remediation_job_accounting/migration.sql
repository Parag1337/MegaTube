-- Phase 5.1 remediation: separate worker claims, generation attempts and
-- recovery events. Additive only; existing rows keep their `attempts` value.
--
--   claimCount    successful claims (including claim-then-crash)
--   attempts      real generation attempts (source acquisition begins)
--   recoveryCount expired-lease / abandoned-worker recoveries

ALTER TABLE "PreviewGenerationJob"
    ADD COLUMN "claimCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PreviewGenerationJob"
    ADD COLUMN "recoveryCount" INTEGER NOT NULL DEFAULT 0;

-- Recovery scans filter on status + expired lease. The existing
-- leaseExpiresAt index is kept; this partial index makes the common
-- generating-only recovery scan cheap as the historical backlog grows.
CREATE INDEX "PreviewGenerationJob_recovery_idx"
    ON "PreviewGenerationJob"("leaseExpiresAt")
    WHERE "status" = 'generating';
