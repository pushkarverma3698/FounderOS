-- job_ingest_runs: persist the free lane's per-stage funnel.
--
-- `runFreeIngest` has always computed these six counts and always thrown them
-- away at the ledger boundary, so the only record was a log line. On 2026-08-21
-- answering "are we dropping roles?" required journalctl on the production box
-- and a regex over 36 hours of output.
--
-- It was worth answering. `stale` was discarding 24,446 postings per sweep while
-- `job_applications` held 554 rows lifetime — so at most 554 of them had ever
-- been seen, and ≥23,892 were open roles that had never been screened once. A
-- funnel that lives only in a log is a funnel nobody queries.
--
-- NULLABLE, deliberately, with no default. The metered ATS/Indeed lane does not
-- compute a funnel, and its rows must read "not measured here" rather than
-- "measured, and everything passed" — the same distinction `screen_error`
-- exists to preserve. IF NOT EXISTS so a re-run is a no-op.

ALTER TABLE agents.job_ingest_runs
  ADD COLUMN IF NOT EXISTS seen integer,
  ADD COLUMN IF NOT EXISTS undated integer,
  ADD COLUMN IF NOT EXISTS stale integer,
  ADD COLUMN IF NOT EXISTS off_track integer,
  ADD COLUMN IF NOT EXISTS off_market integer,
  ADD COLUMN IF NOT EXISTS known integer,
  ADD COLUMN IF NOT EXISTS bodyless integer;
