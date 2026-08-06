-- Jobhunt: count the screening outcomes the ledger was throwing away.
--
-- `IngestLine.outcome` has five values and the ledger counted three. Postings
-- that came back `duplicate` or `error` were counted in `screened` and appeared
-- in no other column, so the columns did not sum to the total and nothing said
-- so. A sweep in which EVERY posting failed the gates was recorded as
-- "27 screened, 0 passed, 0 flagged, 0 rejected" — arithmetically identical to a
-- market that had nothing to offer.
--
-- That ambiguity hid a total screening outage from 2026-08-02 to 2026-08-05. The
-- IND sponsor register stopped resolving in the built output (it was looked up
-- three directories above the module, which is right for src/ and wrong for the
-- dist/src/ that tsc emits), so getSponsorRegister() threw ENOENT on every
-- posting. Four sweeps, ~$0.77 of Apify spend, zero rows, no signal.
--
-- `screen_error` is the GATES failing on postings that arrived fine, and is
-- deliberately separate from `error`, which is the FETCH failing. Both were null
-- on every row of the outage while every posting was failing: the message was
-- present in memory on each line and never written down.
--
-- All three default so rows written before these columns existed stay honest —
-- they did not measure this, and 0/NULL is what we know about them.
ALTER TABLE "agents"."job_ingest_runs"
  ADD COLUMN IF NOT EXISTS "duplicates" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "errored" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "screen_error" text;
