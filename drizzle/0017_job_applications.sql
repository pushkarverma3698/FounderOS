-- Job application state table: the dedupe + stage tracker behind the NL entry
-- campaign (docs/strategy/09-NL-ENTRY-CAMPAIGN.md §3).
--
-- `dedupe_key` is normalised `company::role` (src/tools/jobhunt/filters.ts). The
-- UNIQUE constraint on (tenant_id, dedupe_key) — not application logic — is what
-- makes double-applying structurally impossible: a screen that races another
-- screen fails on the constraint rather than quietly inserting a second row.

CREATE TABLE IF NOT EXISTS agents.job_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  dedupe_key text NOT NULL,
  company text NOT NULL,
  registered_name text,
  title text NOT NULL,
  url text,
  sponsor_verdict text NOT NULL,
  salary_status text NOT NULL,
  salary_evidence text,
  fit_score numeric,
  fit_evidence text,
  stage text NOT NULL DEFAULT 'screened',
  applied_at timestamptz,
  last_contact_at timestamptz,
  followups_sent integer NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ja_dedupe_uniq
  ON agents.job_applications (tenant_id, dedupe_key);

-- Monday pipeline review hot path: live applications ordered by staleness.
CREATE INDEX IF NOT EXISTS ja_stage_idx
  ON agents.job_applications (tenant_id, stage, last_contact_at);
