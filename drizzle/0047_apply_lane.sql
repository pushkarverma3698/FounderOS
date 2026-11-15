-- job_applications.apply_lane*: shadow apply routing (2026-11-15). Plain nullable ADD COLUMN on a live table.
--
-- Additive: nothing reads these until AUTO_APPLY_SHADOW=on and the new code runs; existing rows stay NULL.
-- Rollback (manual, no down migration):
--   ALTER TABLE "agents"."job_applications" DROP COLUMN "apply_lane", DROP COLUMN "apply_lane_reason", DROP COLUMN "apply_lane_at";
-- Safe at any time: the shadow hook only writes these and then reports.
--
-- The journal `when` stays above every earlier entry (tests/unit/db/migration-journal.test.ts).

ALTER TABLE "agents"."job_applications" ADD COLUMN IF NOT EXISTS "apply_lane" text;
ALTER TABLE "agents"."job_applications" ADD COLUMN IF NOT EXISTS "apply_lane_reason" text;
ALTER TABLE "agents"."job_applications" ADD COLUMN IF NOT EXISTS "apply_lane_at" timestamp with time zone;
