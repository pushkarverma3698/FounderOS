-- Saved-workflow catalog: one row per distinct script/workflow the agent has
-- run (vps_run, claude_code). Identity is a content `signature` (tool + command
-- + image); `run_count` increments on every repeat so "our most-used workflows"
-- is ORDER BY run_count DESC. Scripts themselves live in S3 (`s3_keys`, set for
-- vps_run artifacts); this table is the findable index for tomorrow's re-runs.
-- Written best-effort by code AFTER a run succeeds — never fails a finished job.

CREATE TABLE IF NOT EXISTS agents.saved_workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  slug text NOT NULL,
  signature text NOT NULL,
  tool text NOT NULL,
  command text NOT NULL,
  brief text,
  image text,
  s3_keys jsonb NOT NULL DEFAULT '[]',
  last_run_id text,
  run_count integer NOT NULL DEFAULT 1,
  first_used_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS sw_tenant_sig_idx
  ON agents.saved_workflows (tenant_id, signature);

CREATE INDEX IF NOT EXISTS sw_popularity_idx
  ON agents.saved_workflows (tenant_id, run_count);
