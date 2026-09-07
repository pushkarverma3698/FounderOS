-- job_lane_heartbeats: persist the free lane's "am I still alive" state per profile.
--
-- 2026-09-07: this state lived ONLY in an in-process Map (sweep-runner.ts), on
-- the reasoning that a restart honestly resetting it was fine. That assumed
-- restarts are rare. Measured: prod restarted 18 times in 3 days, 4 of them in
-- 7 minutes during one deploy. The 3-hour "prove the lane is alive" ping needs
-- 3 CONTINUOUS hours without a restart to ever fire. A high-volume profile
-- never notices — its real "new roles passed" alerts fire far more often than
-- that — but a thin-market profile can go silent indefinitely: Tashi's last
-- passing role was 2026-09-04, three days before this was found, with zero
-- alerts and zero heartbeat pings the whole time. This table is that state,
-- persisted, so a restart no longer erases the founder's only proof a quiet
-- lane is running.

CREATE TABLE IF NOT EXISTS "agents"."job_lane_heartbeats" (
	"profile_id" text PRIMARY KEY NOT NULL,
	"quiet_sweeps" integer DEFAULT 0 NOT NULL,
	"boards_polled" integer DEFAULT 0 NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"zero_pass_streak" integer DEFAULT 0 NOT NULL,
	"last_funnel" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
