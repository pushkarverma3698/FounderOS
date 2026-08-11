-- Jobhunt: record how many postings each feed query found that were NEW.
--
-- The feed bills per job RETURNED. On 2026-08-02 the sweep was billed for 32
-- postings, screened 27, cost $0.4682 and added zero rows to job_applications —
-- every one was already stored. Nothing counted new-versus-already-seen, so that
-- morning rendered identically to a productive one.
--
-- Per QUERY rather than per sweep: "which pool still finds new roles" is the
-- question that decides where to cut cost, and job_applications cannot answer it
-- because it never records which query found a row.
--
-- Defaults to 0 so rows written before this column existed stay honest: they did
-- not measure it, and 0 is what we know about them.
ALTER TABLE "agents"."job_ingest_runs"
  ADD COLUMN IF NOT EXISTS "fresh" integer DEFAULT 0 NOT NULL;
