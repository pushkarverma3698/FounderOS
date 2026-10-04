/**
 * FounderOS — conversation_turns (Drizzle schema)
 * ===============================================
 * Migration: drizzle/0043_conversation_turns.sql. Re-exported from src/db/schema.ts (one line) so
 * tests/unit/db/schema-migration-parity.test.ts sees the table. Own file and own `pgSchema("agents")`
 * for the same reasons as goals-schema.ts: schema.ts is far over the 400-line budget, and importing
 * `agentsSchema` back from it would be a cycle.
 *
 * One row per COMPLETED turn of a thread. The unique (thread_id, turn_id) key is what makes the write
 * safe to repeat. Read only through src/db/conversation-turns.ts, always filtered by thread_id.
 */

import { sql } from "drizzle-orm";
import { check, index, pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

const agents = pgSchema("agents");

export const conversationTurns = agents.table(
  "conversation_turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The kernel thread, `<tenant>:<chat id>`. Every read filters on it: a group chat must not read a private one. */
    thread_id: text("thread_id").notNull(),
    turn_id: text("turn_id").notNull(),
    /** When the turn happened (the kernel's own timestamp), not when the row was written. */
    occurred_at: timestamp("occurred_at", { withTimezone: true }).notNull(),
    user_input: text("user_input").notNull(),
    goal: text("goal").notNull(),
    /** replied | done | failed — CHECK-constrained in the migration. */
    outcome: text("outcome").notNull(),
    reply: text("reply").notNull(),
    recorded_at: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    threadTurnKey: unique("conversation_turns_thread_turn_key").on(t.thread_id, t.turn_id),
    threadTimeIdx: index("conversation_turns_thread_time_idx").on(t.thread_id, t.occurred_at),
    outcomeCheck: check("conversation_turns_outcome_check", sql`${t.outcome} IN ('replied', 'done', 'failed')`),
  }),
);

export type ConversationTurnRecord = typeof conversationTurns.$inferSelect;
