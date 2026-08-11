-- Two things the first real production brief proved were missing.
--
-- 1. gate_json — the SCREENING RECORD, not just the verdict.
--
-- A verdict is three or four separate checks. Until now only the combined status
-- and a pipe-joined string of reasons survived; the per-gate status was dropped
-- at `combineVerdict`. So nothing downstream could tell a check that PASSED from
-- the one that failed. The brief showed reason #1 as each row's headline, which
-- meant a role flagged on salary was labelled with its PASSING sponsor line, and
-- /ask handed the model all three gates under the heading "What is unresolved".
-- The founder's verdict on that brief was that he could not tell why any company
-- was on the list. He was right: the information had been destroyed before
-- anything tried to display it.
--
-- Nullable, and every existing row stays NULL. Rows screened before this column
-- existed are read back through a legacy parser that splits `salary_evidence`
-- and reports every gate as "needs a look" — because their status genuinely is
-- unknown, and inventing `pass` would put a row into APPLY TODAY on no evidence.
--
-- text, not jsonb: it is only ever read whole, and text keeps this a plain ADD
-- COLUMN with no rewrite on a live table.
ALTER TABLE agents.job_applications ADD COLUMN IF NOT EXISTS gate_json text;

-- 2. job_ingest_runs — what the pipeline costs, answerable from data.
--
-- Asked on 2026-08-01 how many times this runs and what it costs, the only
-- available answer was arithmetic done by hand over actor pricing pages and a
-- reading of the cron schedule. That is a question about our own system that our
-- own system could not answer, and the hand-built answer goes stale the moment a
-- query count changes.
--
-- One row per paid feed call. A FAILED call gets a row too: the actor start is
-- billed whether or not the run returns anything, so a table that recorded only
-- successes would under-report exactly on the days something is wrong.
CREATE TABLE IF NOT EXISTS agents.job_ingest_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,

  -- Groups every query of one sweep, so a day's cost is one GROUP BY.
  sweep_id uuid NOT NULL,

  feed text NOT NULL,
  pool text NOT NULL,
  track text NOT NULL,

  requested integer NOT NULL,
  returned integer NOT NULL DEFAULT 0,

  screened integer NOT NULL DEFAULT 0,
  passed integer NOT NULL DEFAULT 0,
  flagged integer NOT NULL DEFAULT 0,
  rejected integer NOT NULL DEFAULT 0,

  -- Our arithmetic over the posted per-job and per-start prices. Apify bills on
  -- its own ledger and this table never sees that invoice, so the column is
  -- named "estimated" and must not be read as an accounting record.
  estimated_cost_usd numeric NOT NULL DEFAULT 0,

  error text,

  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jir_tenant_day_idx
  ON agents.job_ingest_runs (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS jir_sweep_idx
  ON agents.job_ingest_runs (sweep_id);
