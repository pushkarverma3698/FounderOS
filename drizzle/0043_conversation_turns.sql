-- conversation_turns: the founder's conversation, kept past the 6-hour session the planner replays.
--
-- 2026-10-04. The planner only sees the current session (a 6 h gap ends it, 20 turns, 16000 chars), and
-- the rest of a thread lives in an LLM checkpoint nobody can search. "What did I ask you yesterday?" had no
-- source at all. One row per COMPLETED turn, written by the plan node when the NEXT turn begins (the previous
-- turn is then finished, with its final reply) - see src/kernel/turn-log.ts.
--
-- A table of its own rather than episodic_memory: the read-only MCP search_memory reads episodic_memory, so
-- transcripts there would leak into every MCP client and bury the curated events that table holds. It also
-- needs a unique key (episodic_memory has none), which is what makes the write safe to repeat: a graph retry
-- or a replayed turn hits the same (thread_id, turn_id) and does nothing.
--
-- thread_id is the kernel thread (`<tenant>:<chat id>`). Recall is always filtered by it, because a guest in
-- an allow-listed group chat runs every non-HITL tool and must never read the founder's private chat.
--
-- user_input / reply are the turn's stored text (input capped at 2000 characters, reply at 1500, by the
-- planner before it reaches here). No other content is stored: no tool outputs, no emails or documents.
--
-- Rollback (manual, no down migration: 0030-0042 ship none, only 0029 did):
--   DROP TABLE agents.conversation_turns;
-- Safe at any time: nothing else references it, and recall simply reports that nothing is saved.
--
-- The journal `when` for this entry MUST stay above every earlier entry's (see
-- tests/unit/db/migration-journal.test.ts): drizzle skips an entry whose `when` is not greater than the
-- newest one already applied.

CREATE TABLE IF NOT EXISTS "agents"."conversation_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"user_input" text NOT NULL,
	"goal" text NOT NULL,
	"outcome" text NOT NULL,
	"reply" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_turns_thread_turn_key" UNIQUE ("thread_id", "turn_id"),
	CONSTRAINT "conversation_turns_outcome_check" CHECK ("outcome" IN ('replied', 'done', 'failed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_turns_thread_time_idx" ON "agents"."conversation_turns" USING btree ("thread_id", "occurred_at");
