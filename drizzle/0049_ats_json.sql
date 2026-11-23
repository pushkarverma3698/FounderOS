-- job_applications.ats_json: ATS fit + tailoring result for the auto-apply lane (2026-11-23). Plain nullable ADD COLUMN.
--
-- Additive: nothing reads it until the new code runs; existing rows stay NULL.
-- Rollback (manual, no down migration):
--   ALTER TABLE "agents"."job_applications" DROP COLUMN "ats_json";
--
-- The journal `when` stays above every earlier entry (tests/unit/db/migration-journal.test.ts).

ALTER TABLE "agents"."job_applications" ADD COLUMN IF NOT EXISTS "ats_json" text;
