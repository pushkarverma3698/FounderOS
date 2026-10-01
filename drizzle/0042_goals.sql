-- goals + goal_reviews: what the founder is trying to move, and the daily standup that measures it.
--
-- 2026-09-29. A goal is a target on a metric the CODE computes from real events
-- (applications recorded, PRs merged, actions logged, or a value the founder
-- reports) - never a number the model claims. goal_reviews is the history that
-- makes "behind pace" computable at all, and the ledger that makes the 09:00
-- standup send exactly once.
--
-- goals: the two extra columns over the plan's schema, manual_value and
-- manual_value_at, hold what `/goal <n> <value>` records for a `manual` goal
-- (the current value and when it was reported). A goal's history is the reviews;
-- the current reported value is state on the goal.
--
-- goal_reviews: one row per goal per LOCAL date (the date in APP_TIMEZONE, not
-- UTC). The plan claimed the row with insert-on-conflict-do-nothing BEFORE the
-- work, which loses the day silently when the process dies between the claim
-- and the send: the row exists and nothing was sent. So the row is two-phase:
--   claimed_at  when a run took the row (the lease start); attempts counts takes
--   sent_at     NULL until the message that reports this row was delivered
-- A row with sent_at NULL whose claimed_at is older than the lease is taken
-- again by the next run; a row with sent_at set is never touched again. The
-- claim is a single INSERT ... ON CONFLICT DO UPDATE ... WHERE sent_at IS NULL
-- AND claimed_at < cutoff, so two concurrent runs cannot both win a row.
-- evidence and pace have defaults because the claim row is written BEFORE the
-- metric is computed; they are filled in by the run that holds the claim.
--
-- Rollback (manual, no down migration: 0030-0041 ship none, only 0029 did):
--   DROP TABLE agents.goal_reviews; DROP TABLE agents.goals;
-- This is safe to run before any goal exists and loses only goals data after.
--
-- The journal `when` for this entry MUST stay above every earlier entry's (see
-- tests/unit/db/migration-journal.test.ts): drizzle skips an entry whose `when`
-- is not greater than the newest one already applied.

CREATE TABLE IF NOT EXISTS "agents"."goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"title" text NOT NULL,
	"metric_key" text NOT NULL,
	"metric_arg" text,
	"target" numeric NOT NULL,
	"baseline" numeric DEFAULT 0 NOT NULL,
	"due_on" date,
	"status" text DEFAULT 'active' NOT NULL,
	"blocked_until" timestamp with time zone,
	"blocker" text,
	"priority" integer DEFAULT 100 NOT NULL,
	"manual_value" numeric,
	"manual_value_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goals_status_check" CHECK ("status" IN ('active', 'blocked', 'done', 'dropped'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goals_tenant_status_idx" ON "agents"."goals" USING btree ("tenant_id", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agents"."goal_reviews" (
	"goal_id" uuid NOT NULL,
	"review_date" date NOT NULL,
	"value" numeric,
	"evidence" text DEFAULT '' NOT NULL,
	"pace" text DEFAULT 'unknown' NOT NULL,
	"error" text,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"attempts" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "goal_reviews_pkey" PRIMARY KEY ("goal_id", "review_date"),
	CONSTRAINT "goal_reviews_goal_id_fkey" FOREIGN KEY ("goal_id") REFERENCES "agents"."goals" ("id"),
	CONSTRAINT "goal_reviews_pace_check" CHECK ("pace" IN ('ahead', 'on_track', 'behind', 'unknown'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goal_reviews_review_date_idx" ON "agents"."goal_reviews" USING btree ("review_date");
