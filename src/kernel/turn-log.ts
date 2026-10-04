/**
 * FounderOS kernel — the durable log of finished turns.
 * ====================================================
 * The planner replays only the current conversation: `history` drops every turn before a
 * 6-hour silence (state.ts HISTORY_SESSION_GAP_MS) and keeps at most 20. That bound is
 * right for planning, and it left nothing that remembers what the founder said
 * yesterday: "what did I ask you about the visa last week" had no source to read.
 *
 * The plan node already folds each finished turn into a TurnSummary, the one choke point
 * every turn passes through. It hands that summary to this log too, and recall_conversation
 * reads it back. Injected like LessonStore: Postgres in prod, absent in tests.
 */

import type { TurnSummary } from "./contracts.js";

export interface TurnLog {
  /**
   * Store one finished turn. Recording the same turn_id twice stores it once. Must not throw
   * upward: a lost log row costs a later recall, a thrown one would cost the founder this reply.
   */
  record(turn: TurnSummary, threadId: string): Promise<void>;
}
