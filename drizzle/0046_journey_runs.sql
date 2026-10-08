-- journey_runs: one row per journey per morning run (AG-051, scripts/journey-daily.ts).
--
-- 2026-10-08. The morning run asks the bot J1-J5 through Telegram, scores each reply against the real source, adds
-- journey A-C results and a health line, and sends one message. Rows here give the trend the message cannot
-- ("J2 red 4 mornings running"). Nothing existing stores this: action_log is per tool call, eval tables are the
-- golden set.
--
-- Additive and idempotent: nothing reads it until the new code runs.
--
-- Rollback (manual, no down migration: 0030-0045 ship none, only 0029 did):
--   DROP TABLE agents.journey_runs;
-- Safe at any time: journey-daily then logs the failed insert and still sends the morning message.
--
-- The journal `when` for this entry MUST stay above every earlier entry (see
-- tests/unit/db/migration-journal.test.ts): drizzle skips an entry whose `when` is not greater than the newest one
-- already applied.

CREATE TABLE IF NOT EXISTS "agents"."journey_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"run_id" text NOT NULL,
	"journey" text NOT NULL,
	"status" text NOT NULL,
	"health_ok" boolean NOT NULL,
	"detail" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "journey_runs_journey_created_idx" ON "agents"."journey_runs" USING btree ("journey","created_at");
