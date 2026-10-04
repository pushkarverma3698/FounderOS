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
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "kernel:turn-log" });

export interface TurnLog {
  /**
   * Store one finished turn. Recording the same (thread, turn_id) twice stores it once. May throw:
   * the plan node calls it through recordTurnSafely, which contains the failure, because a lost log
   * row costs a later recall and a thrown one would cost the founder this reply.
   */
  record(turn: TurnSummary, threadId: string): Promise<void>;
}

/**
 * The plan node's one call into the log. Skips a turn that has no thread id (recall is scoped to a
 * thread, so a row filed under none could never be read back), and swallows a failing log: the
 * founder's reply never waits on, or fails because of, a history write.
 */
export async function recordTurnSafely(turnLog: TurnLog, turn: TurnSummary, threadId: unknown): Promise<void> {
  if (typeof threadId !== "string" || threadId === "") return;
  try {
    await turnLog.record(turn, threadId);
  } catch (err) {
    log.warn({ err: String(err), turn_id: turn.turn_id }, "Turn log write failed — this turn will not be recallable"); // allow-failopen: a lost history row costs a later recall; failing here would cost the founder this reply
  }
}
