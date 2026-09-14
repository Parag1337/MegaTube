-- P1.2: persist MP4 layout probe results (moov placement / faststart).
-- Nullable with no default: null = unknown (not yet probed). No index:
-- the field is only ever read via the per-video row already in hand.
-- Trust/invalidation is handled in application code (only used when
-- Video.fileSize still matches the fresh MEGA size).

ALTER TABLE "Video" ADD COLUMN "mp4Faststart" BOOLEAN;
