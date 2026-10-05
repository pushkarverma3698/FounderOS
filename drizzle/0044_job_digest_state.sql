-- job_digest_state: the new-role alerts buffered between batched messages to the jobs group.
--
-- 2026-10-05. The free lane sweeps 48 times a day and sent one group message per sweep that found something,
-- plus an alive ping and the funnel alert, so the family jobs group read as a ticker. Sweeps now buffer here and
-- a batch goes out three times a day (src/tools/jobhunt/alert-digest.ts). Heartbeats and funnel alerts go to the
-- founder DM and need no storage beyond job_lane_heartbeats.
--
-- A table of its own rather than columns on job_lane_heartbeats: the sweep rewrites that row 48 times a day, and
-- a combined upsert would let it clear the buffer (the same split as fresh_viewed_at, written only by /fresh).
-- Additive and idempotent: nothing reads it until the new code runs, and an empty table means "nothing buffered".
--
-- pending is a jsonb PendingAlerts: {rows: [{company, title, outcome, url, key}], backfill, overflow}.
--
-- Rollback (manual, no down migration: 0030-0043 ship none, only 0029 did):
--   DROP TABLE agents.job_digest_state;
-- Safe at any time: the sweep then fails its buffer write and logs it; roles stay visible through /jobs and /fresh.
--
-- The journal `when` for this entry MUST stay above every earlier entry (see
-- tests/unit/db/migration-journal.test.ts): drizzle skips an entry whose `when` is not greater than the newest one
-- already applied.

CREATE TABLE IF NOT EXISTS "agents"."job_digest_state" (
	"profile_id" text PRIMARY KEY NOT NULL,
	"pending" jsonb,
	"last_digest_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
