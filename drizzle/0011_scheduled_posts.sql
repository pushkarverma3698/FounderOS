-- Scheduled social posts queue (LinkedIn has no native scheduling; we fire via cron sweep).
-- Platform-generic so Instagram/Facebook can reuse the same queue (ADR-036 accounts).

CREATE TABLE IF NOT EXISTS agents.scheduled_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  platform text NOT NULL,
  account_key text NOT NULL,
  text text NOT NULL,
  mention_urn text,
  mention_name text,
  visibility text NOT NULL DEFAULT 'PUBLIC',
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled',
  idempotency_key text NOT NULL,
  post_id text,
  post_url text,
  error text,
  created_at timestamptz DEFAULT now(),
  posted_at timestamptz,
  CONSTRAINT scheduled_posts_idempotency_key_unique UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS sp_due_idx
  ON agents.scheduled_posts (status, scheduled_at);

CREATE INDEX IF NOT EXISTS sp_tenant_idx
  ON agents.scheduled_posts (tenant_id, scheduled_at);
