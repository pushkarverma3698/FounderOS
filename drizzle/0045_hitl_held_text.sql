-- hitl_approvals.held_text / held_at: the message the founder sent while an approval card was waiting.
--
-- 2026-10-08 (AG-047). A text that arrived while a card was pending was refused with "send your message again"
-- and dropped (prod 10-07: "Where are we stuck and failing?" was never answered). The gateway now keeps it on the
-- pending approval row, one per card (the newest wins), and runs it as a normal turn after the founder's tap has
-- been answered. In the database, not in memory, so a deploy restart between hold and tap does not lose it.
--
-- held_text is NULL when nothing is held. held_at is when the text arrived; a text older than the HITL restore
-- window (2 h) is dropped with a one-line notice instead of run. Both are claimed (cleared) before the held turn runs.
--
-- Additive and idempotent: nothing reads the columns until the new code runs, and NULL means "nothing held".
--
-- Rollback (manual, no down migration: 0030-0044 ship none, only 0029 did):
--   ALTER TABLE agents.hitl_approvals DROP COLUMN held_text, DROP COLUMN held_at;
-- Safe at any time: the gateway then goes back to refusing a message sent while a card waits.
--
-- The journal `when` for this entry MUST stay above every earlier entry (see
-- tests/unit/db/migration-journal.test.ts): drizzle skips an entry whose `when` is not greater than the newest one
-- already applied.

ALTER TABLE "agents"."hitl_approvals"
	ADD COLUMN IF NOT EXISTS "held_text" text,
	ADD COLUMN IF NOT EXISTS "held_at" timestamp with time zone;
