-- FounderOS — Migration 0010: agent_assets table
-- Stores S3 key references for files uploaded by agents or users.
-- File content NEVER enters Postgres — only the key and metadata are stored.
-- Presigned download URLs are generated on-demand via the storage layer.

CREATE TABLE IF NOT EXISTS agents.agent_assets (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            TEXT        NOT NULL,
  agent_id          TEXT,
  s3_key            TEXT        NOT NULL,
  original_filename TEXT,
  asset_type        TEXT,        -- 'input' | 'output' | 'scratch'
  mime_type         TEXT,
  created_at        TIMESTAMPTZ DEFAULT now(),
  expires_at        TIMESTAMPTZ              -- nullable; set for scratch files
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS aa_run_idx  ON agents.agent_assets (run_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS aa_type_idx ON agents.agent_assets (asset_type);
