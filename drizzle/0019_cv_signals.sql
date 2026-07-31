-- 0019 — cv_signals + posting provenance on job_applications
--
-- cv_signals accumulates what the REACHABLE market asks for: only postings that
-- pass the screening gates contribute. It informs the CV and never edits it
-- (ADR-015 — personal-rag stays read-only).
--
-- seen_count is DISTINCT PASSING POSTINGS, not mentions.

CREATE TABLE IF NOT EXISTS agents.cv_signals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  term          text NOT NULL,
  category      text NOT NULL,
  seen_count    integer NOT NULL DEFAULT 0,
  first_seen_at timestamptz DEFAULT now(),
  last_seen_at  timestamptz DEFAULT now(),
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS cv_signals_term_uniq
  ON agents.cv_signals (tenant_id, term);

CREATE INDEX IF NOT EXISTS cv_signals_rank_idx
  ON agents.cv_signals (tenant_id, seen_count);

-- Provenance + source text on the screening rows. `description` is kept so that
-- adding a dictionary term later can re-derive signals from history instead of
-- silently under-counting everything screened before the term existed.
ALTER TABLE agents.job_applications
  ADD COLUMN IF NOT EXISTS description text;

ALTER TABLE agents.job_applications
  ADD COLUMN IF NOT EXISTS posted_at timestamptz;

ALTER TABLE agents.job_applications
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';
