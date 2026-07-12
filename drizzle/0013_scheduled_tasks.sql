-- Scheduled agent tasks queue: founder-scheduled future kernel turns.
-- A zero-LLM cron sweep claims due rows and fires each as a normal kernel turn
-- on the founder's thread — HITL gating and budget caps apply at fire time.

CREATE TABLE IF NOT EXISTS agents.scheduled_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  prompt text NOT NULL,
  chat_id text NOT NULL,
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled',
  attempts integer NOT NULL DEFAULT 0,
  idempotency_key text NOT NULL,
  error text,
  created_at timestamptz DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT scheduled_tasks_idempotency_key_unique UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS st_due_idx
  ON agents.scheduled_tasks (status, scheduled_at);

CREATE INDEX IF NOT EXISTS st_tenant_idx
  ON agents.scheduled_tasks (tenant_id, scheduled_at);
