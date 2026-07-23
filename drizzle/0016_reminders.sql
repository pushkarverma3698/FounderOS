-- Reminders queue: founder-facing pure pings (zero-LLM).
-- A reminder NEVER executes anything (that is scheduled_tasks) — a zero-LLM cron
-- sweep claims due rows and sends the text straight to chat with no kernel turn,
-- no budget gate and no HITL. One-shot rows go 'fired'; recurring rows re-arm
-- (remind_at advances to the next occurrence, status back to 'scheduled').

CREATE TABLE IF NOT EXISTS agents.reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  chat_id text NOT NULL,
  text text NOT NULL,
  remind_at timestamptz NOT NULL,
  recurrence jsonb,
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  status text NOT NULL DEFAULT 'scheduled',
  idempotency_key text NOT NULL,
  error text,
  created_at timestamptz DEFAULT now(),
  fired_at timestamptz,
  CONSTRAINT reminders_idempotency_key_unique UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS rem_due_idx
  ON agents.reminders (status, remind_at);

CREATE INDEX IF NOT EXISTS rem_tenant_idx
  ON agents.reminders (tenant_id, remind_at);
