-- FounderOS — Memory System Migration
-- Adds two tables:
--   conversations   — searchable record of each Telegram thread (summary + topics)
--   episodic_memory — time-ordered events for episodic recall
--
-- Run with: pnpm db:migrate
-- Applied: 2026-06-04

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conversations" (
  "id"               SERIAL PRIMARY KEY,
  "thread_id"        TEXT NOT NULL UNIQUE,
  "tenant_id"        TEXT NOT NULL DEFAULT 'turicks',
  "started_at"       TIMESTAMPTZ,
  "last_message_at"  TIMESTAMPTZ,
  "summary"          TEXT,
  "topics"           JSONB DEFAULT '[]'::jsonb,
  "message_count"    INTEGER NOT NULL DEFAULT 0,
  "created_at"       TIMESTAMPTZ DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conv_tenant_time_idx"
  ON "conversations" ("tenant_id", "last_message_at");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "episodic_memory" (
  "id"          SERIAL PRIMARY KEY,
  "tenant_id"   TEXT NOT NULL DEFAULT 'turicks',
  "event_type"  TEXT NOT NULL,
  "occurred_at" TIMESTAMPTZ NOT NULL,
  "title"       TEXT NOT NULL,
  "summary"     TEXT,
  "tags"        JSONB DEFAULT '[]'::jsonb,
  "thread_id"   TEXT,
  "source"      TEXT NOT NULL DEFAULT 'telegram',
  "created_at"  TIMESTAMPTZ DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "em_tenant_time_idx"
  ON "episodic_memory" ("tenant_id", "occurred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "em_title_idx"
  ON "episodic_memory" ("title");
