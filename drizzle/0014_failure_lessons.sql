-- Failure-lesson memory (the Hermes learning seam, src/kernel/lessons.ts):
-- one row per (tenant, worker, normalized failure signature) that a corrected
-- retry has RESOLVED at least once. The kernel injects the lesson into future
-- retries of the same signature. Recorded by code from validated results —
-- never by the model — so a lesson can never assert something that didn't happen.

CREATE TABLE IF NOT EXISTS agents.failure_lessons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  worker text NOT NULL,
  signature text NOT NULL,
  component text NOT NULL,
  objective text NOT NULL,
  resolved_with_tools jsonb NOT NULL DEFAULT '[]',
  times_seen integer NOT NULL DEFAULT 1,
  times_applied integer NOT NULL DEFAULT 0,
  last_resolved_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS fl_tenant_worker_sig_idx
  ON agents.failure_lessons (tenant_id, worker, signature);
