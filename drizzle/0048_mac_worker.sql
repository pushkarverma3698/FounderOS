-- job_applications.mac_*: the Mac worker's lease on a CAPTCHA-blocked row, and agents.mac_worker_beat (2026-11-22).
--
-- Additive: nullable columns plus one new table. Nothing reads them until MAC_WORKER_TOKEN is set and the worker API
-- (src/gateway/mac-worker-api.ts) runs; existing rows stay NULL / 0.
--   mac_lease_id     random id of the current lease; a result must quote it
--   mac_leased_at    when the lease was taken
--   mac_lease_until  lease expiry (30 min; a challenge ping extends it)
--   mac_attempts     leases taken so far; the worker gets a row at most 3 times
--   mac_result       last outcome the worker reported (failed:<reason>, challenge, code_needed)
--   mac_result_at    when
-- Rollback (manual, no down migration):
--   ALTER TABLE "agents"."job_applications" DROP COLUMN "mac_lease_id", DROP COLUMN "mac_leased_at", DROP COLUMN "mac_lease_until",
--     DROP COLUMN "mac_attempts", DROP COLUMN "mac_result", DROP COLUMN "mac_result_at";
--   DROP TABLE "agents"."mac_worker_beat";
-- Safe at any time: with the columns gone the worker API fails its queries and answers 500; nothing else reads them.
--
-- The journal `when` stays above every earlier entry (tests/unit/db/migration-journal.test.ts).

ALTER TABLE "agents"."job_applications" ADD COLUMN IF NOT EXISTS "mac_lease_id" text;
ALTER TABLE "agents"."job_applications" ADD COLUMN IF NOT EXISTS "mac_leased_at" timestamp with time zone;
ALTER TABLE "agents"."job_applications" ADD COLUMN IF NOT EXISTS "mac_lease_until" timestamp with time zone;
ALTER TABLE "agents"."job_applications" ADD COLUMN IF NOT EXISTS "mac_attempts" integer NOT NULL DEFAULT 0;
ALTER TABLE "agents"."job_applications" ADD COLUMN IF NOT EXISTS "mac_result" text;
ALTER TABLE "agents"."job_applications" ADD COLUMN IF NOT EXISTS "mac_result_at" timestamp with time zone;

-- One row per worker ("mac"): when it last checked in. The digest/queue read it through macOnline().
CREATE TABLE IF NOT EXISTS "agents"."mac_worker_beat" (
  "worker_id" text PRIMARY KEY,
  "last_beat_at" timestamp with time zone NOT NULL DEFAULT now()
);
